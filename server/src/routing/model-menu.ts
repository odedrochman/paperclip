/**
 * In-code mirror of docs/routing-layer/MODEL_MENU.md from the parent
 * remote-agents-farm repo.
 *
 * Each entry describes one routing tier (local / fast / default / heavy).
 * The dispatch resolver (resolve-tier.ts) reads issue.complexity +
 * agent.tier_preference and produces a concrete model + provider pair
 * via these constants. Phase E1 wraps the agent at the adapter.execute
 * call site with the resolved values in adapterConfig.env so adapter
 * Patch 5.1 reads them as per-call overrides.
 *
 * When MODEL_MENU.md changes, this file MUST be updated in the same
 * fork PR so the resolver picks up the new model. The rotation
 * procedure is in the parent repo's RUNBOOK.md under "Model rotation
 * procedure".
 *
 * Provider values must be in the hermes-paperclip-adapter's
 * VALID_PROVIDERS whitelist (Patch 3); otherwise --provider gets
 * silently dropped and hermes auto-detects from the model name.
 * Patch 3 currently whitelists: anthropic, google, ollama, auto.
 */
import type { RoutingTier } from "@paperclipai/shared";

export type ModelMenuProvider = "anthropic" | "google" | "ollama";

export interface ModelMenuEntry {
  readonly tier: RoutingTier;
  readonly model: string;
  readonly provider: ModelMenuProvider;
  /**
   * Optional same-tier fallback used by within-call retry on failure.
   * Not consumed by Phase E1 dispatch (which uses the primary only);
   * Phase E2's escalation backstop or a later same-tier retry layer
   * can use this when wired.
   */
  readonly sameTierFallback?: {
    readonly model: string;
    readonly provider: ModelMenuProvider;
  };
}

/**
 * Locked 2026-05-20 per MODEL_MENU.md. Order is canonical (local =
 * cheapest, heavy = most expensive) so escalation logic can index
 * adjacent tiers without an extra lookup.
 */
export const MODEL_MENU: Readonly<Record<RoutingTier, ModelMenuEntry>> = {
  local: {
    tier: "local",
    model: "qwen2.5-coder:7b",
    provider: "ollama",
    sameTierFallback: {
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    },
  },
  fast: {
    tier: "fast",
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    sameTierFallback: {
      model: "gemini-2.5-flash",
      provider: "google",
    },
  },
  default: {
    tier: "default",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
  },
  heavy: {
    tier: "heavy",
    model: "claude-opus-4-7",
    provider: "anthropic",
  },
};

export function resolveModel(tier: RoutingTier): ModelMenuEntry {
  return MODEL_MENU[tier];
}
