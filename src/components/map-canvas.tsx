"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

// The world map behind Today: drag to pan; wheel, trackpad pinch, touch pinch,
// double-click or the +/− buttons to zoom. What is drawn on it comes from the
// caller, which gets k (map units per screen pixel) so pins and labels keep
// their size at any zoom.

export type View = { x: number; y: number; w: number; h: number };

export function MapCanvas({
  land: coarse,
  extent,
  view: initial,
  label,
  overlay,
  children,
}: {
  land: string;
  /** Size of the whole map in map units. */
  extent: { w: number; h: number };
  view: View;
  label: string;
  /** Cards and legends laid over the map. */
  overlay?: ReactNode;
  /** The map's contents, drawn in map units. */
  children: (k: number) => ReactNode;
}) {
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

  // The page draws a light coastline; the detailed one (~450 KB) follows once the view is
  // zoomed in far enough to show the difference (the browser keeps it).
  const wantFine = view.w < extent.w / 3;
  useEffect(() => {
    if (!wantFine || land !== coarse) return;
    let live = true;
    fetch("/map/land")
      .then((r) => (r.ok ? r.text() : null))
      .then((d) => live && d && setLand(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wantFine, land, coarse]);

  // Map units per screen pixel.
  const k = Math.max(view.w / size.w, view.h / size.h);

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

  return (
    <section ref={box} className="relative h-[320px] shrink-0 overflow-hidden bg-[#E6EDF5] sm:h-[420px] lg:h-auto lg:flex-1 dark:bg-[#0A1018]">
      <svg
        role="img"
        aria-label={label}
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
        {children(k)}
      </svg>

      {overlay}

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
  );
}

/** Label text with a halo, so it reads over coastlines. */
export const haloCls = "fill-zinc-900 stroke-white dark:fill-zinc-100 dark:stroke-zinc-950";
export const haloStyle = (k: number) => ({ paintOrder: "stroke" as const, strokeWidth: 4 * k, strokeLinejoin: "round" as const });
