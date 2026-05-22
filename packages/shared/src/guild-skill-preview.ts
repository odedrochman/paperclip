/**
 * Plan 3 Phase F follow-up — body preview shared between the control-plane
 * emitter (paperclip activity_log) and the consumer (ceo-chat Telegram
 * notifier). Both sides must agree on this cap so a producer-side trim
 * does not produce a doubly-truncated body downstream.
 *
 * The notifier in services/ceo-chat/src/notifier.ts re-truncates at the
 * same cap with the same `…` marker, so a body emitted at exactly
 * GUILD_SKILL_BODY_PREVIEW_MAX codepoints is a fixed point and will not
 * be touched again.
 */

/**
 * Maximum body length, in Unicode codepoints, included in
 * `activity_log.details.ingested[].body` and in the consumer's
 * Telegram preview line.
 */
export const GUILD_SKILL_BODY_PREVIEW_MAX = 500;

/**
 * Codepoint-safe truncation. Iterates by Unicode codepoint via
 * `Array.from`, so surrogate pairs (emoji, supplementary-plane CJK,
 * combined-form characters that occupy two UTF-16 code units) cannot
 * be split across the boundary.
 *
 * Returns the input unchanged when it already fits within `max`
 * codepoints; otherwise returns the first `max` codepoints followed
 * by the ellipsis character `…`.
 */
export function truncateGuildSkillBody(
  body: string,
  max: number = GUILD_SKILL_BODY_PREVIEW_MAX,
): string {
  const codepoints = Array.from(body);
  if (codepoints.length <= max) return body;
  return codepoints.slice(0, max).join("") + "…";
}
