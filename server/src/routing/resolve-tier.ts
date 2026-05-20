/**
 * Phase E1 dispatch resolver.
 *
 * Inputs:
 *   - issue.complexity (optional; null/undefined for runs without an
 *     issue, or for code paths that didn't go through the routing tag
 *     parser)
 *   - agent.tierPreference (optional; agent's default tier if no
 *     issue-level override)
 *
 * Output: a RoutingTier name (local / fast / default / heavy).
 *
 * Precedence (locked per MODEL_MENU.md):
 *   1. Explicit complexity tag wins  (trivial -> fast, hard -> heavy,
 *      local -> local). Operator intent is canonical.
 *   2. complexity === "normal" (or no complexity column read at all)
 *      falls back to agent.tierPreference.
 *   3. If neither is set, fall back to "default" tier.
 *
 * Pure functional. No DB reads, no env reads, no side effects. The
 * dispatch site in services/heartbeat.ts calls this with already-
 * loaded issue + agent rows, then wraps adapterConfig.env with the
 * resolved (model, provider) per Phase E0's contract.
 */
import type { IssueComplexity, RoutingTier } from "@paperclipai/shared";

import { resolveModel, type ModelMenuEntry } from "./model-menu.js";

/**
 * Operator-tag-to-tier mapping. "normal" is intentionally absent: it
 * means "fall through to agent preference", which the resolver handles
 * separately.
 */
const COMPLEXITY_TO_TIER: Readonly<Record<IssueComplexity, RoutingTier | null>> = {
  trivial: "fast",
  normal: null,
  hard: "heavy",
  local: "local",
};

export interface ResolveTierInput {
  /** Issue's complexity column. null for runs with no issue context. */
  readonly issueComplexity?: IssueComplexity | null;
  /** Agent's tier_preference column. null if agent hasn't declared one. */
  readonly agentTierPreference?: RoutingTier | null;
}

export interface ResolveTierResult {
  readonly tier: RoutingTier;
  /** Why this tier was chosen (for run-record auditing + debugging). */
  readonly source: "issue_complexity" | "agent_preference" | "default";
  readonly entry: ModelMenuEntry;
}

export function resolveTier(input: ResolveTierInput): ResolveTierResult {
  const issueTier = input.issueComplexity
    ? COMPLEXITY_TO_TIER[input.issueComplexity]
    : null;
  if (issueTier) {
    return { tier: issueTier, source: "issue_complexity", entry: resolveModel(issueTier) };
  }
  const agentTier = input.agentTierPreference ?? null;
  if (agentTier) {
    return { tier: agentTier, source: "agent_preference", entry: resolveModel(agentTier) };
  }
  return { tier: "default", source: "default", entry: resolveModel("default") };
}
