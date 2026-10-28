import { Suspense } from "react";
import { resetDemo } from "@/app/actions";
import { Submit } from "@/components/forms";
import { TodayBoard, type BoardItem, type BoardKind, type Destination } from "@/components/today-board";
import { ButtonLink, Card, Loading, Page, primaryCls } from "@/components/ui";
import { getDb } from "@/db/server";
import { landPath, MAP_H, MAP_W, project } from "@/geo/map";
import { findPlace } from "@/geo/places";
import { getSession, requestNow } from "@/lib/session";
import { buildDigest, type Digest, type DigestItem, type Suggestion } from "@/workflow/deals";

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
  if (!d.hasDemands) return <NoDemands digest={d} networkName={network.alias} />;

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

  // Open on today's decisions and delivery ports; fall back to the whole region.
  const focus = [...items.filter((i) => i.action && i.pin).map((i) => [i.pin!.x, i.pin!.y]), ...destinations.map((x) => [x.x, x.y])];
  const view = fit(focus.length ? focus : [[MAP_W * 0.25, MAP_H * 0.2], [MAP_W * 0.75, MAP_H * 0.75]]);
  const day = `${now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${user.name.split(" · ")[0].replace(/\s*\(fictional\)/, "")}`;

  return (
    <main className="flex flex-1 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[600px]">
      <TodayBoard land={landPath()} view={view} items={items} destinations={destinations} day={day} deals={d.stats.deals} />
    </main>
  );
}

/** A view box around the points, with room for labels, never narrower than a regional view. */
function fit(points: number[][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = 110;
  let w = Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, 420);
  let h = Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, 320);
  // Roughly the map panel's shape, so the points sit in the middle.
  if (w / h < 1.25) w = h * 1.25;
  else h = w / 1.25;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
}

function NoDemands({ digest, networkName }: { digest: Digest; networkName: string }) {
  return (
    <Page title="Today" subtitle={`${networkName} has no active demands.`}>
      <Card>
        <div className="space-y-4 text-sm">
          {digest.staleOwnLots > 0 ? (
            <p className="flex items-center gap-2 font-medium text-rose-800 dark:text-rose-300">
              <span className="size-2 rounded-full bg-rose-600" aria-hidden />
              {digest.staleOwnLots} of your lots {digest.staleOwnLots === 1 ? "needs" : "need"} reconfirming (older than 48 h)
            </p>
          ) : (
            <p className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
              <span className="size-2 rounded-full bg-emerald-600" aria-hidden />
              All your stock was confirmed in the last 48 h
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/inventory" primary>
              Inventory
            </ButtonLink>
            <ButtonLink href="/demands/new">New demand</ButtonLink>
          </div>
        </div>
      </Card>
    </Page>
  );
}
