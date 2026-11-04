import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { getDb } from "@/db/server";
import { demoLoaded, seatSession } from "@/lib/session";
import { DemoSplit, type PaneAccount } from "./split";

export const metadata: Metadata = { title: "Two accounts side by side" };

// The demo with two accounts on one screen: each pane is the whole app, signed
// in on its own seat (src/lib/seat.ts), so what one side does shows on the other.

export default function DemoPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Demo />
    </Suspense>
  );
}

async function Demo() {
  if (!(await demoLoaded())) return <DemoSplit accounts={[]} seats={[null, null]} />;
  const accounts = await (await getDb()).query<PaneAccount & { id: string }>(
    `SELECT u.id, u.username, u.name, n.alias, u.simulated FROM users u JOIN networks n ON n.id = u.network_id
      WHERE u.username IS NOT NULL ORDER BY u.simulated, n.alias, u.username`,
  );
  const [a, b] = await Promise.all([seatSession(1), seatSession(2)]);
  const username = (id?: string) => accounts.find((x) => x.id === id)?.username ?? null;
  return <DemoSplit accounts={accounts} seats={[username(a?.user.id), username(b?.user.id)]} />;
}
