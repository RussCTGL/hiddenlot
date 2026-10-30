"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { acceptSuggestionsAction, declineSuggestionAction } from "@/app/actions";
import { CopyButton } from "./copy-button";
import { ActionForm, Submit } from "./forms";
import { CheckMarkIcon } from "./icons";

// Map-first Today: every decision is a row in the list and, where the shared
// fields say where the lot is, a pin on the map. Selecting either highlights both.

export type BoardKind = "risk" | "forward" | "ask" | "parked" | "missing" | "out";

export interface BoardItem {
  key: string;
  kind: BoardKind;
  title: string;
  sub: string;
  href: string | null;
  lotRef: string;
  /** Map position and how precise it is; null when no location is shared. */
  pin: { x: number; y: number; place: string; precision: "stock" | "ships_from" | "delivered"; own: boolean; terms: string | null } | null;
  /** The demand's delivery port, for the route line. */
  dest: { x: number; y: number; name: string } | null;
  action: { key: string; button: string; decline: string | null; facts: { ok: boolean; text: string }[]; draft: string | null; priority: number | null } | null;
}

export interface Destination {
  name: string;
  x: number;
  y: number;
}

const COLOR: Record<BoardKind, string> = {
  risk: "#C2412D",
  forward: "#12804C",
  ask: "#C27A12",
  parked: "#6B45C6",
  missing: "#D9A441",
  out: "#8A93A1",
};
const SECTION: Record<BoardKind, string> = {
  risk: "Needs attention",
  forward: "Move forward",
  ask: "Needs an answer",
  parked: "Parked for engineering",
  missing: "Several facts open",
  out: "Ruled out",
};
const ORDER: BoardKind[] = ["risk", "forward", "ask", "parked", "missing", "out"];

type View = { x: number; y: number; w: number; h: number };

export function TodayBoard({
  land: coarse,
  extent,
  view: initial,
  items,
  destinations,
  day,
  deals,
}: {
  land: string;
  /** Size of the whole map in map units. */
  extent: { w: number; h: number };
  view: View;
  items: BoardItem[];
  destinations: Destination[];
  day: string;
  deals: number;
}) {
  const [shown, setShown] = useState<Record<BoardKind, boolean>>({ risk: true, forward: true, ask: true, parked: false, missing: false, out: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [view, setView] = useState<View>(initial);
  const [land, setLand] = useState(coarse);
  const [size, setSize] = useState({ w: 900, h: 700 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; view: View } | null>(null);
  // Fingers on the map, for pinch zoom on touch screens.
  const touches = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width || 1, h: e.contentRect.height || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel and trackpad zoom around the cursor. A native listener, because React's is passive and could not stop the page scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // A trackpad pinch arrives as a wheel event with ctrlKey and small steps.
      zoomAt(Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // The page draws a light coastline; the detailed one follows (the browser keeps it).
  useEffect(() => {
    let live = true;
    fetch("/map/land")
      .then((r) => (r.ok ? r.text() : null))
      .then((d) => live && d && setLand(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const count = (k: BoardKind) => items.filter((i) => i.kind === k).length;
  const actions = items.filter((i) => i.action);
  const visible = items.filter((i) => shown[i.kind]);
  const sel = items.find((i) => i.key === selected) ?? null;

  // Map units per screen pixel, so pins and labels keep their size at any zoom.
  const k = Math.max(view.w / size.w, view.h / size.h);

  // Pins: a lot at one of your delivery ports is listed under that port; others are spread out per place.
  const { pins, chips } = useMemo(() => {
    const destNames = new Set(destinations.map((d) => d.name));
    const chips = new Map<string, BoardItem[]>();
    const byPlace = new Map<string, BoardItem[]>();
    for (const i of visible) {
      if (!i.pin) continue;
      if (destNames.has(i.pin.place)) chips.set(i.pin.place, [...(chips.get(i.pin.place) ?? []), i]);
      else byPlace.set(i.pin.place, [...(byPlace.get(i.pin.place) ?? []), i]);
    }
    const pins: { item: BoardItem; x: number; y: number; side: "left" | "right" }[] = [];
    for (const group of byPlace.values()) {
      group.forEach((item, n) => {
        const dx = (n - (group.length - 1) / 2) * 24;
        pins.push({ item, x: item.pin!.x + dx * k, y: item.pin!.y + (n % 2) * 8 * k, side: group.length > 1 && n % 2 === 0 ? "left" : "right" });
      });
    }
    return { pins, chips };
  }, [visible, destinations, k]);

  /** Keeps the centre of the view on the map, so panning and zooming out never lose the world. */
  const onMap = (v: View): View => ({
    ...v,
    x: Math.min(Math.max(v.x, -v.w / 2), extent.w - v.w / 2),
    y: Math.min(Math.max(v.y, -v.h / 2), extent.h - v.h / 2),
  });
  /** Zooms by factor f (<1 = in), keeping the map point under (clientX, clientY), or the centre, in place. */
  function zoomAt(f: number, clientX?: number, clientY?: number) {
    const rect = box.current?.getBoundingClientRect();
    setView((v) => {
      const w = Math.min(Math.max(v.w * f, extent.w / 40), extent.w);
      const r = w / v.w;
      let px = v.x + v.w / 2;
      let py = v.y + v.h / 2;
      if (rect && clientX !== undefined && clientY !== undefined) {
        // The SVG letterboxes the view (xMidYMid meet): undo that to find the map point.
        const kk = Math.max(v.w / rect.width, v.h / rect.height);
        px = v.x - (rect.width * kk - v.w) / 2 + (clientX - rect.left) * kk;
        py = v.y - (rect.height * kk - v.h) / 2 + (clientY - rect.top) * kk;
      }
      return onMap({ x: px + (v.x - px) * r, y: py + (v.y - py) * r, w, h: v.h * r });
    });
  }
  function onDown(e: ReactPointerEvent<SVGSVGElement>) {
    if ((e.target as Element).closest("[data-pin]")) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current = touches.current.size === 1 ? { px: e.clientX, py: e.clientY, view } : null;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const prev = touches.current.get(e.pointerId);
    if (prev && touches.current.size === 2) {
      // Pinch: zoom by the change in finger distance, around the midpoint.
      const other = [...touches.current.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (before > 0 && after > 0) zoomAt(before / after, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
      return;
    }
    if (prev) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    setView(onMap({ ...d.view, x: d.view.x - (e.clientX - d.px) * k, y: d.view.y - (e.clientY - d.py) * k }));
  }
  function onUp(e: ReactPointerEvent<SVGSVGElement>) {
    touches.current.delete(e.pointerId);
    drag.current = null; // lifting one finger of a pinch does not start a drag
  }
  function select(key: string) {
    setSelected((s) => (s === key ? null : key));
    setDraftOpen(false);
    document.getElementById(`row-${key}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const label = { paintOrder: "stroke" as const, strokeWidth: 4 * k, strokeLinejoin: "round" as const };
  const halo = "fill-zinc-900 stroke-white dark:fill-zinc-100 dark:stroke-zinc-950";

  return (
    <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
      {/* Map */}
      <section ref={box} className="relative h-[320px] shrink-0 overflow-hidden bg-[#E6EDF5] sm:h-[420px] lg:h-auto lg:flex-1 dark:bg-[#0A1018]">
        <svg
          role="img"
          aria-label={`Map of today's decisions${destinations.length ? `, delivering to ${destinations.map((d) => d.name).join(" and ")}` : ""}`}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 h-full w-full touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={(e) => {
            if (!(e.target as Element).closest("[data-pin]")) zoomAt(0.5, e.clientX, e.clientY);
          }}
        >
          <path d={land} className="fill-white stroke-[#C9D1DC] dark:fill-zinc-800 dark:stroke-zinc-600" strokeWidth={0.8 * k} />

          {/* routes to the delivery port */}
          {visible.map((i) => {
            if (!i.pin || !i.dest || i.pin.place === i.dest.name) return null;
            const p = pins.find((x) => x.item.key === i.key);
            if (!p) return null;
            const mx = (p.x + i.dest.x) / 2;
            const my = (p.y + i.dest.y) / 2 - Math.hypot(i.dest.x - p.x, i.dest.y - p.y) * 0.25;
            const on = selected === i.key;
            return (
              <path
                key={`r-${i.key}`}
                d={`M${p.x} ${p.y} Q ${mx} ${my} ${i.dest.x} ${i.dest.y}`}
                fill="none"
                stroke={COLOR[i.kind]}
                strokeWidth={(on ? 2.5 : 1.75) * k}
                strokeDasharray={on ? undefined : `${5 * k} ${5 * k}`}
                opacity={selected && !on ? 0.35 : 0.9}
              />
            );
          })}

          {/* your delivery ports, with the lots that sit or arrive there */}
          {destinations.map((d) => {
            const here = chips.get(d.name) ?? [];
            return (
              <g key={d.name}>
                <circle cx={d.x} cy={d.y} r={22 * k} fill="#2453C7" opacity={0.1} />
                <circle cx={d.x} cy={d.y} r={13 * k} fill="none" stroke="#2453C7" strokeWidth={2 * k} />
                <circle cx={d.x} cy={d.y} r={5 * k} fill="#2453C7" />
                <text x={d.x - 28 * k} y={d.y - 6 * k} textAnchor="end" fontSize={12 * k} fontWeight={600} className={halo} style={label}>
                  {d.name}
                </text>
                <text x={d.x - 28 * k} y={d.y + 9 * k} textAnchor="end" fontSize={11 * k} className={halo} style={label} opacity={0.75}>
                  your delivery point
                </text>
                {here.map((i, n) => {
                  const y = d.y + (20 + n * 26) * k;
                  const w = 92 * k;
                  const on = selected === i.key;
                  return (
                    <g key={i.key} data-pin onClick={() => select(i.key)} className="cursor-pointer" role="button" aria-label={`${i.lotRef}: ${i.title}`}>
                      <rect x={d.x - w - 16 * k} y={y} width={w} height={22 * k} rx={11 * k} className="fill-white dark:fill-zinc-900" stroke={COLOR[i.kind]} strokeWidth={(on ? 2.5 : 1.25) * k} />
                      <circle cx={d.x - w - 4 * k} cy={y + 11 * k} r={4 * k} fill={COLOR[i.kind]} />
                      <text x={d.x - w + 5 * k} y={y + 15 * k} fontSize={11 * k} fontWeight={500} className="fill-zinc-900 dark:fill-zinc-100">
                        {i.lotRef} · {i.pin!.own ? "own" : i.pin!.precision === "delivered" ? (i.pin!.terms?.split(" ")[0] ?? "delivered") : "here"}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* lots elsewhere */}
          {pins.map(({ item: i, x, y, side }) => {
            const on = selected === i.key;
            const c = COLOR[i.kind];
            const tx = side === "left" ? x - 14 * k : x + 13 * k;
            const anchor = side === "left" ? "end" : "start";
            return (
              <g key={i.key} data-pin onClick={() => select(i.key)} className="cursor-pointer" role="button" aria-label={`${i.lotRef}: ${i.title}`}>
                {on && <circle cx={x} cy={y} r={16 * k} fill={c} opacity={0.18} />}
                {i.pin!.precision === "stock" ? (
                  <circle cx={x} cy={y} r={7 * k} fill={c} className="stroke-white dark:stroke-zinc-900" strokeWidth={2 * k} />
                ) : (
                  <circle cx={x} cy={y} r={8 * k} className="fill-white dark:fill-zinc-900" stroke={c} strokeWidth={2.5 * k} strokeDasharray={`${3 * k} ${2.5 * k}`} />
                )}
                {on && <circle cx={x} cy={y} r={11.5 * k} fill="none" className="stroke-zinc-900 dark:stroke-white" strokeWidth={1.5 * k} />}
                <text x={tx} y={y - 3 * k} textAnchor={anchor} fontSize={12 * k} fontWeight={600} className={halo} style={label}>
                  {i.lotRef}
                </text>
                <text x={tx} y={y + 11 * k} textAnchor={anchor} fontSize={11 * k} className={halo} style={label} opacity={0.75}>
                  {i.pin!.precision === "ships_from" ? `ships from ${i.pin!.place}` : i.pin!.precision === "delivered" ? `delivered ${i.pin!.place}` : i.pin!.place}
                </text>
              </g>
            );
          })}
        </svg>

        {/* summary card */}
        <div className="absolute top-4 left-4 hidden flex-col gap-2.5 rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-lg shadow-zinc-900/5 sm:flex dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{day}</span>
          <Summary count={actions.length} deals={deals} keys={actions.map((i) => i.action!.key)} />
        </div>

        {/* filters */}
        <div className="absolute top-4 right-4 hidden flex-wrap justify-end gap-1.5 md:flex">
          {(["forward", "ask", "risk"] as BoardKind[]).map((kind) => (
            <Chip key={kind} kind={kind} n={count(kind)} on={shown[kind]} toggle={() => setShown((s) => ({ ...s, [kind]: !s[kind] }))} />
          ))}
        </div>

        {/* legend */}
        <div className="absolute bottom-4 left-4 hidden flex-wrap gap-x-3.5 gap-y-1 rounded-lg bg-white/90 px-3 py-2 text-xs text-zinc-700 md:flex dark:bg-zinc-900/90 dark:text-zinc-300">
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="12" height="12">
              <circle cx="6" cy="6" r="5" className="fill-zinc-600 dark:fill-zinc-400" />
            </svg>
            stock location
          </span>
          <span className="flex items-center gap-1.5" title="The owner did not share where the stock is; this is the port it ships from">
            <svg aria-hidden width="12" height="12">
              <circle cx="6" cy="6" r="4.5" fill="none" className="stroke-zinc-600 dark:stroke-zinc-400" strokeWidth="1.5" strokeDasharray="2 1.5" />
            </svg>
            ships from (location not shared)
          </span>
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="12" height="12">
              <circle cx="6" cy="6" r="5" fill="none" stroke="#2453C7" strokeWidth="1.5" />
              <circle cx="6" cy="6" r="2" fill="#2453C7" />
            </svg>
            your delivery point
          </span>
        </div>

        {/* zoom */}
        <div className="absolute right-4 bottom-4 flex flex-col overflow-hidden rounded-lg border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <button type="button" aria-label="Zoom in" onClick={() => zoomAt(0.7)} className="size-9 border-b border-zinc-300 text-lg hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 0.7)} className="size-9 text-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
            −
          </button>
        </div>
      </section>

      {/* summary on phones, where the map card is hidden */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 sm:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <Summary count={actions.length} deals={deals} keys={actions.map((i) => i.action!.key)} inline />
      </div>

      {/* decision list */}
      <aside className="flex flex-col border-zinc-200 bg-white lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-l dark:border-zinc-800 dark:bg-zinc-900">
        {ORDER.filter((kind) => shown[kind] && count(kind) > 0).map((kind) => (
          <div key={kind}>
            <div className="flex items-center justify-between px-4 pt-4 pb-1.5 text-[11px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: COLOR[kind] }} aria-hidden />
                {SECTION[kind]}
              </span>
              <span className="font-mono">{count(kind)}</span>
            </div>
            {items
              .filter((i) => i.kind === kind)
              .map((i) => (
                <Row key={i.key} item={i} selected={sel?.key === i.key} onSelect={() => select(i.key)} draftOpen={draftOpen} toggleDraft={() => setDraftOpen((o) => !o)} />
              ))}
          </div>
        ))}
        {actions.length === 0 && !shown.parked && !shown.out && (
          <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
            Nothing to decide.{" "}
            {deals > 0 && (
              <Link href="/deals" className="text-accent hover:underline">
                {deals} deal{deals === 1 ? "" : "s"} in progress
              </Link>
            )}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-2 border-t border-zinc-100 px-4 py-3.5 dark:border-zinc-800">
          {(["parked", "missing", "out"] as BoardKind[])
            .filter((kind) => count(kind) > 0)
            .map((kind) => (
              <Chip key={kind} kind={kind} n={count(kind)} on={shown[kind]} toggle={() => setShown((s) => ({ ...s, [kind]: !s[kind] }))} short />
            ))}
          <span className="md:hidden">
            {(["forward", "ask", "risk"] as BoardKind[])
              .filter((kind) => count(kind) > 0 && !shown[kind])
              .map((kind) => (
                <Chip key={kind} kind={kind} n={count(kind)} on={false} toggle={() => setShown((s) => ({ ...s, [kind]: true }))} short />
              ))}
          </span>
        </div>
      </aside>
    </div>
  );
}

function Summary({ count, deals, keys, inline = false }: { count: number; deals: number; keys: string[]; inline?: boolean }) {
  return (
    <>
      <span className={`flex items-baseline gap-2 ${inline ? "" : ""}`}>
        <b className={`font-mono leading-none font-medium ${inline ? "text-2xl" : "text-[32px]"}`}>{count}</b>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{count === 1 ? "decision" : "decisions"}</span>
      </span>
      <span className={`flex gap-2.5 ${inline ? "items-center" : "flex-col"}`}>
        {count > 0 && (
          <ActionForm action={acceptSuggestionsAction} className="max-w-56">
            {keys.map((key) => (
              <input key={key} type="hidden" name="key" value={key} />
            ))}
            <Submit
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              pending="Working…"
            >
              <CheckMarkIcon size={14} />
              Accept all
            </Submit>
          </ActionForm>
        )}
        {deals > 0 && (
          <Link href="/deals" className="text-sm font-medium text-accent hover:underline">
            {deals} deal{deals === 1 ? "" : "s"} in progress →
          </Link>
        )}
      </span>
    </>
  );
}

function Chip({ kind, n, on, toggle, short = false }: { kind: BoardKind; n: number; on: boolean; toggle: () => void; short?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={toggle}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium ${on ? "border-zinc-300 bg-white text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100" : "border-zinc-200 bg-zinc-100 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-400"}`}
    >
      <span className="size-2 rounded-full" style={{ background: COLOR[kind] }} aria-hidden />
      {short ? SECTION[kind].replace(" for engineering", "") : SECTION[kind]} {n}
    </button>
  );
}

const btn = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[13px] font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800";
const primary = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[13px] font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const quiet = "inline-flex min-h-9 items-center justify-center rounded-lg px-2.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800";

function Row({ item: i, selected, onSelect, draftOpen, toggleDraft }: { item: BoardItem; selected: boolean; onSelect: () => void; draftOpen: boolean; toggleDraft: () => void }) {
  const a = i.action;
  return (
    <div id={`row-${i.key}`} className={`border-b border-zinc-100 px-4 py-3 dark:border-zinc-800 ${selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"}`}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onSelect} aria-expanded={selected} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: COLOR[i.kind] }} aria-hidden />
            <span className="truncate text-sm font-semibold">{i.title}</span>
          </span>
          <span className="mt-0.5 block truncate pl-[18px] text-xs text-zinc-500 dark:text-zinc-400">{i.sub}</span>
        </button>
        {a && !selected && (
          <ActionForm action={acceptSuggestionsAction}>
            <input type="hidden" name="key" value={a.key} />
            <Submit className={btn} pending="…">
              Accept
            </Submit>
          </ActionForm>
        )}
        {a?.priority != null && selected && (
          <span className="font-mono text-[13px] text-zinc-600 dark:text-zinc-400" title="Review priority, not a deal probability">
            {a.priority}
          </span>
        )}
      </div>
      {selected && (
        <div className="mt-2.5 space-y-2.5 pl-[18px]">
          {a && a.facts.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
              {a.facts.map((f) => (
                <span key={f.text}>
                  <b className={f.ok ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}>{f.ok ? "✓" : "~"}</b> {f.text}
                </span>
              ))}
            </div>
          )}
          {!a && <p className="text-xs text-zinc-700 dark:text-zinc-300">{i.sub}</p>}
          {a && (
            <div className="flex flex-wrap items-start gap-1.5">
              <ActionForm action={acceptSuggestionsAction}>
                <input type="hidden" name="key" value={a.key} />
                <Submit className={primary} pending="Saving…">
                  {a.button}
                </Submit>
              </ActionForm>
              {a.draft && (
                <button type="button" className={btn} onClick={toggleDraft} aria-expanded={draftOpen}>
                  Message
                </button>
              )}
              {a.decline && (
                <ActionForm action={declineSuggestionAction}>
                  <input type="hidden" name="key" value={a.key} />
                  <Submit className={quiet} pending="…">
                    {a.decline}
                  </Submit>
                </ActionForm>
              )}
            </div>
          )}
          {a?.draft && draftOpen && (
            <div className="space-y-1.5 rounded-lg bg-white px-3 py-2.5 text-[13px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              <p>{a.draft}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-500">Draft from shared fields · not sent</span>
                <CopyButton text={a.draft} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent hover:bg-zinc-100 dark:hover:bg-zinc-800" />
              </div>
            </div>
          )}
          {i.href && (
            <Link href={i.href} className="inline-block text-xs text-accent hover:underline">
              Open details
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
