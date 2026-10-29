import { Suspense } from "react";
import Link from "next/link";
import { intakeAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Card, inputCls, Loading, Page, primaryCls } from "@/components/ui";
import { getDb } from "@/db/server";
import { MAX_BYTES } from "@/ingestion/intake";
import { metaAvailable } from "@/lib/meta";
import { requireSession } from "@/lib/session";

export default function IntakePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Intake />
    </Suspense>
  );
}

const SAMPLE = `[SYNTHETIC — fictional offer]
Lot B-052
SS400 (JIS G3101) HRC 3.0mm x 1500mm, 17.6 MT, 1 coil, prime
Location: Busan port
Available from 2026-11-06
Price: USD 541 / MT CFR Haiphong
MTC available, heat no. H24-80115`;

async function Intake() {
  const { actor } = await requireSession();
  const db = await getDb();
  const docs = await db.query<{ id: string; filename: string | null; kind: string; status: string; error: string | null; created_at: Date }>(
    `SELECT id, filename, kind, status, error, created_at FROM source_documents WHERE network_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [actor.network_id],
  );
  const meta = metaAvailable();
  return (
    <Page
      title="Intake"
      subtitle="Files stay private to your network until you publish and share."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New offer" className="lg:col-span-2">
          <ActionForm action={intakeAction} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Paste a message</label>
              <textarea name="text" rows={9} className={`${inputCls} font-mono`} defaultValue={SAMPLE} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">…or upload a file</label>
              <input type="file" name="file" accept=".txt,.csv,.xlsx,.pdf,text/plain,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="text-sm" />
              <p className="mt-1 text-xs text-zinc-500">.txt · .csv · .xlsx · text PDF · max {MAX_BYTES / 1024 / 1024} MB</p>
            </div>
            <fieldset className="text-sm">
              <legend className="mb-1 font-medium">Extractor</legend>
              <label className="mr-4">
                <input type="radio" name="extractor" value="meta" defaultChecked={meta} disabled={!meta} /> Meta Muse Spark{meta ? "" : " (not configured)"}
              </label>
              <label>
                <input type="radio" name="extractor" value="regex_baseline" defaultChecked={!meta} /> Regex baseline (no model)
              </label>
            </fieldset>
            <label htmlFor="synthetic_confirmed" className="flex items-start gap-2 text-sm">
              <input type="checkbox" id="synthetic_confirmed" name="synthetic_confirmed" className="mt-1" />
              <span>This is synthetic test data. Real documents are not accepted.</span>
            </label>
            <Submit className={primaryCls} pending="Extracting… (Meta can take up to a minute)">
              Extract lots
            </Submit>
          </ActionForm>
        </Card>
        <Card title="What happens">
          <ol className="space-y-3 text-sm">
            {["Split into numbered lines", "Each value quoted from source", "Code checks every quote", "Hidden instructions ignored", "You review, then publish"].map((t, i) => (
              <li key={t} className="flex items-center gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-xs text-accent">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
        </Card>
      </div>
      <Card title="Recent documents" className="mt-4">
        {docs.length === 0 ? (
          <p className="text-sm text-zinc-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <Link href={`/documents/${d.id}`} className="text-accent hover:underline">
                  {d.filename ?? d.id}
                </Link>
                <span className="text-xs text-zinc-500">
                  {d.kind} · {d.status.replaceAll("_", " ")}
                  {d.error ? ` · ${d.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
