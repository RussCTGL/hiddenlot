"use server";

import { cookies } from "next/headers";
import { ZodError } from "zod";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getClockOffsetHours, getUser, setClockOffsetHours, VersionConflictError } from "@/db/repo";
import { getDb } from "@/db/server";
import { discoverAll } from "@/discovery/engine";
import { InventoryLotFields, LotCondition, PriceBasis, ProductForm, SurplusReason, type InventoryLotField } from "@/domain/hrc";
import { intakeDocument, type ExtractorName } from "@/ingestion/intake";
import { getExplainCall, getMetaExtract } from "@/lib/meta";
import { acceptSuggestions, closeDeal, declineSuggestion, moveDeal, recordQuote, startDeal } from "@/workflow/deals";
import { explainOpportunity } from "@/workflow/explain";
import { ACTOR_COOKIE, requestNow, requireSession } from "@/lib/session";
import { seedDemo } from "@/seed/demo";
import {
  ALL_LOT_FIELDS,
  createDemand,
  createGrant,
  decideOpportunity,
  publishLot,
  reconfirmLot,
  ReviewDecision,
  reviewLot,
  revokeGrant,
  setLotStatus,
  withdrawDemand,
  type DemandInput,
  type FieldEdit,
} from "@/workflow/actions";

// Server Actions. Each one re-reads the demo session on the server and passes
// the actor to the workflow layer, which enforces ownership; nothing trusts
// IDs or permissions sent from the browser.

export type ActionState = { error?: string; ok?: string } | null;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const num = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError(`${k} must be a number`);
  return n;
};

class UserError extends Error {}

async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: "Saved" };
  } catch (err) {
    // redirect() works by throwing; let it through.
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof VersionConflictError) return { error: "Someone saved a newer version first. Reload and try again." };
    if (err instanceof ZodError) return { error: "Invalid input" };
    // Database errors (bad foreign key, constraint) are not shown verbatim.
    if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string" && /^[0-9A-Z]{5}$/.test((err as { code: string }).code)) {
      return { error: "Invalid request" };
    }
    if (err instanceof Error) return { error: err.message };
    return { error: "Something went wrong" };
  }
}

// --- session & demo ----------------------------------------------------------

export async function switchActor(formData: FormData) {
  const id = str(formData, "user_id");
  const db = await getDb();
  if (!(await getUser(db, id))) return;
  (await cookies()).set(ACTOR_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  refresh();
}

/** Public deployments set HIDDENLOT_ALLOW_RESET=false so visitors cannot wipe the shared demo. */
const resetAllowed = () => (process.env.HIDDENLOT_ALLOW_RESET ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";

export async function resetDemo() {
  if (!resetAllowed()) return;
  const db = await getDb();
  await seedDemo(db, new Date()); // also puts the demo clock back to real time
  refresh();
}

export async function rerunDiscovery() {
  const { actor } = await requireSession();
  await discoverAll(await getDb(), await requestNow(), actor.network_id);
  refresh();
}

// --- intake ----------------------------------------------------------------

export async function intakeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await run(async () => {
    const { actor } = await requireSession();
    if (formData.get("synthetic_confirmed") !== "on") throw new UserError("This public demo only accepts synthetic test data. Tick the confirmation box.");
    const file = formData.get("file");
    const text = str(formData, "text");
    let bytes: Uint8Array;
    let filename: string | null;
    let mime: string | null;
    if (file instanceof File && file.size > 0) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      mime = file.type || null;
    } else if (text) {
      bytes = new TextEncoder().encode(text);
      filename = "pasted.txt";
      mime = "text/plain";
    } else throw new UserError("Choose a file or paste a message.");
    const extractor = (str(formData, "extractor") || "meta") as ExtractorName;
    if (extractor !== "meta" && extractor !== "regex_baseline") throw new UserError("Unknown extractor");
    const r = await intakeDocument(await getDb(), actor, { bytes, filename, mime, extractor, synthetic: true }, getMetaExtract(), await requestNow());
    target = r.document_id;
  });
  if (target) redirect(`/documents/${target}`);
  return state;
}

// --- lot review -------------------------------------------------------------

const ENUMS: Partial<Record<InventoryLotField, readonly string[]>> = {
  product_form: ProductForm.options,
  condition: LotCondition.options,
  price_basis: PriceBasis.options,
  surplus_reason: SurplusReason.options,
};

function parseCorrection(field: InventoryLotField, raw: string): unknown {
  if (raw === "") return null; // "clear" makes the field Unknown again
  if (ENUMS[field]) {
    if (!ENUMS[field]!.includes(raw)) throw new UserError(`Choose one of ${ENUMS[field]!.join(", ")}`);
    return raw;
  }
  switch (field) {
    case "thickness_mm":
    case "width_mm":
    case "total_kg": {
      const n = Number(raw);
      if (!(n > 0)) throw new UserError("Enter a positive number");
      return n;
    }
    case "piece_count": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new UserError("Enter a whole number");
      return n;
    }
    case "splittable":
      if (raw !== "true" && raw !== "false") throw new UserError("Choose yes or no");
      return raw === "true";
    case "certificate_claims":
    case "heat_numbers":
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    case "available_from":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new UserError("Use YYYY-MM-DD");
      return raw;
    case "price_amount":
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new UserError("Enter a decimal amount without separators");
      return raw;
    case "price_currency":
    case "location_country":
      return raw.toUpperCase();
    default:
      return raw;
  }
}

export async function correctFieldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const field = str(formData, "field") as InventoryLotField;
    if (!Object.hasOwn(InventoryLotFields.shape, field)) throw new UserError("Unknown field");
    const note = str(formData, "note");
    if (!note) throw new UserError("Say why you are correcting the value");
    const edit: FieldEdit = { field, action: "correct", value: parseCorrection(field, str(formData, "value")), note };
    await reviewLot(await getDb(), actor, str(formData, "lot_id"), Number(str(formData, "version")), [edit], await requestNow());
    refresh();
    return { ok: "Corrected; the original stays in the previous version" };
  });
}

export async function confirmAllAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    await reviewLot(await getDb(), actor, str(formData, "lot_id"), Number(str(formData, "version")), ALL_LOT_FIELDS.map((field) => ({ field, action: "confirm" as const })), await requestNow());
    refresh();
    return { ok: "Confirmed; Unknown values stay Unknown" };
  });
}

export async function publishAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const { stats } = await publishLot(await getDb(), actor, str(formData, "lot_id"), Number(str(formData, "version")), await requestNow());
    refresh();
    return { ok: `Published; discovery checked ${stats.pairs} demand(s), ${stats.new_opportunities} new opportunity(ies)` };
  });
}

export async function reconfirmAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    await reconfirmLot(await getDb(), actor, str(formData, "lot_id"), Number(str(formData, "version")), await requestNow());
    refresh();
    return { ok: "Stock reconfirmed" };
  });
}

export async function setLotStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const status = str(formData, "status");
    if (status !== "sold" && status !== "withdrawn") throw new UserError("Unknown status");
    const { invalidated } = await setLotStatus(await getDb(), actor, str(formData, "lot_id"), Number(str(formData, "version")), status, await requestNow());
    refresh();
    return { ok: `Marked ${status}; ${invalidated} opportunity(ies) invalidated` };
  });
}

// --- demands ----------------------------------------------------------------

export async function createDemandAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let created: string | null = null;
  const state = await run(async () => {
    const { actor } = await requireSession();
    const t = (k: string) => {
      const v = num(formData, k);
      return v === null ? null : Math.round(v * 1000);
    };
    const minKg = t("qty_min_t");
    const maxKg = t("qty_max_t");
    if (minKg === null || maxKg === null) throw new UserError("Quantity min and max are required");
    const grades = str(formData, "grades")
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [grade, standard, edition] = line.split("|").map((s) => s.trim());
        return { grade, standard_id: standard || null, edition: edition || null };
      });
    if (grades.length === 0) throw new UserError("List at least one accepted grade");
    const budgetAmount = str(formData, "budget_amount");
    const input: DemandInput = {
      title: str(formData, "title") || "Untitled demand",
      product_form: "hot_rolled_coil",
      quantity_kg: { min: minKg, target: t("qty_target_t"), max: maxKg },
      thickness_mm: { min: num(formData, "thk_min"), max: num(formData, "thk_max"), source: "buyer_explicit" },
      width_mm: { min: num(formData, "wid_min"), max: num(formData, "wid_max"), source: "buyer_explicit" },
      accepted_grades: grades,
      substitution_policy: str(formData, "substitution") === "review_required" ? "review_required" : "forbidden",
      acceptable_conditions: (formData.getAll("conditions").map(String) as ("prime" | "secondary" | "rejected_on_arrival")[]).filter((c) => ["prime", "secondary", "rejected_on_arrival"].includes(c)),
      must_have_certificates: str(formData, "certificates").split(",").map((s) => s.trim()).filter(Boolean),
      allow_partial_delivery: formData.get("allow_partial") === "on",
      allow_multi_lot: false,
      destination: str(formData, "destination") || null,
      need_by: str(formData, "need_by") || null,
      budget: budgetAmount
        ? {
            amount: budgetAmount,
            currency: str(formData, "budget_currency").toUpperCase() || "USD",
            basis: "per_mt",
            incoterm: str(formData, "budget_incoterm").toUpperCase(),
            place: str(formData, "budget_place"),
          }
        : null,
      expires_at: null,
    };
    if (input.acceptable_conditions.length === 0) throw new UserError("Choose at least one acceptable condition");
    const { demand } = await createDemand(await getDb(), actor, input, await requestNow());
    created = demand.demand_id;
  });
  if (created) redirect(`/opportunities?demand=${created}`);
  return state;
}

export async function withdrawDemandAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    await withdrawDemand(await getDb(), actor, str(formData, "demand_id"), await requestNow());
    refresh();
    return { ok: "Withdrawn" };
  });
}

// --- sharing ----------------------------------------------------------------

export async function createGrantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const scope = formData.getAll("field_scope").map(String).filter((f): f is InventoryLotField => (ALL_LOT_FIELDS as string[]).includes(f));
    if (scope.length === 0) throw new UserError("Share at least one field");
    const days = num(formData, "expires_days");
    const { grant_id } = await createGrant(
      await getDb(),
      actor,
      {
        recipient_network_id: str(formData, "recipient"),
        lot_id: str(formData, "lot_id") || null,
        field_scope: scope,
        allow_identity_disclosure: formData.get("identity") === "on",
        allow_model_processing: formData.get("model_processing") === "on",
        expires_at: days ? new Date((await requestNow()).getTime() + days * 86_400_000) : null,
      },
      await requestNow(),
    );
    refresh();
    return { ok: `Shared (${grant_id}); discovery ran for the recipient's demands` };
  });
}

export async function revokeGrantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const { invalidated } = await revokeGrant(await getDb(), actor, str(formData, "grant_id"), await requestNow());
    refresh();
    return { ok: `Revoked; ${invalidated} opportunity(ies) invalidated` };
  });
}

// --- opportunity review -------------------------------------------------------

export async function decideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const decision = ReviewDecision.parse(str(formData, "decision"));
    const db = await getDb();
    const now = await requestNow();
    const oppId = str(formData, "opportunity_id");
    const reason = str(formData, "reason");
    await decideOpportunity(db, actor, oppId, decision, reason, now);
    // Acting on a candidate starts tracking it as a deal.
    if (decision === "shortlisted") await startDeal(db, actor, oppId, "quote_requested", null, `Shortlisted: ${reason}`, now);
    if (decision === "information_requested") await startDeal(db, actor, oppId, "waiting", reason, `Asked: ${reason}`, now);
    refresh();
    return { ok: decision === "shortlisted" || decision === "information_requested" ? "Saved and tracked in Deals" : "Decision saved with the versions it was based on" };
  });
}

// --- daily digest and deals ---------------------------------------------------------

export async function acceptSuggestionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const keys = formData.getAll("key").map(String);
    const { done, skipped } = await acceptSuggestions(await getDb(), actor, keys, await requestNow());
    refresh();
    return { ok: `${done} done${skipped ? `; ${skipped} no longer applied` : ""}. Nothing was sent: copy the drafts to send them.` };
  });
}

export async function declineSuggestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    if (!(await declineSuggestion(await getDb(), actor, str(formData, "key"), await requestNow()))) throw new UserError("This suggestion no longer applies");
    refresh();
  });
}

export async function recordQuoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const price = str(formData, "price").replace(/,/g, "");
    if (!price) throw new UserError("Enter the offered price");
    await recordQuote(
      await getDb(),
      actor,
      str(formData, "deal_id"),
      { price, currency: str(formData, "currency").toUpperCase() || "USD", incoterm: str(formData, "incoterm") || "—", valid_until: str(formData, "valid_until") || null, quantity_t: num(formData, "quantity_t") },
      await requestNow(),
    );
    refresh();
    return { ok: "Offer recorded" };
  });
}

export async function moveDealAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const to = str(formData, "to");
    if (to !== "quote_requested" && to !== "negotiating") throw new UserError("Unknown stage");
    await moveDeal(await getDb(), actor, str(formData, "deal_id"), to, await requestNow());
    refresh();
  });
}

export async function closeDealAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const outcome = str(formData, "outcome");
    if (outcome !== "won" && outcome !== "lost") throw new UserError("Unknown outcome");
    await closeDeal(await getDb(), actor, str(formData, "deal_id"), outcome, str(formData, "reason"), await requestNow());
    refresh();
  });
}

/** Demo only: move the shared demo clock so time-based rules can be shown. */
export async function shiftClockAction(formData: FormData) {
  if (!resetAllowed()) return;
  const db = await getDb();
  const step = str(formData, "hours");
  await setClockOffsetHours(db, step === "reset" ? 0 : Math.min(24 * 30, (await getClockOffsetHours(db)) + Math.max(0, Math.min(72, Number(step) || 0))));
  refresh();
}

const explainAttempts = new Map<string, number>();

export async function explainAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { actor } = await requireSession();
    const call = getExplainCall();
    if (!call) throw new UserError("Meta is not configured on this server");
    const id = str(formData, "opportunity_id");
    // One paid call per opportunity per minute, counting attempts and calls in flight (per server process).
    const last = explainAttempts.get(id);
    if (last !== undefined && Date.now() - last < 60_000) throw new UserError("An explanation was requested less than a minute ago; wait before trying again");
    explainAttempts.set(id, Date.now());
    const stored = await explainOpportunity(await getDb(), actor, id, call, await requestNow());
    refresh();
    return { ok: `Explanation written by ${stored.model.model_id}${stored.dropped.length ? `; ${stored.dropped.length} unsupported sentence(s) removed` : ""}` };
  });
}
