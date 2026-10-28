// Runs once when the server starts. In a container the demo may need to be
// seeded on first start, and a public demo is reseeded periodically so its
// stock confirmations never go stale (see README, Docker).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDemoMaintenance } = await import("./lib/demo-maintenance");
  await startDemoMaintenance();
}
