import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { ActorSwitcher } from "@/components/actor-switcher";
import { getDb } from "@/db/server";
import { listNetworks } from "@/db/repo";
import { getSession, listDemoUsers } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "HiddenLot",
  description: "Evidence-backed discovery of surplus steel supply across authorized trade networks.",
};

const NAV = [
  ["/", "Overview"],
  ["/intake", "Intake"],
  ["/inventory", "Inventory"],
  ["/demands", "Demands"],
  ["/opportunities", "Opportunities"],
  ["/sharing", "Sharing"],
] as const;

async function Header() {
  const session = await getSession();
  const users = await listDemoUsers().catch(() => []);
  const networks = new Map((await listNetworks(await getDb()).catch(() => [])).map((n) => [n.id, n.alias]));
  return (
    <ActorSwitcher
      users={users.map((u) => ({ id: u.id, name: u.name, network: networks.get(u.network_id) ?? u.network_id }))}
      current={session?.user.id ?? ""}
    />
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <div className="bg-amber-100 px-4 py-1 text-center text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Synthetic demo — every network, company, lot, price and certificate here is fictional. Not trading or engineering advice.
        </div>
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-5">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                HiddenLot
              </Link>
              <nav className="flex flex-wrap gap-4 text-sm text-zinc-600 dark:text-zinc-300">
                {NAV.map(([href, label]) => (
                  <Link key={href} href={href} className="hover:text-zinc-900 dark:hover:text-white">
                    {label}
                  </Link>
                ))}
              </nav>
            </div>
            <Suspense fallback={<span className="text-xs text-zinc-400">…</span>}>
              <Header />
            </Suspense>
          </div>
        </header>
        {children}
        <footer className="border-t border-zinc-200 px-4 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800">
          Matches are decided by deterministic rules; Meta Muse Spark reads documents and cites its sources. Scores are review priority, not deal or quality probability.
        </footer>
      </body>
    </html>
  );
}
