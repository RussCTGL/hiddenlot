// A second signed-in account in the same browser, for the side-by-side demo
// (/demo). Pages under /seat2/… are the same pages: src/proxy.ts rewrites them
// and adds SEAT_HEADER, and the session then reads a second cookie. Links on
// those pages stay under /seat2 (components/seat-links.tsx).

export const SEAT2 = "/seat2";
export const SEAT_HEADER = "x-hl-seat";

export type Seat = 1 | 2;

/** `path` as seen from `seat`: "/deals" → "/seat2/deals" for the second seat. */
export const atSeat = (seat: Seat, path: string) => (seat === 2 ? `${SEAT2}${path === "/" ? "" : path}` : path);

/** The app path behind a /seat2 URL: "/seat2/deals" → "/deals". */
export const unseat = (path: string) => (path === SEAT2 || path.startsWith(`${SEAT2}/`) ? path.slice(SEAT2.length) || "/" : path);
