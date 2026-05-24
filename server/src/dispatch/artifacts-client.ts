/**
 * Phase 2 Task 2.4 -- agent-fs artifact client seam.
 *
 * The dispatch layer mirrors prior-stage video artifacts into a worker's
 * per-run sandbox before spawning. Reading from agent-fs is factored
 * behind this interface so unit tests can inject a fake without spinning
 * up real HTTP. The real production implementation is
 * `httpArtifactsClient`, which hits the agent-fs REST surface added in
 * Task 2.3.
 *
 * v0 contract: JSON-only. The agent-fs route returns the parsed JSON
 * body. Text and binary artifacts (e.g. captions.srt, .mp4) are not in
 * scope; they require an agent-fs route extension and a different
 * fetch path. A `null` return means the artifact does not exist (or
 * the agent-fs call returned a non-200 we treat as missing); callers
 * decide whether that is fatal.
 *
 * The HTTP request shape:
 *   GET <baseUrl>/artifacts/<requestId>/<stage>/<filename>
 *   Authorization: Bearer <token>
 *
 * See docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 * Task 2.4 + Task 2.3.
 */

/**
 * Fetches a single artifact JSON blob from agent-fs (or a fake in
 * tests). Returns the parsed body, or null when the artifact is
 * missing.
 */
export interface ArtifactsClient {
  fetchArtifact(
    requestId: string,
    stage: string,
    filename: string,
  ): Promise<unknown | null>;
}

export interface HttpArtifactsClientEnv {
  /** Base URL for agent-fs, e.g. `http://agent-fs:8080`. No trailing slash. */
  url: string;
  /** Bearer token for the dispatcher's agent-fs credentials. */
  token: string;
}

/**
 * Production implementation. Wraps `fetch` against the agent-fs
 * Task 2.3 route. Non-200 responses resolve to `null` (the dispatcher
 * surfaces this as a non-fatal warning); network errors propagate so
 * the dispatcher fails-fast on outright agent-fs unavailability.
 */
export function httpArtifactsClient(env: HttpArtifactsClientEnv): ArtifactsClient {
  const base = env.url.replace(/\/+$/, "");
  return {
    async fetchArtifact(
      requestId: string,
      stage: string,
      filename: string,
    ): Promise<unknown | null> {
      const url = `${base}/artifacts/${encodeURIComponent(requestId)}/${encodeURIComponent(stage)}/${encodeURIComponent(filename)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.token}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    },
  };
}
