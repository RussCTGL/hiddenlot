"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  ["/", "Overview"],
  ["/intake", "Intake"],
  ["/inventory", "Inventory"],
  ["/demands", "Demands"],
  ["/opportunities", "Opportunities"],
  ["/sharing", "Sharing"],
] as const;

export function Nav() {
  return <NavLinks path={usePathname()} />;
}

/** Without a path nothing is highlighted; used as the Suspense fallback while the path streams in. */
export function NavLinks({ path }: { path: string }) {
  return (
    <nav className="flex flex-1 flex-wrap gap-0.5 text-sm">
      {NAV.map(([href, label]) => {
        const on = href === "/" ? path === "/" : path.startsWith(href) || (href === "/intake" && path.startsWith("/documents"));
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className={`rounded-md px-2.5 py-2 ${on ? "bg-zinc-100 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
