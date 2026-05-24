/**
 * Phase 2 Task 2.4 review follow-up -- httpArtifactsClient distinguishes
 * truly-missing (404) from operational failures (auth, server errors).
 *
 *   - 404 returns null (degraded-path warning).
 *   - 5xx / 4xx-not-404 throw with status + URL in the message so the
 *     dispatcher's try/catch surfaces it as a louder warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpArtifactsClient } from "../dispatch/artifacts-client.js";

describe("httpArtifactsClient (Phase 2 Task 2.4 review fix)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when agent-fs responds 404 (artifact truly missing)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    const client = httpArtifactsClient({ url: "http://agent-fs:8080", token: "tkn" });

    const result = await client.fetchArtifact("req-1", "research", "research-bundle.json");

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on non-404 errors (e.g. 500) with status + URL in the message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500 }),
    );
    const client = httpArtifactsClient({ url: "http://agent-fs:8080", token: "tkn" });

    await expect(
      client.fetchArtifact("req-2", "strategy", "creative-brief.json"),
    ).rejects.toThrow(/500/);
    await expect(
      client.fetchArtifact("req-2", "strategy", "creative-brief.json"),
    ).rejects.toThrow(/agent-fs/);
  });

  it("throws on 401 with status in the message (auth-failure surfacing)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    const client = httpArtifactsClient({ url: "http://agent-fs:8080", token: "tkn" });

    await expect(
      client.fetchArtifact("req-3", "copy", "script.json"),
    ).rejects.toThrow(/401/);
  });
});
