/**
 * Phase 3.5 Step 2 -- `uploadWorkerArtifacts` unit tests.
 *
 * Uses a real temp directory and a fake `ArtifactUploadClient` injection
 * so there is no real HTTP and no dependency on env vars.
 *
 * Coverage:
 *   - Happy path: all files uploaded, result lists all in `uploaded`.
 *   - Empty dir: returns uploaded:[], failed:[], skipped:null.
 *   - Missing dir (ENOENT): returns skipped:{reason:'no-artifacts-dir'}.
 *   - Mixed: one file throws on upload, ends up in `failed`.
 *   - .partial files are skipped.
 *   - Hidden dotfiles are skipped.
 *   - Subdirectories are skipped.
 *   - Fake client receives correct requestId, stage, filename, body.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactUploadClient } from "../artifacts-client.js";
import { uploadWorkerArtifacts } from "../upload-worker-artifacts.js";

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface UploadCall {
  requestId: string;
  stage: string;
  filename: string;
  body: Buffer;
}

class FakeUploadClient implements ArtifactUploadClient {
  public readonly calls: UploadCall[] = [];
  constructor(private readonly throwFor: Set<string> = new Set()) {}

  async uploadArtifact(
    requestId: string,
    stage: string,
    filename: string,
    body: Buffer,
  ): Promise<void> {
    if (this.throwFor.has(filename)) {
      throw new Error(`fake upload error for ${filename}`);
    }
    this.calls.push({ requestId, stage, filename, body });
  }
}

const noopLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

async function makeAgentHomeWithFiles(
  tmpRoot: string,
  files: Array<{ name: string; content: string | Buffer }>,
): Promise<string> {
  const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-"));
  const outDir = path.join(agentHome, "artifacts", "out");
  await fsp.mkdir(outDir, { recursive: true });
  for (const f of files) {
    await fsp.writeFile(
      path.join(outDir, f.name),
      typeof f.content === "string" ? f.content : f.content,
    );
  }
  return agentHome;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("uploadWorkerArtifacts", () => {
  let tmpRoot: string;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "upload-worker-artifacts-test-"));
    createdDirs.push(tmpRoot);
  });

  afterEach(async () => {
    for (const dir of createdDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    createdDirs.length = 0;
  });

  it("happy path: uploads all files, returns them all in uploaded[]", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "research-bundle.json", content: '{"result":"ok"}' },
      { name: "insights.json", content: '{"key":"val"}' },
      { name: "notes.txt", content: "some notes" },
      { name: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: "captions.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nHello" },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-happy",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toBeNull();
    expect(result.failed).toHaveLength(0);
    expect(result.uploaded).toHaveLength(5);
    expect(result.uploaded.sort()).toEqual([
      "captions.srt",
      "insights.json",
      "logo.png",
      "notes.txt",
      "research-bundle.json",
    ]);
    expect(client.calls).toHaveLength(5);
    // Check one call's requestId + stage forwarding.
    const jsonCall = client.calls.find((c) => c.filename === "research-bundle.json")!;
    expect(jsonCall.requestId).toBe("req-happy");
    expect(jsonCall.stage).toBe("research");
    expect(jsonCall.body.toString("utf-8")).toBe('{"result":"ok"}');
  });

  it("empty dir: returns uploaded:[], failed:[], skipped:null", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-empty-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-empty",
      stage: "strategy",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result).toEqual({ uploaded: [], failed: [], skipped: null });
    expect(client.calls).toHaveLength(0);
  });

  it("missing dir (ENOENT): returns skipped:{reason:'no-artifacts-dir'}", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-nodir-"));
    // Do NOT create artifacts/out; leave it absent.
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-nodir",
      stage: "copy",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toEqual({ reason: "no-artifacts-dir" });
    expect(result.uploaded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it("mixed: 3 files, client throws on bad.mp4, result has 2 uploaded + 1 failed", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "script.json", content: '{"script":"text"}' },
      { name: "good.mp4", content: Buffer.from([0x00, 0x01]) },
      { name: "bad.mp4", content: Buffer.from([0xff]) },
    ]);
    const client = new FakeUploadClient(new Set(["bad.mp4"]));

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-mixed",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toBeNull();
    expect(result.uploaded.sort()).toEqual(["good.mp4", "script.json"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].filename).toBe("bad.mp4");
    expect(result.failed[0].reason).toContain("fake upload error");
  });

  it("skips .partial files", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "output.mp4", content: Buffer.from([0x00]) },
      { name: "output.mp4.partial", content: Buffer.from([0x01]) },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-partial",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["output.mp4"]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filename).toBe("output.mp4");
  });

  it("skips hidden dotfiles", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "visible.json", content: "{}" },
      { name: ".hidden", content: "secret" },
      { name: ".DS_Store", content: "mac cruft" },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-hidden",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["visible.json"]);
    expect(client.calls).toHaveLength(1);
  });

  it("skips non-file directory entries (subdirectories)", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-subdir-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });
    // Create a file and a subdirectory.
    await fsp.writeFile(path.join(outDir, "real.json"), "{}");
    await fsp.mkdir(path.join(outDir, "subdir"), { recursive: true });
    await fsp.writeFile(path.join(outDir, "subdir", "nested.json"), "{}");

    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-subdir",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["real.json"]);
    expect(client.calls).toHaveLength(1);
    // The nested file inside subdir should NOT be uploaded.
    expect(client.calls[0].filename).toBe("real.json");
  });
});
