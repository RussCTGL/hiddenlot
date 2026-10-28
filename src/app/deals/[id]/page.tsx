import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { acceptSuggestionsAction, closeDealAction, moveDealAction, recordQuoteAction } from "@/app/actions";
import { NotFoundError } from "@/auth/access";
import { Draft } from "@/components/draft";
import { ActionForm, Submit } from "@/components/forms";
import { BackIcon } from "@/components/icons";
import { Card, Loading, Page, buttonCls, inputCls, primaryCls } from "@/components/ui";
import { getDb } from "@/db/server";
import { REVIEWABLE } from "@/discovery/constraints";
import type { InventoryLot, InventoryLotField } from "@/domain/hrc";
import { requestNow, requireSession } from "@/lib/session";
import { dealDraft, fmtDay, getDealViewForActor, OPEN_STAGES, STAGE_LABEL, type DealStage, type DealView } from "@/workflow/deals";

export default function DealPage(props: PageProps<"/deals/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Detail params={props.params} />
    </Suspense>
  );
}

const STEPS: { stage: DealStage; label: string; kinds: string[] }[] = [
  { stage: "waiting", label: "Asked / shortlisted", kinds: ["waiting", "quote_requested"] },
  { stage: "quote_requested", label: "Quote requested", kinds: ["quote_requested"] },
  { stage: "quote_in_hand", label: "Quote in hand", kinds: ["quote"] },
  { stage: "negotiating", label: "Negotiating", kinds: ["negotiating"] },
  { stage: "won", label: "Closed", kinds: ["closed"] },
];
const ORDER: DealStage[] = ["waiting", "quote_requested", "quote_in_hand", "negotiating", "won"];
const rank = (s: DealStage) => ORDER.indexOf(s === "lost" ? "won" : s);

function shared<T>(lot: InventoryLot | null, f: InventoryLotField): T | null {
  if (!lot) return null;
  const o = lot.fields[f];
  return o.status === "not_stated" || o.status === "unresolved" ? null : (o.normalized_value as T | null);
}

async function Detail({ params }: { params: PageProps<"/deals/[id]">["params"] }) {
  const { id } = await params;
  const { actor } = await requireSession();
  let v: DealView;
  try {
    v = await getDealViewForActor(await getDb(), actor, id, await requestNow());
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const d = v.deal;
  const open = OPEN_STAGES.includes(d.stage);
  const draft = open ? dealDraft(v) : null;
  const reviewable = v.compatibility !== null && REVIEWABLE.includes(v.compatibility);
  const firstOf = (kinds: string[]) => [...v.events].reverse().find((e) => kinds.includes(e.kind));

  return (
    <Page
      back={
        <Link href="/deals" className="inline-flex min-h-8 items-center gap-1.5 text-sm text-accent hover:underline">
          <BackIcon size={16} />
          Deals
        </Link>
      }
      title={v.title}
      subtitle={v.ref}
      actions={
        <span className={`rounded-full px-3 py-1 text-sm font-medium ${d.stage === "won" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : d.stage === "lost" ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200" : "bg-accent-soft text-accent"}`}>
          {STAGE_LABEL[d.stage]}
        </span>
      }
    >
      <ol aria-label="Deal stage" className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {STEPS.map((s) => {
          const done = rank(d.stage) > rank(s.stage) || (!open && s.stage === "won");
          const current = open && rank(d.stage) === rank(s.stage);
          const ev = firstOf(s.kinds);
          return (
            <li key={s.stage} aria-current={current ? "step" : undefined} className="flex flex-col gap-1.5">
              <span className={`h-1 rounded-full ${done ? "bg-zinc-900 dark:bg-zinc-100" : current ? "bg-accent" : "bg-zinc-200 dark:bg-zinc-800"}`} />
              <span className={`text-[13px] ${current ? "font-semibold text-accent" : done ? "font-semibold" : "text-zinc-500"}`}>{s.stage === "won" && !open ? STAGE_LABEL[d.stage] : s.label}</span>
              <span className="text-xs text-zinc-500">{ev && (done || current) ? ev.created_at.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : current ? "now" : ""}</span>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {!open && (
            <Card>
              <p className="text-sm">
                <b className="font-semibold">{STAGE_LABEL[d.stage]}:</b> {d.closed_reason}
              </p>
            </Card>
          )}

          {v.risk && (
            <section className="space-y-3.5 rounded-xl border border-rose-600 bg-white px-6 py-5 dark:bg-zinc-900">
              <h2 className="flex items-center gap-2.5 text-base font-semibold">
                <span className="size-2.5 rounded-full bg-rose-600" aria-hidden />
                {v.risk.badge}
              </h2>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{v.risk.reason}</p>
              {v.risk.draft && <Draft text={v.risk.draft} />}
              <ActionForm action={acceptSuggestionsAction}>
                <input type="hidden" name="key" value={`deal:${d.id}:${v.risk.action}`} />
                <Submit className={primaryCls} pending="Saving…">
                  {v.risk.label.charAt(0).toUpperCase() + v.risk.label.slice(1)}
                </Submit>
              </ActionForm>
            </section>
          )}

          {open && d.stage === "waiting" && (
            <Card title="Waiting for an answer">
              <div className="space-y-3.5">
                <p className="text-sm">{d.ask}</p>
                {draft && !v.risk?.draft && <Draft text={draft} />}
                <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
                  When the owner updates the lot, the rules check it again. {reviewable ? "Every hard requirement passes now." : "A quote can be requested once every hard requirement passes."}
                </p>
                <ActionForm action={moveDealAction}>
                  <input type="hidden" name="deal_id" value={d.id} />
                  <input type="hidden" name="to" value="quote_requested" />
                  <Submit className={buttonCls} disabled={!reviewable} title={reviewable ? undefined : "Open requirements first"}>
                    Request a quote
                  </Submit>
                </ActionForm>
              </div>
            </Card>
          )}

          {open && d.stage !== "waiting" && (
            <Card title={d.quote ? "Update the seller's offer" : "Record the seller's offer"}>
              {d.stage === "quote_requested" && draft && !v.risk?.draft && (
                <div className="mb-4">
                  <Draft text={draft} />
                </div>
              )}
              <ActionForm action={recordQuoteAction} className="space-y-4">
                <input type="hidden" name="deal_id" value={d.id} />
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                    <span>Price per MT</span>
                    <input name="price" inputMode="decimal" defaultValue={d.quote?.price ?? shared<string>(v.lot, "price_amount") ?? ""} className={inputCls} required />
                  </label>
                  <label className="space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                    <span>Currency</span>
                    <input name="currency" defaultValue={d.quote?.currency ?? shared<string>(v.lot, "price_currency") ?? "USD"} className={inputCls} />
                  </label>
                  <label className="space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                    <span>Incoterm and place</span>
                    <input name="incoterm" defaultValue={d.quote?.incoterm ?? [shared<string>(v.lot, "incoterm"), shared<string>(v.lot, "incoterm_place")].filter(Boolean).join(" ")} className={inputCls} />
                  </label>
                  <label className="space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                    <span>Valid until</span>
                    <input name="valid_until" type="date" defaultValue={d.quote?.valid_until ?? ""} className={inputCls} />
                  </label>
                </div>
                <label className="block max-w-40 space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                  <span>Quantity, t</span>
                  <input name="quantity_t" inputMode="decimal" defaultValue={d.quote?.quantity_t ?? ""} className={inputCls} />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {v.budgetNote && <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{v.budgetNote}</span>}
                  <Submit className={primaryCls} pending="Saving…">
                    Save offer
                  </Submit>
                </div>
              </ActionForm>
              {d.stage === "quote_in_hand" && (
                <ActionForm action={moveDealAction} className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                  <input type="hidden" name="deal_id" value={d.id} />
                  <input type="hidden" name="to" value="negotiating" />
                  <Submit className={buttonCls}>Start negotiating</Submit>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="History">
            <ol>
              {v.events.map((e, i) => (
                <li key={i} className="grid grid-cols-[96px_1fr] gap-4 border-b border-zinc-100 py-3 text-sm last:border-0 dark:border-zinc-800">
                  <time className="pt-0.5 text-xs text-zinc-500">{e.created_at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                  <span>
                    {e.note}
                    {e.actor_id === null && <span className="text-zinc-500"> · automatic</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="space-y-5">
          <Card title="Watching">
            <dl>
              {v.watch.map((w) => (
                <div key={w.label} className="flex items-center justify-between gap-3 border-b border-zinc-100 py-2.5 text-sm last:border-0 dark:border-zinc-800">
                  <dt>{w.label}</dt>
                  <dd className={`flex items-center gap-1.5 ${w.tone === "warn" ? "font-medium text-rose-800 dark:text-rose-300" : ""}`}>
                    <span className={`size-2 rounded-full ${w.tone === "ok" ? "bg-emerald-600" : w.tone === "warn" ? "bg-rose-600" : "bg-zinc-400"}`} aria-hidden />
                    {w.value}
                  </dd>
                </div>
              ))}
            </dl>
            {v.view && (
              <Link href={`/opportunities/${v.view.opportunity.id}`} className="mt-3 inline-block text-sm text-accent hover:underline">
                See every check
              </Link>
            )}
          </Card>

          <Card title="Terms so far">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {d.quote && (
                <>
                  <dt className="text-zinc-500">Offer</dt>
                  <dd className="text-right font-mono">
                    {d.quote.currency} {d.quote.price}/MT
                  </dd>
                </>
              )}
              {shared<string>(v.lot, "price_amount") && (
                <>
                  <dt className="text-zinc-500">Listed price</dt>
                  <dd className="text-right font-mono">
                    {shared<string>(v.lot, "price_currency")} {shared<string>(v.lot, "price_amount")}/MT
                  </dd>
                </>
              )}
              {v.demand.budget && (
                <>
                  <dt className="text-zinc-500">Your budget</dt>
                  <dd className="text-right font-mono">
                    {v.demand.budget.currency} {v.demand.budget.amount}/MT
                  </dd>
                </>
              )}
              {shared<string>(v.lot, "incoterm") && (
                <>
                  <dt className="text-zinc-500">Delivery</dt>
                  <dd className="text-right">{[shared<string>(v.lot, "incoterm"), shared<string>(v.lot, "incoterm_place")].filter(Boolean).join(" ")}</dd>
                </>
              )}
              {shared<string>(v.lot, "available_from") && (
                <>
                  <dt className="text-zinc-500">Ready</dt>
                  <dd className="text-right">{fmtDay(shared<string>(v.lot, "available_from")!)}</dd>
                </>
              )}
              {v.demand.need_by && (
                <>
                  <dt className="text-zinc-500">Need by</dt>
                  <dd className="text-right">{fmtDay(v.demand.need_by)}</dd>
                </>
              )}
              {v.view?.checks.find((c) => c.id === "certificates" && v.demand.must_have_certificates.length > 0) && (
                <>
                  <dt className="text-zinc-500">{v.demand.must_have_certificates.join(", ")}</dt>
                  <dd className="text-right">{v.view.checks.find((c) => c.id === "certificates")?.basis === "seller_claim" ? "Seller's claim" : v.view.checks.find((c) => c.id === "certificates")?.status === "pass" ? "Stated" : "Not stated"}</dd>
                </>
              )}
            </dl>
          </Card>

          {open && (
            <Card title="Close the deal">
              <ActionForm action={closeDealAction} className="space-y-3">
                <input type="hidden" name="deal_id" value={d.id} />
                <label className="block space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                  <span>Reason</span>
                  <input name="reason" required placeholder="e.g. Agreed at USD 540 CFR" className={inputCls} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Submit name="outcome" value="won" className={buttonCls} disabled={!d.quote || !reviewable} title={!d.quote ? "Record the seller's offer first" : undefined}>
                    Close as won
                  </Submit>
                  <Submit name="outcome" value="lost" className={buttonCls}>
                    Close as lost
                  </Submit>
                </div>
              </ActionForm>
            </Card>
          )}
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">If the lot is sold or sharing ends, this deal closes as lost on its own.</p>
        </aside>
      </div>
    </Page>
  );
}
