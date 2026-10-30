import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { marketStepAction, shiftClockAction, signOutAction } from "@/app/actions";
import { ClockIcon, LogoIcon } from "@/components/icons";
import { Nav, NavLinks } from "@/components/nav";
import { getDb } from "@/db/server";
import { getClockOffsetHours } from "@/db/repo";
import { demoControlsAllowed } from "@/lib/demo";
import { getSession, requestNow } from "@/lib/session";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["500"] });

export const metadata: Metadata = {
  title: "HiddenLot",
  description: "Evidence-backed discovery of surplus steel supply across authorized trade networks.",
};

/** Demo only: skip ahead so freshness and follow-ups can be shown without waiting. */
async function DemoClock() {
  if (!demoControlsAllowed() || !(await getSession())) return null;
  const now = await requestNow();
  const offset = await getClockOffsetHours(await getDb());
  const btn = "inline-flex min-h-8 items-center rounded-md border border-zinc-300 bg-white px-2.5 font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <span className="inline-flex items-center gap-1.5">
        <ClockIcon size={14} />
        Demo time {now.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
        {offset > 0 && ` (+${offset} h)`}
      </span>
      <form action={shiftClockAction}>
        <button name="hours" value="24" className={btn}>
          Skip ahead 1 day
        </button>
      </form>
      {offset > 0 && (
        <form action={shiftClockAction}>
          <button name="hours" value="reset" className={btn}>
            Back to real time
          </button>
        </form>
      )}
      <form action={marketStepAction}>
        <button className={btn} title="The simulated users post stock and demands, answer questions and sell, as they would in an hour">
          Simulate 1 market hour
        </button>
      </form>
    </div>
  );
}

const SYNTHETIC = "Every network, company, lot, price and certificate here is fictional. Not trading or engineering advice.";

/** Who is signed in, with switching (back to the sign-in page) and sign-out. */
async function Account() {
  const session = await getSession();
  if (!session) {
    return (
      <Link href="/login" className="inline-flex min-h-10 items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
        Sign in
      </Link>
    );
  }
  const name = session.user.name.replace(/\s*\(fictional\)/, "").split(" · ")[0];
  return (
    <div className="flex items-center gap-1">
      <Link
        href="/login"
        title="Signed in. Switch account"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        <span className="text-zinc-500 dark:text-zinc-400">{session.network.alias}</span>
        <span className="font-medium">{name}</span>
      </Link>
      <form action={signOutAction}>
        <button className="inline-flex min-h-10 items-center rounded-lg px-2.5 text-[13px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">Sign out</button>
      </form>
    </div>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
              <span className="text-accent">
                <LogoIcon size={24} />
              </span>
              HiddenLot
            </Link>
            <span title={SYNTHETIC} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 md:hidden dark:bg-amber-950 dark:text-amber-200">
              Synthetic
            </span>
            <Suspense fallback={<NavLinks path="" />}>
              <Nav>
                <Suspense fallback={null}>
                  <Account />
                </Suspense>
              </Nav>
            </Suspense>
            <span title={SYNTHETIC} className="hidden rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 md:inline dark:bg-amber-950 dark:text-amber-200">
              Synthetic demo
            </span>
            <div className="hidden md:block">
              <Suspense fallback={<span className="text-xs text-zinc-400">…</span>}>
                <Account />
              </Suspense>
            </div>
          </div>
        </header>
        {children}
        <footer className="space-y-3 border-t border-zinc-200 px-4 py-5 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <Suspense fallback={null}>
            <DemoClock />
          </Suspense>
          <p>
            Fictional data · Rules decide matches · Meta reads and cites · Scores rank review, not deals · Not trading or engineering advice ·{" "}
            <Link href="/about" className="text-accent hover:underline">
              How it works
            </Link>
          </p>
        </footer>
      </body>
    </html>
  );
}
