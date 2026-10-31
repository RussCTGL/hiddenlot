import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { reconfirmAction, resetDemo } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { TodayBoard, type BoardItem, type BoardKind, type Destination } from "@/components/today-board";
import { StockMap, type StockPin } from "@/components/stock-map";
import { ButtonLink, buttonCls, Card, Loading, Page, primaryCls } from "@/components/ui";
import { listGrantsByOwner, listLotsOfNetwork, listNetworks } from "@/db/repo";
import { getDb } from "@/db/server";
import { FRESHNESS_WINDOW_HOURS } from "@/discovery/constraints";
import { fitView as fit, landPath, MAP_H, MAP_W, project } from "@/geo/map";
import { findPlace } from "@/geo/places";
import { demoLoaded, getSession, requestNow } from "@/lib/session";
import { buildDigest, lotRef, lotTitle, whereOf, type DigestItem, type Suggestion } from "@/workflow/deals";

// The root layout's title template only applies below this segment.
export const metadata: Metadata = { title: { absolute: "Today · HiddenLot" } };

export default function Today() {
  return (
    <Suspense fallback={<Loading label="Preparing today's digest…" />}>
      <TodayPage />
    </Suspense>
  );
}

async function TodayPage() {
  const session = await getSession();
  if (!session) {
    if (await demoLoaded()) redirect("/login");
    return (
      <Page title="HiddenLot" subtitle="No demo data loaded yet.">
        <Card>
          <form action={resetDemo}>
            <Submit className={primaryCls} pending="Loading demo…">
              Load demo data
            </Submit>
          </form>
        </Card>
      </Page>
    );
  }
  const { actor, user, network } = session;
  const db = await getDb();
  const now = await requestNow();
  const d = await buildDigest(db, actor, now);
  const day = `${now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${user.name.split(" · ")[0].replace(/\s*\(.*?\)/, "")}`;
  if (!d.hasDemands) return <NoDemands actor={actor} networkName={network.alias} day={day} now={now} />;

  // Delivery ports of this network's active demands.
  const demands = await db.query<{ destination: string | null }>(
    `SELECT v.data->>'destination' AS destination FROM demands x JOIN demand_versions v ON v.demand_id = x.id AND v.version = x.current_version WHERE x.buyer_network_id = $1 AND x.status = 'active'`,
    [actor.network_id],
  );
  const destinations: Destination[] = [];
  for (const r of demands) {
    const p = findPlace(r.destination);
    const xy = p && project(p.lonlat);
    if (p && xy && !destinations.some((x) => x.name === p.name)) destinations.push({ name: p.name, x: xy[0], y: xy[1] });
  }

  const pinOf = (where: Suggestion["where"], own: boolean): BoardItem["pin"] => {
    const xy = where && project(where.lonlat);
    return where && xy ? { x: xy[0], y: xy[1], place: where.name, precision: where.kind, own, terms: where.terms } : null;
  };
  const fromSuggestion = (s: Suggestion, kind: BoardKind): BoardItem => {
    const dxy = s.destination && project(s.destination.lonlat);
    return {
      key: s.key,
      kind,
      title: s.title,
      sub: s.sub,
      href: s.href,
      lotRef: s.lotRef,
      pin: pinOf(s.where, s.seller === "Your network"),
      dest: s.destination && dxy ? { x: dxy[0], y: dxy[1], name: s.destination.name } : null,
      action: { key: s.key, button: s.button, decline: kind === "risk" ? "Not now" : kind === "forward" ? "Dismiss" : null, facts: s.facts, draft: s.draft, priority: s.priority },
    };
  };
  const fromItem = (i: DigestItem, kind: BoardKind): BoardItem => ({
    key: i.key,
    kind,
    title: i.title,
    sub: `${i.lotRef} · ${i.text}`,
    href: i.href,
    lotRef: i.lotRef,
    pin: pinOf(i.where, false),
    dest: null,
    action: null,
  });
  const items = [
    ...d.risks.map((s) => fromSuggestion(s, "risk")),
    ...d.forward.map((s) => fromSuggestion(s, "forward")),
    ...d.ask.map((s) => fromSuggestion(s, "ask")),
    ...d.engineering.map((i) => fromItem(i, "parked")),
    ...d.missing.map((i) => fromItem(i, "missing")),
    ...d.ruledOut.map((i) => fromItem(i, "out")),
  ];

  // Open on today's decisions and delivery ports, wherever they are; with none, on every pin; else the world.
  const focus = [...items.filter((i) => i.action && i.pin).map((i) => [i.pin!.x, i.pin!.y]), ...destinations.map((x) => [x.x, x.y])];
  const all = items.filter((i) => i.pin).map((i) => [i.pin!.x, i.pin!.y]);
  const view = fit(focus.length ? focus : all);

  return (
    <main className="flex flex-1 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[600px]">
      <TodayBoard land={landPath()} extent={{ w: MAP_W, h: MAP_H }} view={view} items={items} destinations={destinations} day={day} deals={d.stats.deals} />
    </main>
  );
}

async function NoDemands({ actor, networkName, day, now }: { actor: { network_id: string }; networkName: string; day: string; now: Date }) {
  const db = await getDb();
  const [lots, grants, networks] = await Promise.all([listLotsOfNetwork(db, actor.network_id), listGrantsByOwner(db, actor.network_id), listNetworks(db)]);
  const alias = new Map(networks.map((n) => [n.id, n.alias]));
  const age = (l: (typeof lots)[number]) => (now.getTime() - new Date(l.data.last_verified_at ?? l.data.observed_at).getTime()) / 3_600_000;
  // Oldest confirmation first, so the lots to reconfirm lead.
  const published = lots.filter((l) => l.status === "published").sort((a, b) => age(b) - age(a));
  const toReview = lots.filter((l) => l.status === "needs_review").length;
  const isStale = (l: (typeof lots)[number]) => age(l) > FRESHNESS_WINDOW_HOURS;
  const stale = published.filter(isStale);
  const fresh = published.filter((l) => !isStale(l));
  const live = grants.filter((g) => !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > now));

  const pins: StockPin[] = [];
  for (const l of published) {
    const w = whereOf(l.data);
    const xy = w && project(w.lonlat);
    if (w && xy) pins.push({ id: l.id, lotRef: lotRef(l.data, l.id), title: lotTitle(l.data), place: w.name, precision: w.kind, x: xy[0], y: xy[1], stale: isStale(l) });
  }
  const view = fit(pins.map((p) => [p.x, p.y]));

  const head = "flex items-center justify-between px-4 pt-4 pb-1.5 text-[11px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400";
  const row = (l: (typeof lots)[number], action: React.ReactNode) => (
    <li key={l.id} id={`lot-${l.id}`} className="flex scroll-mt-4 items-center gap-3 border-b border-zinc-100 px-4 py-3 target:bg-accent-soft target:shadow-[inset_3px_0_0_var(--accent)] dark:border-zinc-800">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{lotTitle(l.data)}</span>
        <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">
          {lotRef(l.data, l.id)} · {whereOf(l.data)?.name ?? "no location"} · confirmed {Math.ceil(age(l))} h ago
        </span>
      </span>
      {action}
    </li>
  );

  return (
    <main className="flex flex-1 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[600px]">
      <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <StockMap land={landPath()} extent={{ w: MAP_W, h: MAP_H }} view={view} pins={pins} day={day} stale={stale.length} published={published.length} />
        <aside className="flex flex-col border-zinc-200 bg-white lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-l dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <span className="text-sm font-semibold">{networkName} · your stock</span>
            <ButtonLink href="/intake">Add stock</ButtonLink>
          </div>
          {stale.length > 0 && (
            <>
              <div className={head}>
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#C2412D]" aria-hidden />
                  Reconfirm · buyers see these as unconfirmed
                </span>
                <span className="font-mono">{stale.length}</span>
              </div>
              <ul>
                {stale.map((l) =>
                  row(
                    l,
                    <ActionForm action={reconfirmAction}>
                      <input type="hidden" name="lot_id" value={l.id} />
                      <input type="hidden" name="version" value={l.current_version} />
                      <Submit className={buttonCls} pending="…">
                        Still available
                      </Submit>
                    </ActionForm>,
                  ),
                )}
              </ul>
            </>
          )}
          <div className={head}>
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[#12804C]" aria-hidden />
              Confirmed in the last {FRESHNESS_WINDOW_HOURS} h
            </span>
            <span className="font-mono">{fresh.length}</span>
          </div>
          {fresh.length === 0 ? <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">None.</p> : <ul>{fresh.map((l) => row(l, null))}</ul>}

          <div className="mt-auto space-y-3 border-t border-zinc-100 px-4 py-3.5 text-sm dark:border-zinc-800">
            <p className="text-zinc-600 dark:text-zinc-400">
              {live.length === 0 ? (
                "Not shared with anyone yet. Buyers in other networks cannot see your stock."
              ) : (
                <>
                  Shared with{" "}
                  {live.map((g, n) => (
                    <span key={g.id}>
                      {n > 0 && ", "}
                      <b className="font-semibold text-zinc-900 dark:text-zinc-100">{alias.get(g.recipient_network_id) ?? g.recipient_network_id}</b> ({g.lot_id ? "one lot" : "all lots"}, {g.field_scope.length} fields)
                    </span>
                  ))}
                  .
                </>
              )}
              {toReview > 0 && ` ${toReview} new lot${toReview === 1 ? "" : "s"} to review.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href="/inventory" primary>
                Inventory
              </ButtonLink>
              <ButtonLink href="/demands/new">New demand</ButtonLink>
              <ButtonLink href="/sharing">Sharing</ButtonLink>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
