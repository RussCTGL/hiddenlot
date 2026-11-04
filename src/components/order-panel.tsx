import { addDealFileAction, completeStepAction, createProformaAction, declineOrderAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { CiteIcon } from "@/components/icons";
import { Badge, buttonCls, Card, dangerCls, inputCls, Mark, primaryCls } from "@/components/ui";
import { docIssues, type DocCheck, type FieldCheck } from "@/workflow/doc-templates";
import { FILE_ACCEPT, MAX_FILE_BYTES, type DealFile, type OrderView, type StepView } from "@/workflow/orders";

// The order both sides share once the buyer accepts an offer: each step, who
// does it, what they attached, and the form for the step that is the viewer's.
// A document attached to a step is checked against its template; both sides
// see every field as matches, differs (expected vs found, with the line it
// was read from) or not found.

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

const fileInputCls =
  "block w-full text-xs file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs dark:file:border-zinc-700 dark:file:bg-zinc-900";

const FIELD_MARK = { ok: "pass", differs: "fail", missing: "unknown" } as const;

function CheckRow({ f }: { f: FieldCheck }) {
  return (
    <li className="flex gap-2 py-1.5">
      <Mark kind={FIELD_MARK[f.status]} small />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{f.label}</span>
          {!f.required && <span className="text-zinc-500"> (optional)</span>}
          {f.status === "ok" && f.found && <span className="text-zinc-600 dark:text-zinc-400"> · {f.found}</span>}
          {f.status === "differs" && (
            <span className="text-rose-800 dark:text-rose-300">
              {" "}
              · expected <b className="font-mono font-medium">{f.expected}</b> from {f.source}, found <b className="font-mono font-medium">{f.found}</b>
            </span>
          )}
          {f.status === "missing" && <span className="text-amber-800 dark:text-amber-300"> · not found{f.expected ? ` (expected ${f.expected})` : ""}</span>}
        </p>
        {f.quote && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={f.quote.text}>
            {f.quote.at}: “{f.quote.text}”
          </p>
        )}
      </div>
    </li>
  );
}

/** One line on how a document compares with the order, opening to every field. Open by default when something is off. */
export function DocCheckView({ check, collapsed = false }: { check: DocCheck; collapsed?: boolean }) {
  const issues = docIssues(check);
  const differs = issues.filter((f) => f.status === "differs").length;
  const missing = issues.length - differs;
  const tone = differs ? "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/40" : missing ? "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40" : "border-zinc-200 dark:border-zinc-800";
  const summary = issues.length
    ? [differs ? `${differs} field${differs > 1 ? "s" : ""} differ${differs > 1 ? "" : "s"} from the order` : null, missing ? `${missing} required field${missing > 1 ? "s" : ""} not found` : null].filter(Boolean).join(", ")
    : `All ${check.fields.filter((f) => f.required).length} required fields match the order`;
  return (
    <details open={!collapsed && issues.length > 0} className={`mt-1.5 rounded-lg border px-3 py-2 text-xs ${tone}`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
        <Mark kind={differs ? "fail" : missing ? "unknown" : "pass"} small />
        <span className="font-medium">
          {check.title} check: {summary}
        </span>
        {check.generated && <span className="text-zinc-500">· built from the offer</span>}
      </summary>
      {check.note && <p className="mt-2 text-zinc-600 dark:text-zinc-400">{check.note}</p>}
      <ul className="mt-1 divide-y divide-zinc-200/70 dark:divide-zinc-800">
        {check.fields.map((f) => (
          <CheckRow key={f.key} f={f} />
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-zinc-500">Read from labelled lines only; nothing is guessed. A field with no labelled line stays “not found”.</p>
    </details>
  );
}

function StepDocument({ s }: { s: StepView }) {
  const check = s.doc?.check;
  if (!check) return null;
  const issues = docIssues(check);
  return (
    <>
      <DocCheckView check={check} />
      {issues.length > 0 && !s.done && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-rose-800 dark:text-rose-300">
          {s.by === "seller" ? "The seller's" : "The buyer's"} {check.title.toLowerCase()} does not match the order. {s.next ? "The step can only be completed with a reason, which both sides see." : ""}
        </p>
      )}
    </>
  );
}

function TemplateRules({ s }: { s: StepView }) {
  if (!s.template) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">What the {s.template.title.toLowerCase()} must show</summary>
      <ul className="mt-1.5 space-y-0.5 text-zinc-600 dark:text-zinc-400">
        {s.template.rules.map((r) => (
          <li key={r.label}>
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{r.label}</span>
            {r.required ? "" : " (optional)"}: {r.rule}
          </li>
        ))}
      </ul>
    </details>
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
                {s.override && (
                  <p className="mt-1 text-xs font-medium text-rose-800 dark:text-rose-300">
                    Completed although the document does not match the order. Reason: {s.override}
                  </p>
                )}
                {files.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                    {files.map((f) => (
                      <FileLink key={f.id} dealId={dealId} f={f} />
                    ))}
                  </p>
                )}
                {(s.done || s.next) && <StepDocument s={s} />}
                {s.done && s.template && !s.doc && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">No {s.template.title.toLowerCase()} attached.</p>}
                {s.next && !mine && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Waiting for {other}.</p>}
                {s.next && mine && (
                  <div className="mt-2 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{s.hint}</p>
                    <TemplateRules s={s} />
                    {s.id === "contract" && (
                      <ActionForm action={createProformaAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="deal_id" value={dealId} />
                        <input name="payment_terms" required maxLength={120} className={`${inputCls} min-w-0 flex-1`} placeholder="Payment terms, e.g. irrevocable L/C at sight" aria-label="Payment terms" />
                        <Submit className={buttonCls} pending="Creating…">
                          Create proforma from the offer
                        </Submit>
                      </ActionForm>
                    )}
                    {s.template && (
                      <ActionForm action={addDealFileAction} className="space-y-2">
                        <input type="hidden" name="deal_id" value={dealId} />
                        <input type="hidden" name="step" value={s.id} />
                        <div className="flex flex-wrap items-center gap-2">
                          <input type="file" name="file" required accept={FILE_ACCEPT} className={`${fileInputCls} min-w-0 flex-1`} aria-label={`Attach the ${s.template.title.toLowerCase()}`} />
                          <Submit className={buttonCls} pending="Checking…">
                            {s.doc ? "Attach a new version" : "Attach and check"}
                          </Submit>
                        </div>
                        <p className="text-[11px] text-zinc-500">Text PDF, Excel, CSV or text files are read and checked against the order. Images and Word files are kept but not read.</p>
                      </ActionForm>
                    )}
                    <ActionForm action={completeStepAction} className="space-y-2">
                      <input type="hidden" name="deal_id" value={dealId} />
                      <input type="hidden" name="step" value={s.id} />
                      <input name="note" maxLength={500} className={inputCls} placeholder={s.id === "shipped" ? "B/L number, vessel" : s.id === "payment" ? "e.g. L/C no. or transfer reference" : "Note (optional)"} />
                      {docIssues(s.doc?.check ?? null).length > 0 && (
                        <input name="override" required maxLength={500} className={`${inputCls} border-rose-300 dark:border-rose-800`} placeholder="Reason to complete anyway (both sides see it)" aria-label="Reason to complete anyway" />
                      )}
                      <Submit
                        className={docIssues(s.doc?.check ?? null).length > 0 ? dangerCls : primaryCls}
                        pending="Saving…"
                        confirm={s.id === "confirmed" ? "Confirm this order? The lot is marked sold and other buyers' deals on it close." : undefined}
                      >
                        {s.id === "confirmed" ? "Confirm order" : s.id === "received" ? "Confirm receipt" : docIssues(s.doc?.check ?? null).length > 0 ? "Complete anyway" : "Mark done"}
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
            <li key={f.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                <FileLink dealId={dealId} f={f} />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {f.side === side ? "you" : f.side === "buyer" ? buyer : seller} · {f.who} · {kb(f.size_bytes)} · {when(f.created_at)}
                </span>
              </div>
              {f.check && <DocCheckView check={f.check} collapsed />}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <ActionForm action={addDealFileAction} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <input type="hidden" name="deal_id" value={dealId} />
          <input type="file" name="file" required accept={FILE_ACCEPT} className={`${fileInputCls} min-w-0 flex-1`} />
          <Submit className={buttonCls} pending="Uploading…">
            Share file
          </Submit>
          <span className="w-full text-xs text-zinc-500 dark:text-zinc-400">PDF, image, Excel, Word, CSV or text, up to {MAX_FILE_BYTES / 1024 / 1024} MB.</span>
        </ActionForm>
      )}
    </Card>
  );
}
