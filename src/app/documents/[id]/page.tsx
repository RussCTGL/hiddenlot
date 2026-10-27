import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { confirmAllAction, correctFieldAction, publishAction, setLotStatusAction } from "@/app/actions";
import { getDocumentForActor, NotFoundError } from "@/auth/access";
import { FieldTable, FIELD_LABEL } from "@/components/fields";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, buttonCls, Card, dangerCls, inputCls, Loading, Page, primaryCls } from "@/components/ui";
import { listLotsOfDocument } from "@/db/repo";
import { getDb } from "@/db/server";
import { LotCondition, PriceBasis, ProductForm, SurplusReason, type InventoryLotField } from "@/domain/hrc";
import { requireSession } from "@/lib/session";

export default function DocumentPage(props: PageProps<"/documents/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentReview params={props.params} />
    </Suspense>
  );
}

const ENUM_OPTIONS: Partial<Record<InventoryLotField, readonly string[]>> = {
  product_form: ProductForm.options,
  condition: LotCondition.options,
  price_basis: PriceBasis.options,
  surplus_reason: SurplusReason.options,
};
const HINT: Partial<Record<InventoryLotField, string>> = {
  thickness_mm: "mm",
  width_mm: "mm",
  total_kg: "kg (18 t = 18000)",
  available_from: "YYYY-MM-DD",
  certificate_claims: "comma-separated",
  heat_numbers: "comma-separated",
  splittable: "true / false",
  price_amount: "e.g. 545.00",
};

function CorrectField({ lotId, version, field }: { lotId: string; version: number; field: InventoryLotField }) {
  const options = ENUM_OPTIONS[field];
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Correct</summary>
      <ActionForm action={correctFieldAction} className="mt-1 space-y-1">
        <input type="hidden" name="lot_id" value={lotId} />
        <input type="hidden" name="version" value={version} />
        <input type="hidden" name="field" value={field} />
        {options ? (
          <select name="value" className={inputCls} defaultValue="">
            <option value="">Unknown (clear)</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        ) : (
          <input name="value" placeholder={`${FIELD_LABEL[field]}${HINT[field] ? ` · ${HINT[field]}` : ""} (empty = Unknown)`} className={inputCls} />
        )}
        <input name="note" required placeholder="Why (e.g. confirmed by phone)" className={inputCls} />
        <Submit className={buttonCls}>Save correction</Submit>
      </ActionForm>
    </details>
  );
}

async function DocumentReview({ params }: { params: PageProps<"/documents/[id]">["params"] }) {
  const { id } = await params;
  const { actor } = await requireSession();
  const db = await getDb();
  let docView;
  try {
    docView = await getDocumentForActor(db, actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { doc, fragments } = docView;
  const lots = await listLotsOfDocument(db, id);
  const run = (
    await db.query<{ extractor: string; status: string; model_run: Record<string, unknown> | null; issues: { lot_index: number | null; field: string | null; code: string; detail: string }[]; ignored_instructions: { note: string; evidence: string[] }[] }>(
      `SELECT extractor, status, model_run, issues, ignored_instructions FROM extraction_runs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    )
  )[0];
  const cited = new Set(lots.flatMap((l) => Object.values(l.data.fields).flatMap((o) => o.evidence.map((e) => e.fragment_id))));
  const usage = run?.model_run?.usage as { total_tokens?: number } | undefined;

  return (
    <Page
      title={doc.filename ?? doc.id}
      subtitle={`${doc.kind.toUpperCase()} · ${doc.status.replaceAll("_", " ")} · private to your network${doc.synthetic ? " · synthetic" : ""}`}
      actions={<Link href="/intake" className="text-sm underline">← Intake</Link>}
    >
      {doc.error && <div className="mb-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">{doc.error}</div>}
      {run && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <Badge tone={run.extractor === "meta" ? "sky" : "zinc"}>
            {run.extractor === "meta" ? `Meta ${String(run.model_run?.response_model_id ?? run.model_run?.model_id ?? "")}` : run.extractor.replaceAll("_", " ")}
          </Badge>
          <Badge>{run.status}</Badge>
          {typeof run.model_run?.latency_ms === "number" && <Badge>{Math.round(run.model_run.latency_ms as number) / 1000} s</Badge>}
          {usage?.total_tokens && <Badge>{usage.total_tokens} tokens</Badge>}
          {typeof run.model_run?.prompt_version === "string" && <Badge>{run.model_run.prompt_version}</Badge>}
        </div>
      )}
      {run?.issues.some((x) => x.code === "lot_not_extracted") && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <b>Possibly missed lots:</b> the document mentions{" "}
          {run.issues
            .filter((x) => x.code === "lot_not_extracted")
            .map((x) => x.detail)
            .join(", ")}{" "}
          but no lot was extracted for them. Check the source before publishing; nothing was guessed for them.
        </div>
      )}
      {run?.ignored_instructions.length ? (
        <div className="mb-4 rounded-md border border-violet-300 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
          <b>Ignored instructions found in the document</b> (treated as data, changed nothing):
          <ul className="mt-1 list-disc pl-5">
            {run.ignored_instructions.map((ins, i) => (
              <li key={i}>
                [{ins.evidence.join(", ")}] {ins.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card title="Source" className="xl:col-span-2">
          <ol className="max-h-[75vh] space-y-0.5 overflow-auto font-mono text-xs">
            {fragments.map((f) => (
              <li key={f.fragment_id} id={`frag-${f.fragment_id}`} className={`flex gap-2 rounded px-1 ${cited.has(f.fragment_id) ? "bg-sky-50 dark:bg-sky-950" : ""}`}>
                <span className="w-16 shrink-0 text-right text-zinc-400">{f.fragment_id}</span>
                <span className="whitespace-pre-wrap break-words">{f.text}</span>
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-4 xl:col-span-3">
          {lots.length === 0 && <Card>No lots were extracted.</Card>}
          {lots.map((l, i) => {
            const issues = run?.issues.filter((x) => x.lot_index === i) ?? [];
            const reviewed = Object.values(l.data.fields).every((o) => o.normalized_value === null || o.status.startsWith("user_"));
            return (
              <Card
                key={l.id}
                title={`Lot ${String(l.data.fields.seller_lot_ref.normalized_value ?? i + 1)} · v${l.current_version}`}
                aside={<Badge tone={l.status === "published" ? "emerald" : l.status === "needs_review" ? "amber" : "zinc"}>{l.status.replaceAll("_", " ")}</Badge>}
              >
                <FieldTable lot={l.data} render={(f) => (l.status === "sold" || l.status === "withdrawn" ? null : <CorrectField lotId={l.id} version={l.current_version} field={f} />)} />
                {issues.length > 0 && (
                  <p className="mt-2 text-xs text-rose-700 dark:text-rose-400">
                    Checks flagged: {issues.map((x) => `${x.field ?? ""} ${x.code}`).join("; ")}
                  </p>
                )}
                {l.status !== "sold" && l.status !== "withdrawn" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!reviewed && (
                      <ActionForm action={confirmAllAction}>
                        <input type="hidden" name="lot_id" value={l.id} />
                        <input type="hidden" name="version" value={l.current_version} />
                        <Submit className={buttonCls}>Confirm all extracted values</Submit>
                      </ActionForm>
                    )}
                    {l.status !== "published" && (
                      <ActionForm action={publishAction}>
                        <input type="hidden" name="lot_id" value={l.id} />
                        <input type="hidden" name="version" value={l.current_version} />
                        <Submit className={primaryCls}>Publish to discovery</Submit>
                      </ActionForm>
                    )}
                    <ActionForm action={setLotStatusAction}>
                      <input type="hidden" name="lot_id" value={l.id} />
                      <input type="hidden" name="version" value={l.current_version} />
                      <input type="hidden" name="status" value="withdrawn" />
                      <Submit className={dangerCls}>Withdraw</Submit>
                    </ActionForm>
                  </div>
                )}
                <p className="mt-2 text-xs text-zinc-500">Unknown values stay Unknown when you confirm. Publishing shares only under the grants on the Sharing page.</p>
              </Card>
            );
          })}
        </div>
      </div>
    </Page>
  );
}
