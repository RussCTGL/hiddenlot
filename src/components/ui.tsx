import Link from "next/link";
import type { ReactNode } from "react";
import type { CheckStatus, CompatibilityStatus } from "@/discovery/constraints";
import { STATUS_LABEL } from "@/discovery/constraints";

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </main>
  );
}

export function Card({ title, children, className = "", aside }: { title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS_STYLE: Record<CompatibilityStatus, string> = {
  evidence_supported: "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800",
  declared_match: "bg-teal-100 text-teal-900 ring-teal-300 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800",
  conditional_candidate: "bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800",
  engineering_review_required: "bg-violet-100 text-violet-900 ring-violet-300 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800",
  insufficient_evidence: "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800",
  incompatible: "bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800",
};

export function StatusPill({ status }: { status: CompatibilityStatus }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

const CHECK_STYLE: Record<CheckStatus, [string, string]> = {
  pass: ["✓", "text-emerald-700 dark:text-emerald-400"],
  conditional: ["◐", "text-sky-700 dark:text-sky-400"],
  review: ["⚑", "text-violet-700 dark:text-violet-400"],
  unknown: ["?", "text-amber-700 dark:text-amber-400"],
  fail: ["✕", "text-rose-700 dark:text-rose-400"],
  not_checked: ["–", "text-zinc-500"],
};

export function CheckIcon({ status }: { status: CheckStatus }) {
  const [glyph, cls] = CHECK_STYLE[status];
  return (
    <span className={`inline-block w-5 text-center font-bold ${cls}`} aria-label={status}>
      {glyph}
    </span>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "amber" | "rose" | "emerald" | "sky" | "violet" }) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    rose: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
    emerald: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    sky: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
    violet: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Unknown({ reason }: { reason?: string }) {
  return (
    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800" title={reason}>
      Unknown{reason ? ` · ${reason}` : ""}
    </span>
  );
}

export function ButtonLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={
        primary
          ? "inline-flex items-center rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          : "inline-flex items-center rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }
    >
      {children}
    </Link>
  );
}

export const buttonCls =
  "inline-flex items-center rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";
export const primaryCls =
  "inline-flex items-center rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
export const dangerCls =
  "inline-flex items-center rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950";
export const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-zinc-500">{label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">{children}</p>;
}
