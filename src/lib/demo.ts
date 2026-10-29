import "server-only";

// Deployment switches for the demo. Locally everything is on; a public
// deployment turns the shared-state controls off (see README, Docker).

/** Reset demo and the demo clock. Off by default in production so visitors cannot wipe the shared demo. */
export const demoControlsAllowed = () => (process.env.HIDDENLOT_ALLOW_RESET ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";

/** Paid Meta calls allowed per UTC day; null = no cap. */
export const metaDailyLimit = () => limitFrom(process.env.HIDDENLOT_META_DAILY_LIMIT);

/** Paid Meta calls one visitor may make per UTC day; null = no cap. */
export const metaVisitorLimit = () => limitFrom(process.env.HIDDENLOT_META_VISITOR_LIMIT);

function limitFrom(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
