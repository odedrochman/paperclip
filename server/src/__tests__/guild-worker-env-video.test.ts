/**
 * Phase 2 Task 2.1 -- video-guild dispatcher env-var pass-through.
 *
 * Verifies that `buildGuildWorkerEnv` extracts the stage + request_id
 * from an issue title of the form `video-<stage>/<request_id>` and
 * emits `VIDEO_AD_STAGE` + `VIDEO_AD_REQUEST_ID` env vars for the
 * worker. Non-matching titles (e.g. eng-guild issues) are unaffected.
 *
 * NOTE: the function signature is `{ agent, sandboxDir, issueTitle? }`.
 * The plan's test sketch used `{ issue, guildSlug }` which is the call
 * site's shape, not the function's. This file adapts the test to the
 * function's actual signature per the TDD rule "adapt the test, not
 * the function".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildGuildWorkerEnv } from "../dispatch/guild-worker-env.js";

const guildAgent = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "video-guild",
  kind: "guild" as const,
};
const engGuildAgent = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "eng-guild",
  kind: "guild" as const,
};
const sandboxDir = "/tmp/paperclip-guild-run-vid-XXXXXX";

describe("video-guild worker env", () => {
  it("passes VIDEO_AD_REQUEST_ID + VIDEO_AD_STAGE=research when issue title starts with video-research/", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-research/abc-123",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBe("abc-123");
    expect(env.VIDEO_AD_STAGE).toBe("research");
  });

  it("passes VIDEO_AD_STAGE=strategy for video-strategy/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-strategy/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("strategy");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("passes VIDEO_AD_STAGE=copy for video-copy/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-copy/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("copy");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("passes VIDEO_AD_STAGE=edit for video-edit/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-edit/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("edit");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("does not set VIDEO_AD_* for non-video guild issues", () => {
    const env = buildGuildWorkerEnv({
      agent: engGuildAgent,
      sandboxDir,
      issueTitle: "eng-typescript-bug",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* when issueTitle is omitted", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* for unknown stages (e.g. video-foo/...)", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-foo/bar-123",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* when request_id segment contains a slash (e.g. video-research/abc/def)", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-research/abc/def",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  describe("VIDEO_AD_ARTIFACTS_DIR (Task 2.4b)", () => {
    it("sets VIDEO_AD_ARTIFACTS_DIR=<sandboxDir>/artifacts when issue title matches video pattern", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBe(path.join(sandboxDir, "artifacts"));
    });

    it("sets VIDEO_AD_ARTIFACTS_DIR for every recognised stage", () => {
      for (const stage of ["research", "strategy", "copy", "edit"]) {
        const env = buildGuildWorkerEnv({
          agent: guildAgent,
          sandboxDir,
          issueTitle: `video-${stage}/req-1`,
        });
        expect(env.VIDEO_AD_ARTIFACTS_DIR).toBe(path.join(sandboxDir, "artifacts"));
      }
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR for non-video guild issues (eng-guild)", () => {
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-typescript-bug",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR when issueTitle is omitted on a video-guild agent", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR for unrecognised video-* stages", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-foo/bar-123",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });
  });

  /**
   * Bug G fix -- forward narrow allowlist of third-party API keys from
   * the paperclip process env to the worker env, but only for video-guild
   * issues. The dispatcher's worker had been failing on ElevenLabs voice
   * synthesis because the key, though set in the paperclip container,
   * was never propagated to the spawned worker's env.
   */
  describe("VIDEO_WORKER_FORWARDED_ENV_KEYS allowlist (Bug G)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("forwards ELEVENLABS_API_KEY when process.env has it AND issue is a video stage", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBe("test-key-xyz");
    });

    it("does NOT forward ELEVENLABS_API_KEY for non-video guild issues (eng-task)", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-task-1",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when issueTitle is null", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: null,
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when agent.kind !== 'guild'", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: {
          id: "00000000-0000-0000-0000-000000000003",
          name: "some-worker",
          kind: "worker" as never,
        },
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env).toEqual({});
    });

    it("does NOT forward ELEVENLABS_API_KEY when process.env.ELEVENLABS_API_KEY is unset", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", undefined as unknown as string);
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when process.env.ELEVENLABS_API_KEY is an empty string", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });
  });

  /**
   * Tier 3 Phase 1 Task 2 -- operator UGC clip detection.
   *
   * When the operator drops `.mp4` clips into
   * `${PAPERCLIP_OPERATOR_UPLOADS_ROOT}/<request_id>/`, the dispatcher
   * surfaces UGC_INPUT_DIR + UGC_INPUT_COUNT to the worker. Absence of
   * UGC_INPUT_DIR is the worker's signal to take the synthetic-clip
   * fallback path (B.2). Tests redirect the root to a tmpdir.
   */
  describe("UGC_INPUT_DIR + UGC_INPUT_COUNT (Tier 3 Phase 1 Task 2)", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operator-uploads-"));
      vi.stubEnv("PAPERCLIP_OPERATOR_UPLOADS_ROOT", tmpRoot);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    it("does NOT emit UGC_INPUT_DIR when the operator-uploads dir does not exist", () => {
      // tmpRoot exists but has no subdir for the request_id
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit/req-missing",
      });
      expect(env.UGC_INPUT_DIR).toBeUndefined();
      expect(env.UGC_INPUT_COUNT).toBeUndefined();
    });

    it("does NOT emit UGC_INPUT_DIR when the dir exists but is empty", () => {
      fs.mkdirSync(path.join(tmpRoot, "req-empty"));
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit/req-empty",
      });
      expect(env.UGC_INPUT_DIR).toBeUndefined();
      expect(env.UGC_INPUT_COUNT).toBeUndefined();
    });

    it("does NOT emit UGC_INPUT_DIR when the dir contains only non-mp4 files", () => {
      const dir = path.join(tmpRoot, "req-only-txt");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
      fs.writeFileSync(path.join(dir, "thumb.png"), "");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit/req-only-txt",
      });
      expect(env.UGC_INPUT_DIR).toBeUndefined();
      expect(env.UGC_INPUT_COUNT).toBeUndefined();
    });

    it("emits UGC_INPUT_DIR + UGC_INPUT_COUNT='1' when the dir contains a single .mp4", () => {
      const requestId = "req-single";
      const dir = path.join(tmpRoot, requestId);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "hook.mp4"), "");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: `video-edit/${requestId}`,
      });
      expect(env.UGC_INPUT_DIR).toBe(dir);
      expect(env.UGC_INPUT_COUNT).toBe("1");
    });

    it("counts only .mp4 files; UGC_INPUT_COUNT='3' when dir has 3 mp4 + 1 txt", () => {
      const requestId = "req-mixed";
      const dir = path.join(tmpRoot, requestId);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "hook.mp4"), "");
      fs.writeFileSync(path.join(dir, "reaction.mp4"), "");
      fs.writeFileSync(path.join(dir, "outro.mp4"), "");
      fs.writeFileSync(path.join(dir, "notes.txt"), "operator notes");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: `video-edit/${requestId}`,
      });
      expect(env.UGC_INPUT_DIR).toBe(dir);
      expect(env.UGC_INPUT_COUNT).toBe("3");
    });

    it("treats .MP4 (uppercase) as an mp4 (case-insensitive match)", () => {
      const requestId = "req-upper";
      const dir = path.join(tmpRoot, requestId);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "CLIP1.MP4"), "");
      fs.writeFileSync(path.join(dir, "clip2.Mp4"), "");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: `video-edit/${requestId}`,
      });
      expect(env.UGC_INPUT_DIR).toBe(dir);
      expect(env.UGC_INPUT_COUNT).toBe("2");
    });

    it("does NOT emit UGC_INPUT_DIR for a non-video issue title even if a same-named dir exists", () => {
      // The dir exists but the issue is not a video-* one, so the
      // dispatcher short-circuits before the UGC check runs. This also
      // matches the existing video-only VIDEO_AD_* gating.
      const dir = path.join(tmpRoot, "req-non-video");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "hook.mp4"), "");
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-typescript-bug",
      });
      expect(env.UGC_INPUT_DIR).toBeUndefined();
      expect(env.UGC_INPUT_COUNT).toBeUndefined();
      // Existing behavior preserved: no video env vars either.
      expect(env.VIDEO_AD_STAGE).toBeUndefined();
      expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    });

    it("emits UGC_INPUT_DIR for every recognised video stage when clips are present", () => {
      for (const stage of ["research", "strategy", "copy", "edit"]) {
        const requestId = `req-${stage}`;
        const dir = path.join(tmpRoot, requestId);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "clip.mp4"), "");
        const env = buildGuildWorkerEnv({
          agent: guildAgent,
          sandboxDir,
          issueTitle: `video-${stage}/${requestId}`,
        });
        expect(env.UGC_INPUT_DIR).toBe(dir);
        expect(env.UGC_INPUT_COUNT).toBe("1");
      }
    });

    it("uses the production default root (/paperclip/operator-uploads) when PAPERCLIP_OPERATOR_UPLOADS_ROOT is unset", () => {
      // The default root almost certainly does not exist on the test
      // host, so the helper must short-circuit cleanly with no emission
      // and no error.
      vi.stubEnv("PAPERCLIP_OPERATOR_UPLOADS_ROOT", undefined as unknown as string);
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit/req-no-default-root",
      });
      expect(env.UGC_INPUT_DIR).toBeUndefined();
      expect(env.UGC_INPUT_COUNT).toBeUndefined();
    });
  });

  /**
   * Plan 5 -- edit sub-stage gates. The orchestrator dispatches
   * separate paperclip issues for each gate inside the edit stage so
   * the operator can approve per-scene + per-post-render step. Issue
   * titles take the form `video-edit-<sub>/<request_id>`. The
   * dispatcher must extract the sub-stage as VIDEO_AD_STAGE so the
   * worker knows which sub-stage to run.
   */
  describe("Plan 5 edit sub-stage gates", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const SUB_STAGES = [
      "edit-scene-1",
      "edit-scene-2",
      "edit-scene-3",
      "edit-scene-4",
      "edit-scene-5",
      "edit-stitch",
      "edit-motion-graphics",
      "edit-screenshots",
      "edit-captions",
      "edit-final",
    ] as const;

    for (const sub of SUB_STAGES) {
      it(`extracts VIDEO_AD_STAGE='${sub}' from video-${sub}/<id>`, () => {
        const env = buildGuildWorkerEnv({
          agent: guildAgent,
          sandboxDir,
          issueTitle: `video-${sub}/req-plan5`,
        });
        expect(env.VIDEO_AD_STAGE).toBe(sub);
        expect(env.VIDEO_AD_REQUEST_ID).toBe("req-plan5");
      });
    }

    it("matches edit-scene-1 not 'edit' when title is video-edit-scene-1/<id> (alternation order)", () => {
      // Regression guard: if the regex's alternation put 'edit' before
      // 'edit-scene-1', the regex would greedily match 'edit' and
      // capture '/scene-1/req-x' as the request_id (which has a slash,
      // failing the [^/]+ guard). The order in the live regex must
      // therefore put longer prefixes first.
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit-scene-1/req-disambig",
      });
      expect(env.VIDEO_AD_STAGE).toBe("edit-scene-1");
      expect(env.VIDEO_AD_REQUEST_ID).toBe("req-disambig");
    });

    it("rejects unknown sub-stage names (e.g. video-edit-scene-9)", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit-scene-9/req-bogus",
      });
      expect(env.VIDEO_AD_STAGE).toBeUndefined();
      expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    });

    it("rejects unknown sub-stage names (e.g. video-edit-foo)", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit-foo/req-bogus",
      });
      expect(env.VIDEO_AD_STAGE).toBeUndefined();
      expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    });

    it("forwards FAL_KEY to sub-stage workers (Plan 5 allowlist extension)", () => {
      vi.stubEnv("FAL_KEY", "test-uuid:test-secret");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-edit-scene-1/req-fal-test",
      });
      expect(env.FAL_KEY).toBe("test-uuid:test-secret");
    });

    it("does NOT forward FAL_KEY for non-video guild issues", () => {
      vi.stubEnv("FAL_KEY", "test-uuid:test-secret");
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-typescript-bug",
      });
      expect(env.FAL_KEY).toBeUndefined();
    });

    it("sets VIDEO_AD_ARTIFACTS_DIR for every sub-stage", () => {
      for (const sub of SUB_STAGES) {
        const env = buildGuildWorkerEnv({
          agent: guildAgent,
          sandboxDir,
          issueTitle: `video-${sub}/req-art-${sub}`,
        });
        expect(env.VIDEO_AD_ARTIFACTS_DIR).toBe(path.join(sandboxDir, "artifacts"));
      }
    });
  });
});
