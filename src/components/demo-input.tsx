"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { atSeat, SEAT2 } from "@/lib/seat";

// Demo helpers: fill a form with sample values in one click, and bind a
// generated demo file to a form's file field, so a walkthrough never waits on
// typing or on finding a file. Nothing is sent until the form is submitted.

export type DemoValues = Record<string, string | boolean | string[]>;

const ghost =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-violet-300 px-2.5 text-xs font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950";

function Spark() {
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
    </svg>
  );
}

/** "+14d" in a date field means 14 days from today. */
const relativeDay = (v: string) => {
  const m = /^\+(\d+)d$/.exec(v);
  return m ? new Date(Date.now() + Number(m[1]) * 86_400_000).toISOString().slice(0, 10) : v;
};

/** Sets a field the way typing would, so React and the browser both see the change. */
function setField(el: Element, value: string | boolean | string[]) {
  if (typeof value === "string") value = relativeDay(value);
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = Array.isArray(value) ? value.includes(el.value) : typeof value === "boolean" ? value : el.value === value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, String(value));
  } else return;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** A "Demo input" button that fills the fields of the form it sits in. */
export function DemoFill({ values, label = "Demo input" }: { values: DemoValues; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={ghost}
      title="Fill this form with sample values (you can still edit them)"
      onClick={() => {
        const form = ref.current?.closest("form");
        if (!form) return;
        for (const [name, value] of Object.entries(values)) {
          form.querySelectorAll(`[name="${CSS.escape(name)}"]`).forEach((el) => setField(el, value));
        }
        form.querySelector<HTMLElement>("button[type=submit]")?.focus();
      }}
    >
      <Spark />
      {label}
    </button>
  );
}

/** The URL as seen from this pane: under /seat2 in the second pane of /demo. */
const fromHere = (path: string) => (location.pathname === SEAT2 || location.pathname.startsWith(`${SEAT2}/`) ? atSeat(2, path) : path);

/**
 * Binds a generated demo file to the form's file field as soon as it shows,
 * and again on request (for example after the form was sent and cleared).
 */
export function DemoFile({ src, field = "file", auto = true }: { src: string; field?: string; auto?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<{ name?: string; error?: string; busy?: boolean }>({});
  const last = useRef<string | null>(null);
  const bind = useCallback(async () => {
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>(`input[type=file][name="${CSS.escape(field)}"]`);
    if (!input) return;
    setState({ busy: true });
    try {
      const res = await fetch(fromHere(src), { cache: "no-store" });
      if (!res.ok) throw new Error(`demo file: ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "demo-file";
      const blob = await res.blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: blob.type }));
      input.files = dt.files;
      last.current = name;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      setState({ name });
    } catch {
      setState({ error: "Demo file not available" });
    }
  }, [src, field]);

  useEffect(() => {
    const form = ref.current?.closest("form");
    const input = form?.querySelector<HTMLInputElement>(`input[type=file][name="${CSS.escape(field)}"]`);
    if (!form || !input) return;
    // The form clears itself after it is sent, and someone may pick their own file: then the demo file is gone.
    const check = () => {
      if (input.files?.[0]?.name !== last.current) setState({});
    };
    const cleared = () => {
      last.current = null;
      setState({});
    };
    form.addEventListener("reset", cleared);
    input.addEventListener("change", check);
    return () => {
      form.removeEventListener("reset", cleared);
      input.removeEventListener("change", check);
    };
  }, [field]);

  // Bind once when the field first shows.
  const bound = useRef(false);
  useEffect(() => {
    if (bound.current || !auto) return;
    bound.current = true;
    void bind();
  }, [bind, auto]);

  return (
    <span ref={ref} className="inline-flex flex-wrap items-center gap-2 text-xs">
      {state.name ? (
        <span className="inline-flex items-center gap-1.5 text-violet-700 dark:text-violet-300">
          <Spark />
          Demo file attached: <b className="font-medium">{state.name}</b>
        </span>
      ) : (
        <button type="button" className={ghost} onClick={() => void bind()} disabled={state.busy}>
          <Spark />
          {state.busy ? "Attaching…" : "Use demo file"}
        </button>
      )}
      {state.error && <span className="text-rose-700 dark:text-rose-400">{state.error}</span>}
    </span>
  );
}
