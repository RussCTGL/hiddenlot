import Link from "next/link";
import { Suspense } from "react";
import { publishAction, reconfirmAction, setLotStatusAction } from "@/app/actions";
import { formatValue } from "@/components/fields";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, ButtonLink, buttonCls, Card, dangerCls, Empty, Loading, Page, primaryCls, Unknown } from "@/components/ui";
import { listLotsOfNetwork, type LotWithData } from "@/db/repo";
import { getDb } from "@/db/server";
import { FRESHNESS_WINDOW_HOURS } from "@/discovery/constraints";
import type { InventoryLotField } from "@/domain/hrc";
import { requestNow, requireSession } from "@/lib/session";

export default function InventoryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Inventory />
    </Suspense>
  );
}

function V({ lot, f }: { lot: LotWithData; f: InventoryLotField }) {
  const v = lot.data.fields[f].normalized_value;
  return v === null || (Array.isArray(v) && v.length === 0) ? <Unknown /> : <>{formatValue(f, v)}</>;
}

function Hidden({ lot, children }: { lot: LotWithData; children: React.ReactNode }) {
  return (
    <>
      <input type="hidden" name="lot_id" value={lot.id} />
      <input type="hidden" name="version" value={lot.current_version} />
      {children}
    </>
  );
}

async function Inventory() {
  const { actor, network } = await requireSession();
  const lots = await listLotsOfNetwork(await getDb(), actor.network_id);
  const now = requestNow().getTime();
  return (
    <Page title="Inventory" subtitle={`${network.alias}'s own lots. Published lots take part in discovery for networks you share with; sold or withdrawn lots stop immediately.`} actions={<ButtonLink href="/intake" primary>Add stock</ButtonLink>}>
      {lots.length === 0 ? (
        <Empty>No lots yet.</Empty>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400">
                  <th className="pb-2 font-medium">Lot</th>
                  <th className="pb-2 font-medium">Grade / standard</th>
                  <th className="pb-2 font-medium">Size</th>
                  <th className="pb-2 font-medium">Weight</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Confirmed</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => {
                  const verified = l.data.last_verified_at ?? l.data.observed_at;
                  const ageH = Math.round((now - Date.parse(verified)) / 3_600_000);
                  return (
                    <tr key={l.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                      <td className="py-2 pr-3">
                        {l.source_document_id ? (
                          <Link href={`/documents/${l.source_document_id}`} className="font-medium underline">
                            {String(l.data.fields.seller_lot_ref.normalized_value ?? l.id)}
                          </Link>
                        ) : (
                          String(l.data.fields.seller_lot_ref.normalized_value ?? l.id)
                        )}
                        <div className="text-xs text-zinc-500">
                          <V lot={l} f="product_form" />
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <V lot={l} f="grade_raw" /> <span className="text-zinc-500">·</span> <V lot={l} f="standard_id" />
                      </td>
                      <td className="py-2 pr-3">
                        <V lot={l} f="thickness_mm" /> × <V lot={l} f="width_mm" />
                      </td>
                      <td className="py-2 pr-3">
                        <V lot={l} f="total_kg" />
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={l.status === "published" ? "emerald" : l.status === "needs_review" ? "amber" : "zinc"}>{l.status.replaceAll("_", " ")}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {ageH} h ago{ageH > FRESHNESS_WINDOW_HOURS && <div className="text-amber-700 dark:text-amber-400">stale — reconfirm</div>}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {l.status === "needs_review" && (
                            <ActionForm action={publishAction}>
                              <Hidden lot={l}>
                                <Submit className={primaryCls}>Publish</Submit>
                              </Hidden>
                            </ActionForm>
                          )}
                          {l.status === "published" && (
                            <>
                              <ActionForm action={reconfirmAction}>
                                <Hidden lot={l}>
                                  <Submit className={buttonCls}>Still available</Submit>
                                </Hidden>
                              </ActionForm>
                              <ActionForm action={setLotStatusAction}>
                                <Hidden lot={l}>
                                  <input type="hidden" name="status" value="sold" />
                                  <Submit className={dangerCls}>Mark sold</Submit>
                                </Hidden>
                              </ActionForm>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Page>
  );
}
