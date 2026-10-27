import { Suspense } from "react";
import { resetDemo, rerunDiscovery } from "@/app/actions";
import { listOpportunitiesForActor } from "@/auth/access";
import { Submit } from "@/components/forms";
import { ButtonLink, Card, Loading, Page, StatusPill, buttonCls, primaryCls } from "@/components/ui";
import { listDemandsOfNetwork, listLotsOfNetwork } from "@/db/repo";
import { getDb } from "@/db/server";
import type { CompatibilityStatus } from "@/discovery/constraints";
import { GROUP_ORDER } from "@/discovery/engine";
import { getSession } from "@/lib/session";
import { metaAvailable } from "@/lib/meta";

export default function Home() {
  return (
    <Suspense fallback={<Loading />}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  const session = await getSession();
  if (!session) {
    return (
      <Page title="HiddenLot" subtitle="No demo data loaded yet.">
        <Card>
          <p className="mb-3 text-sm">Load the synthetic three-network demo to start.</p>
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
    listOpportunitiesForActor(db, actor, new Date()),
  ]);
  const live = opps.filter((o) => o.status !== "invalidated");
  const byGroup = new Map<CompatibilityStatus, number>();
  for (const o of live) byGroup.set(o.compatibility_status as CompatibilityStatus, (byGroup.get(o.compatibility_status as CompatibilityStatus) ?? 0) + 1);
  const cross = live.filter((o) => o.novelty === "cross_network").length;

  return (
    <Page
      title={`${network.alias} · ${network.name}`}
      subtitle="HiddenLot finds surplus hot-rolled coil across trade networks that have agreed to share, explains each candidate with evidence from the source, and keeps every unknown visible."
      actions={
        <>
          <form action={rerunDiscovery}>
            <Submit className={buttonCls}>Re-run discovery</Submit>
          </form>
          <form action={resetDemo}>
            <Submit className={buttonCls} pending="Resetting…">
              Reset demo
            </Submit>
          </form>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Your stock">
          <p className="text-3xl font-semibold">{lots.filter((l) => l.status === "published").length}</p>
          <p className="text-sm text-zinc-500">published lots · {lots.filter((l) => l.status === "needs_review").length} awaiting review</p>
          <div className="mt-3 flex gap-2">
            <ButtonLink href="/inventory">Inventory</ButtonLink>
            <ButtonLink href="/intake">Add stock</ButtonLink>
          </div>
        </Card>
        <Card title="Your demands">
          <p className="text-3xl font-semibold">{demands.filter((d) => d.status === "active").length}</p>
          <p className="text-sm text-zinc-500">active buyer requirements</p>
          <div className="mt-3 flex gap-2">
            <ButtonLink href="/demands">Demands</ButtonLink>
            <ButtonLink href="/demands/new">New demand</ButtonLink>
          </div>
        </Card>
        <Card title="Opportunities">
          <p className="text-3xl font-semibold">{live.length}</p>
          <p className="text-sm text-zinc-500">{cross} found in other networks under their sharing grants</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {GROUP_ORDER.filter((g) => byGroup.get(g)).map((g) => (
              <span key={g} className="flex items-center gap-1 text-xs">
                <StatusPill status={g} /> {byGroup.get(g)}
              </span>
            ))}
          </div>
          <div className="mt-3">
            <ButtonLink href="/opportunities" primary>
              Review opportunities
            </ButtonLink>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card title="How it works">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            <li>A stockist uploads an offer (message text, CSV/XLSX or text PDF). Meta Muse Spark extracts each lot and cites the exact line, cell or page for every value.</li>
            <li>Deterministic checks verify every citation; units are converted in code. Anything the source does not state stays Unknown.</li>
            <li>The owner reviews, publishes and chooses which networks may use which fields.</li>
            <li>Publishing triggers discovery against the authorized demands. Hard constraints decide pass / fail / unknown; there is no grade-equivalence table.</li>
            <li>Buyers review candidates with evidence. Selling, editing or revoking sharing invalidates them immediately.</li>
          </ol>
        </Card>
        <Card title="Demo walkthrough">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            <li>As <b>Network A</b>, open Opportunities: lot B-018 from Network B is a declared spec match that Network A&apos;s own stock could not provide.</li>
            <li>See why Network C&apos;s look-alikes are not recommended: wrong standard, too late, or a different grade needing engineering review.</li>
            <li>Shortlist B-018 with a reason.</li>
            <li>Switch to <b>Network B</b>, mark B-018 sold, switch back: the opportunity is invalidated and its details are hidden.</li>
            <li>As Network B, upload a new offer in Intake and watch Meta extract it with evidence.</li>
          </ol>
          <p className="mt-3 text-xs text-zinc-500">Meta extraction: {metaAvailable() ? "configured on this server" : "not configured — the regex baseline is used instead"}.</p>
        </Card>
      </div>
    </Page>
  );
}
