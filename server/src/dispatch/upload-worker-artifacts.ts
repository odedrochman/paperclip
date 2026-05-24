/**
 * Phase 3.5 Step 2 -- worker exit-hook artifact uploader.
 *
 * Pure function: scans `<agentHomeDir>/artifacts/out/` for completed
 * artifact files and pushes each one to agent-fs via the supplied
 * `ArtifactUploadClient`. Designed to be called from the worker exit
 * hook in heartbeat.ts immediately after `ingestGuildLearnings` succeeds
 * and before `cleanupGuildRunSandbox`.
 *
 * Error policy:
 *   - ENOENT on the artifacts/out dir: silently no-op (skipped.reason =
 *     'no-artifacts-dir'). Workers that produced no output are common
 *     (e.g. research stage only writes JSON; edit stage also writes .mp4).
 *   - Per-file read or upload failure: push to `failed[]` with the
 *     error message and continue. Never throw out of this function.
 *   - Hidden files (leading '.') and '.partial' suffix: skipped silently.
 *   - Non-file directory entries (subdirectories): skipped silently.
 *
 * See docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 * Phase 3.5 Step 2.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { ArtifactUploadClient } from "./artifacts-client.js";

export interface UploadWorkerArtifactsInput {
  /** Absolute path to the agent's home directory (from
   * `resolveDefaultAgentWorkspaceDir`). Artifacts live at
   * `<agentHomeDir>/artifacts/out/<filename>`. */
  agentHomeDir: string;
  /** Video ad request id, e.g. `campaign-42`. */
  requestId: string;
  /** Video pipeline stage, e.g. `research`. */
  stage: string;
  /** Client used to push each file to agent-fs. */
  uploadClient: ArtifactUploadClient;
  /** Minimal logger surface. Only `warn` is used (per warn-log-continue
   * policy). Tests inject a no-op or spy; production passes `logger`. */
  logger: { warn: (...args: unknown[]) => void };
}

export interface UploadWorkerArtifactsResult {
  /** Filenames (basename only) that were successfully uploaded. */
  uploaded: string[];
  /** Files that failed to read or upload. Each entry carries the
   * filename and a human-readable reason. */
  failed: Array<{ filename: string; reason: string }>;
  /** Non-null when the artifacts/out directory did not exist (ENOENT).
   * Normal for workers that produced no output files. */
  skipped: { reason: "no-artifacts-dir" } | null;
}

/**
 * Scans `<agentHomeDir>/artifacts/out/` and uploads each eligible file
 * to agent-fs. Returns a structured result; never throws.
 */
export async function uploadWorkerArtifacts(
  input: UploadWorkerArtifactsInput,
): Promise<UploadWorkerArtifactsResult> {
  const outDir = path.join(input.agentHomeDir, "artifacts", "out");

  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true, encoding: "utf-8" }) as import("node:fs").Dirent<string>[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Expected for workers that produced no artifacts.
      return { uploaded: [], failed: [], skipped: { reason: "no-artifacts-dir" } };
    }
    // Unexpected readdir failure (permissions, etc.) -- treat as warn.
    input.logger.warn(
      { err, agentHomeDir: input.agentHomeDir, outDir },
      "upload-worker-artifacts: readdir failed unexpectedly",
    );
    return { uploaded: [], failed: [], skipped: null };
  }

  const uploaded: string[] = [];
  const failed: Array<{ filename: string; reason: string }> = [];

  for (const entry of entries) {
    // Skip non-file entries (subdirectories, symlinks, etc.).
    if (!entry.isFile()) continue;
    const filename = entry.name;
    // Skip hidden dotfiles and incomplete .partial files.
    if (filename.startsWith(".") || filename.endsWith(".partial")) continue;

    const filePath = path.join(outDir, filename);
    let body: Buffer;
    try {
      body = await fsp.readFile(filePath);
    } catch (readErr) {
      failed.push({
        filename,
        reason: readErr instanceof Error ? readErr.message : String(readErr),
      });
      continue;
    }

    try {
      await input.uploadClient.uploadArtifact(
        input.requestId,
        input.stage,
        filename,
        body,
      );
      uploaded.push(filename);
    } catch (uploadErr) {
      failed.push({
        filename,
        reason: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
  }

  return { uploaded, failed, skipped: null };
}
