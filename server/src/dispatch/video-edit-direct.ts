/**
 * Plan 5 Phase B — direct-Python execution for video-edit-* sub-stages.
 *
 * The smoke retro for Plan 5 (2026-05-28) showed that every edit
 * sub-stage's LLM-worker hallucinated `error_code: missing_api_keys`
 * before ever invoking the Python entrypoint, despite verified env
 * access. AGENTS.md prescriptive hardening (commit e68d72d) did not
 * change the behaviour on scenes 2..5. The LLM is pure overhead and
 * a hallucination liability for these deterministic Python scripts.
 *
 * This module replaces the LLM-adapter spawn for `video-edit-*` issues
 * with a direct `child_process.spawn` of the mapped Python entrypoint.
 * The wedge sits in heartbeat.ts immediately before `adapter.execute`;
 * the synthesized `AdapterExecutionResult` falls through to the existing
 * artifact-upload + final_cut_ready emit flow unchanged.
 *
 * Mapping (from VIDEO_ISSUE_TITLE_PATTERN stage captures):
 *   edit-scene-1..5      ->  render_scene.py  <N>
 *   edit-stitch          ->  stitch.py
 *   edit-motion-graphics ->  motion_graphics.py
 *   edit-screenshots     ->  screenshots.py
 *   edit-captions        ->  captions.py
 *   edit-final           ->  finalize.py
 *
 * Non-edit-* stages (research/strategy/copy) are CREATIVE and stay on
 * the LLM-adapter path. `resolveVideoEditDirectTarget` returns null for
 * them; the wedge short-circuits to the normal `adapter.execute` call.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

import { VIDEO_ISSUE_TITLE_PATTERN } from "./guild-worker-env.js";

/** Compiled mapping result for a single edit sub-stage. */
export interface VideoEditDirectTarget {
  /** The exact sub-stage label parsed from `video-<stage>/<id>`. */
  stage: string;
  /** Absolute path to the Python interpreter to spawn. */
  pythonBin: string;
  /** Absolute path to the script entrypoint. */
  scriptPath: string;
  /** Positional args appended after the script path. */
  args: readonly string[];
}

/** Default Python interpreter inside the paperclip image. Overridable
 * via `VIDEO_GUILD_PYTHON_BIN` for test fixtures + future runtime moves. */
const DEFAULT_PYTHON_BIN = "/opt/hermes-venv/bin/python";

/** Default scripts dir baked into the paperclip image at build time
 * (Dockerfile.hermes-overlay COPY of services/video-guild/scripts/).
 * Overridable via `VIDEO_GUILD_SCRIPTS_DIR` for tests. */
const DEFAULT_SCRIPTS_DIR = "/opt/video-guild/scripts";

/** Per-substage timeout in milliseconds. Default 10 minutes; covers
 * the longest plausible Plan 5 substage (finalize.py with ffmpeg remux
 * on a 100MB stitched cut runs in ~5s; an edit-scene-N Kling render +
 * Sync lipsync runs ~3min). Overridable via `VIDEO_GUILD_SUBSTAGE_TIMEOUT_MS`. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Single source of truth for stage -> script mapping. Exported as a
 * frozen object so tests can assert exhaustive coverage. */
export const VIDEO_EDIT_DIRECT_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  "edit-stitch": "stitch.py",
  "edit-motion-graphics": "motion_graphics.py",
  "edit-screenshots": "screenshots.py",
  "edit-captions": "captions.py",
  "edit-final": "finalize.py",
  // edit-scene-N is handled separately below because it takes an arg.
});

/**
 * Inspect an issueTitle. If it names a Plan 5 edit sub-stage, return
 * the resolved (script, args) tuple. Otherwise return null and the
 * caller falls back to the LLM-adapter path.
 *
 * The pythonBin + scripts dir defaults can be overridden via the
 * env-var fields on `opts` so test rigs can point at a fake interpreter
 * + fake scripts (e.g. a small `echo.py`).
 */
export function resolveVideoEditDirectTarget(
  issueTitle: string | null | undefined,
  opts: { pythonBin?: string; scriptsDir?: string } = {},
): VideoEditDirectTarget | null {
  if (typeof issueTitle !== "string") return null;
  const m = issueTitle.match(VIDEO_ISSUE_TITLE_PATTERN);
  if (!m) return null;
  const stage = m[1];
  const pythonBin = opts.pythonBin ?? process.env.VIDEO_GUILD_PYTHON_BIN ?? DEFAULT_PYTHON_BIN;
  const scriptsDir = opts.scriptsDir ?? process.env.VIDEO_GUILD_SCRIPTS_DIR ?? DEFAULT_SCRIPTS_DIR;

  // edit-scene-N -> render_scene.py with the scene index as arg.
  const sceneMatch = stage.match(/^edit-scene-([1-5])$/);
  if (sceneMatch) {
    return {
      stage,
      pythonBin,
      scriptPath: path.join(scriptsDir, "render_scene.py"),
      args: [sceneMatch[1]],
    };
  }

  const script = VIDEO_EDIT_DIRECT_SCRIPTS[stage];
  if (!script) return null;
  return {
    stage,
    pythonBin,
    scriptPath: path.join(scriptsDir, script),
    args: [],
  };
}

/** Logger surface the spawn helper needs. Matches the warn-and-continue
 * pattern used elsewhere in the dispatch path. */
export interface DirectSpawnLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

/** Subset of the heartbeat spawn callback surface this module needs.
 * Mirrors the shapes the LLM adapter receives so wedge callers can pass
 * the same callbacks unchanged. */
export interface DirectSpawnCallbacks {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
}

/** Inputs to `runVideoEditSubstageDirectly`. */
export interface RunVideoEditSubstageDirectlyInput {
  target: VideoEditDirectTarget;
  /** Working directory for the spawn. Should be the guild run sandbox
   * dir (`$AGENT_HOME`); scripts read artifacts/in/out under here. */
  cwd: string;
  /** Spawn env. Callers pass `{ ...process.env, ...guildEnv }` so the
   * worker sees both container-level secrets (FAL_KEY, AGENT_FS_TOKEN)
   * AND per-run scoped vars (AGENT_HOME, VIDEO_AD_STAGE). */
  env: Record<string, string>;
  callbacks: DirectSpawnCallbacks;
  logger: DirectSpawnLogger;
  /** Override the default 10-minute per-substage timeout. Tests pass a
   * tiny value to assert the timeout-kills-process path. */
  timeoutMs?: number;
}

/**
 * Spawn a Python edit sub-stage directly and synthesize an
 * AdapterExecutionResult for the rest of the heartbeat pipeline.
 *
 * Behaviour:
 *   - Spawns `pythonBin scriptPath [...args]` with the supplied env + cwd.
 *   - Streams stdout + stderr through `callbacks.onLog` (decoded UTF-8).
 *   - Fires `callbacks.onSpawn` once with pid + startedAt.
 *   - On clean exit: returns `{ exitCode: 0, signal: null, timedOut: false,
 *     provider: 'python-direct', model: scriptName }`. The downstream
 *     hook in heartbeat.ts treats `exitCode === 0 && !errorMessage` as
 *     `runStatus: "succeeded"`, which triggers the existing
 *     uploadWorkerArtifacts + video.ad.final_cut_ready emit path.
 *   - On non-zero exit: returns the actual exitCode + a summary
 *     errorMessage. The post-execution hook still fires
 *     video.artifacts.uploaded if anything landed in artifacts/out/.
 *   - On timeout: SIGTERM + 5s grace + SIGKILL. Result has
 *     `timedOut: true` so the escalation backstop deliberately skips it
 *     (escalating a deterministic script to a higher LLM tier makes no
 *     sense).
 *   - On spawn failure (ENOENT, EACCES, etc.): returns
 *     `{ exitCode: null, errorMessage: <reason>, errorCode: 'spawn_failed' }`.
 *
 * The function never throws -- spawn errors are captured in the result
 * shape so callers can rely on `await` returning a value.
 */
export async function runVideoEditSubstageDirectly(
  input: RunVideoEditSubstageDirectlyInput,
): Promise<AdapterExecutionResult> {
  const { target, cwd, env, callbacks, logger } = input;
  const timeoutMs = input.timeoutMs ?? Number(process.env.VIDEO_GUILD_SUBSTAGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const scriptName = path.basename(target.scriptPath);

  return await new Promise<AdapterExecutionResult>((resolve) => {
    let resolved = false;
    const finish = (result: AdapterExecutionResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(target.pythonBin, [target.scriptPath, ...target.args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      logger.warn(
        { err: spawnErr, target, cwd },
        "video-edit-direct: spawn threw synchronously",
      );
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `video-edit-direct: spawn failed: ${msg}`,
        errorCode: "spawn_failed",
        provider: "python-direct",
        model: scriptName,
      });
      return;
    }

    // Fire onSpawn ASAP so heartbeat can persist the pid for kill paths.
    if (callbacks.onSpawn && typeof child.pid === "number") {
      void callbacks.onSpawn({
        pid: child.pid,
        processGroupId: null,
        startedAt,
      }).catch((cbErr: unknown) => {
        logger.warn(
          { err: cbErr, pid: child.pid },
          "video-edit-direct: onSpawn callback threw (continuing)",
        );
      });
    }

    // Stream stdout + stderr. Buffer per-event so partial multi-byte
    // sequences across chunks decode cleanly via setEncoding('utf-8').
    if (child.stdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        void callbacks.onLog("stdout", chunk).catch((cbErr: unknown) => {
          logger.warn(
            { err: cbErr },
            "video-edit-direct: onLog(stdout) callback threw (continuing)",
          );
        });
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        void callbacks.onLog("stderr", chunk).catch((cbErr: unknown) => {
          logger.warn(
            { err: cbErr },
            "video-edit-direct: onLog(stderr) callback threw (continuing)",
          );
        });
      });
    }

    // Timeout: SIGTERM + 5s grace + SIGKILL. Mark timedOut so the
    // upstream escalation backstop skips this path (escalating a
    // deterministic Python script to a heavier LLM tier is nonsense).
    let timedOut = false;
    const sigtermTimer = setTimeout(() => {
      if (resolved) return;
      timedOut = true;
      logger.warn(
        { target, pid: child.pid, timeoutMs },
        "video-edit-direct: substage exceeded timeout; sending SIGTERM",
      );
      try {
        child.kill("SIGTERM");
      } catch (killErr) {
        logger.warn(
          { err: killErr, pid: child.pid },
          "video-edit-direct: SIGTERM kill threw (continuing)",
        );
      }
      // Hard kill after 5s grace so a hung ffmpeg can't deadlock the run.
      setTimeout(() => {
        if (resolved) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }, 5_000).unref?.();
    }, timeoutMs);
    sigtermTimer.unref?.();

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(sigtermTimer);
      logger.warn(
        { err, target, cwd },
        "video-edit-direct: child emitted error",
      );
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `video-edit-direct: child error: ${err.message}`,
        errorCode: err.code ?? "child_error",
        provider: "python-direct",
        model: scriptName,
      });
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(sigtermTimer);
      const durationMs = Date.now() - startMs;
      const cleanExit = (code ?? -1) === 0 && !timedOut;
      finish({
        exitCode: code,
        signal: signal,
        timedOut,
        ...(cleanExit
          ? {}
          : {
              errorMessage: timedOut
                ? `video-edit-direct: ${target.stage} timed out after ${timeoutMs}ms`
                : `video-edit-direct: ${target.stage} exited code=${code} signal=${signal ?? "null"}`,
              errorCode: timedOut ? "substage_timeout" : "substage_failed",
            }),
        provider: "python-direct",
        model: scriptName,
        // Cost-tracking: deterministic scripts are free at the LLM
        // layer. They burn fal.ai + ElevenLabs spend separately; that
        // accounting happens in render-log.json, not here.
        costUsd: 0,
        summary: `video-edit-direct: ${target.stage} ${
          cleanExit ? "succeeded" : timedOut ? "timed out" : "failed"
        } in ${durationMs}ms`,
      });
    });
  });
}
