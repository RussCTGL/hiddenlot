import { Suspense } from "react";
import { createGrantAction, revokeGrantAction } from "@/app/actions";
import { FIELD_LABEL, FIELD_ORDER } from "@/components/fields";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, Card, dangerCls, Empty, inputCls, Loading, Page, primaryCls } from "@/components/ui";
import { listGrantsByOwner, listLotsOfNetwork, listNetworks } from "@/db/repo";
import { getDb } from "@/db/server";
import { requestNow, requireSession } from "@/lib/session";

export default function SharingPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Sharing />
    </Suspense>
  );
}

const DEFAULT_OFF = new Set(["location_place", "heat_numbers", "price_amount"]);

async function Sharing() {
  const { actor } = await requireSession();
  const db = await getDb();
  const [grants, networks, lots] = await Promise.all([listGrantsByOwner(db, actor.network_id), listNetworks(db), listLotsOfNetwork(db, actor.network_id)]);
  const alias = new Map(networks.map((n) => [n.id, n.alias]));
  const lotLabel = new Map(lots.map((l) => [l.id, String(l.data.fields.seller_lot_ref.normalized_value ?? l.id)]));
  const now = (await requestNow()).getTime();
  return (
    <Page
      title="Sharing"
      subtitle="Others see only the fields you pick. Revoking is immediate."
    >
      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="Active and past grants" className="lg:col-span-3">
          {grants.length === 0 ? (
            <Empty>You share nothing yet.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {grants.map((g) => {
                const expired = g.expires_at !== null && new Date(g.expires_at).getTime() <= now;
                const active = !g.revoked_at && !expired;
                return (
                  <li key={g.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{alias.get(g.recipient_network_id)}</b>
                      <Badge tone={active ? "emerald" : "zinc"}>{g.revoked_at ? "revoked" : expired ? "expired" : "active"}</Badge>
                      <span className="text-xs text-zinc-500">{g.lot_id ? `lot ${lotLabel.get(g.lot_id) ?? g.lot_id}` : "all published lots"}</span>
                      {g.allow_identity_disclosure && <Badge tone="amber">identity disclosed</Badge>}
                      <Badge tone={g.allow_model_processing ? "sky" : "zinc"}>{g.allow_model_processing ? "Meta explanations allowed" : "no model processing"}</Badge>
                      {active && (
                        <ActionForm action={revokeGrantAction} className="ml-auto">
                          <input type="hidden" name="grant_id" value={g.id} />
                          <Submit className={dangerCls}>Revoke</Submit>
                        </ActionForm>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      Fields: {g.field_scope.length === FIELD_ORDER.length ? "all" : g.field_scope.map((f) => FIELD_LABEL[f]).join(", ")}
                      {g.expires_at ? ` · expires ${new Date(g.expires_at).toISOString().slice(0, 10)}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Share with a network" className="lg:col-span-2">
          <ActionForm action={createGrantAction} className="space-y-3 text-sm">
            <div>
              <label className="mb-1 block text-xs font-medium">Recipient</label>
              <select name="recipient" className={inputCls}>
                {networks
                  .filter((n) => n.id !== actor.network_id)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.alias}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Lots</label>
              <select name="lot_id" className={inputCls}>
                <option value="">All published lots</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {lotLabel.get(l.id)}
                  </option>
                ))}
              </select>
            </div>
            <fieldset>
              <legend className="mb-1 text-xs font-medium">Fields the recipient may use</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {FIELD_ORDER.map((f) => (
                  <label key={f} className="text-xs">
                    <input type="checkbox" name="field_scope" value={f} defaultChecked={!DEFAULT_OFF.has(f)} /> {FIELD_LABEL[f]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" name="identity" /> Disclose our network&apos;s name to them
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" name="model_processing" className="mt-0.5" /> Allow Meta explanations on shared fields (files are never sent)
            </label>
            <div>
              <label className="mb-1 block text-xs font-medium">Expires after (days, empty = no expiry)</label>
              <input name="expires_days" className={inputCls} placeholder="e.g. 30" />
            </div>
            <Submit className={primaryCls}>Share</Submit>
          </ActionForm>
        </Card>
      </div>
    </Page>
  );
}
