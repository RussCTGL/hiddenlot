"use client";

import { haloCls, haloStyle, MapCanvas, type View } from "./map-canvas";

// Today for a network without demands: its own published stock on the map.
// A lot that needs reconfirming is red; each pin links to its row in the list.

export interface StockPin {
  id: string;
  lotRef: string;
  title: string;
  place: string;
  precision: "stock" | "ships_from" | "delivered";
  x: number;
  y: number;
  stale: boolean;
}

const STALE = "#C2412D";
const FRESH = "#12804C";

export function StockMap({ land, extent, view, pins, day, stale, published }: { land: string; extent: { w: number; h: number }; view: View; pins: StockPin[]; day: string; stale: number; published: number }) {
  return (
    <MapCanvas
      land={land}
      extent={extent}
      view={view}
      label={`Map of your published stock: ${published} lots, ${stale} to reconfirm`}
      overlay={
        <>
          <div className="absolute top-4 left-4 hidden flex-col gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-lg shadow-zinc-900/5 sm:flex dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{day}</span>
            <span className="flex items-baseline gap-2">
              <b className="font-mono text-[32px] leading-none font-medium">{stale}</b>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">to reconfirm</span>
            </span>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">{published} published</span>
          </div>
          <div className="absolute bottom-4 left-4 hidden flex-wrap gap-x-3.5 gap-y-1 rounded-lg bg-white/90 px-3 py-2 text-xs text-zinc-700 md:flex dark:bg-zinc-900/90 dark:text-zinc-300">
            <Key color={STALE}>needs reconfirming</Key>
            <Key color={FRESH}>confirmed recently</Key>
            <span className="flex items-center gap-1.5">
              <svg aria-hidden width="12" height="12">
                <circle cx="6" cy="6" r="4.5" fill="none" className="stroke-zinc-600 dark:stroke-zinc-400" strokeWidth="1.5" strokeDasharray="2 1.5" />
              </svg>
              port only (no stock location)
            </span>
          </div>
        </>
      }
    >
      {(k) => {
        const label = haloStyle(k);
        const byPlace = new Map<string, StockPin[]>();
        for (const p of pins) byPlace.set(p.place, [...(byPlace.get(p.place) ?? []), p]);
        return [...byPlace.values()].flatMap((group) =>
          group.map((p, n) => {
            const x = p.x + (n - (group.length - 1) / 2) * 24 * k;
            const y = p.y + (n % 2) * 8 * k;
            const left = group.length > 1 && n % 2 === 0;
            const tx = left ? x - 14 * k : x + 13 * k;
            const anchor = left ? "end" : "start";
            const c = p.stale ? STALE : FRESH;
            return (
              <a key={p.id} href={`#lot-${p.id}`} data-pin aria-label={`${p.lotRef}: ${p.title}${p.stale ? ", needs reconfirming" : ""}`}>
                {p.precision === "stock" ? (
                  <circle cx={x} cy={y} r={7 * k} fill={c} className="stroke-white dark:stroke-zinc-900" strokeWidth={2 * k} />
                ) : (
                  <circle cx={x} cy={y} r={8 * k} className="fill-white dark:fill-zinc-900" stroke={c} strokeWidth={2.5 * k} strokeDasharray={`${3 * k} ${2.5 * k}`} />
                )}
                <text x={tx} y={y - 3 * k} textAnchor={anchor} fontSize={12 * k} fontWeight={600} className={haloCls} style={label}>
                  {p.lotRef}
                </text>
                {n === 0 && (
                  <text x={tx} y={y + 11 * k} textAnchor={anchor} fontSize={11 * k} className={haloCls} style={label} opacity={0.75}>
                    {p.place}
                    {group.length > 1 ? ` · ${group.length} lots` : ""}
                  </text>
                )}
              </a>
            );
          }),
        );
      }}
    </MapCanvas>
  );
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg aria-hidden width="12" height="12">
        <circle cx="6" cy="6" r="5" fill={color} />
      </svg>
      {children}
    </span>
  );
}
