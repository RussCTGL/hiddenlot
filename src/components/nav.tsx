"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { unseat } from "@/lib/seat";

const NAV = [
  ["/", "Today"],
  ["/deals", "Deals"],
  ["/requests", "Requests"],
  ["/inventory", "Inventory"],
  ["/intake", "Intake"],
  ["/opportunities", "Opportunities"],
  ["/demands", "Demands"],
  ["/sharing", "Sharing"],
  ["/activity", "Activity"],
] as const;

/** On wide screens the first ones are links and the rest sit under "More", so the header stays one line. */
const MAIN = 5;

/** `children` (e.g. the signed-in account) go inside the phone menu; `requests` is the count shown on Requests. */
export function Nav({ children, requests }: { children?: ReactNode; requests?: ReactNode }) {
  return (
    <NavLinks path={unseat(usePathname())} requests={requests}>
      {children}
    </NavLinks>
  );
}

/** Without a path nothing is highlighted; used as the Suspense fallback while the path streams in. */
export function NavLinks({ path, children, requests }: { path: string; children?: ReactNode; requests?: ReactNode }) {
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href) || (href === "/intake" && path.startsWith("/documents")));
  const current = NAV.find(([href]) => isOn(href));
  const links = NAV.map(([href, label]) => {
    const on = isOn(href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={on ? "page" : undefined}
        className={`rounded-md px-2.5 py-2 whitespace-nowrap ${on ? "bg-zinc-100 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"}`}
      >
        {label}
        {href === "/requests" && requests}
      </Link>
    );
  });
  const moreOn = NAV.slice(MAIN).some(([href]) => isOn(href));
  return (
    <>
      <nav className="hidden flex-1 items-center gap-0.5 text-sm md:flex">
        {links.slice(0, MAIN)}
        <details key={path} className="group relative">
          <summary
            className={`inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-2.5 py-2 ${moreOn ? "bg-zinc-100 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"}`}
          >
            {moreOn ? NAV.find(([href]) => isOn(href))?.[1] : "More"}
            <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="transition group-open:rotate-180">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <div className="absolute top-11 left-0 z-20 flex w-48 flex-col rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">{links.slice(MAIN)}</div>
        </details>
      </nav>
      {/* Phones: one menu button instead of a wrapped row of links. */}
      <details key={path} className="relative ml-auto text-sm md:hidden">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-zinc-300 px-3 font-medium dark:border-zinc-700">
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
          {/* The page name only where it fits next to the logo; "Opportunities" wraps the header on phones. */}
          <span className="sm:hidden">Menu</span>
          <span className="hidden sm:inline">{current?.[1] ?? "Menu"}</span>
        </summary>
        <div className="absolute top-12 right-0 z-20 flex w-64 flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <nav className="flex flex-col">{links}</nav>
          {children && <div className="border-t border-zinc-100 px-2.5 pt-2.5 pb-1.5 dark:border-zinc-800">{children}</div>}
        </div>
      </details>
    </>
  );
}
