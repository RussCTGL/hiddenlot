import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { reconfirmForBuyerAction, replyToBuyerAction, sendOfferAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, buttonCls, Card, Empty, inputCls, Loading, Page, primaryCls } from "@/components/ui";
import { getDb } from "@/db/server";
import { requireSession } from "@/lib/session";
import { listRequestsForSeller, STAGE_LABEL, type BuyerRequest } from "@/workflow/deals";
import { listOrdersForSeller } from "@/workflow/orders";

export const metadata: Metadata = { title: "Requests" };

export default function RequestsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Requests />
    </Suspense>
  );
}

async function Requests() {
  const { actor, network } = await requireSession();
  const db = await getDb();
  const [requests, orders] = await Promise.all([listRequestsForSeller(db, actor), listOrdersForSeller(db, actor)]);
  const open = requests.filter((r) => r.needsReply).length;
  return (
    <Page
      title="Requests"
      subtitle={`${network.alias} · buyers asking about your published lots. They see your answer on their deal at once; their demand stays private.`}
    >
      {orders.length > 0 && (
        <Card title="Orders" aside={<span className="font-mono text-xs text-zinc-500">{orders.length}</span>} className="mb-4">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {orders.map((o) => (
              <li key={o.dealId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">
                    {o.buyer} · lot {o.lotRef}
                  </span>
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{o.title}</span>
                  <span className="block text-xs text-zinc-600 dark:text-zinc-400">{o.next ? `Next: ${o.next}` : STAGE_LABEL[o.stage]}</span>
                </span>
                {o.yourTurn && <Badge tone="amber">your turn</Badge>}
                <Link href={`/deals/${o.dealId}`} className={o.yourTurn ? primaryCls : buttonCls}>
                  Open order
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {requests.length === 0 ? (
        <Empty>
          No buyer has asked about your lots yet. Questions and quote requests on lots you share show up here.{" "}
          <Link href="/sharing" className="text-accent hover:underline">
            Sharing
          </Link>
        </Empty>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{open === 0 ? "Everything is answered." : `${open} waiting for your answer.`}</p>
          {requests.map((r) => (
            <RequestCard key={r.dealId} r={r} />
          ))}
        </div>
      )}
    </Page>
  );
}

const label = "space-y-1.5 text-[13px] text-zinc-600 dark:text-zinc-400";

function RequestCard({ r }: { r: BuyerRequest }) {
  const at = r.at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {r.buyer} · lot {r.lotRef}
          {r.needsReply && <Badge tone="amber">needs your answer</Badge>}
        </span>
      }
      aside={<span className="text-xs text-zinc-500 dark:text-zinc-400">{STAGE_LABEL[r.stage]}</span>}
    >
      <div id={`req-${r.dealId}`} className="scroll-mt-24 space-y-4">
        <div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{r.lotTitle}</p>
          <p className="mt-1.5 text-sm font-medium">{r.request}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Latest: {r.latest} · {at}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ActionForm action={replyToBuyerAction} className="space-y-2">
            <input type="hidden" name="deal_id" value={r.dealId} />
            <label className={`block ${label}`}>
              <span>Reply</span>
              <textarea name="reply" required rows={3} maxLength={1000} className={inputCls} placeholder="e.g. Yes, still available. Produced to GB/T 700-2006, MTC available." />
            </label>
            <div className="flex flex-wrap gap-2">
              <Submit className={primaryCls} pending="Sending…">
                Send reply
              </Submit>
            </div>
          </ActionForm>

          <ActionForm action={sendOfferAction} className="space-y-2">
            <input type="hidden" name="deal_id" value={r.dealId} />
            <div className="grid grid-cols-3 gap-2">
              <label className={label}>
                <span>Price per MT</span>
                <input name="price" inputMode="decimal" required defaultValue={r.quote?.price ?? ""} className={inputCls} placeholder="e.g. 545" />
              </label>
              <label className={label}>
                <span>Currency</span>
                <input name="currency" defaultValue={r.quote?.currency ?? "USD"} className={inputCls} />
              </label>
              <label className={label}>
                <span>Quantity, t</span>
                <input name="quantity_t" inputMode="decimal" defaultValue={r.quote?.quantity_t ?? ""} className={inputCls} />
              </label>
              <label className={`col-span-2 ${label}`}>
                <span>Incoterm and place</span>
                <input name="incoterm" defaultValue={r.quote?.incoterm ?? ""} className={inputCls} placeholder="e.g. CFR Haiphong" />
              </label>
              <label className={label}>
                <span>Valid until</span>
                <input name="valid_until" type="date" defaultValue={r.quote?.valid_until ?? ""} className={inputCls} />
              </label>
            </div>
            <Submit className={buttonCls} pending="Sending…">
              {r.quote ? "Send a new offer" : "Send offer"}
            </Submit>
          </ActionForm>
        </div>

        <ActionForm action={reconfirmForBuyerAction} className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <input type="hidden" name="deal_id" value={r.dealId} />
          <Submit className={buttonCls} pending="…">
            Still available
          </Submit>
          <span className="ml-3 text-xs text-zinc-500 dark:text-zinc-400">Reconfirms lot {r.lotRef} for every buyer and tells {r.buyer}.</span>
        </ActionForm>
      </div>
    </Card>
  );
}
