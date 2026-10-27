import Link from "next/link";
import type { ReactNode } from "react";
import type { CheckStatus, CompatibilityStatus } from "@/discovery/constraints";
import { STATUS_LABEL } from "@/discovery/constraints";
import { InfoIcon } from "./icons";

export function Page({ title, subtitle, actions, back, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-16 sm:px-6 sm:pt-10">
      {back && <div className="mb-4">{back}</div>}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="text-[15px] text-zinc-500 dark:text-zinc-400">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </main>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <h2 className="text-xs font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400">{children}</h2>;
}

export function Card({ title, children, className = "", aside }: { title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <Label>{title}</Label>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** Short status names for dense views; full names stay in tooltips. */
export const SHORT_STATUS: Record<CompatibilityStatus, string> = {
  evidence_supported: "Evidence-backed",
  declared_match: "Declared match",
  conditional_candidate: "Conditional",
  engineering_review_required: "Eng. review",
  insufficient_evidence: "Missing info",
  incompatible: "Fails",
};

export const STATUS_DOT: Record<CompatibilityStatus, string> = {
  evidence_supported: "bg-emerald-600",
  declared_match: "bg-teal-600",
  conditional_candidate: "bg-sky-600",
  engineering_review_required: "bg-violet-600",
  insufficient_evidence: "bg-amber-500",
  incompatible: "bg-rose-600",
};

const STATUS_STYLE: Record<CompatibilityStatus, string> = {
  evidence_supported: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  declared_match: "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  conditional_candidate: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  engineering_review_required: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  insufficient_evidence: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  incompatible: "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
};

export function StatusDot({ status, className = "size-2.5" }: { status: CompatibilityStatus; className?: string }) {
  return <span className={`inline-block shrink-0 rounded-full ${STATUS_DOT[status]} ${className}`} aria-hidden />;
}

export function StatusPill({ status }: { status: CompatibilityStatus }) {
  return (
    <span title={STATUS_LABEL[status]} className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold ${STATUS_STYLE[status]}`}>
      <StatusDot status={status} className="size-2" />
      {SHORT_STATUS[status]}
    </span>
  );
}

export type MarkKind = CheckStatus | "claim";

const MARK: Record<MarkKind, [string, string, string]> = {
  pass: ["✓", "Passes", "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"],
  claim: ["~", "Seller claim, not verified", "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-300"],
  conditional: ["~", "Conditional", "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300"],
  review: ["!", "Needs engineering review", "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300"],
  unknown: ["?", "Unknown", "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
  fail: ["×", "Fails", "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300"],
  not_checked: ["–", "Not checked", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"],
};

export const MARK_LEGEND: MarkKind[] = ["pass", "claim", "review", "unknown", "fail"];

export function Mark({ kind, title, small = false }: { kind: MarkKind; title?: string; small?: boolean }) {
  const [glyph, label, cls] = MARK[kind];
  return (
    <span
      role="img"
      aria-label={title ? `${label}: ${title}` : label}
      title={title ? `${label} · ${title}` : label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${small ? "size-[18px] text-[11px]" : "size-6 text-[13px]"} ${cls}`}
    >
      {glyph}
    </span>
  );
}

export function markLabel(kind: MarkKind) {
  return MARK[kind][1];
}

export function CheckIcon({ status }: { status: CheckStatus }) {
  return <Mark kind={status} small />;
}

export function Hint({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
      <InfoIcon size={16} label={text} />
    </span>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "amber" | "rose" | "emerald" | "sky" | "violet" }) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    amber: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    rose: "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
    emerald: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    sky: "bg-accent-soft text-accent",
    violet: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  };
  return <span className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

export function Unknown({ reason }: { reason?: string }) {
  return (
    <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200" title={reason}>
      Unknown{reason ? ` · ${reason}` : ""}
    </span>
  );
}

const btnBase = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:opacity-50";
export const buttonCls = `${btnBase} border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`;
export const primaryCls = `${btnBase} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
export const dangerCls = `${btnBase} border border-rose-300 bg-white text-rose-800 hover:bg-rose-50 dark:border-rose-800 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-rose-950`;
export const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950";

export function ButtonLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link href={href} className={primary ? primaryCls : buttonCls}>
      {children}
    </Link>
  );
}

export function Bar({ value, className = "bg-zinc-900 dark:bg-zinc-100" }: { value: number | null; className?: string }) {
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <span className={className} style={{ width: `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%` }} />
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-zinc-500">{label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">{children}</p>;
}
