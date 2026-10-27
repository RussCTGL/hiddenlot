import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { ActorSwitcher } from "@/components/actor-switcher";
import { LogoIcon } from "@/components/icons";
import { Nav, NavLinks } from "@/components/nav";
import { getDb } from "@/db/server";
import { listNetworks } from "@/db/repo";
import { getSession, listDemoUsers } from "@/lib/session";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["500"] });

export const metadata: Metadata = {
  title: "HiddenLot",
  description: "Evidence-backed discovery of surplus steel supply across authorized trade networks.",
};

async function Header() {
  const session = await getSession();
  const users = await listDemoUsers().catch(() => []);
  const networks = new Map((await listNetworks(await getDb()).catch(() => [])).map((n) => [n.id, n.alias]));
  return (
    <ActorSwitcher
      users={users.map((u) => ({ id: u.id, name: u.name.replace(/\s*\(fictional\)/, ""), network: networks.get(u.network_id) ?? u.network_id }))}
      current={session?.user.id ?? ""}
    />
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
            <Suspense fallback={<NavLinks path="" />}>
              <Nav />
            </Suspense>
            <span
              title="Every network, company, lot, price and certificate here is fictional. Not trading or engineering advice."
              className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              Synthetic demo
            </span>
            <Suspense fallback={<span className="text-xs text-zinc-400">…</span>}>
              <Header />
            </Suspense>
          </div>
        </header>
        {children}
        <footer className="border-t border-zinc-200 px-4 py-5 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Fictional data · Rules decide matches · Meta reads and cites · Scores rank review, not deals · Not trading or engineering advice
        </footer>
      </body>
    </html>
  );
}
