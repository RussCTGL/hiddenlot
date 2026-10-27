import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { decideAction, explainAction } from "@/app/actions";
import { getOpportunityForActor, NotFoundError } from "@/auth/access";
import { FieldTable, FIELD_LABEL } from "@/components/fields";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, buttonCls, Card, CheckIcon, inputCls, Loading, Page, primaryCls, StatusPill } from "@/components/ui";
import { getDb } from "@/db/server";
import { REVIEWABLE, type Check } from "@/discovery/constraints";
import { listDecisions } from "@/workflow/actions";
import { requireSession } from "@/lib/session";
import { metaAvailable } from "@/lib/meta";
import type { StoredExplanation } from "@/workflow/explain";

export default function OpportunityPage(props: PageProps<"/opportunities/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Detail params={props.params} />
    </Suspense>
  );
}

const ASK: Record<string, string> = { seller: "Seller", buyer: "Buyer (you)", engineering: "Engineering / QA", system: "HiddenLot" };
const BASIS: Record<string, string> = {
  reviewed: "confirmed by the lot owner, not independently verified",
  source_evidence: "from source, not yet reviewed",
  seller_claim: "seller claim, not verified",
  grade_only: "grade only; no standard required",
  not_required: "not required by buyer; not stated",
  system: "",
};

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2 py-1.5 text-sm">
          <CheckIcon status={c.status} />
          <div>
            <span className="font-medium">{c.label}</span> <span className="text-zinc-600 dark:text-zinc-400">— {c.detail}</span>
            {c.basis && BASIS[c.basis] && <span className="ml-1 text-xs text-zinc-500">({BASIS[c.basis]})</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

async function Detail({ params }: { params: PageProps<"/opportunities/[id]">["params"] }) {
  const { id } = await params;
  const { actor } = await requireSession();
  const db = await getDb();
  let view;
  try {
    view = await getOpportunityForActor(db, actor, id, new Date());
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const decisions = await listDecisions(db, actor, id);
  const { opportunity: o, demand, lot, checks, score } = view;
  const passed = checks.filter((c) => c.status === "pass" && c.id !== "access");
  const open = checks.filter((c) => ["unknown", "review", "conditional", "not_checked"].includes(c.status));
  const failed = checks.filter((c) => c.status === "fail");
  const nextSteps = open.filter((c) => c.ask);
  const invalid = o.status === "invalidated";
  const canShortlist = REVIEWABLE.includes(view.compatibility_status);

  return (
    <Page
      title={demand.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill status={view.compatibility_status} />
          {o.novelty === "cross_network" ? <Badge tone="sky">Cross-network · {view.seller_label}</Badge> : <Badge>{view.seller_label}</Badge>}
          <Badge tone={invalid ? "rose" : "zinc"}>{o.status.replaceAll("_", " ")}</Badge>
        </span>
      }
      actions={<Link href="/opportunities" className="text-sm underline">← All opportunities</Link>}
    >
      {invalid && (
        <div className="mb-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <b>Invalidated:</b> {o.invalidated_reason}. Decisions made earlier do not carry over to a new assessment.
        </div>
      )}
      {view.access_note && !invalid && <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{view.access_note}</div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ExplanationCard
            oppId={o.id}
            stored={(o.explanation as StoredExplanation | null)?.assessment_id === o.assessment_id ? (o.explanation as StoredExplanation) : null}
            allowed={view.model_processing_allowed && !invalid}
            ended={invalid || !lot}
            meta={metaAvailable()}
          />

          <Card title="Why this was found">
            <p className="text-sm">
              {o.novelty === "cross_network"
                ? `This stock is held in another network. ${view.seller_label.split(" (")[0]} shared it for discovery with your network, so HiddenLot matched it against your demand as soon as it was published. Your own network's stock would not have shown it.`
                : "This stock is in your own network and was matched when it or your demand last changed."}
            </p>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              It also had to be readable: the seller wrote the offer in their own format (free text, a spreadsheet or a PDF, often mixed Chinese and English). HiddenLot turned it into comparable fields with cited sources before any rule ran, so a keyword search for your spec would not necessarily have found it.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Lot: {lot?.fields.seller_lot_ref.normalized_value ? String(lot.fields.seller_lot_ref.normalized_value) : "seller's reference not shared"} · HiddenLot ID {o.lot_id}
            </p>
          </Card>

          {failed.length > 0 && (
            <Card title="Hard requirements that fail">
              <CheckList checks={failed} />
            </Card>
          )}
          <Card title="What is satisfied">
            {passed.length ? <CheckList checks={passed} /> : <p className="text-sm text-zinc-500">Nothing confirmed yet.</p>}
          </Card>
          <Card title="Still open">
            {open.length ? <CheckList checks={open} /> : <p className="text-sm text-zinc-500">No open requirements.</p>}
          </Card>

          <Card title={lot ? "Lot as shared with you" : "Lot details"}>
            {lot ? (
              <>
                <FieldTable lot={lot} />
                {o.novelty === "cross_network" && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Values are what the seller shared. Quotes and file locations stay in the seller&apos;s private document; fields they did not share show as Unknown.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-zinc-500">Hidden: you no longer have access to this lot.</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Review priority">
            {score && score.observed !== null ? (
              <>
                <p className="text-2xl font-semibold">
                  {score.lower}–{score.upper}
                </p>
                <p className="text-xs text-zinc-500">
                  {score.observed} on the {Math.round(score.coverage * 100)}% that is known. A priority for human review — not a probability of a deal, of quality, or of credit.
                </p>
                <ul className="mt-3 space-y-1 text-xs">
                  {Object.entries(score.components).map(([k, c]) => (
                    <li key={k}>
                      <span className="font-medium capitalize">{k}</span>: {c.value === null ? <span className="text-amber-700 dark:text-amber-400">unknown</span> : c.value.toFixed(2)} <span className="text-zinc-500">— {c.note}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-500">Freight, insurance, duty and FX: not included and not estimated.</p>
                <p className="mt-1 text-xs">
                  Commercial:{" "}
                  {score.commercial === "within_budget" ? "goods price within budget on the same basis (freight, duty and FX not included)" : score.commercial === "over_budget" ? "goods price above budget" : "unknown — not on a comparable basis"}
                </p>
              </>
            ) : (
              <p className="text-sm text-zinc-500">Not available.</p>
            )}
          </Card>

          <Card title="Next steps">
            {nextSteps.length ? (
              <ul className="space-y-1.5 text-sm">
                {nextSteps.map((c) => (
                  <li key={c.id}>
                    <b>{ASK[c.ask!]}</b>: {c.label.toLowerCase()} — <span className="text-zinc-600 dark:text-zinc-400">{c.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No open questions. A person still decides whether to enquire.</p>
            )}
            <p className="mt-2 text-xs text-zinc-500">HiddenLot sends no messages and reserves no stock. &ldquo;Request information&rdquo; records an internal to-do.</p>
          </Card>

          {!invalid && lot && view.compatibility_status !== "incompatible" && (
            <Card title="Your decision">
              <ActionForm action={decideAction} className="space-y-2">
                <input type="hidden" name="opportunity_id" value={o.id} />
                <select name="decision" className={inputCls} defaultValue={canShortlist ? "shortlisted" : "information_requested"}>
                  <option value="under_review">Under review</option>
                  <option value="information_requested">Request information</option>
                  <option value="shortlisted" disabled={!canShortlist}>
                    Shortlist (worth enquiring){canShortlist ? "" : " — not available for this status"}
                  </option>
                  <option value="dismissed">Dismiss</option>
                </select>
                <textarea name="reason" required placeholder="Reason (required, saved with the versions you saw)" className={inputCls} rows={2} />
                <Submit className={primaryCls}>Save decision</Submit>
              </ActionForm>
            </Card>
          )}

          <Card title="History">
            {decisions.length === 0 ? (
              <p className="text-sm text-zinc-500">No decisions yet.</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {decisions.map((d) => (
                  <li key={d.id}>
                    <b>{d.decision.replaceAll("_", " ")}</b> by {d.actor_id} · {new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC
                    <div className="text-zinc-600 dark:text-zinc-400">{d.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Buyer requirements">
            <ul className="space-y-0.5 text-xs text-zinc-700 dark:text-zinc-300">
              <li>Grades: {demand.accepted_grades.map((g) => [g.grade, g.standard_id, g.edition].filter(Boolean).join(" ")).join(" / ")} ({demand.substitution_policy === "forbidden" ? "no substitution" : "other grades only after engineering review"})</li>
              <li>
                Size: {demand.thickness_mm.min ?? "?"}–{demand.thickness_mm.max ?? "?"} × {demand.width_mm.min ?? "?"}–{demand.width_mm.max ?? "?"} mm
              </li>
              <li>
                Quantity: {demand.quantity_kg.min / 1000}–{demand.quantity_kg.max / 1000} t{demand.allow_partial_delivery ? ", partial OK" : ""}
              </li>
              <li>Condition: {demand.acceptable_conditions.join(", ")}</li>
              <li>{FIELD_LABEL.certificate_claims.replace(" (seller says)", "")}: {demand.must_have_certificates.join(", ") || "none required"}</li>
              <li>Need by: {demand.need_by ?? "no date"}</li>
              <li>Budget: {demand.budget ? `${demand.budget.currency} ${demand.budget.amount}/MT ${demand.budget.incoterm} ${demand.budget.place}` : "none set"}</li>
            </ul>
          </Card>
        </div>
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
      title="Explanation · Meta Muse Spark"
      aside={
        allowed && meta ? (
          <ActionForm action={explainAction}>
            <input type="hidden" name="opportunity_id" value={oppId} />
            <Submit className={buttonCls} pending="Asking Meta…">
              {stored ? "Regenerate" : "Explain with Meta"}
            </Submit>
          </ActionForm>
        ) : null
      }
    >
      {ended ? (
        <p className="text-sm text-zinc-500">Not available: this opportunity is no longer current.</p>
      ) : !allowed ? (
        <p className="text-sm text-zinc-500">The lot owner has not allowed model processing of this lot for your network, so only the rule-based explanation below is shown.</p>
      ) : !meta ? (
        <p className="text-sm text-zinc-500">Meta is not configured on this server; the rule-based explanation below is complete on its own.</p>
      ) : !e ? (
        <p className="text-sm text-zinc-500">Meta can rephrase the rule results for a trader. Every sentence must cite the facts below it; anything unsupported is removed automatically.</p>
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
