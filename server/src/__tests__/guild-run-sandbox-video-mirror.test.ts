/**
 * Phase 2 Task 2.4 -- prior-stage artifact mirroring into the
 * per-run guild sandbox.
 *
 * These tests assert that when `prepareGuildRunSandbox` is called with a
 * `videoContext`, it pulls the prior-stage artifacts from a passed-in
 * `ArtifactsClient` and writes them into
 * `<sandboxDir>/artifacts/in/<stage>/<filename>`. The contract:
 *
 *   - research stage: no priors -> nothing mirrored, no warnings.
 *   - strategy stage: mirrors research/research-bundle.json.
 *   - copy stage: mirrors research/research-bundle.json +
 *     strategy/creative-brief.json.
 *   - edit stage: mirrors all of the above plus copy/script.json +
 *     copy/caption_variants.json.
 *   - a null from the client is non-fatal -- the sandbox is still
 *     created and a warning is appended (degraded path).
 *   - when no videoContext is provided, the dispatcher behavior is
 *     unchanged (backwards compatible -- no client calls, no
 *     artifacts/in dir).
 *
 * The expected paths use `os.tmpdir()` indirection via `tmpDirOverride`
 * so the test never touches real /tmp lifetimes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactsClient } from "../dispatch/artifacts-client.js";
import { prepareGuildRunSandbox } from "../dispatch/guild-run-sandbox.js";

class FakeArtifactsClient implements ArtifactsClient {
  public readonly calls: Array<{ requestId: string; stage: string; filename: string }> = [];
  constructor(
    private readonly responses: Map<string, unknown | null>,
    private readonly throwFor: Map<string, Error> = new Map(),
  ) {}
  async fetchArtifact(
    requestId: string,
    stage: string,
    filename: string,
  ): Promise<unknown | null> {
    this.calls.push({ requestId, stage, filename });
    const key = `${stage}/${filename}`;
    if (this.throwFor.has(key)) {
      throw this.throwFor.get(key)!;
    }
    if (!this.responses.has(key)) return null;
    return this.responses.get(key) ?? null;
  }
}

describe("prepareGuildRunSandbox video-context mirror (Phase 2 Task 2.4)", () => {
  let testTmpRoot: string;
  let bundleRoot: string;
  const createdSandboxes: string[] = [];

  beforeEach(async () => {
    testTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guild-sandbox-vid-tmp-"));
    bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guild-sandbox-vid-bundle-"));
    // Every test in this suite needs a valid autonomy.json so the
    // baseline path doesn't add unrelated warnings.
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");
  });

  afterEach(async () => {
    for (const dir of createdSandboxes) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    createdSandboxes.length = 0;
    await fs.rm(testTmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(bundleRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("research stage: no prior artifacts mirrored and no artifacts/in dir created", async () => {
    const client = new FakeArtifactsClient(new Map());
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-1",
        stage: "research",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(client.calls).toEqual([]);
    expect(result.mirroredArtifacts).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(fs.access(path.join(result.sandboxDir, "artifacts", "in"))).rejects.toThrow();
  });

  it("strategy stage: mirrors research-bundle.json from the research stage", async () => {
    const bundle = { topics: ["a", "b"], summary: "ok" };
    const client = new FakeArtifactsClient(
      new Map([["research/research-bundle.json", bundle]]),
    );
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000002",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-2",
        stage: "strategy",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(client.calls).toEqual([
      { requestId: "req-2", stage: "research", filename: "research-bundle.json" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.mirroredArtifacts).toEqual([
      path.join("artifacts", "in", "research", "research-bundle.json"),
    ]);
    const written = await fs.readFile(
      path.join(result.sandboxDir, "artifacts", "in", "research", "research-bundle.json"),
      "utf-8",
    );
    expect(JSON.parse(written)).toEqual(bundle);
  });

  it("copy stage: mirrors research-bundle.json + creative-brief.json", async () => {
    const bundle = { topics: ["a"] };
    const brief = { hook: "wow", audience: "founders" };
    const client = new FakeArtifactsClient(
      new Map<string, unknown | null>([
        ["research/research-bundle.json", bundle],
        ["strategy/creative-brief.json", brief],
      ]),
    );
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000003",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-3",
        stage: "copy",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(client.calls).toEqual([
      { requestId: "req-3", stage: "research", filename: "research-bundle.json" },
      { requestId: "req-3", stage: "strategy", filename: "creative-brief.json" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.mirroredArtifacts).toEqual([
      path.join("artifacts", "in", "research", "research-bundle.json"),
      path.join("artifacts", "in", "strategy", "creative-brief.json"),
    ]);
    const bundleOnDisk = JSON.parse(
      await fs.readFile(
        path.join(result.sandboxDir, "artifacts", "in", "research", "research-bundle.json"),
        "utf-8",
      ),
    );
    const briefOnDisk = JSON.parse(
      await fs.readFile(
        path.join(result.sandboxDir, "artifacts", "in", "strategy", "creative-brief.json"),
        "utf-8",
      ),
    );
    expect(bundleOnDisk).toEqual(bundle);
    expect(briefOnDisk).toEqual(brief);
  });

  it("edit stage: mirrors all four prior artifacts", async () => {
    const bundle = { topics: ["a"] };
    const brief = { hook: "wow" };
    const script = { scenes: [{ duration: 3, text: "hi" }] };
    const captions = { variants: [{ id: 1, text: "alt 1" }] };
    const client = new FakeArtifactsClient(
      new Map<string, unknown | null>([
        ["research/research-bundle.json", bundle],
        ["strategy/creative-brief.json", brief],
        ["copy/script.json", script],
        ["copy/caption_variants.json", captions],
      ]),
    );
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000004",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-4",
        stage: "edit",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(client.calls.map((c) => `${c.stage}/${c.filename}`)).toEqual([
      "research/research-bundle.json",
      "strategy/creative-brief.json",
      "copy/script.json",
      "copy/caption_variants.json",
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.mirroredArtifacts).toEqual([
      path.join("artifacts", "in", "research", "research-bundle.json"),
      path.join("artifacts", "in", "strategy", "creative-brief.json"),
      path.join("artifacts", "in", "copy", "script.json"),
      path.join("artifacts", "in", "copy", "caption_variants.json"),
    ]);

    for (const [stage, file, expected] of [
      ["research", "research-bundle.json", bundle],
      ["strategy", "creative-brief.json", brief],
      ["copy", "script.json", script],
      ["copy", "caption_variants.json", captions],
    ] as const) {
      const onDisk = JSON.parse(
        await fs.readFile(
          path.join(result.sandboxDir, "artifacts", "in", stage, file),
          "utf-8",
        ),
      );
      expect(onDisk).toEqual(expected);
    }
  });

  it("null artifact from client is non-fatal: warning appended, sandbox still usable", async () => {
    // strategy stage expects research-bundle.json; client returns null.
    const client = new FakeArtifactsClient(new Map([["research/research-bundle.json", null]]));
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000005",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-5",
        stage: "strategy",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.mirroredArtifacts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/research-bundle\.json/);
    expect(result.warnings[0]).toMatch(/research/);
    // sandbox dir was still created and available_skills.json still written
    await expect(fs.access(result.availableSkillsPath)).resolves.not.toThrow();
    // the file was NOT created because the artifact was null
    await expect(
      fs.access(
        path.join(result.sandboxDir, "artifacts", "in", "research", "research-bundle.json"),
      ),
    ).rejects.toThrow();
  });

  it("client throw is non-fatal: warning includes error message, sandbox still usable", async () => {
    // strategy stage expects research-bundle.json; client throws (e.g. agent-fs 401).
    const client = new FakeArtifactsClient(
      new Map(),
      new Map([
        ["research/research-bundle.json", new Error("agent-fs returned 401 for http://agent-fs/x")],
      ]),
    );
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000007",
      guildId: "g1",
      guildSlug: "video-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
      videoContext: {
        requestId: "req-7",
        stage: "strategy",
        artifacts: client,
      },
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.mirroredArtifacts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/research-bundle\.json/);
    expect(result.warnings[0]).toMatch(/401/);
    // sandbox dir was still created and available_skills.json still written
    await expect(fs.access(result.availableSkillsPath)).resolves.not.toThrow();
    // no artifact file written for the throwing path
    await expect(
      fs.access(
        path.join(result.sandboxDir, "artifacts", "in", "research", "research-bundle.json"),
      ),
    ).rejects.toThrow();
  });

  it("no videoContext: backward-compatible -- no client calls, no artifacts/in dir", async () => {
    const result = await prepareGuildRunSandbox({
      runId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000006",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.warnings).toEqual([]);
    expect(result.mirroredArtifacts).toEqual([]);
    await expect(fs.access(path.join(result.sandboxDir, "artifacts"))).rejects.toThrow();
  });
});
