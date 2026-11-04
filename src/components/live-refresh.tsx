"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 8_000;
// Inside the side-by-side demo (/demo) both panes are on screen at once.
const IN_FRAME_MS = 4_000;

let channel: BroadcastChannel | null | undefined;
const live = () => (channel === undefined ? (channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("hiddenlot-live")) : channel);

/** Tells this browser's other HiddenLot tabs and demo panes that something was saved, so they refresh at once. */
export function announceChange() {
  live()?.postMessage("changed");
}

/**
 * Re-renders the open page from the server every few seconds while it is in
 * view, at once when the tab comes back, and at once when another tab or pane
 * of this browser saved something, so what another account did (a buyer's
 * question, a seller's answer) shows without reloading. It waits while someone
 * is typing, so a refresh never interrupts a form.
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
    const timer = setInterval(tick, window.self === window.top ? EVERY_MS : IN_FRAME_MS);
    const ch = live();
    ch?.addEventListener("message", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      ch?.removeEventListener("message", tick);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [router]);
  return null;
}
