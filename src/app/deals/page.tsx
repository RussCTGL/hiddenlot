import Link from "next/link";
import { Suspense } from "react";
import { EyeIcon } from "@/components/icons";
import { Empty, Loading, Page } from "@/components/ui";
import { getDb } from "@/db/server";
import { requestNow, requireSession } from "@/lib/session";
import { fmtDay, isoDay, listDealsForActor, OPEN_STAGES, STAGE_LABEL, type DealCard, type DealStage } from "@/workflow/deals";

export default function DealsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Board />
    </Suspense>
  );
}

const COLUMNS: { title: string; stages: DealStage[]; empty: string }[] = [
  { title: STAGE_LABEL.waiting, stages: ["waiting"], empty: "Questions you asked show up here." },
  { title: STAGE_LABEL.quote_requested, stages: ["quote_requested"], empty: "Shortlisted lots wait here for an offer." },
  { title: STAGE_LABEL.quote_in_hand, stages: ["quote_in_hand"], empty: "Record a seller's offer and it moves here." },
  { title: STAGE_LABEL.negotiating, stages: ["negotiating"], empty: "Nothing here yet." },
  { title: "Closed", stages: ["won", "lost"], empty: "Won or lost, with the reason." },
];

const WATCHED: [string, boolean][] = [
  ["Stock older than 48 h", true],
  ["No reply by the follow-up date", true],
  ["Offer past its validity", true],
  ["Lot or demand changed", true],
  ["Lot sold → closed as lost", false],
  ["Sharing ended → closed as lost", false],
];

async function Board() {
  const { actor } = await requireSession();
  const now = await requestNow();
  const cards = await listDealsForActor(await getDb(), actor, now);
  const open = cards.filter((c) => OPEN_STAGES.includes(c.deal.stage));
  const flagged = open.filter((c) => c.risk).length;
  const today = isoDay(now);
  const due = open.filter((c) => c.deal.follow_up_on !== null && c.deal.follow_up_on <= today).length;

  return (
    <Page title="Deals" subtitle={`${open.length} open · ${flagged} need${flagged === 1 ? "s" : ""} attention · ${due} due today`}>
      {cards.length === 0 && (
        <div className="mb-6">
          <Empty>
            No deals yet. Accept a suggestion on{" "}
            <Link href="/" className="text-accent hover:underline">
              Today
            </Link>{" "}
            or shortlist an opportunity to start tracking it.
          </Empty>
        </div>
      )}
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[1060px] grid-cols-5 gap-3.5">
          {COLUMNS.map((col, i) => {
            const items = cards.filter((c) => col.stages.includes(c.deal.stage));
            return (
              <section key={col.title} className="flex flex-col gap-2.5">
                <div className={`flex items-center justify-between border-b-2 px-1 pb-1.5 ${i === 1 ? "border-zinc-900 dark:border-zinc-200" : "border-zinc-300 dark:border-zinc-700"}`}>
                  <h2 className="text-sm font-semibold">{col.title}</h2>
                  <span className="font-mono text-[13px] text-zinc-500">{items.length}</span>
                </div>
                {items.map((c) => (
                  <Card key={c.deal.id} c={c} />
                ))}
                {items.length === 0 && <p className="px-1 py-3 text-[13px] text-zinc-400 dark:text-zinc-500">{col.empty}</p>}
              </section>
            );
          })}
        </div>
      </div>

      <section className="mt-8 space-y-3.5 rounded-xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="flex items-center gap-2.5 text-base font-semibold">
          <span className="text-accent">
            <EyeIcon size={18} />
          </span>
          Watched every day
        </h2>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {WATCHED.map(([text, risk]) => (
            <span key={text} className="flex items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-300">
              <span className={`size-2 rounded-full ${risk ? "bg-rose-600" : "bg-zinc-400"}`} aria-hidden />
              {text}
            </span>
          ))}
        </div>
        <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Anything flagged shows up on Today with a suggested next step.</p>
      </section>
    </Page>
  );
}

function Card({ c }: { c: DealCard }) {
  const d = c.deal;
  const closed = d.stage === "won" || d.stage === "lost";
  return (
    <Link
      href={`/deals/${d.id}`}
      className={`flex flex-col gap-2 rounded-[10px] border bg-white p-3.5 hover:border-zinc-400 dark:bg-zinc-900 dark:hover:border-zinc-500 ${c.risk ? "border-zinc-900 dark:border-zinc-300" : "border-zinc-200 dark:border-zinc-800"}`}
    >
      <span className="text-[15px] font-semibold">{c.title}</span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{c.ref}</span>
      {closed && (
        <span className={`self-start rounded-md px-2 py-0.5 text-xs font-medium ${d.stage === "won" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
          {STAGE_LABEL[d.stage]}
        </span>
      )}
      {c.risk && (
        <span className="inline-flex items-center gap-1.5 self-start rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <span className="size-2 rounded-full bg-rose-600" aria-hidden />
          {c.risk.badge}
        </span>
      )}
      <span className="line-clamp-3 text-[13px] text-zinc-700 dark:text-zinc-300" title={c.next}>{c.next}</span>
      {!closed && d.follow_up_on && <span className="text-xs text-zinc-500 dark:text-zinc-400">Follow up {fmtDay(d.follow_up_on)}</span>}
    </Link>
  );
}
