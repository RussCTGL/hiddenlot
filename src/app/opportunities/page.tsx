import Link from "next/link";
import { Suspense } from "react";
import { listOpportunitiesForActor, listRejectedForActor } from "@/auth/access";
import { Badge, CheckIcon, Empty, Loading, Page, StatusPill } from "@/components/ui";
import { listDemandsOfNetwork } from "@/db/repo";
import { getDb } from "@/db/server";
import type { Check, CompatibilityStatus } from "@/discovery/constraints";
import type { Score } from "@/discovery/score";
import { requireSession } from "@/lib/session";

export default function OpportunitiesPage(props: PageProps<"/opportunities">) {
  return (
    <Suspense fallback={<Loading />}>
      <Feed searchParams={props.searchParams} />
    </Suspense>
  );
}

const GROUPS: { title: string; hint: string; statuses: CompatibilityStatus[] }[] = [
  { title: "Worth human review", hint: "Every hard check passed. Declared matches still rest on seller statements (e.g. certificates) that a person must verify.", statuses: ["evidence_supported", "declared_match", "conditional_candidate"] },
  { title: "Engineering review required", hint: "A different grade from the one the buyer listed. HiddenLot never treats grades as equivalent; an engineer and the buyer must approve.", statuses: ["engineering_review_required"] },
  { title: "Needs evidence", hint: "No known failure, but a critical fact is missing. Ask for it before treating this as a candidate.", statuses: ["insufficient_evidence"] },
];

function ScoreLine({ score }: { score: Score | null }) {
  if (!score || score.observed === null) return <span className="text-xs text-zinc-500">Priority: not enough known</span>;
  return (
    <span className="text-xs text-zinc-600 dark:text-zinc-400" title="Review priority, not a probability of a deal or of material conformity">
      Priority {score.observed} on known parts · range {score.lower}–{score.upper} · coverage {Math.round(score.coverage * 100)}%
    </span>
  );
}

const pick = (checks: Check[], id: string) => checks.find((c) => c.id === id);

async function Feed({ searchParams }: { searchParams: PageProps<"/opportunities">["searchParams"] }) {
  const sp = await searchParams;
  const demandFilter = typeof sp.demand === "string" ? sp.demand : null;
  const { actor, network } = await requireSession();
  const db = await getDb();
  const now = new Date();
  const [all, demands, rejected] = await Promise.all([listOpportunitiesForActor(db, actor, now), listDemandsOfNetwork(db, actor.network_id), listRejectedForActor(db, actor, now)]);
  const opps = all.filter((o) => !demandFilter || o.demand_id === demandFilter);
  const live = opps.filter((o) => o.status !== "invalidated");
  const invalidated = opps.filter((o) => o.status === "invalidated");
  const rej = rejected.filter((r) => !demandFilter || r.demand_id === demandFilter);

  return (
    <Page
      title="Opportunities"
      subtitle={`Candidates for ${network.alias}'s active demands, from your own stock and from networks that shared with you. Found automatically when stock or demands change.`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500">Demand:</span>
        <Link href="/opportunities" className={`rounded-full px-2.5 py-0.5 ring-1 ring-zinc-300 dark:ring-zinc-700 ${!demandFilter ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""}`}>
          All
        </Link>
        {demands.map((d) => (
          <Link key={d.id} href={`/opportunities?demand=${d.id}`} className={`rounded-full px-2.5 py-0.5 ring-1 ring-zinc-300 dark:ring-zinc-700 ${demandFilter === d.id ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""}`}>
            {d.data.title}
          </Link>
        ))}
      </div>

      {demands.length === 0 && <Empty>Your network has no demands. Create one to start discovery.</Empty>}

      <div className="space-y-6">
        {GROUPS.map((g) => {
          const items = live.filter((o) => g.statuses.includes(o.compatibility_status as CompatibilityStatus));
          return (
            <section key={g.title}>
              <h2 className="text-base font-semibold">
                {g.title} <span className="text-zinc-400">({items.length})</span>
              </h2>
              <p className="mb-2 text-xs text-zinc-500">{g.hint}</p>
              {items.length === 0 ? (
                <Empty>None</Empty>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {items.map((o) => {
                    const grade = pick(o.checks, "grade");
                    const open = o.checks.filter((c) => c.status === "unknown" || c.status === "review" || c.status === "conditional");
                    return (
                      <Link key={o.id} href={`/opportunities/${o.id}`} className="block rounded-lg border border-zinc-200 bg-white p-4 shadow-sm hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <StatusPill status={o.compatibility_status as CompatibilityStatus} />
                          {o.novelty === "cross_network" ? <Badge tone="sky">From {o.seller_alias} · shared</Badge> : <Badge>Your network</Badge>}
                          {o.status !== "discovered" && <Badge tone="violet">{o.status.replaceAll("_", " ")}</Badge>}
                        </div>
                        <p className="text-sm font-medium">{o.demand_title}</p>
                        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{grade?.detail}</p>
                        <ul className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                          {["thickness", "width", "quantity"].map((id) => {
                            const c = pick(o.checks, id);
                            return c ? (
                              <li key={id}>
                                <CheckIcon status={c.status} /> {c.detail}
                              </li>
                            ) : null;
                          })}
                        </ul>
                        {open.length > 0 && (
                          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                            Open: {open.map((c) => c.label.toLowerCase()).join(", ")}
                          </p>
                        )}
                        <div className="mt-2">
                          <ScoreLine score={o.score} />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer text-base font-semibold">
            Not recommended <span className="text-zinc-400">({rej.length})</span>
            <span className="ml-2 text-xs font-normal text-zinc-500">At least one hard requirement fails. Kept for transparency; never shown as a candidate.</span>
          </summary>
          <div className="mt-3 space-y-2">
            {rej.map((r) => (
              <div key={r.id} className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status="incompatible" />
                  <Badge tone={r.seller_network_id === actor.network_id ? "zinc" : "sky"}>{r.seller_network_id === actor.network_id ? "Your network" : `From ${r.seller_alias}`}</Badge>
                  <span className="text-xs text-zinc-500">{r.demand_title}</span>
                </div>
                <ul className="mt-1 text-xs">
                  {r.checks
                    .filter((c) => c.status === "fail")
                    .map((c) => (
                      <li key={c.id}>
                        <CheckIcon status="fail" /> <b>{c.label}:</b> {c.detail}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
            {rej.length === 0 && <p className="text-sm text-zinc-500">None.</p>}
          </div>
        </details>

        {invalidated.length > 0 && (
          <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="cursor-pointer text-base font-semibold">
              Invalidated <span className="text-zinc-400">({invalidated.length})</span>
              <span className="ml-2 text-xs font-normal text-zinc-500">The lot, demand or sharing changed after assessment. Earlier decisions do not carry over.</span>
            </summary>
            <ul className="mt-3 space-y-1 text-sm">
              {invalidated.map((o) => (
                <li key={o.id}>
                  <Link href={`/opportunities/${o.id}`} className="underline">
                    {o.demand_title}
                  </Link>{" "}
                  · {o.novelty === "cross_network" ? o.seller_alias : "your network"} · <span className="text-zinc-500">{o.invalidated_reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Page>
  );
}
