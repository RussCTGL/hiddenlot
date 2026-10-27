import type { ChatMessage, ModelRunRecord } from "@/ai/meta/client";
import { buildExplainMessages, buildFacts, checkExplanation, type Explanation, type Fact } from "@/ai/tasks/explain-candidate";
import { ForbiddenError, getOpportunityForActor, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { audit } from "@/db/repo";

// Stores a Meta-written explanation on an opportunity. Only facts the buyer's
// network may already see are sent, and only if the lot owner allowed model
// processing for this network. Failed or malformed runs store nothing.

export type ExplainCall = (messages: ChatMessage[]) => Promise<{ data: Explanation | null; run: ModelRunRecord }>;

export interface StoredExplanation {
  assessment_id: string;
  explanation: Explanation;
  dropped: { text: string; reason: string }[];
  facts: Fact[];
  model: { model_id: string; prompt_version: string; latency_ms: number; usage: ModelRunRecord["usage"] };
  created_at: string;
}

export async function explainOpportunity(db: Db, actor: Actor, oppId: string, call: ExplainCall, now: Date): Promise<StoredExplanation> {
  const view = await getOpportunityForActor(db, actor, oppId, now);
  if (view.opportunity.status === "invalidated" || view.lot === null) throw new ForbiddenError("This opportunity is no longer current");
  if (!view.model_processing_allowed) throw new ForbiddenError("The lot owner has not allowed model processing for your network; the rule-based explanation is shown instead");
  const facts = buildFacts(view.checks, view.demand, view.lot);
  const { data, run } = await call(buildExplainMessages(facts, view.compatibility_status));
  if (!data) throw new Error(`Meta explanation ${run.result_status}: ${run.error ?? "no output"}`);
  const { explanation, dropped } = checkExplanation(data, facts);
  const stored: StoredExplanation = {
    assessment_id: view.opportunity.assessment_id,
    explanation,
    dropped,
    facts,
    model: { model_id: run.response_model_id ?? run.model_id, prompt_version: run.prompt_version, latency_ms: run.latency_ms, usage: run.usage },
    created_at: now.toISOString(),
  };
  await db.query(`UPDATE opportunities SET explanation = $2, updated_at = now() WHERE id = $1 AND buyer_network_id = $3`, [oppId, stored, actor.network_id]);
  await audit(db, actor.id, "opportunity.explained", "opportunity", oppId, { dropped: dropped.length, model: stored.model.model_id });
  return stored;
}
