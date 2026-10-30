import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Page } from "@/components/ui";
import { getDb } from "@/db/server";
import { demoControlsAllowed } from "@/lib/demo";
import { marketMinutes } from "@/lib/market-clock";
import { requestNow, requireSession } from "@/lib/session";
import { listMarketEvents } from "@/sim/market";

export default function ActivityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Activity />
    </Suspense>
  );
}

const KIND: Record<string, string> = {
  stock: "Stock",
  demand: "Demand",
  demand_closed: "Demand",
  answer: "Answer",
  sold: "Sold",
  withdrawn: "Withdrawn",
};

async function Activity() {
  const { actor, network } = await requireSession();
  const now = await requestNow();
  const events = await listMarketEvents(await getDb(), actor.network_id, now);
  const minutes = marketMinutes();
  return (
    <Page
      title="Market activity"
      subtitle={`What the simulated users did that ${network.alias} may see: everything from your own network, and a summary from networks that share stock with you.`}
    >
      <Card>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {minutes
            ? `The simulated market takes a step every ${minutes} minutes while people use the demo. `
            : demoControlsAllowed()
              ? "The simulated market moves when you press Simulate 1 market hour in the footer. "
              : "The simulated market is paused here. "}
          New matches show up on <Link href="/" className="text-accent hover:underline">Today</Link>; answers to your questions show up as changed lots on{" "}
          <Link href="/deals" className="text-accent hover:underline">Deals</Link>.
        </p>
      </Card>
      {events.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Nothing yet.</p>
      ) : (
        <ol className="mt-6 divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {events.map((e) => (
            <li key={e.id} className="flex gap-4 px-4 py-3 text-sm">
              <time className="w-24 shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400" dateTime={new Date(e.at).toISOString()}>
                {new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC
              </time>
              <span className="hidden w-20 shrink-0 text-xs font-medium tracking-wide text-zinc-500 uppercase sm:block dark:text-zinc-400">{KIND[e.kind] ?? e.kind}</span>
              <span className="min-w-0 flex-1">
                {e.summary}
                {!e.own && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">partner</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Page>
  );
}
