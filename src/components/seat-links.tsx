"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { atSeat, SEAT2 } from "@/lib/seat";

/**
 * On a /seat2 page (the second account of the side-by-side demo), keeps every
 * in-app link under /seat2 so the pane stays signed in as that account.
 * Elsewhere it does nothing.
 */
export function SeatLinks() {
  const router = useRouter();
  useEffect(() => {
    const inSeat2 = () => location.pathname === SEAT2 || location.pathname.startsWith(`${SEAT2}/`);
    if (!inSeat2()) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !(e.target instanceof Element)) return;
      const a = e.target.closest("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_top" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === SEAT2 || url.pathname.startsWith(`${SEAT2}/`) || url.pathname.startsWith("/_next/")) return;
      e.preventDefault();
      e.stopPropagation();
      const to = atSeat(2, url.pathname) + url.search + url.hash;
      if (a.target === "_blank") window.open(to, "_blank", "noopener");
      else router.push(to);
    };
    // Capture, so this runs before Next's own link handling.
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [router]);
  return null;
}
