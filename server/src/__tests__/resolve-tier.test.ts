import { describe, expect, it } from "vitest";

import { MODEL_MENU, resolveModel } from "../routing/model-menu.js";
import { resolveTier } from "../routing/resolve-tier.js";

describe("resolveTier (Phase E1 dispatch resolver)", () => {
  describe("issue complexity wins over agent preference", () => {
    it("trivial -> fast", () => {
      const r = resolveTier({
        issueComplexity: "trivial",
        agentTierPreference: "heavy",
      });
      expect(r.tier).toBe("fast");
      expect(r.source).toBe("issue_complexity");
      expect(r.entry.model).toBe("claude-haiku-4-5-20251001");
      expect(r.entry.provider).toBe("anthropic");
    });

    it("hard -> heavy", () => {
      const r = resolveTier({
        issueComplexity: "hard",
        agentTierPreference: "fast",
      });
      expect(r.tier).toBe("heavy");
      expect(r.source).toBe("issue_complexity");
      expect(r.entry.model).toBe("claude-opus-4-7");
      expect(r.entry.provider).toBe("anthropic");
    });

    it("local -> local", () => {
      const r = resolveTier({
        issueComplexity: "local",
        agentTierPreference: "default",
      });
      expect(r.tier).toBe("local");
      expect(r.source).toBe("issue_complexity");
      expect(r.entry.model).toBe("qwen2.5-coder:7b");
      expect(r.entry.provider).toBe("ollama");
    });
  });

  describe("normal complexity falls through to agent preference", () => {
    it("normal + agent=fast -> fast", () => {
      const r = resolveTier({
        issueComplexity: "normal",
        agentTierPreference: "fast",
      });
      expect(r.tier).toBe("fast");
      expect(r.source).toBe("agent_preference");
      expect(r.entry.model).toBe("claude-haiku-4-5-20251001");
    });

    it("normal + agent=heavy -> heavy", () => {
      const r = resolveTier({
        issueComplexity: "normal",
        agentTierPreference: "heavy",
      });
      expect(r.tier).toBe("heavy");
      expect(r.source).toBe("agent_preference");
    });

    it("normal + agent=null -> default", () => {
      const r = resolveTier({
        issueComplexity: "normal",
        agentTierPreference: null,
      });
      expect(r.tier).toBe("default");
      expect(r.source).toBe("default");
      expect(r.entry.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("no issue context (null complexity)", () => {
    it("null complexity + agent=fast -> fast", () => {
      const r = resolveTier({
        issueComplexity: null,
        agentTierPreference: "fast",
      });
      expect(r.tier).toBe("fast");
      expect(r.source).toBe("agent_preference");
    });

    it("null complexity + null agent -> default", () => {
      const r = resolveTier({
        issueComplexity: null,
        agentTierPreference: null,
      });
      expect(r.tier).toBe("default");
      expect(r.source).toBe("default");
    });

    it("undefined complexity + undefined agent -> default", () => {
      const r = resolveTier({});
      expect(r.tier).toBe("default");
      expect(r.source).toBe("default");
    });
  });

  describe("model menu shape (locked per MODEL_MENU.md)", () => {
    it("every tier has a primary model + provider", () => {
      for (const tier of ["local", "fast", "default", "heavy"] as const) {
        const entry = MODEL_MENU[tier];
        expect(entry.tier).toBe(tier);
        expect(entry.model).toBeTruthy();
        expect(entry.provider).toBeTruthy();
      }
    });

    it("local + fast have same-tier fallbacks; default + heavy do not", () => {
      expect(MODEL_MENU.local.sameTierFallback).toBeDefined();
      expect(MODEL_MENU.fast.sameTierFallback).toBeDefined();
      expect(MODEL_MENU.default.sameTierFallback).toBeUndefined();
      expect(MODEL_MENU.heavy.sameTierFallback).toBeUndefined();
    });

    it("every provider value is in Patch 3's VALID_PROVIDERS whitelist (anthropic/google/ollama)", () => {
      const allowed = new Set(["anthropic", "google", "ollama"]);
      for (const tier of ["local", "fast", "default", "heavy"] as const) {
        const entry = MODEL_MENU[tier];
        expect(allowed.has(entry.provider)).toBe(true);
        if (entry.sameTierFallback) {
          expect(allowed.has(entry.sameTierFallback.provider)).toBe(true);
        }
      }
    });

    it("resolveModel returns the locked primary for each tier", () => {
      expect(resolveModel("local").model).toBe("qwen2.5-coder:7b");
      expect(resolveModel("fast").model).toBe("claude-haiku-4-5-20251001");
      expect(resolveModel("default").model).toBe("claude-sonnet-4-6");
      expect(resolveModel("heavy").model).toBe("claude-opus-4-7");
    });
  });

  describe("precedence is operator > agent > default", () => {
    it("explicit trivial beats all agent preferences", () => {
      for (const agentPref of ["local", "fast", "default", "heavy"] as const) {
        const r = resolveTier({
          issueComplexity: "trivial",
          agentTierPreference: agentPref,
        });
        expect(r.tier).toBe("fast");
        expect(r.source).toBe("issue_complexity");
      }
    });

    it("agent preference beats default fallback", () => {
      for (const agentPref of ["local", "fast", "heavy"] as const) {
        const r = resolveTier({
          issueComplexity: "normal",
          agentTierPreference: agentPref,
        });
        expect(r.tier).toBe(agentPref);
        expect(r.source).toBe("agent_preference");
      }
    });
  });
});
