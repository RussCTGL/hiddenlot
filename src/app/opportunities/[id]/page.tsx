import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { decideAction, explainAction } from "@/app/actions";
import { getOpportunityForActor, NotFoundError } from "@/auth/access";
import { FieldTable, formatValue } from "@/components/fields";
import { ArrowIcon, BackIcon, SparkIcon } from "@/components/icons";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, Bar, buttonCls, Card, Hint, inputCls, Loading, Mark, markLabel, Page, primaryCls, StatusPill, type MarkKind } from "@/components/ui";
import { getDb } from "@/db/server";
import { FRESHNESS_WINDOW_HOURS, REVIEWABLE, type Check, type CheckStatus } from "@/discovery/constraints";
import type { Demand, InventoryLot, InventoryLotField } from "@/domain/hrc";
import { listDecisions } from "@/workflow/actions";
import { requestNow, requireSession } from "@/lib/session";
import { STAGE_LABEL, type DealStage } from "@/workflow/deals";
import { metaAvailable } from "@/lib/meta";
import type { StoredExplanation } from "@/workflow/explain";

export default function OpportunityPage(props: PageProps<"/opportunities/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Detail params={props.params} />
    </Suspense>
  );
}

const ASK: Record<string, string> = { seller: "Ask seller", buyer: "You decide", engineering: "Engineering / QA", system: "HiddenLot" };
const BASIS: Record<string, string> = {
  reviewed: "Confirmed by the lot owner, not independently verified",
  source_evidence: "From source, not yet reviewed",
  seller_claim: "Seller claim, not verified",
  grade_only: "Grade only; no standard required",
  not_required: "Not required by buyer; not stated",
  system: "",
};
const SHORT_LABEL: Partial<Record<string, string>> = {
  available_date: "Ready by",
  lot_status: "Still available",
  freshness: "Recently confirmed",
  heat_link: "Cert ↔ this lot",
  product_form: "Form",
};
const SEVERITY: CheckStatus[] = ["fail", "review", "unknown", "conditional", "not_checked", "pass"];

const markOf = (c: Check): MarkKind => (c.status === "pass" && c.basis === "seller_claim" ? "claim" : c.status);
const range = (r: { min: number | null; max: number | null }, unit: string) => `${r.min ?? "?"}–${r.max ?? "?"} ${unit}`;

/** "You need" and "Lot has" for one check, from the demand and the lot as shared now. */
function needHas(c: Check, d: Demand, lot: InventoryLot | null): [string, string] {
  const v = (f: InventoryLotField) => {
    if (!lot) return "hidden";
    const o = lot.fields[f];
    if (o.issues.includes("withheld_by_owner")) return "not shared";
    const x = o.normalized_value;
    if (x === null || (Array.isArray(x) && x.length === 0)) return "?";
    return f === "total_kg" ? `${(x as number) / 1000} t` : formatValue(f, x);
  };
  switch (c.id) {
    case "grade":
      return [d.accepted_grades.map((g) => g.grade).join(" / "), v("grade_raw")];
    case "standard": {
      const want = d.accepted_grades.map((g) => [g.standard_id, g.edition].filter(Boolean).join(":")).filter(Boolean);
      const ed = lot?.fields.standard_edition.normalized_value;
      const has = v("standard_id");
      return [want.length ? want.join(" / ") : "any", ed && has !== "?" && has !== "not shared" ? `${has}:${String(ed)}` : has];
    }
    case "thickness":
      return [range(d.thickness_mm, "mm"), v("thickness_mm")];
    case "width":
      return [range(d.width_mm, "mm"), v("width_mm")];
    case "quantity":
      return [`${d.quantity_kg.min / 1000}–${d.quantity_kg.max / 1000} t${d.allow_partial_delivery ? ", partial OK" : ""}`, v("total_kg")];
    case "available_date":
      return [d.need_by ? `by ${d.need_by}` : "any date", v("available_from")];
    case "condition":
      return [d.acceptable_conditions.join(", ").replaceAll("_", " "), v("condition")];
    case "certificates":
      return [d.must_have_certificates.join(", ") || "none", v("certificate_claims")];
    case "product_form":
      return [d.product_form.replaceAll("_", " "), v("product_form")];
    case "freshness":
      return [`≤ ${FRESHNESS_WINDOW_HOURS} h ago`, c.detail.replace(/^(Last )?[Cc]onfirmed /, "").split(/[;(]/)[0].trim()];
    case "lot_status":
      return ["available", c.status === "pass" ? "published" : c.detail.replace(/^Lot is /, "")];
    case "heat_link":
      return ["cert matches lot", "needs the document"];
    default:
      return ["", c.detail];
  }
}

function Requirements({ checks, demand, lot }: { checks: Check[]; demand: Demand; lot: InventoryLot | null }) {
  const rows = checks.filter((c) => c.id !== "access").sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status));
  const counts = new Map<MarkKind, number>();
  for (const c of rows) counts.set(markOf(c), (counts.get(markOf(c)) ?? 0) + 1);
  const summary = (["fail", "review", "unknown", "conditional", "claim", "not_checked", "pass"] as MarkKind[])
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${markLabel(k).split(",")[0].toLowerCase()}`)
    .join(" · ");
  return (
    <Card title="Requirements" aside={<span className="text-[13px] text-zinc-600 dark:text-zinc-400">{summary}</span>}>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="pb-2.5 font-medium">Check</th>
              <th className="pb-2.5 font-medium">You need</th>
              <th className="pb-2.5 font-medium">Lot has</th>
              <th className="w-8 pb-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const [need, has] = needHas(c, demand, lot);
              const tip = [c.detail, c.basis ? BASIS[c.basis] : ""].filter(Boolean).join(" · ");
              return (
                <tr key={c.id} title={tip} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="py-3 pr-3 font-medium">{SHORT_LABEL[c.id] ?? c.label}</td>
                  <td className="py-3 pr-3 text-zinc-600 tabular-nums dark:text-zinc-400">{need}</td>
                  <td className={`py-3 pr-3 font-medium tabular-nums ${has === "?" || has === "not shared" ? "text-amber-700 dark:text-amber-400" : ""}`}>{has}</td>
                  <td className="py-3 text-right">
                    <Mark kind={markOf(c)} title={tip} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function lotTitle(lot: InventoryLot) {
  const v = (f: InventoryLotField) => lot.fields[f].normalized_value;
  const n = (x: unknown) => (x === null ? "?" : String(x));
  const kg = v("total_kg") as number | null;
  return `${n(v("grade_raw"))} · ${n(v("thickness_mm"))} × ${n(v("width_mm"))} mm · ${kg === null ? "?" : kg / 1000} t`;
}

function lotLine(lot: InventoryLot, ref: string | null) {
  const v = (f: InventoryLotField) => lot.fields[f].normalized_value;
  const terms = [v("incoterm"), v("incoterm_place")].filter((x) => x !== null).join(" ");
  const price = v("price_amount") !== null ? `${v("price_currency") ?? ""} ${v("price_amount")}/MT`.trim() : null;
  return [ref ? `Lot ${ref}` : null, terms || null, price].filter(Boolean).join(" · ");
}

async function Detail({ params }: { params: PageProps<"/opportunities/[id]">["params"] }) {
  const { id } = await params;
  const { actor } = await requireSession();
  const db = await getDb();
  let view;
  try {
    view = await getOpportunityForActor(db, actor, id, await requestNow());
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const decisions = await listDecisions(db, actor, id);
  const deal = (
    await db.query<{ id: string; stage: DealStage }>(
      `SELECT id, stage FROM deals WHERE buyer_network_id = $1 AND demand_id = $2 AND lot_id = $3 ORDER BY created_at DESC LIMIT 1`,
      [actor.network_id, view.opportunity.demand_id, view.opportunity.lot_id],
    )
  )[0];
  const { opportunity: o, demand, lot, checks, score } = view;
  const nextSteps = checks.filter((c) => ["unknown", "review", "conditional", "not_checked"].includes(c.status) && c.ask);
  const invalid = o.status === "invalidated";
  const canShortlist = REVIEWABLE.includes(view.compatibility_status);
  const ref = lot?.fields.seller_lot_ref.normalized_value ? String(lot.fields.seller_lot_ref.normalized_value) : null;
  const sellerName = view.seller_label.split(" (")[0].replace(/^Seller in /, "");

  return (
    <Page
      back={
        <Link href="/opportunities" className="inline-flex min-h-8 items-center gap-1.5 text-sm text-accent hover:underline">
          <BackIcon size={16} />
          Opportunities
        </Link>
      }
      title={lot ? lotTitle(lot) : demand.title}
      subtitle={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={view.compatibility_status} />
            {o.novelty === "cross_network" ? <Badge tone="sky">{sellerName} · shared with you</Badge> : <Badge>Your network</Badge>}
            {o.status !== "discovered" && <Badge tone={invalid ? "rose" : "violet"}>{o.status.replaceAll("_", " ")}</Badge>}
          </div>
          <p>{lot ? lotLine(lot, ref) || `For ${demand.title}` : "Lot details hidden"}</p>
        </div>
      }
    >
      {invalid && (
        <div className="mb-5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <b>Invalidated:</b> {o.invalidated_reason}. Earlier decisions do not carry over.
        </div>
      )}
      {view.access_note && !invalid && <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{view.access_note}</div>}

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[999_1_560px] space-y-5">
          <Requirements checks={checks} demand={demand} lot={lot} />

          <ExplanationCard
            oppId={o.id}
            stored={(o.explanation as StoredExplanation | null)?.assessment_id === o.assessment_id ? (o.explanation as StoredExplanation) : null}
            allowed={view.model_processing_allowed && !invalid}
            ended={invalid || !lot}
            meta={metaAvailable()}
          />

          {lot && (
            <details className="rounded-xl border border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
              <summary className="flex min-h-7 cursor-pointer items-center gap-2 text-[15px] font-semibold">
                All lot fields <span className="font-mono text-[13px] font-medium text-zinc-500">{Object.keys(lot.fields).length}</span>
                {o.novelty === "cross_network" && <Hint text="Values as the seller shared them. Quotes and file locations stay private; unshared fields show as Unknown." />}
              </summary>
              <div className="mt-4 overflow-x-auto">
                <FieldTable lot={lot} />
              </div>
            </details>
          )}
        </div>

        <aside className="min-w-0 flex-[1_1_300px] space-y-5">
          {deal && (
            <Link href={`/deals/${deal.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent-soft px-5 py-3.5 text-sm font-medium text-accent hover:underline">
              <span>Tracked in Deals · {STAGE_LABEL[deal.stage]}</span>
              <span aria-hidden>→</span>
            </Link>
          )}
          {!invalid && lot && view.compatibility_status !== "incompatible" && (
            <Card title="Your decision">
              <ActionForm action={decideAction} className="space-y-3">
                <input type="hidden" name="opportunity_id" value={o.id} />
                <label htmlFor="reason" className="sr-only">
                  Reason
                </label>
                <textarea id="reason" name="reason" required placeholder="Reason (required)" className={inputCls} rows={2} />
                <div className="flex flex-wrap gap-2">
                  <Submit
                    name="decision"
                    value="shortlisted"
                    className={primaryCls}
                    disabled={!canShortlist}
                    title={canShortlist ? "Worth enquiring" : "Only evidence-backed, declared or conditional candidates can be shortlisted"}
                  >
                    Shortlist
                  </Submit>
                  <Submit name="decision" value="information_requested" className={buttonCls}>
                    Request info
                  </Submit>
                  <Submit name="decision" value="dismissed" className={buttonCls}>
                    Dismiss
                  </Submit>
                </div>
              </ActionForm>
            </Card>
          )}

          <Card title="Review priority" aside={<Hint text="A priority for human review, not a probability of a deal, of quality or of credit. Freight, insurance, duty and FX are excluded." />}>
            {score && score.observed !== null ? (
              <div className="space-y-4">
                <p className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[44px] leading-none font-medium tracking-tight">{Math.round(score.observed)}</span>
                  <span className="text-[13px] text-zinc-600 dark:text-zinc-400">
                    {Math.round(score.coverage * 100)}% known{score.lower !== score.upper ? ` · range ${score.lower}–${score.upper}` : ""}
                  </span>
                </p>
                <ul className="space-y-3">
                  {Object.entries(score.components).map(([k, c]) => (
                    <li key={k} title={c.note} className="grid grid-cols-[96px_minmax(0,1fr)_40px] items-center gap-2.5 text-[13px]">
                      <span className="capitalize">{k}</span>
                      <Bar value={c.value} className="bg-accent" />
                      <span className={`text-right font-mono ${c.value === null ? "text-amber-700 dark:text-amber-400" : ""}`}>{c.value === null ? "?" : c.value.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Price:{" "}
                  {score.commercial === "within_budget" ? "within budget (goods only)" : score.commercial === "over_budget" ? "above budget" : "not comparable"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">Not available.</p>
            )}
          </Card>

          <Card title="Next steps" aside={<Hint text="HiddenLot sends no messages and reserves no stock. Request info records an internal to-do." />}>
            {nextSteps.length ? (
              <ul className="space-y-3">
                {nextSteps.map((c) => (
                  <li key={c.id} className="flex items-start gap-3" title={c.detail}>
                    <Mark kind={markOf(c)} />
                    <span className="text-sm">
                      <b className="block font-semibold">{ASK[c.ask!]}</b>
                      <span className="text-zinc-600 dark:text-zinc-400">{SHORT_LABEL[c.id] ?? c.label}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Nothing open. You decide whether to enquire.</p>
            )}
          </Card>

          <Card title="Why you see it">
            <div className="flex items-center gap-2.5 text-sm font-medium">
              <span className={`rounded-lg px-2.5 py-1.5 ${o.novelty === "cross_network" ? "bg-accent-soft text-accent" : "bg-zinc-100 dark:bg-zinc-800"}`}>{o.novelty === "cross_network" ? sellerName : "Your stock"}</span>
              <span className="text-zinc-400">
                <ArrowIcon size={18} />
              </span>
              <span className="rounded-lg bg-zinc-900 px-2.5 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900">You</span>
            </div>
            <p className="mt-3 text-[13px] text-zinc-600 dark:text-zinc-400">{o.novelty === "cross_network" ? "Shared stock, matched when published. Your network alone would not show it." : "Matched when the lot or your demand last changed."}</p>
            <p className="mt-2 font-mono text-xs text-zinc-500">{o.lot_id}</p>
          </Card>

          {decisions.length > 0 && (
            <Card title="History">
              <ul className="space-y-2.5 text-[13px]">
                {decisions.map((d) => (
                  <li key={d.id}>
                    <b className="font-semibold capitalize">{d.decision.replaceAll("_", " ")}</b>{" "}
                    <span className="text-zinc-500">· {new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                    <div className="text-zinc-600 dark:text-zinc-400">{d.reason}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </Page>
  );
}

function Cite({ ids }: { ids: string[] }) {
  return <span className="ml-1 font-mono text-[10px] text-zinc-400">[{ids.join(", ")}]</span>;
}

function ExplanationCard({ oppId, stored, allowed, ended, meta }: { oppId: string; stored: StoredExplanation | null; allowed: boolean; ended: boolean; meta: boolean }) {
  const e = stored?.explanation;
  return (
    <Card
      title="Meta explanation"
      aside={
        allowed && meta ? (
          <ActionForm action={explainAction}>
            <input type="hidden" name="opportunity_id" value={oppId} />
            <Submit className={buttonCls} pending="Asking Meta…">
              <SparkIcon size={16} />
              {stored ? "Regenerate" : "Explain with Meta"}
            </Submit>
          </ActionForm>
        ) : null
      }
    >
      {ended ? (
        <p className="text-sm text-zinc-500">Not available: no longer current.</p>
      ) : !allowed ? (
        <p className="text-sm text-zinc-500">The owner did not allow model processing of this lot. The rule results above are complete.</p>
      ) : !meta ? (
        <p className="text-sm text-zinc-500">Meta is not configured. The rule results above are complete.</p>
      ) : !e ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Every sentence must cite a checked fact. Uncited sentences are dropped.</p>
      ) : (
        <div className="space-y-2 text-sm">
          {e.summary.text && (
            <p className="font-medium">
              {e.summary.text}
              <Cite ids={e.summary.fact_ids} />
            </p>
          )}
          {e.supported_facts.length > 0 && (
            <ul className="list-disc pl-5">
              {e.supported_facts.map((x, i) => (
                <li key={i}>
                  {x.text}
                  <Cite ids={x.fact_ids} />
                </li>
              ))}
            </ul>
          )}
          {e.differences_and_unknowns.length > 0 && (
            <ul className="list-disc pl-5 text-amber-900 dark:text-amber-200">
              {e.differences_and_unknowns.map((x, i) => (
                <li key={i}>
                  {x.text}
                  <Cite ids={x.fact_ids} />
                </li>
              ))}
            </ul>
          )}
          {e.next_questions.length > 0 && (
            <ul className="space-y-0.5">
              {e.next_questions.map((q, i) => (
                <li key={i}>
                  <Badge tone="sky">ask {q.to}</Badge> {q.question}
                  <Cite ids={q.fact_ids} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-zinc-500">
            {stored!.model.model_id} · {stored!.model.prompt_version} · {Math.round(stored!.model.latency_ms / 100) / 10} s
            {stored!.dropped.length > 0 && ` · ${stored!.dropped.length} unsupported sentence(s) removed: ${stored!.dropped.map((d) => d.reason).join("; ")}`}
          </p>
        </div>
      )}
    </Card>
  );
}
