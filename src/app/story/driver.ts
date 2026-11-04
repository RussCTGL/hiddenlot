import { atSeat, unseat, type Seat } from "@/lib/seat";

// Drives the two panes of the story (same-origin iframes): opens pages, finds
// elements by their visible text, points at them with a cursor and a ring, and
// clicks or types the way a person would. Everything it does is an ordinary
// action in the app.

export type Pane = 0 | 1;

/** Thrown to end a run that was restarted or left. */
export class Stopped extends Error {}

/** Thrown from a wait condition to stop waiting at once: the app said no. */
export class Failed extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANE_CSS = `
footer, nextjs-portal { display: none !important; }
#story-ring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #f59e0b; border-radius: 12px;
  box-shadow: 0 0 0 5px rgba(245,158,11,.22), 0 0 28px rgba(245,158,11,.5); transition: left .25s ease, top .25s ease, width .25s ease, height .25s ease, opacity .25s ease; }
#story-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 26px; height: 26px; margin: -3px 0 0 -3px;
  transition: left .75s cubic-bezier(.45,0,.2,1), top .75s cubic-bezier(.45,0,.2,1); filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); }
#story-cursor::after { content: ""; position: absolute; left: -9px; top: -9px; width: 24px; height: 24px; border-radius: 50%;
  background: rgba(245,158,11,.55); transform: scale(0); opacity: 0; }
#story-cursor.click::after { animation: story-click .45s ease-out; }
@keyframes story-click { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.8); opacity: 0; } }
`;

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.4-2.9 1.5-3.9-7.4L4 19.3z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const visible = (e: Element) => (e as HTMLElement).getClientRects().length > 0;

/** Elements that can be a row or box on screen, for finding one by its text. */
export const BOX = "div, p, li, tr, td, section, article, span, a, button, label, dd, dt";

/** A ringed element and how to find it again after the page re-renders it. */
interface Target {
  el: Element;
  tag: string;
  cls: string;
  text: string;
}

const signature = (el: Element): Target => ({ el, tag: el.tagName, cls: el.getAttribute("class") ?? "", text: (el.textContent ?? "").slice(0, 60) });

export class Driver {
  frames: [HTMLIFrameElement | null, HTMLIFrameElement | null] = [null, null];
  paused = false;
  stopped = false;
  private skip = false;
  /** What the run is waiting for, shown in the caption (e.g. a model call's seconds). */
  status: (() => string) | null = null;
  /** Shared between steps. */
  lotRef = "B-052";
  dealPath = "";
  private targets: [Target | null, Target | null] = [null, null];
  private raf = 0;

  constructor() {
    const loop = () => {
      for (const p of [0, 1] as const) this.placeRing(p);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
  }

  /** Ends the current hold early ("Next"). */
  next() {
    this.skip = true;
  }

  win(p: Pane): Window {
    const w = this.frames[p]?.contentWindow;
    if (!w || this.stopped) throw new Stopped();
    return w;
  }

  doc(p: Pane): Document {
    return this.win(p).document;
  }

  path(p: Pane): string {
    try {
      return unseat(this.win(p).location.pathname);
    } catch (e) {
      if (e instanceof Stopped) throw e;
      return "";
    }
  }

  text(p: Pane): string {
    return this.doc(p).body?.innerText ?? "";
  }

  private async tick() {
    if (this.stopped) throw new Stopped();
    while (this.paused) {
      await sleep(100);
      if (this.stopped) throw new Stopped();
    }
  }

  async sleep(ms: number) {
    let left = ms;
    while (left > 0) {
      await this.tick();
      const t = Math.min(100, left);
      await sleep(t);
      left -= t;
    }
  }

  /** Waits for the viewer to read; "Next" ends it early. Paused time does not count. */
  async hold(ms: number) {
    this.skip = false;
    let left = ms;
    while (left > 0 && !this.skip) {
      await this.tick();
      const t0 = Date.now();
      await sleep(100);
      left -= Math.min(300, Date.now() - t0);
    }
    this.skip = false;
  }

  async until<T>(fn: () => T | null | undefined | false, timeout = 30_000, what = "the page"): Promise<T> {
    let waited = 0;
    for (;;) {
      await this.tick();
      let v: T | null | undefined | false = null;
      try {
        v = fn();
      } catch (e) {
        if (e instanceof Stopped || e instanceof Failed) throw e;
      }
      if (v) return v as T;
      if (waited > timeout) throw new Error(`Timed out waiting for ${what}`);
      await sleep(150);
      waited += 150;
    }
  }

  /** Adds the cursor, ring and pane styles to a freshly loaded page, and answers its confirm dialogs. */
  private prep(p: Pane) {
    const w = this.win(p) as Window & { confirm: (m?: string) => boolean };
    const d = w.document;
    if (!d.getElementById("story-style")) {
      const s = d.createElement("style");
      s.id = "story-style";
      s.textContent = PANE_CSS;
      d.head.appendChild(s);
    }
    if (!d.getElementById("story-cursor")) {
      const c = d.createElement("div");
      c.id = "story-cursor";
      c.innerHTML = CURSOR_SVG;
      c.style.left = `${w.innerWidth * 0.55}px`;
      c.style.top = `${w.innerHeight * 0.6}px`;
      d.body.appendChild(c);
    }
    w.confirm = () => true;
  }

  private loaded(p: Pane) {
    const d = this.doc(p);
    const w = this.win(p) as Window & { __storyStale?: boolean };
    if (w.__storyStale || d.readyState !== "complete" || !d.querySelector("main")) return false;
    // Suspense fallbacks show "Loading…" until the page has streamed in.
    return ![...d.querySelectorAll('[role="status"]')].some((e) => e.textContent?.trim() === "Loading…");
  }

  /** Waits for whatever the pane is loading. */
  async ready(p: Pane, text?: string) {
    await this.until(() => this.loaded(p) && (!text || this.text(p).includes(text)), 45_000, text ? `"${text}"` : "the page to load");
    this.prep(p);
  }

  /** Opens a page in a pane, as that pane's account. */
  async go(p: Pane, path: string, text?: string) {
    this.clear(p);
    const w = this.win(p) as Window & { __storyStale?: boolean };
    w.__storyStale = true;
    w.location.assign(atSeat((p + 1) as Seat, path));
    await this.ready(p, text);
  }

  /** The first visible element matching the selector whose text contains every given string. */
  find<E extends HTMLElement = HTMLElement>(p: Pane, sel: string, text?: string | string[], within?: Element | null): E | null {
    const texts = text === undefined ? [] : Array.isArray(text) ? text : [text];
    const root = within ?? this.doc(p);
    for (const e of root.querySelectorAll<E>(sel)) {
      if (visible(e) && texts.every((t) => (e.textContent ?? "").includes(t))) return e;
    }
    return null;
  }

  /** The smallest visible element matching the selector that contains every given string: the row or box that says it. */
  block<E extends HTMLElement = HTMLElement>(p: Pane, sel: string, text: string | string[], within?: Element | null): E | null {
    const texts = Array.isArray(text) ? text : [text];
    let best: E | null = null;
    for (const e of (within ?? this.doc(p)).querySelectorAll<E>(sel)) {
      const t = e.textContent ?? "";
      if (visible(e) && texts.every((x) => t.includes(x)) && (!best || t.length < (best.textContent ?? "").length)) best = e;
    }
    return best;
  }

  get<E extends HTMLElement = HTMLElement>(p: Pane, sel: string, text?: string | string[], within?: Element | null, timeout = 20_000) {
    return this.until(() => this.find<E>(p, sel, text, within), timeout, text ? `"${[text].flat().join(" ")}"` : sel);
  }

  getBlock<E extends HTMLElement = HTMLElement>(p: Pane, sel: string, text: string | string[], timeout = 20_000) {
    return this.until(() => this.block<E>(p, sel, text), timeout, `"${[text].flat().join(" ")}"`);
  }

  private placeRing(p: Pane) {
    const target = this.targets[p];
    let d: Document;
    try {
      d = this.doc(p);
    } catch {
      return;
    }
    const ring = d.getElementById("story-ring");
    if (target && !target.el.isConnected) {
      // A refresh replaced the element: ring the one that took its place.
      const again = target.text.trim()
        ? [...d.getElementsByTagName(target.tag)].find((e) => (e.getAttribute("class") ?? "") === target.cls && (e.textContent ?? "").startsWith(target.text))
        : undefined;
      if (again) target.el = again;
    }
    if (!target || !target.el.isConnected) {
      if (ring) ring.style.opacity = "0";
      return;
    }
    const r = target.el.getBoundingClientRect();
    let el = ring;
    if (!el) {
      el = d.createElement("div");
      el.id = "story-ring";
      d.body.appendChild(el);
    }
    const pad = 6;
    Object.assign(el.style, { opacity: "1", left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  }

  clear(p: Pane) {
    this.targets[p] = null;
  }

  /** Scrolls an element into view and rings it. */
  async point(p: Pane, el: Element, opts: { cursor?: boolean } = {}) {
    this.prep(p);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await this.sleep(550);
    this.targets[p] = signature(el);
    if (opts.cursor) await this.moveCursor(p, el);
    else await this.sleep(300);
  }

  private async moveCursor(p: Pane, el: Element) {
    const c = this.doc(p).getElementById("story-cursor");
    if (!c) return;
    const r = el.getBoundingClientRect();
    c.style.left = `${r.left + Math.min(r.width / 2, 40)}px`;
    c.style.top = `${r.top + r.height / 2}px`;
    await this.sleep(800);
  }

  /** Points at an element with the cursor and clicks it. */
  async click(p: Pane, el: HTMLElement) {
    await this.point(p, el, { cursor: true });
    const c = this.doc(p).getElementById("story-cursor");
    c?.classList.remove("click");
    void c?.offsetWidth;
    c?.classList.add("click");
    await this.sleep(250);
    this.prep(p);
    el.click();
    await this.sleep(350);
  }

  /** Types into a text field at a steady pace, so React sees each change. */
  async type(p: Pane, el: HTMLTextAreaElement | HTMLInputElement, text: string, charsPerSecond = 70) {
    await this.point(p, el, { cursor: true });
    el.focus();
    // The field lives in the pane's window, so its own prototypes have the value setter React listens to.
    const view = (el.ownerDocument.defaultView ?? window) as typeof window;
    const proto = el.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    // Paced by the clock, not by timers, so a busy or background tab types in bigger steps instead of slower.
    let shown = 0;
    let typing = 0;
    while (shown < text.length) {
      const t0 = Date.now();
      await this.sleep(30);
      typing += Math.min(200, Date.now() - t0); // a pause in between does not count
      shown = Math.min(text.length, Math.round((typing / 1000) * charsPerSecond));
      set?.call(el, text.slice(0, shown));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.scrollTop = el.scrollHeight;
    }
    set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
