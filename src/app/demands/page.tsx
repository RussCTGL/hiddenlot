import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { withdrawDemandAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, ButtonLink, Card, dangerCls, Empty, Loading, Page } from "@/components/ui";
import { listDemandsOfNetwork } from "@/db/repo";
import { budgetText } from "@/domain/hrc";
import { getDb } from "@/db/server";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Demands" };

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
    <Page title="Demands" subtitle={`${network.alias} · must-haves are hard rules; empty means Unknown`} actions={<ButtonLink href="/demands/new" primary>New demand</ButtonLink>}>
      {demands.length === 0 ? (
        <Empty>No demands yet.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {demands.map((d) => {
            const x = d.data;
            return (
              <Card key={d.id} title={<span className="normal-case">{x.title}</span>} aside={<Badge tone={d.status === "active" ? "emerald" : "zinc"}>{d.status} · v{d.current_version}</Badge>}>
                <ul className="space-y-0.5 text-sm">
                  <li>
                    Grades: {x.accepted_grades.map((g) => [g.grade, g.standard_id, g.edition].filter(Boolean).join(" ")).join(" / ")}{" "}
                    <span className="text-zinc-500 dark:text-zinc-400">({x.substitution_policy === "forbidden" ? "no substitution" : "substitution only after engineering review"})</span>
                  </li>
                  <li>
                    {x.thickness_mm.min ?? "?"}–{x.thickness_mm.max ?? "?"} × {x.width_mm.min ?? "?"}–{x.width_mm.max ?? "?"} mm · {x.quantity_kg.min / 1000}–{x.quantity_kg.max / 1000} t
                  </li>
                  <li>
                    {x.acceptable_conditions.join(", ")} · certificates: {x.must_have_certificates.join(", ") || "none"} · need by {x.need_by ?? "—"}
                  </li>
                  <li>Budget: {x.budget ? budgetText(x.budget) : "—"}</li>
                </ul>
                <div className="mt-3 flex gap-2">
                  <Link href={`/opportunities?demand=${d.id}`} className="inline-flex min-h-10 items-center text-sm text-accent hover:underline">
                    Opportunities →
                  </Link>
                  {d.status === "active" && (
                    <ActionForm action={withdrawDemandAction} className="ml-auto">
                      <input type="hidden" name="demand_id" value={d.id} />
                      <Submit className={dangerCls} confirm="Withdraw this demand? Its opportunities and open deals close.">
                        Withdraw
                      </Submit>
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
