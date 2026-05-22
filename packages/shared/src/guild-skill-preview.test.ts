import { describe, expect, it } from "vitest";

import {
  GUILD_SKILL_BODY_PREVIEW_MAX,
  truncateGuildSkillBody,
} from "./guild-skill-preview.js";

describe("truncateGuildSkillBody", () => {
  it("returns input unchanged when length is under the cap", () => {
    const body = "short";
    expect(truncateGuildSkillBody(body)).toBe("short");
  });

  it("returns input unchanged when length is exactly the cap", () => {
    const body = "a".repeat(GUILD_SKILL_BODY_PREVIEW_MAX);
    expect(truncateGuildSkillBody(body)).toBe(body);
  });

  it("truncates and appends a single '…' when over the cap by one", () => {
    const body = "a".repeat(GUILD_SKILL_BODY_PREVIEW_MAX + 1);
    const out = truncateGuildSkillBody(body);
    expect(Array.from(out)).toHaveLength(GUILD_SKILL_BODY_PREVIEW_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, GUILD_SKILL_BODY_PREVIEW_MAX)).toBe(
      "a".repeat(GUILD_SKILL_BODY_PREVIEW_MAX),
    );
  });

  it("truncates a long body to cap+1 codepoints (cap chars + ellipsis)", () => {
    const body = "x".repeat(10_000);
    const out = truncateGuildSkillBody(body);
    expect(Array.from(out)).toHaveLength(GUILD_SKILL_BODY_PREVIEW_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair (emoji are codepoint-safe)", () => {
    // 🦔 is a single codepoint (U+1F994) but two UTF-16 code units.
    // A naive `slice(0, n)` could split this; Array.from must not.
    const body = "🦔".repeat(GUILD_SKILL_BODY_PREVIEW_MAX + 50);
    const out = truncateGuildSkillBody(body);
    // First MAX codepoints are full hedgehogs; trailing char is the ellipsis.
    expect(Array.from(out)).toHaveLength(GUILD_SKILL_BODY_PREVIEW_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    // Body up to the ellipsis must be parseable as exactly MAX hedgehogs
    // — i.e. no lone high-surrogate at the boundary.
    const head = Array.from(out.slice(0, out.length - 1));
    expect(head).toHaveLength(GUILD_SKILL_BODY_PREVIEW_MAX);
    for (const cp of head) {
      expect(cp).toBe("🦔");
    }
  });

  it("respects a caller-supplied custom max", () => {
    expect(truncateGuildSkillBody("abcdef", 3)).toBe("abc…");
    expect(truncateGuildSkillBody("abc", 3)).toBe("abc");
  });

  it("is a fixed point at the cap (re-truncating a truncated body is a no-op)", () => {
    // The consumer in ceo-chat re-truncates at the same cap. A body
    // emitted at length cap+1 (cap chars + '…') should pass through
    // unchanged on the second pass — Array.from(out).length === cap+1
    // is over the cap, so the consumer trims to cap and re-appends '…'.
    // The visible result must still be the same first-cap-chars + '…'.
    const body = "a".repeat(10_000);
    const first = truncateGuildSkillBody(body);
    const second = truncateGuildSkillBody(first);
    // Both passes yield the same MAX-prefix followed by '…'.
    expect(second.slice(0, GUILD_SKILL_BODY_PREVIEW_MAX)).toBe(
      first.slice(0, GUILD_SKILL_BODY_PREVIEW_MAX),
    );
    expect(second.endsWith("…")).toBe(true);
  });
});
