import Link from "next/link";
import { Suspense } from "react";
import { listOpportunitiesForActor, listRejectedForActor } from "@/auth/access";
import { Badge, Bar, Empty, Hint, Loading, MARK_LEGEND, Mark, Page, StatusDot, StatusPill, markLabel, type MarkKind } from "@/components/ui";
import { listDemandsOfNetwork } from "@/db/repo";
import { getDb } from "@/db/server";
import type { Check, CheckStatus, CompatibilityStatus } from "@/discovery/constraints";
import { requestNow, requireSession } from "@/lib/session";

export default function OpportunitiesPage(props: PageProps<"/opportunities">) {
  return (
    <Suspense fallback={<Loading />}>
      <Feed searchParams={props.searchParams} />
    </Suspense>
  );
}

const GROUPS: { title: string; hint: string; dot: CompatibilityStatus; statuses: CompatibilityStatus[] }[] = [
  { title: "Worth review", dot: "evidence_supported", hint: "Every hard check passed. Seller claims still need a person to verify.", statuses: ["evidence_supported", "declared_match", "conditional_candidate"] },
  { title: "Engineering review", dot: "engineering_review_required", hint: "Different grade or standard. Never treated as equivalent; an engineer and the buyer must approve.", statuses: ["engineering_review_required"] },
  { title: "Missing info", dot: "insufficient_evidence", hint: "No known failure, but a critical fact is missing. Ask for it first.", statuses: ["insufficient_evidence"] },
];

const SEVERITY: CheckStatus[] = ["fail", "review", "unknown", "conditional", "not_checked", "pass"];

/** The worst outcome among the given checks, shown as one mark per column. */
function worst(checks: Check[], ids: string[]): { kind: MarkKind; title: string } | null {
  const cs = checks.filter((c) => ids.includes(c.id));
  if (cs.length === 0) return null;
  const c = cs.reduce((a, b) => (SEVERITY.indexOf(b.status) < SEVERITY.indexOf(a.status) ? b : a));
  return { kind: c.status === "pass" && c.basis === "seller_claim" ? "claim" : c.status, title: `${c.label}: ${c.detail}` };
}

const COLUMNS: [string, string[]][] = [
  ["Grade", ["grade", "standard", "product_form"]],
  ["Size", ["thickness", "width"]],
  ["Qty", ["quantity"]],
  ["Date", ["available_date"]],
  ["Cert", ["certificates"]],
];

/** The lot's own value, as the rule stated it (e.g. "3 mm within …" → "3 mm"). Unknown → "?". */
function lead(checks: Check[], id: string, cut: RegExp) {
  const c = checks.find((x) => x.id === id);
  if (!c) return "?";
  const head = c.detail.split(cut)[0];
  if (c.status !== "unknown" && c.status !== "not_checked") return head;
  // An unknown can still carry the lot's value (e.g. the buyer's range is open); never an implausible one.
  return /^[\d.]+( t)?$/.test(head) && !c.detail.includes("implausible") ? head : "?";
}

function lotSpec(checks: Check[]) {
  const grade = lead(checks, "grade", / is /);
  const t = lead(checks, "thickness", / mm/);
  const w = lead(checks, "width", / mm/);
  const q = lead(checks, "quantity", / (?:within|covers|is|exceeds)/);
  return { grade, spec: `${t} × ${w} mm · ${q}` };
}

async function Feed({ searchParams }: { searchParams: PageProps<"/opportunities">["searchParams"] }) {
  const sp = await searchParams;
  const demandFilter = typeof sp.demand === "string" ? sp.demand : null;
  const { actor } = await requireSession();
  const db = await getDb();
  const now = await requestNow();
  const [all, demands, rejected] = await Promise.all([listOpportunitiesForActor(db, actor, now), listDemandsOfNetwork(db, actor.network_id), listRejectedForActor(db, actor, now)]);
  const opps = all.filter((o) => !demandFilter || o.demand_id === demandFilter);
  const live = opps.filter((o) => o.status !== "invalidated");
  const invalidated = opps.filter((o) => o.status === "invalidated");
  const rej = rejected.filter((r) => !demandFilter || r.demand_id === demandFilter);
  const liveAll = all.filter((o) => o.status !== "invalidated");
  const chip = (on: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-medium ${on ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`;

  return (
    <Page title="Opportunities">
      <div className="-mt-4 mb-8 flex flex-wrap gap-2">
        <Link href="/opportunities" className={chip(!demandFilter)}>
          All · {liveAll.length}
        </Link>
        {demands.map((d) => (
          <Link key={d.id} href={`/opportunities?demand=${d.id}`} className={chip(demandFilter === d.id)}>
            {d.data.title}
          </Link>
        ))}
      </div>

      {demands.length === 0 && <Empty>No demands yet. Create one to start discovery.</Empty>}

      <div className="space-y-8">
        {GROUPS.map((g) => {
          const items = live.filter((o) => g.statuses.includes(o.compatibility_status as CompatibilityStatus));
          if (items.length === 0) return null;
          return (
            <section key={g.title} className="space-y-3">
              <div className="flex items-center gap-2.5">
                <StatusDot status={g.dot} />
                <h2 className="text-[17px] font-semibold">{g.title}</h2>
                <span className="font-mono text-[13px] text-zinc-500">{items.length}</span>
                <Hint text={g.hint} />
              </div>
              <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      <th className="px-4 py-2.5 font-medium">Lot</th>
                      <th className="px-3 py-2.5 font-medium">From</th>
                      {COLUMNS.map(([label]) => (
                        <th key={label} className="w-14 px-1 py-2.5 text-center font-medium">
                          {label}
                        </th>
                      ))}
                      <th className="px-4 py-2.5 text-right font-medium">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((o) => {
                      const { grade, spec } = lotSpec(o.checks);
                      const s = o.score && o.score.observed !== null ? o.score : null;
                      return (
                        <tr key={o.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
                          <td className="px-4 py-3">
                            <Link href={`/opportunities/${o.id}`} className="block">
                              <span className="flex items-center gap-2 font-semibold">
                                {grade}
                                {o.compatibility_status !== g.dot && <StatusPill status={o.compatibility_status as CompatibilityStatus} />}
                                {o.status !== "discovered" && <Badge tone="violet">{o.status.replaceAll("_", " ")}</Badge>}
                              </span>
                              <span className="font-mono text-[13px] text-zinc-600 dark:text-zinc-400">{spec}</span>
                              {!demandFilter && demands.length > 1 && <span className="block text-xs text-zinc-500">for {o.demand_title}</span>}
                            </Link>
                          </td>
                          <td className="px-3 py-3">{o.novelty === "cross_network" ? <Badge tone="sky">{o.seller_alias}</Badge> : <Badge>Your network</Badge>}</td>
                          {COLUMNS.map(([label, ids]) => {
                            const m = worst(o.checks, ids);
                            return (
                              <td key={label} className="px-1 py-3 text-center">
                                {m ? <Mark kind={m.kind} title={m.title} /> : <span className="text-zinc-400">–</span>}
                              </td>
                            );
                          })}
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-2.5" title={s ? `Range ${s.lower}–${s.upper} · ${Math.round(s.coverage * 100)}% known. Review priority, not a deal probability.` : "Not enough known"}>
                              <span className="w-16">
                                <Bar value={s ? (s.observed ?? 0) / 100 : 0} />
                              </span>
                              <span className="w-10 text-right font-mono">{s ? s.observed : "—"}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

        {live.length === 0 && demands.length > 0 && <Empty>No candidates right now.</Empty>}

        <div className="grid gap-3 md:grid-cols-2">
          <details className="rounded-xl border border-zinc-200 bg-white px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="flex min-h-7 cursor-pointer items-center gap-2.5 text-[15px] font-semibold">
              <StatusDot status="incompatible" />
              Not recommended <span className="font-mono text-[13px] font-medium text-zinc-500">{rej.length}</span>
              <Hint text="A hard requirement fails. Shown for transparency, never as a candidate." />
            </summary>
            <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              {rej.map((r) => (
                <li key={r.id} className="py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.seller_network_id === actor.network_id ? "zinc" : "sky"}>{r.seller_network_id === actor.network_id ? "Your network" : r.seller_alias}</Badge>
                    <span className="text-xs text-zinc-500">{r.demand_title}</span>
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {r.checks
                      .filter((c) => c.status === "fail")
                      .map((c) => (
                        <li key={c.id} className="flex items-start gap-2 text-[13px]">
                          <Mark kind="fail" small />
                          <span>
                            <b className="font-medium">{c.label}</b> <span className="text-zinc-600 dark:text-zinc-400">{c.detail}</span>
                          </span>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
              {rej.length === 0 && <li className="py-2 text-sm text-zinc-500">None.</li>}
            </ul>
          </details>
          <details className="rounded-xl border border-zinc-200 bg-white px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="flex min-h-7 cursor-pointer items-center gap-2.5 text-[15px] font-semibold">
              <span className="size-2.5 rounded-full bg-zinc-400" aria-hidden />
              Invalidated <span className="font-mono text-[13px] font-medium text-zinc-500">{invalidated.length}</span>
              <Hint text="Lot sold or changed, demand changed, or sharing ended. Earlier decisions do not carry over." />
            </summary>
            <ul className="mt-3 space-y-1.5 text-sm">
              {invalidated.map((o) => (
                <li key={o.id}>
                  <Link href={`/opportunities/${o.id}`} className="text-accent hover:underline">
                    {o.demand_title}
                  </Link>{" "}
                  <span className="text-zinc-500">
                    · {o.novelty === "cross_network" ? o.seller_alias : "your network"} · {o.invalidated_reason}
                  </span>
                </li>
              ))}
              {invalidated.length === 0 && <li className="text-zinc-500">None.</li>}
            </ul>
          </details>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-600 dark:text-zinc-400">
          {MARK_LEGEND.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <Mark kind={k} small />
              {markLabel(k)}
            </span>
          ))}
        </div>
      </div>
    </Page>
  );
}
