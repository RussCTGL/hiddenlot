import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { resetDemo, rerunDiscovery } from "@/app/actions";
import { listOpportunitiesForActor } from "@/auth/access";
import { Submit } from "@/components/forms";
import { CiteIcon, RefreshIcon, SearchIcon, ShareIcon, ShieldIcon, UploadIcon } from "@/components/icons";
import { ButtonLink, Card, Label, Loading, Page, SHORT_STATUS, STATUS_DOT, StatusDot, buttonCls, primaryCls } from "@/components/ui";
import { listDemandsOfNetwork, listLotsOfNetwork } from "@/db/repo";
import { getDb } from "@/db/server";
import type { CompatibilityStatus } from "@/discovery/constraints";
import { GROUP_ORDER } from "@/discovery/engine";
import { demoLoaded, getSession, requestNow } from "@/lib/session";
import { demoControlsAllowed } from "@/lib/demo";
import { metaAvailable } from "@/lib/meta";

export default function About() {
  return (
    <Suspense fallback={<Loading />}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  const session = await getSession();
  if (!session) {
    if (await demoLoaded()) redirect("/login");
    return (
      <Page title="HiddenLot" subtitle="No demo data loaded yet.">
        <Card>
          <p className="mb-3 text-sm">Load the synthetic demo to start.</p>
          <form action={resetDemo}>
            <Submit className={primaryCls} pending="Loading demo…">
              Load demo data
            </Submit>
          </form>
        </Card>
      </Page>
    );
  }
  const db = await getDb();
  const { actor, network } = session;
  const [lots, demands, opps] = await Promise.all([
    listLotsOfNetwork(db, actor.network_id),
    listDemandsOfNetwork(db, actor.network_id),
    listOpportunitiesForActor(db, actor, await requestNow()),
  ]);
  const live = opps.filter((o) => o.status !== "invalidated");
  const byGroup = new Map<CompatibilityStatus, number>();
  for (const o of live) byGroup.set(o.compatibility_status as CompatibilityStatus, (byGroup.get(o.compatibility_status as CompatibilityStatus) ?? 0) + 1);
  const cross = live.filter((o) => o.novelty === "cross_network").length;

  const toReview = lots.filter((l) => l.status === "needs_review").length;
  const groups = GROUP_ORDER.filter((g) => byGroup.get(g));

  return (
    <Page
      title="How it works"
      subtitle={`${network.alias} · ${network.name.replace(/\s*\(fictional\)/, "")}`}
      actions={
        <>
          <form action={rerunDiscovery}>
            <Submit className={buttonCls} pending="Running…">
              <RefreshIcon size={16} />
              Re-run discovery
            </Submit>
          </form>
          {demoControlsAllowed() && (
            <form action={resetDemo}>
              <Submit className={buttonCls} pending="Resetting…">
                Reset demo
              </Submit>
            </form>
          )}
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Tile label="Your stock" value={lots.filter((l) => l.status === "published").length} unit={toReview ? `live · ${toReview} to review` : "live"}>
          <ButtonLink href="/inventory">Inventory</ButtonLink>
          <ButtonLink href="/intake">Add stock</ButtonLink>
        </Tile>
        <Tile label="Your demands" value={demands.filter((d) => d.status === "active").length} unit="active">
          <ButtonLink href="/demands">Demands</ButtonLink>
          <ButtonLink href="/demands/new">New demand</ButtonLink>
        </Tile>
        <Tile label="Opportunities" value={live.length} unit={cross ? `${cross} from other networks` : undefined} strong>
          {groups.length > 0 && (
            <div className="w-full space-y-2">
              <div role="img" aria-label={groups.map((g) => `${byGroup.get(g)} ${SHORT_STATUS[g]}`).join(", ")} className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                {groups.map((g) => (
                  <span key={g} className={STATUS_DOT[g]} style={{ flex: byGroup.get(g) }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                {groups.map((g) => (
                  <span key={g} className="flex items-center gap-1.5">
                    <StatusDot status={g} className="size-2" />
                    {SHORT_STATUS[g]} {byGroup.get(g)}
                  </span>
                ))}
              </div>
            </div>
          )}
          <ButtonLink href="/opportunities" primary>
            Review opportunities
          </ButtonLink>
        </Tile>
      </div>

      <section className="mt-10 space-y-5">
        <Label>How it works</Label>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {STEPS.map(([Icon, title, line]) => (
            <div key={title} className="space-y-2.5">
              <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon />
              </span>
              <p className="text-[15px] font-semibold">{title}</p>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{line}</p>
            </div>
          ))}
        </div>
      </section>

      <details className="mt-10 rounded-xl border border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900" open>
        <summary className="flex min-h-7 cursor-pointer items-center text-[15px] font-semibold">Demo guide · 8 steps</summary>
        <ol className="mt-4 mb-1 grid list-decimal gap-x-8 gap-y-3 pl-5 text-sm text-zinc-700 sm:grid-cols-2 lg:grid-cols-3 dark:text-zinc-300">
          <li>Sign in as Ana (Network A), open Today and accept all</li>
          <li>Open Deals: five lots are tracked</li>
          <li>Skip ahead 2 days (footer): Today flags stale stock</li>
          <li>Switch to Bo (Network B), reconfirm B-018 in Inventory</li>
          <li>As Bo, mark B-018 sold: Ana&rsquo;s deal closes</li>
          <li>Sign in as Dana (Network D), open Today: a Houston buyer, stock in New Orleans, Altamira and Rotterdam</li>
          <li>As Dana, accept all. Within the hour Sofia answers the &ldquo;tons&rdquo; question (locally: Simulate 1 market hour, footer)</li>
          <li>Open Activity: what the simulated users did that Dana may see</li>
        </ol>
        {!metaAvailable() && <p className="mt-3 text-xs text-zinc-500">Meta is not configured here; the regex baseline extracts instead.</p>}
      </details>
    </Page>
  );
}

const STEPS = [
  [UploadIcon, "Upload", "Text, sheet or PDF"],
  [CiteIcon, "Extract & cite", "Meta quotes every value"],
  [ShieldIcon, "Verify", "Code checks each quote"],
  [ShareIcon, "Share", "Field by field, revocable"],
  [SearchIcon, "Match", "Hard rules, no guessing"],
] as const;

function Tile({ label, value, unit, strong = false, children }: { label: string; value: number; unit?: string; strong?: boolean; children: ReactNode }) {
  return (
    <section className={`flex flex-col gap-4 rounded-xl border bg-white p-6 dark:bg-zinc-900 ${strong ? "border-zinc-900 dark:border-zinc-400" : "border-zinc-200 dark:border-zinc-800"}`}>
      <Label>{label}</Label>
      <p className="flex items-baseline gap-3">
        <span className="font-mono text-5xl leading-none font-medium tracking-tight">{value}</span>
        {unit && <span className="text-sm text-zinc-500 dark:text-zinc-400">{unit}</span>}
      </p>
      <div className="mt-auto flex flex-wrap items-end gap-2">{children}</div>
    </section>
  );
}
