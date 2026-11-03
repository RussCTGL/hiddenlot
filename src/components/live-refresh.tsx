"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 8_000;

/**
 * Re-renders the open page from the server every few seconds while it is in
 * view, and at once when the tab comes back, so what another account did
 * (a buyer's question, a seller's answer) shows without reloading. It waits
 * while someone is typing, so a refresh never interrupts a form.
 */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    };
    const tick = () => {
      if (document.visibilityState === "visible" && !typing()) router.refresh();
    };
    const timer = setInterval(tick, EVERY_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [router]);
  return null;
}
