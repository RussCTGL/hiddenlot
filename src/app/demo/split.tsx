"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { signInPaneAction } from "@/app/actions";
import { LogoIcon } from "@/components/icons";
import { atSeat, unseat, type Seat } from "@/lib/seat";

export interface PaneAccount {
  username: string;
  name: string;
  alias: string;
  simulated: boolean;
}

/** Who each pane starts as when it is not signed in yet: the buyer and the seller of the demo's order. */
const DEFAULTS = ["ana", "bo"] as const;

const short = (a: PaneAccount) => `${a.name.replace(/\s*\(fictional\)/, "").split(" · ")[0]} · ${a.alias}`;
const btn =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";

export function DemoSplit({ accounts, seats }: { accounts: PaneAccount[]; seats: [string | null, string | null] }) {
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  // Bumped to reload a pane after its account changes.
  const [loads, setLoads] = useState([0, 0]);
  const reload = (i: number) => setLoads((l) => l.map((n, j) => (j === i ? n + 1 : n)));

  /** Opens in the other pane the page this one shows, e.g. the same deal as seen by the other side. */
  const mirror = (from: number) => {
    const src = frames[from].current?.contentWindow?.location;
    const to = frames[1 - from].current?.contentWindow;
    if (!src || !to) return;
    to.location.assign(atSeat((2 - from) as Seat, unseat(src.pathname)) + src.search);
  };

  if (accounts.length === 0) {
    return (
      <Shell>
        <p className="m-auto text-sm text-zinc-600 dark:text-zinc-400">
          No demo data loaded yet.{" "}
          <Link href="/" className="text-accent hover:underline">
            Load it first
          </Link>
          .
        </p>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-2 p-2 lg:grid-cols-2 lg:grid-rows-1">
        {([0, 1] as const).map((i) => (
          <section key={i} className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <PaneBar seat={(i + 1) as Seat} accounts={accounts} current={seats[i]} fallback={DEFAULTS[i]} onSignedIn={() => reload(i)}>
              <button type="button" className={btn} onClick={() => mirror(i)} title="Open this page in the other pane, as the other account">
                {i === 0 ? "Same page →" : "← Same page"}
              </button>
              <button type="button" className={btn} onClick={() => reload(i)} title="Back to Today">
                Today
              </button>
            </PaneBar>
            <iframe
              key={`${seats[i]}-${loads[i]}`}
              ref={frames[i]}
              src={atSeat((i + 1) as Seat, "/")}
              title={`Pane ${i + 1}`}
              className="min-h-0 w-full flex-1 border-0 bg-zinc-50 dark:bg-zinc-950"
            />
          </section>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  // Covers the app's own header and footer: here each pane has its own.
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-100 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <Link href="/" target="_top" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="text-accent">
            <LogoIcon size={20} />
          </span>
          HiddenLot
        </Link>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">Two accounts side by side: what one saves, the other sees within seconds.</span>
        <span className="ml-auto rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">Synthetic demo</span>
      </header>
      {children}
    </div>
  );
}

function PaneBar({
  seat,
  accounts,
  current,
  fallback,
  onSignedIn,
  children,
}: {
  seat: Seat;
  accounts: PaneAccount[];
  current: string | null;
  fallback: string;
  onSignedIn: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const signIn = (username: string) =>
    start(async () => {
      const fd = new FormData();
      fd.set("seat", String(seat));
      fd.set("username", username);
      const r = await signInPaneAction(fd);
      setError(r?.error ?? null);
      if (!r?.error) {
        onSignedIn();
        router.refresh();
      }
    });
  // A pane nobody is signed in to yet starts as the demo's buyer (left) or seller (right).
  const started = useRef(false);
  useEffect(() => {
    if (current || started.current || !accounts.some((a) => a.username === fallback)) return;
    started.current = true;
    signIn(fallback);
  });
  const groups = [
    ["Walkthrough accounts", accounts.filter((a) => !a.simulated)],
    ["Simulated users", accounts.filter((a) => a.simulated)],
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">{seat === 1 ? "Left" : "Right"}</span>
        <select
          value={current ?? ""}
          disabled={pending}
          onChange={(e) => e.target.value && signIn(e.target.value)}
          className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-sm font-medium text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          aria-label={`Account in the ${seat === 1 ? "left" : "right"} pane`}
        >
          {!current && <option value="">{pending ? "Signing in…" : "Choose an account"}</option>}
          {groups.map(([label, list]) => (
            <optgroup key={label} label={label}>
              {list.map((a) => (
                <option key={a.username} value={a.username}>
                  {short(a)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {error && <span className="text-xs text-rose-700 dark:text-rose-400">{error}</span>}
      <span className="ml-auto flex gap-1.5">{children}</span>
    </div>
  );
}
