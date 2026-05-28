/**
 * Plan 5 Phase B — unit + integration tests for the direct-Python
 * execution wedge. Two layers:
 *
 *   1. resolveVideoEditDirectTarget — pure mapping logic. Asserts every
 *      Plan 5 edit sub-stage produces the right script + args, and that
 *      non-edit-* titles return null so the LLM-adapter path stays
 *      authoritative for creative stages.
 *
 *   2. runVideoEditSubstageDirectly — integration tests using REAL
 *      `child_process.spawn` against tiny shell stubs that mimic
 *      success/failure/timeout/spawn-error/stream behaviour. No mocked
 *      spawn, no fake child — the goal is to catch contract breakage
 *      at the OS boundary that a mock would paper over.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  VIDEO_EDIT_DIRECT_SCRIPTS,
  resolveVideoEditDirectTarget,
  runVideoEditSubstageDirectly,
  type VideoEditDirectTarget,
} from "../dispatch/video-edit-direct.js";

const noopLogger = { warn: () => {}, info: () => {} };

// ---------------------------------------------------------------------------
// resolveVideoEditDirectTarget
// ---------------------------------------------------------------------------

describe("resolveVideoEditDirectTarget", () => {
  const PY = "/fake/python";
  const DIR = "/fake/scripts";

  it("maps each edit-scene-N to render_scene.py with N as arg", () => {
    for (let n = 1; n <= 5; n++) {
      const t = resolveVideoEditDirectTarget(`video-edit-scene-${n}/req-x`, {
        pythonBin: PY,
        scriptsDir: DIR,
      });
      expect(t).not.toBeNull();
      expect(t!.stage).toBe(`edit-scene-${n}`);
      expect(t!.scriptPath).toBe(path.join(DIR, "render_scene.py"));
      expect(t!.args).toEqual([String(n)]);
      expect(t!.pythonBin).toBe(PY);
    }
  });

  it("maps every entry in VIDEO_EDIT_DIRECT_SCRIPTS exhaustively", () => {
    for (const [stage, script] of Object.entries(VIDEO_EDIT_DIRECT_SCRIPTS)) {
      const t = resolveVideoEditDirectTarget(`video-${stage}/req-x`, {
        pythonBin: PY,
        scriptsDir: DIR,
      });
      expect(t).not.toBeNull();
      expect(t!.stage).toBe(stage);
      expect(t!.scriptPath).toBe(path.join(DIR, script));
      expect(t!.args).toEqual([]);
    }
  });

  it("returns null for creative stages (LLM-adapter path stays authoritative)", () => {
    for (const stage of ["research", "strategy", "copy", "edit"]) {
      const t = resolveVideoEditDirectTarget(`video-${stage}/req-x`, {
        pythonBin: PY,
        scriptsDir: DIR,
      });
      expect(t).toBeNull();
    }
  });

  it("returns null for non-video issue titles", () => {
    for (const title of [
      "eng-typescript-bug-123",
      "ops-deploy",
      "video-edit-scene-6/x", // out of range
      "video-edit-foo/x",       // not in whitelist
      "video-edit-scene-1",     // missing /<id>
      "",
    ]) {
      expect(resolveVideoEditDirectTarget(title, { pythonBin: PY, scriptsDir: DIR })).toBeNull();
    }
  });

  it("returns null for null / undefined / non-string input", () => {
    expect(resolveVideoEditDirectTarget(null)).toBeNull();
    expect(resolveVideoEditDirectTarget(undefined)).toBeNull();
    expect(resolveVideoEditDirectTarget(42 as unknown as string)).toBeNull();
  });

  it("honours VIDEO_GUILD_PYTHON_BIN env override when opts not supplied", () => {
    const prev = process.env.VIDEO_GUILD_PYTHON_BIN;
    process.env.VIDEO_GUILD_PYTHON_BIN = "/usr/local/bin/python3.99";
    try {
      const t = resolveVideoEditDirectTarget("video-edit-stitch/req-x");
      expect(t).not.toBeNull();
      expect(t!.pythonBin).toBe("/usr/local/bin/python3.99");
    } finally {
      if (prev === undefined) delete process.env.VIDEO_GUILD_PYTHON_BIN;
      else process.env.VIDEO_GUILD_PYTHON_BIN = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// runVideoEditSubstageDirectly  -- real spawn
// ---------------------------------------------------------------------------

describe("runVideoEditSubstageDirectly (integration)", () => {
  let tmpDir: string;
  let scriptDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-edit-direct-test-"));
    scriptDir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-edit-direct-scripts-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Write a small Python script the test will spawn. Marked executable
   * isn't needed -- we spawn `python3 <script>` directly. */
  async function writeScript(name: string, body: string): Promise<string> {
    const p = path.join(scriptDir, name);
    await fsp.writeFile(p, body, { mode: 0o644 });
    return p;
  }

  /** Build a target pointing at the test scripts dir. Resolves the real
   * `python3` from PATH so the test runs on any machine that has it. */
  function makeTarget(stage: string, scriptName: string, args: string[] = []): VideoEditDirectTarget {
    return {
      stage,
      pythonBin: "python3",
      scriptPath: path.join(scriptDir, scriptName),
      args,
    };
  }

  it("returns exitCode=0 + success summary on clean exit", async () => {
    await writeScript("ok.py", "print('all good')\n");
    const logCalls: Array<{ stream: string; chunk: string }> = [];

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-stitch", "ok.py"),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: {
        onLog: async (stream, chunk) => {
          logCalls.push({ stream, chunk });
        },
      },
      logger: noopLogger,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeUndefined();
    expect(result.provider).toBe("python-direct");
    expect(result.model).toBe("ok.py");
    expect(result.costUsd).toBe(0);
    expect(result.summary).toMatch(/edit-stitch succeeded/);

    const stdoutText = logCalls.filter((c) => c.stream === "stdout").map((c) => c.chunk).join("");
    expect(stdoutText).toContain("all good");
  });

  it("returns non-zero exitCode + errorMessage when script fails", async () => {
    await writeScript("fail.py", "import sys; print('boom', file=sys.stderr); sys.exit(2)\n");
    const stderrChunks: string[] = [];

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-final", "fail.py"),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: {
        onLog: async (stream, chunk) => {
          if (stream === "stderr") stderrChunks.push(chunk);
        },
      },
      logger: noopLogger,
    });

    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toMatch(/edit-final exited code=2/);
    expect(result.errorCode).toBe("substage_failed");
    expect(stderrChunks.join("")).toContain("boom");
  });

  it("returns timedOut=true and kills the process when over the timeout", async () => {
    // sleep ~30s; we time it out after 200ms so the test stays fast.
    await writeScript("slow.py", "import time; time.sleep(30)\n");

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-motion-graphics", "slow.py"),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: { onLog: async () => {} },
      logger: noopLogger,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("substage_timeout");
    expect(result.errorMessage).toMatch(/timed out after 200ms/);
    // The process was either killed via SIGTERM (signal set) OR managed
    // to exit clean on Python's signal handler (rare but possible).
    // Either way exitCode is non-zero or null.
    expect(result.exitCode === 0).toBe(false);
  });

  it("returns spawn_failed when the interpreter does not exist", async () => {
    const result = await runVideoEditSubstageDirectly({
      target: {
        stage: "edit-captions",
        pythonBin: "/nonexistent/path/to/python",
        scriptPath: "/anywhere/ok.py",
        args: [],
      },
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: { onLog: async () => {} },
      logger: noopLogger,
    });

    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toMatch(/spawn failed|child error/);
    // ENOENT from child error vs spawn-throw -- both map to non-clean
    // exit so the post-execution hook knows not to advance the issue.
    expect(["spawn_failed", "ENOENT"]).toContain(result.errorCode);
  });

  it("forwards env vars to the script", async () => {
    await writeScript(
      "echo_env.py",
      "import os, sys; sys.stdout.write(os.environ.get('TEST_VAR_PLAN5','MISSING'))\n",
    );
    const logCalls: string[] = [];

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-screenshots", "echo_env.py"),
      cwd: tmpDir,
      env: { ...process.env, TEST_VAR_PLAN5: "hello-from-plan5" } as Record<string, string>,
      callbacks: {
        onLog: async (stream, chunk) => {
          if (stream === "stdout") logCalls.push(chunk);
        },
      },
      logger: noopLogger,
    });

    expect(result.exitCode).toBe(0);
    expect(logCalls.join("")).toBe("hello-from-plan5");
  });

  it("runs the script with the supplied cwd", async () => {
    await writeScript("pwd.py", "import os, sys; sys.stdout.write(os.getcwd())\n");
    const logCalls: string[] = [];

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-stitch", "pwd.py"),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: {
        onLog: async (stream, chunk) => {
          if (stream === "stdout") logCalls.push(chunk);
        },
      },
      logger: noopLogger,
    });

    expect(result.exitCode).toBe(0);
    // Normalize for macOS /private symlink on /tmp.
    const stdout = logCalls.join("").trim();
    expect(stdout === tmpDir || stdout === path.join("/private", tmpDir)).toBe(true);
  });

  it("fires onSpawn callback with pid + startedAt", async () => {
    await writeScript("ok.py", "pass\n");
    const spawnMeta: Array<{ pid: number; startedAt: string }> = [];

    await runVideoEditSubstageDirectly({
      target: makeTarget("edit-final", "ok.py"),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: {
        onLog: async () => {},
        onSpawn: async ({ pid, startedAt }) => {
          spawnMeta.push({ pid, startedAt });
        },
      },
      logger: noopLogger,
    });

    expect(spawnMeta.length).toBe(1);
    expect(spawnMeta[0]!.pid).toBeGreaterThan(0);
    expect(spawnMeta[0]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("passes positional args to the script", async () => {
    await writeScript(
      "args.py",
      "import sys; sys.stdout.write('|'.join(sys.argv[1:]))\n",
    );
    const logCalls: string[] = [];

    const result = await runVideoEditSubstageDirectly({
      target: makeTarget("edit-scene-3", "args.py", ["3"]),
      cwd: tmpDir,
      env: { ...process.env } as Record<string, string>,
      callbacks: {
        onLog: async (stream, chunk) => {
          if (stream === "stdout") logCalls.push(chunk);
        },
      },
      logger: noopLogger,
    });

    expect(result.exitCode).toBe(0);
    expect(logCalls.join("")).toBe("3");
  });
});
