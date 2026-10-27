import Link from "next/link";
import { Suspense } from "react";
import { withdrawDemandAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, ButtonLink, Card, dangerCls, Empty, Loading, Page } from "@/components/ui";
import { listDemandsOfNetwork } from "@/db/repo";
import { getDb } from "@/db/server";
import { requireSession } from "@/lib/session";

export default function DemandsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Demands />
    </Suspense>
  );
}

async function Demands() {
  const { actor, network } = await requireSession();
  const demands = await listDemandsOfNetwork(await getDb(), actor.network_id);
  return (
    <Page title="Demands" subtitle={`${network.alias}'s buyer requirements. Must-haves are hard constraints; anything left empty is treated as Unknown, never as "anything goes".`} actions={<ButtonLink href="/demands/new" primary>New demand</ButtonLink>}>
      {demands.length === 0 ? (
        <Empty>No demands yet.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {demands.map((d) => {
            const x = d.data;
            return (
              <Card key={d.id} title={x.title} aside={<Badge tone={d.status === "active" ? "emerald" : "zinc"}>{d.status} · v{d.current_version}</Badge>}>
                <ul className="space-y-0.5 text-sm">
                  <li>
                    Grades: {x.accepted_grades.map((g) => [g.grade, g.standard_id, g.edition].filter(Boolean).join(" ")).join(" / ")}{" "}
                    <span className="text-zinc-500">({x.substitution_policy === "forbidden" ? "no substitution" : "substitution only after engineering review"})</span>
                  </li>
                  <li>
                    {x.thickness_mm.min ?? "?"}–{x.thickness_mm.max ?? "?"} × {x.width_mm.min ?? "?"}–{x.width_mm.max ?? "?"} mm · {x.quantity_kg.min / 1000}–{x.quantity_kg.max / 1000} t
                  </li>
                  <li>
                    {x.acceptable_conditions.join(", ")} · certificates: {x.must_have_certificates.join(", ") || "none"} · need by {x.need_by ?? "—"}
                  </li>
                  <li>Budget: {x.budget ? `${x.budget.currency} ${x.budget.amount}/MT ${x.budget.incoterm} ${x.budget.place}` : "—"}</li>
                </ul>
                <div className="mt-3 flex gap-2">
                  <Link href={`/opportunities?demand=${d.id}`} className="text-sm underline">
                    Opportunities →
                  </Link>
                  {d.status === "active" && (
                    <ActionForm action={withdrawDemandAction} className="ml-auto">
                      <input type="hidden" name="demand_id" value={d.id} />
                      <Submit className={dangerCls}>Withdraw</Submit>
                    </ActionForm>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}
