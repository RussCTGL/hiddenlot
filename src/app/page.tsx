import { Suspense } from "react";
import { reconfirmAction, resetDemo } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { TodayBoard, type BoardItem, type BoardKind, type Destination } from "@/components/today-board";
import { ButtonLink, buttonCls, Card, Loading, Page, primaryCls } from "@/components/ui";
import { listGrantsByOwner, listLotsOfNetwork, listNetworks } from "@/db/repo";
import { getDb } from "@/db/server";
import { FRESHNESS_WINDOW_HOURS } from "@/discovery/constraints";
import { landPath, MAP_H, MAP_W, project } from "@/geo/map";
import { findPlace } from "@/geo/places";
import { getSession, requestNow } from "@/lib/session";
import { buildDigest, type DigestItem, type Suggestion } from "@/workflow/deals";

export default function Today() {
  return (
    <Suspense fallback={<Loading label="Preparing today's digest…" />}>
      <TodayPage />
    </Suspense>
  );
}

const shortTitle = (t: string) => t.replace(" mm", "");

async function TodayPage() {
  const session = await getSession();
  if (!session) {
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
  if (!d.hasDemands) return <NoDemands actor={actor} networkName={network.alias} now={now} />;

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
      title: shortTitle(s.title),
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
    title: shortTitle(i.title),
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
  const view = focus.length ? fit(focus) : all.length ? fit(all) : { x: 0, y: 0, w: MAP_W, h: MAP_H };
  const day = `${now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${user.name.split(" · ")[0].replace(/\s*\(fictional\)/, "")}`;

  return (
    <main className="flex flex-1 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[600px]">
      <TodayBoard land={landPath()} extent={{ w: MAP_W, h: MAP_H }} view={view} items={items} destinations={destinations} day={day} deals={d.stats.deals} />
    </main>
  );
}

/** A view box around the points, with room for labels, never narrower than a regional view (about 30° across). */
function fit(points: number[][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = MAP_W * 0.022;
  let w = Math.min(Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, MAP_W * 0.082), MAP_W);
  let h = Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, MAP_W * 0.064);
  // Roughly the map panel's shape, so the points sit in the middle.
  if (w / h < 1.25) w = h * 1.25;
  else h = w / 1.25;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
}

async function NoDemands({ actor, networkName, now }: { actor: { network_id: string }; networkName: string; now: Date }) {
  const db = await getDb();
  const [lots, grants, networks] = await Promise.all([listLotsOfNetwork(db, actor.network_id), listGrantsByOwner(db, actor.network_id), listNetworks(db)]);
  const alias = new Map(networks.map((n) => [n.id, n.alias]));
  const published = lots.filter((l) => l.status === "published");
  const toReview = lots.filter((l) => l.status === "needs_review").length;
  const age = (l: (typeof lots)[number]) => (now.getTime() - new Date(l.data.last_verified_at ?? l.data.observed_at).getTime()) / 3_600_000;
  const stale = published.filter((l) => age(l) > FRESHNESS_WINDOW_HOURS);
  const live = grants.filter((g) => !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > now));
  const ref = (l: (typeof lots)[number]) => String(l.data.fields.seller_lot_ref.normalized_value ?? l.id);

  return (
    <Page title="Today" subtitle={`${networkName} · your stock`} actions={<ButtonLink href="/demands/new">New demand</ButtonLink>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={stale.length ? `Reconfirm ${stale.length} lot${stale.length === 1 ? "" : "s"}` : "Stock is fresh"}>
          {stale.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
              <span className="size-2 rounded-full bg-emerald-600" aria-hidden />
              Every published lot was confirmed in the last {FRESHNESS_WINDOW_HOURS} h. Buyers can act on all of them.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {stale.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                  <span>
                    <b className="font-semibold">{ref(l)}</b> <span className="text-zinc-500">· confirmed {Math.ceil(age(l))} h ago; buyers see it as unconfirmed</span>
                  </span>
                  <ActionForm action={reconfirmAction}>
                    <input type="hidden" name="lot_id" value={l.id} />
                    <input type="hidden" name="version" value={l.current_version} />
                    <Submit className={buttonCls} pending="…">
                      Still available
                    </Submit>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-5">
          <Card title="Your stock">
            <p className="flex items-baseline gap-2">
              <b className="font-mono text-3xl leading-none font-medium">{published.length}</b>
              <span className="text-sm text-zinc-500">published{toReview ? ` · ${toReview} to review` : ""}</span>
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <ButtonLink href="/inventory" primary>
                Inventory
              </ButtonLink>
              <ButtonLink href="/intake">Add stock</ButtonLink>
            </div>
          </Card>
          <Card title="Shared with">
            {live.length === 0 ? (
              <p className="text-sm text-zinc-500">No one yet. Buyers in other networks cannot see your stock.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {live.map((g) => (
                  <li key={g.id}>
                    <b className="font-semibold">{alias.get(g.recipient_network_id) ?? g.recipient_network_id}</b>{" "}
                    <span className="text-zinc-500">
                      · {g.lot_id ? "one lot" : "all lots"} · {g.field_scope.length} fields
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <ButtonLink href="/sharing">Sharing</ButtonLink>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
