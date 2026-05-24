/**
 * Plan 3 Phase E1a — per-run sandbox for a guild worker.
 *
 * The dispatch layer creates a unique directory per run whose
 * `agent.kind === 'guild'`, copies in the guild's `autonomy.json`,
 * writes the canonical-skills snapshot (`available_skills.json`), and
 * hands the path back to the dispatcher so it can:
 *
 *   1. expose the paths to the worker via the env produced by
 *      `buildGuildWorkerEnv` (sibling module);
 *   2. ingest the worker's `learnings.json` from the same directory in
 *      the Phase E2 worker-exit hook;
 *   3. clean up via `cleanupGuildRunSandbox` after ingest succeeds.
 *
 * The directory is `mkdtemp`'d under `os.tmpdir()` with the prefix
 * `paperclip-guild-run-<runId>-` so concurrent guild dispatches never
 * collide and orphans are easy to spot manually.
 *
 * Failure model:
 *
 *   - sandbox creation is fatal to the run (the dispatcher should
 *     fail-fast with `errorCode='guild_sandbox_init_failed'` so the
 *     operator sees a clean failure, not a silent fall-through).
 *   - a missing guild `autonomy.json` (e.g. operator forgot to deploy
 *     the bundle) is non-fatal: the sandbox is still created without
 *     `autonomy.json` and a warning is returned in the result so the
 *     dispatcher can log it. The worker is then on a degraded path
 *     (no envelope) but the run isn't blocked.
 *   - cleanup is best-effort and idempotent. Failing to remove an
 *     orphan dir is logged by the caller and never throws.
 *
 * See docs/superpowers/specs/2026-05-21-plan3-phase-e-worker-lifecycle.md
 * decisions D4, D6, D9.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ArtifactsClient } from "./artifacts-client.js";
import {
  GUILD_WORKER_AUTONOMY_FILE,
  GUILD_WORKER_SKILLS_FILE,
} from "./guild-worker-env.js";

/**
 * Phase 2 Task 2.4 -- video-guild stage pipeline contract.
 *
 * Ordered list of pipeline stages. For a worker spawning in stage S,
 * the dispatcher mirrors every artifact produced by stages strictly
 * before S, in this order. `edit` is the terminal stage, so nothing
 * downstream ever reads its outputs from a sandbox.
 */
const VIDEO_STAGES = ["research", "strategy", "copy", "edit"] as const;
export type VideoStage = (typeof VIDEO_STAGES)[number];

/**
 * Per-stage artifact contract -- the JSON files each stage publishes
 * for downstream stages to consume. v0 is JSON-only because the
 * agent-fs Task 2.3 route returns only JSON; text/binary artifacts
 * (captions.srt, render.mp4, etc.) are deferred to a future agent-fs
 * route extension. Phase 6 smoke will reveal whether v0 is sufficient.
 */
const VIDEO_STAGE_OUTPUTS: Record<VideoStage, readonly string[]> = {
  research: ["research-bundle.json"],
  strategy: ["creative-brief.json"],
  copy: ["script.json", "caption_variants.json"],
  edit: [],
};

/** Shape of a single canonical skill exposed to the worker at start of run.
 * Mirrors the subset of `skills` table columns the worker actually needs. */
export interface GuildSkillSnapshotEntry {
  id: string;
  name: string;
  body: string;
}

export interface PrepareGuildRunSandboxInput {
  runId: string;
  guildId: string;
  guildSlug: string;
  /** Path on the host where the guild's instruction bundle lives;
   * we read `<root>/autonomy.json` from here. Set per-guild in
   * `agent.adapterConfig.instructionsRootPath`. */
  guildInstructionsRoot: string | null;
  /** Snapshot of canonical, non-retired skills the dispatcher queried
   * pre-spawn (top 20 by recency per the spec). */
  skills: GuildSkillSnapshotEntry[];
  /** Optional override for the tmp-dir parent. Defaults to `os.tmpdir()`.
   * Tests pass an explicit dir; production omits. */
  tmpDirOverride?: string;
  /**
   * Phase 2 Task 2.4 -- video-guild prior-stage artifact mirror.
   *
   * When set, the dispatcher walks `VIDEO_STAGES` from the start up to
   * (but not including) `stage`, asks `artifacts.fetchArtifact` for
   * every JSON file each prior stage produces, and writes each
   * non-null result to `<sandboxDir>/artifacts/in/<stage>/<filename>`.
   * Workers can then read prior-stage outputs from disk without
   * making their own HTTP calls.
   *
   * Null returns from the client are non-fatal: a warning is appended
   * and the worker runs on the degraded path. Non-video guild runs
   * omit `videoContext`; backwards-compatible.
   */
  videoContext?: {
    requestId: string;
    stage: VideoStage;
    artifacts: ArtifactsClient;
  };
}

export interface PrepareGuildRunSandboxResult {
  /** Absolute path to the newly created sandbox directory. */
  sandboxDir: string;
  /** Absolute path to `<sandboxDir>/autonomy.json`. Null when the source
   * bundle's `autonomy.json` was not found (degraded path). */
  autonomyJsonPath: string | null;
  /** Absolute path to `<sandboxDir>/available_skills.json`. Always
   * present; empty `skills: []` if the snapshot was empty. */
  availableSkillsPath: string;
  /** Number of canonical skills written to `available_skills.json`. */
  snapshotedSkillCount: number;
  /**
   * Phase 2 Task 2.4 -- prior-stage artifact paths the dispatcher
   * actually wrote into the sandbox (relative to `sandboxDir`). Empty
   * for non-video runs, the research stage of a video run, or runs
   * where every prior-stage artifact came back null.
   */
  mirroredArtifacts: string[];
  /** Warnings the dispatcher should log. Non-fatal but operator-visible. */
  warnings: string[];
}

/**
 * Build a per-run sandbox dir, populate it with the guild's autonomy
 * envelope + canonical-skills snapshot, and (for video-guild runs)
 * mirror prior-stage JSON artifacts into
 * `<sandboxDir>/artifacts/in/<stage>/<filename>`.
 *
 * Design notes:
 *
 *   - Video artifacts live under the per-run sandbox dir, not under
 *     `$AGENT_HOME/artifacts/in/`. The plan literal says $AGENT_HOME
 *     but the dispatcher creates per-run tmp dirs and video artifacts
 *     are per-request-id scoped, so the per-run sandbox is the right
 *     home. The worker reads its artifacts via the env vars the
 *     sibling `buildGuildWorkerEnv` emits (Task 2.4b will surface a
 *     `VIDEO_AD_ARTIFACTS_DIR` env var; for now workers can derive it
 *     from `GUILD_AUTONOMY_JSON_PATH`'s dir).
 *
 *   - v0 is JSON-only by design (matches Task 2.3's agent-fs route).
 *     Text/binary artifacts like captions.srt or render.mp4 are
 *     deferred until an agent-fs route extension lands.
 */
export async function prepareGuildRunSandbox(
  input: PrepareGuildRunSandboxInput,
): Promise<PrepareGuildRunSandboxResult> {
  const warnings: string[] = [];
  const mirroredArtifacts: string[] = [];
  const prefix = path.join(
    input.tmpDirOverride ?? os.tmpdir(),
    `paperclip-guild-run-${input.runId}-`,
  );
  const sandboxDir = await fs.mkdtemp(prefix);

  // available_skills.json — always written, even if empty.
  const skillsSnapshot = {
    guildId: input.guildId,
    guildSlug: input.guildSlug,
    snapshotAt: new Date().toISOString(),
    totalCanonical: input.skills.length,
    skills: input.skills.map((s) => ({ id: s.id, name: s.name, body: s.body })),
  };
  const availableSkillsPath = path.join(sandboxDir, GUILD_WORKER_SKILLS_FILE);
  await fs.writeFile(
    availableSkillsPath,
    JSON.stringify(skillsSnapshot, null, 2),
    "utf-8",
  );

  // autonomy.json — copied from the deployed bundle if present.
  let autonomyJsonPath: string | null = null;
  if (input.guildInstructionsRoot) {
    const source = path.join(input.guildInstructionsRoot, GUILD_WORKER_AUTONOMY_FILE);
    const target = path.join(sandboxDir, GUILD_WORKER_AUTONOMY_FILE);
    try {
      const contents = await fs.readFile(source, "utf-8");
      // Validate it parses as JSON so a corrupt bundle is caught early
      // (worker would otherwise read it and crash). The parsed value is
      // discarded; we only re-emit the original text so a worker that
      // does its own JSON-Schema validation sees the bytes the operator
      // committed.
      JSON.parse(contents);
      await fs.writeFile(target, contents, "utf-8");
      autonomyJsonPath = target;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `guild_sandbox: failed to copy autonomy.json from ${source}: ${msg}`,
      );
    }
  } else {
    warnings.push(
      "guild_sandbox: no instructionsRootPath configured on the guild row; " +
        "worker will run without autonomy.json (degraded envelope).",
    );
  }

  // Phase 2 Task 2.4 -- mirror prior-stage artifacts for video-guild runs.
  if (input.videoContext) {
    const { requestId, stage, artifacts } = input.videoContext;
    const currentIdx = VIDEO_STAGES.indexOf(stage);
    // Iterate over every stage strictly before `stage` in pipeline order.
    for (let i = 0; i < currentIdx; i++) {
      const priorStage = VIDEO_STAGES[i];
      for (const filename of VIDEO_STAGE_OUTPUTS[priorStage]) {
        let body: unknown | null;
        try {
          body = await artifacts.fetchArtifact(requestId, priorStage, filename);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `guild_sandbox: failed to fetch ${priorStage}/${filename} for requestId=${requestId}: ${msg}`,
          );
          continue;
        }
        if (body === null || body === undefined) {
          warnings.push(
            `guild_sandbox: prior-stage artifact missing (requestId=${requestId}, stage=${priorStage}, file=${filename}); worker will run without it`,
          );
          continue;
        }
        const stageDir = path.join(sandboxDir, "artifacts", "in", priorStage);
        await fs.mkdir(stageDir, { recursive: true, mode: 0o700 });
        const targetPath = path.join(stageDir, filename);
        await fs.writeFile(targetPath, JSON.stringify(body, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        mirroredArtifacts.push(path.join("artifacts", "in", priorStage, filename));
      }
    }
  }

  return {
    sandboxDir,
    autonomyJsonPath,
    availableSkillsPath,
    snapshotedSkillCount: input.skills.length,
    mirroredArtifacts,
    warnings,
  };
}

/**
 * Best-effort cleanup. Idempotent: removing a non-existent dir is a
 * no-op. Any failure is swallowed and returned as a warning string so
 * the caller can decide whether to log. The hook still does its work
 * even if the dir refuses to disappear.
 */
export async function cleanupGuildRunSandbox(
  sandboxDir: string,
): Promise<{ removed: boolean; warning: string | null }> {
  try {
    await fs.rm(sandboxDir, { recursive: true, force: true });
    return { removed: true, warning: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      removed: false,
      warning: `guild_sandbox: cleanup of ${sandboxDir} failed: ${msg}`,
    };
  }
}
