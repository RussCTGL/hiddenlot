import { addDealFileAction, completeStepAction, declineOrderAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { CiteIcon } from "@/components/icons";
import { Badge, buttonCls, Card, dangerCls, inputCls, primaryCls } from "@/components/ui";
import { FILE_ACCEPT, MAX_FILE_BYTES, type DealFile, type OrderView } from "@/workflow/orders";

// The order both sides share once the buyer accepts an offer: each step, who
// does it, what they attached, and the form for the step that is the viewer's.

const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function FileLink({ dealId, f }: { dealId: string; f: DealFile }) {
  return (
    <a href={`/deals/${dealId}/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-accent hover:underline">
      <CiteIcon size={14} />
      {f.filename}
    </a>
  );
}

export function OrderPanel({ dealId, v }: { dealId: string; v: OrderView }) {
  const other = v.side === "buyer" ? v.seller : v.buyer;
  const q = v.quote;
  return (
    <Card
      title={v.stage === "won" ? "Order complete" : "Order in progress"}
      aside={
        v.waitingOn === "you" ? <Badge tone="amber">your turn</Badge> : v.waitingOn === "them" ? <span className="text-xs text-zinc-500 dark:text-zinc-400">waiting for {other}</span> : <Badge tone="emerald">done</Badge>
      }
    >
      <p className="mb-4 text-sm text-zinc-700 dark:text-zinc-300">
        {v.buyer} buys from {v.seller}
        {q && (
          <>
            {" "}
            at <b className="font-mono font-medium">{q.currency} {q.price}/MT</b> {q.incoterm}
            {q.quantity_t ? `, ${q.quantity_t} t` : ""}
          </>
        )}
        . Both sides see every step and file as soon as it is saved.
      </p>
      <ol className="space-y-0">
        {v.steps.map((s, i) => {
          const mine = s.by === v.side;
          const files = v.files.filter((f) => f.step === s.id);
          return (
            <li key={s.id} className="relative flex gap-3 pb-5 last:pb-0">
              {i < v.steps.length - 1 && <span className={`absolute top-6 left-[11px] h-[calc(100%-1.5rem)] w-0.5 ${s.done ? "bg-emerald-600" : "bg-zinc-200 dark:bg-zinc-800"}`} aria-hidden />}
              <span
                className={`relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-emerald-600 text-white" : s.next ? "bg-accent text-white" : "border border-zinc-300 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"}`}
                aria-hidden
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className={s.done || s.next ? "font-semibold" : "text-zinc-500 dark:text-zinc-400"}>{s.label}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{s.by === "buyer" ? v.buyer : v.seller}{mine ? " (you)" : ""}</span>
                </p>
                {s.done && (
                  <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                    {s.done.who} · {when(s.done.at)}
                    {s.done.note ? ` · ${s.done.note}` : ""}
                  </p>
                )}
                {files.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                    {files.map((f) => (
                      <FileLink key={f.id} dealId={dealId} f={f} />
                    ))}
                  </p>
                )}
                {s.next && !mine && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Waiting for {other}.</p>}
                {s.next && mine && (
                  <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{s.hint}</p>
                    <ActionForm action={completeStepAction} className="space-y-2">
                      <input type="hidden" name="deal_id" value={dealId} />
                      <input type="hidden" name="step" value={s.id} />
                      <input name="note" maxLength={500} className={inputCls} placeholder={s.id === "shipped" ? "B/L number, vessel" : s.id === "payment" ? "e.g. L/C no. or transfer reference" : "Note (optional)"} />
                      {s.id !== "confirmed" && s.id !== "received" && <input type="file" name="file" accept={FILE_ACCEPT} className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs dark:file:border-zinc-700 dark:file:bg-zinc-900" />}
                      <Submit className={primaryCls} pending="Saving…" confirm={s.id === "confirmed" ? "Confirm this order? The lot is marked sold and other buyers' deals on it close." : undefined}>
                        {s.id === "confirmed" ? "Confirm order" : s.id === "received" ? "Confirm receipt" : "Mark done"}
                      </Submit>
                    </ActionForm>
                    {s.id === "confirmed" && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Decline the order</summary>
                        <ActionForm action={declineOrderAction} className="mt-2 flex flex-wrap gap-2">
                          <input type="hidden" name="deal_id" value={dealId} />
                          <input name="reason" required className={`${inputCls} flex-1`} placeholder="Why (e.g. sold elsewhere)" />
                          <Submit className={dangerCls}>Decline</Submit>
                        </ActionForm>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function DealFiles({ dealId, files, side, buyer, seller, canAdd }: { dealId: string; files: DealFile[]; side: "buyer" | "seller"; buyer: string; seller: string; canAdd: boolean }) {
  return (
    <Card title="Shared files" aside={<span className="font-mono text-xs text-zinc-500">{files.length}</span>}>
      {files.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No files yet. Both sides see what is shared here.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2">
              <FileLink dealId={dealId} f={f} />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {f.side === side ? "you" : f.side === "buyer" ? buyer : seller} · {f.who} · {kb(f.size_bytes)} · {when(f.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <ActionForm action={addDealFileAction} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <input type="hidden" name="deal_id" value={dealId} />
          <input type="file" name="file" required accept={FILE_ACCEPT} className="min-w-0 flex-1 text-xs file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs dark:file:border-zinc-700 dark:file:bg-zinc-900" />
          <Submit className={buttonCls} pending="Uploading…">
            Share file
          </Submit>
          <span className="w-full text-xs text-zinc-500 dark:text-zinc-400">PDF, image, Excel, Word, CSV or text, up to {MAX_FILE_BYTES / 1024 / 1024} MB.</span>
        </ActionForm>
      )}
    </Card>
  );
}
