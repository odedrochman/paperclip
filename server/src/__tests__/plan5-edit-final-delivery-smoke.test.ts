/**
 * Plan 5 end-to-end smoke: edit-final delivery contract.
 *
 * This is the simulator the SMOKE-FIX-PLAN Phase D called for, scoped
 * to the highest-risk hop: heartbeat writes -> agent-fs upload ->
 * heartbeat emit -> ceo-chat fetch -> Telegram. Without this test, every
 * unit suite can pass while the inter-component contract still 404s
 * on a real run (which is exactly what happened on 2026-05-28).
 *
 * What this exercises (real, not mocked):
 *   - A real in-memory HTTP server pretending to be agent-fs (3 routes:
 *     binary PUT, JSON PUT, binary GET).
 *   - Real `uploadWorkerArtifacts` from artifacts/out/ -> agent-fs.
 *   - The exact `video.ad.final_cut_ready` emit shape heartbeat.ts
 *     produces after Plan 5 Fix 3 (gate requires only final.mp4,
 *     brief_path conditional, paths templated on uploadStage).
 *   - Real `dispatchVideoFinalCut` with the production
 *     `httpArtifactFetcher` pointing at the fake agent-fs.
 *   - Real path parsing via `parseAgentFsArtifactPath` /
 *     `resolveFinalCutFetchTarget`.
 *
 * What this stubs:
 *   - The Python edit-final worker (we just pre-write artifacts/out/
 *     contents that finalize.py would have produced — the Python side
 *     is covered by services/video-guild/scripts/tests/).
 *   - Telegram (records sendVideo/sendDocument calls).
 *
 * Pass criterion: bytes that go IN at artifacts/out/<filename> match
 * bytes that come OUT at sender.sendVideo/sendDocument(localPath). If
 * any step in the chain drops a file, mangles the path, or fetches the
 * wrong stage, the byte equality fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp, readFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { httpArtifactUploadClient } from "../dispatch/artifacts-client.js";
import { uploadWorkerArtifacts } from "../dispatch/upload-worker-artifacts.js";

// Cross-package import: ceo-chat is a sibling service. The smoke needs
// the real dispatcher + fetcher to ensure no mocks paper over the
// contract. tsx + the relative path resolve at test time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ceoChatNotifier: typeof import("../../../../services/ceo-chat/src/notifier.js") =
  await import("../../../../services/ceo-chat/src/notifier.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ceoChatFetcher: typeof import("../../../../services/ceo-chat/src/video-ad/artifact-fetcher.js") =
  await import("../../../../services/ceo-chat/src/video-ad/artifact-fetcher.js");

const noopLogger = { warn: () => {} };

// ───────────────────────── fake agent-fs HTTP server ──────────────────────

/**
 * Minimal in-memory agent-fs. Stores PUT bodies in a map keyed by URL
 * path; serves GET by returning the stored bytes. Mirrors the route
 * shape from services/agent-fs/src/server.ts as far as the upload +
 * fetch contract requires.
 *
 * Routes implemented:
 *   PUT  /artifacts/:req/:stage/:filename            (JSON)
 *   PUT  /artifacts/:req/:stage/:filename/binary     (binary)
 *   GET  /artifacts/:req/:stage/:filename/binary     (binary)
 *
 * Auth: Bearer <token>. Token is matched against the value passed at
 * construction; mismatch returns 401 so credential bugs surface here
 * instead of silently 404ing.
 */
function startFakeAgentFs(opts: { token: string }): Promise<{
  baseUrl: string;
  put: (req: string, stage: string, filename: string, body: Buffer) => void;
  has: (req: string, stage: string, filename: string) => boolean;
  bodyOf: (req: string, stage: string, filename: string) => Buffer | undefined;
  putRequestPaths: string[];
  getRequestPaths: string[];
  close: () => Promise<void>;
}> {
  // key = /<req>/<stage>/<filename>  -> raw bytes
  const store = new Map<string, Buffer>();
  const putRequestPaths: string[] = [];
  const getRequestPaths: string[] = [];

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      // Auth check.
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${opts.token}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      // Health route -- nothing reads it here, but mirror the real server.
      if (method === "GET" && url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", service: "agent-fs-fake" }));
        return;
      }

      // Parse: /artifacts/<req>/<stage>/<filename>[/binary]
      const m = url.match(/^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+?)(\/binary)?$/);
      if (!m) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `unrecognized path: ${url}` }));
        return;
      }
      const [, reqId, stage, filename, isBinary] = m;
      const key = `/${decodeURIComponent(reqId)}/${decodeURIComponent(stage)}/${decodeURIComponent(filename)}`;

      if (method === "PUT") {
        putRequestPaths.push(url);
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(c as Buffer);
        }
        const body = Buffer.concat(chunks);
        if (isBinary) {
          // Raw bytes.
          store.set(key, body);
        } else {
          // JSON route -- parse, re-serialise, store as bytes (matches
          // real agent-fs which parses + persists structured JSON).
          try {
            const parsed: unknown = JSON.parse(body.toString("utf-8"));
            store.set(key, Buffer.from(JSON.stringify(parsed), "utf-8"));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "invalid JSON" }));
            return;
          }
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && isBinary) {
        getRequestPaths.push(url);
        const body = store.get(key);
        if (!body) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "NotFound" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(body.length));
        res.end(body);
        return;
      }

      res.statusCode = 405;
      res.end(JSON.stringify({ error: `method not allowed: ${method} ${url}` }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        put(reqId, stage, filename, body) {
          store.set(`/${reqId}/${stage}/${filename}`, body);
        },
        has(reqId, stage, filename) {
          return store.has(`/${reqId}/${stage}/${filename}`);
        },
        bodyOf(reqId, stage, filename) {
          return store.get(`/${reqId}/${stage}/${filename}`);
        },
        putRequestPaths,
        getRequestPaths,
        close: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
          }),
      });
    });
  });
}

// ───────────────────────── fake Telegram sender ────────────────────────────

interface CapturedSend {
  kind: "video" | "doc";
  chatId: number;
  filename: string;
  bodyBytes: Buffer;
  caption?: string;
}

function makeRecordingSender(): {
  sender: import("../../../../services/ceo-chat/src/notifier.js").TelegramFinalCutSender;
  calls: CapturedSend[];
} {
  const calls: CapturedSend[] = [];
  return {
    sender: {
      async sendVideo(chatId, videoPath, opts) {
        // Read the bytes BEFORE the dispatcher's `finally` block unlinks
        // the tmp file. readFileSync is sync so it completes inline.
        const body = readFileSync(videoPath);
        calls.push({
          kind: "video",
          chatId,
          filename: path.basename(videoPath),
          bodyBytes: body,
          caption: opts.caption,
        });
      },
      async sendDocument(chatId, docPath, opts) {
        const body = readFileSync(docPath);
        calls.push({
          kind: "doc",
          chatId,
          filename: path.basename(docPath),
          bodyBytes: body,
          caption: opts.caption,
        });
      },
    },
    calls,
  };
}

/**
 * Synthesize the exact `video.ad.final_cut_ready` details that
 * heartbeat.ts produces after Plan 5 Fix 3 for a given uploadStage +
 * upload set. Mirrors the production code at heartbeat.ts:~7034.
 */
function buildHeartbeatEmit(args: {
  requestId: string;
  uploadStage: "edit" | "edit-final";
  uploaded: string[];
}): Record<string, unknown> {
  const { requestId, uploadStage, uploaded } = args;
  return {
    request_id: requestId,
    mp4_path: `agent-fs:/${requestId}/${uploadStage}/final.mp4`,
    ...(uploaded.includes("brief.json")
      ? { brief_path: `agent-fs:/${requestId}/${uploadStage}/brief.json` }
      : {}),
    ...(uploaded.includes("captions.srt")
      ? { srt_path: `agent-fs:/${requestId}/${uploadStage}/captions.srt` }
      : {}),
    ...(uploaded.includes("caption_variants.json")
      ? { caption_variants_path: `agent-fs:/${requestId}/${uploadStage}/caption_variants.json` }
      : {}),
    ...(uploaded.includes("caption_text.txt")
      ? { caption_text_path: `agent-fs:/${requestId}/${uploadStage}/caption_text.txt` }
      : {}),
  };
}

// ──────────────────────────── tests ─────────────────────────────────────────

describe("Plan 5 end-to-end smoke: edit-final delivery", () => {
  let agentFs: Awaited<ReturnType<typeof startFakeAgentFs>>;
  let sandboxDir: string;
  const token = "test-agent-fs-token";

  beforeEach(async () => {
    agentFs = await startFakeAgentFs({ token });
    sandboxDir = await fsp.mkdtemp(path.join(os.tmpdir(), "plan5-smoke-"));
    await fsp.mkdir(path.join(sandboxDir, "artifacts", "out"), { recursive: true });
  });

  afterEach(async () => {
    await agentFs.close();
    await fsp.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  });

  it("Plan 5 full chain: artifacts/out/ -> upload -> emit -> dispatch -> Telegram, byte-equal", async () => {
    const requestId = "smoke-req-1";
    const outDir = path.join(sandboxDir, "artifacts", "out");

    // 1. Worker (simulated): write the 5 bundle files to artifacts/out/.
    //    Each file has unique bytes so the byte-equality assertions
    //    catch any cross-wiring (mp4 served as brief etc).
    const fileContents: Record<string, Buffer> = {
      "final.mp4": Buffer.from("MP4-payload-for-smoke-test-not-real-h264", "utf-8"),
      "captions.srt": Buffer.from(
        "1\n00:00:00,000 --> 00:00:02,000\nsmoke test caption\n",
        "utf-8",
      ),
      "caption_text.txt": Buffer.from("smoke test caption text\n", "utf-8"),
      "caption_variants.json": Buffer.from(
        JSON.stringify({ variants: ["smoke v1", "smoke v2"] }),
        "utf-8",
      ),
      "brief.json": Buffer.from(
        JSON.stringify({
          rubric_pass: { item_1: true },
          ai_disclosure_required: false,
        }),
        "utf-8",
      ),
      // render-log.json also lands in artifacts/out/ but is NOT in the
      // operator's 5-file bundle. Include it to verify the dispatcher
      // doesn't accidentally try to deliver it.
      "render-log.json": Buffer.from(
        JSON.stringify({ source_cut: "captioned.mp4", elapsed_s: 0.5 }),
        "utf-8",
      ),
    };
    for (const [name, body] of Object.entries(fileContents)) {
      await fsp.writeFile(path.join(outDir, name), body);
    }

    // 2. Run the REAL uploadWorkerArtifacts against the fake agent-fs.
    //    For Plan 5, the dispatcher calls this with stage='edit-final'
    //    (extracted from the issue title 'video-edit-final/<id>').
    const uploadClient = httpArtifactUploadClient({
      url: agentFs.baseUrl,
      token,
    });
    const uploadResult = await uploadWorkerArtifacts({
      agentHomeDir: sandboxDir,
      requestId,
      stage: "edit-final",
      uploadClient,
      logger: noopLogger,
    });

    // Sanity: every file made it to agent-fs at the Plan 5 namespace.
    expect(uploadResult.failed).toEqual([]);
    expect(uploadResult.uploaded.sort()).toEqual(
      Object.keys(fileContents).sort(),
    );
    for (const name of Object.keys(fileContents)) {
      expect(agentFs.has(requestId, "edit-final", name)).toBe(true);
    }
    // CRITICAL: nothing was uploaded to the LEGACY /edit/ namespace --
    // this assertion would fail on the original codebase where the
    // upload + emit + dispatch chain disagreed on the stage.
    for (const name of Object.keys(fileContents)) {
      expect(agentFs.has(requestId, "edit", name)).toBe(false);
    }

    // 3. Synthesize the exact emit heartbeat.ts produces after Fix 3.
    const emit = buildHeartbeatEmit({
      requestId,
      uploadStage: "edit-final",
      uploaded: uploadResult.uploaded,
    });
    // Sanity: emit shape matches what the dispatcher expects.
    expect(emit.mp4_path).toBe(`agent-fs:/${requestId}/edit-final/final.mp4`);
    expect(emit.brief_path).toBe(`agent-fs:/${requestId}/edit-final/brief.json`);

    // 4. Run the REAL dispatchVideoFinalCut with the production
    //    httpArtifactFetcher pointing at the fake agent-fs.
    const fetcher = ceoChatFetcher.httpArtifactFetcher({
      url: agentFs.baseUrl,
      token,
    });
    const { sender, calls } = makeRecordingSender();
    const logLines: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

    await ceoChatNotifier.dispatchVideoFinalCut({
      chatId: 7777,
      bundle: emit as unknown as Parameters<
        typeof ceoChatNotifier.dispatchVideoFinalCut
      >[0]["bundle"],
      telegram: sender,
      log: (msg, meta) => {
        logLines.push({ msg, meta });
      },
      fetcher,
    });

    // 5. Assertions on what landed in Telegram.
    expect(calls.length).toBe(5);
    expect(calls.filter((c) => c.kind === "video").length).toBe(1);
    expect(calls.filter((c) => c.kind === "doc").length).toBe(4);

    // Byte-for-byte equality: if any path in the chain pointed at the
    // wrong stage, the dispatcher would have fetched the wrong file
    // or 404'd and these would mismatch.
    const videoCall = calls.find((c) => c.kind === "video")!;
    expect(videoCall.bodyBytes.equals(fileContents["final.mp4"]!)).toBe(true);
    expect(videoCall.chatId).toBe(7777);

    const srtCall = calls.find((c) => c.filename === "captions.srt")!;
    expect(srtCall.bodyBytes.equals(fileContents["captions.srt"]!)).toBe(true);

    const variantsCall = calls.find((c) => c.filename === "caption_variants.json")!;
    // JSON file went through agent-fs's JSON route on PUT (re-serialised);
    // verify the parsed-back payload matches what the worker wrote.
    expect(JSON.parse(variantsCall.bodyBytes.toString("utf-8"))).toEqual(
      JSON.parse(fileContents["caption_variants.json"]!.toString("utf-8")),
    );

    const textCall = calls.find((c) => c.filename === "caption_text.txt")!;
    expect(textCall.bodyBytes.equals(fileContents["caption_text.txt"]!)).toBe(true);

    const briefCall = calls.find((c) => c.filename === "brief.json")!;
    expect(JSON.parse(briefCall.bodyBytes.toString("utf-8"))).toEqual(
      JSON.parse(fileContents["brief.json"]!.toString("utf-8")),
    );

    // 6. Dispatcher log should show "delivered 5 of 5 files".
    const summary = logLines.find((l) =>
      l.msg.includes("delivered") && l.msg.includes("5 of 5"),
    );
    expect(summary, `expected 5/5 delivery summary, got ${JSON.stringify(logLines.map((l) => l.msg))}`).toBeDefined();

    // 7. Verify the dispatcher fetched ONLY from /edit-final/ (Plan 5
    //    path), never from /edit/ (legacy). Catches the original bug
    //    where ceo-chat hardcoded stage='edit'.
    for (const reqPath of agentFs.getRequestPaths) {
      expect(reqPath.includes("/edit-final/"), `unexpected fetch path: ${reqPath}`).toBe(true);
      expect(reqPath.includes("/edit/")).toBe(false);
    }
  });

  it("legacy /edit/ chain still works (back-compat)", async () => {
    // A pre-Plan-5 ad request that walks the monolithic 'edit' stage
    // must still deliver. heartbeat emits agent-fs:/<id>/edit/<file>
    // paths; dispatcher fetches from /edit/.
    const requestId = "smoke-legacy-1";
    const outDir = path.join(sandboxDir, "artifacts", "out");

    const fileContents: Record<string, Buffer> = {
      "final.mp4": Buffer.from("LEGACY-mp4-payload"),
      "brief.json": Buffer.from(JSON.stringify({ ai_disclosure_required: true })),
    };
    for (const [name, body] of Object.entries(fileContents)) {
      await fsp.writeFile(path.join(outDir, name), body);
    }

    const uploadClient = httpArtifactUploadClient({ url: agentFs.baseUrl, token });
    const uploadResult = await uploadWorkerArtifacts({
      agentHomeDir: sandboxDir,
      requestId,
      stage: "edit",
      uploadClient,
      logger: noopLogger,
    });
    expect(uploadResult.failed).toEqual([]);

    const emit = buildHeartbeatEmit({
      requestId,
      uploadStage: "edit",
      uploaded: uploadResult.uploaded,
    });
    expect(emit.mp4_path).toBe(`agent-fs:/${requestId}/edit/final.mp4`);

    const fetcher = ceoChatFetcher.httpArtifactFetcher({ url: agentFs.baseUrl, token });
    const { sender, calls } = makeRecordingSender();
    await ceoChatNotifier.dispatchVideoFinalCut({
      chatId: 1,
      bundle: emit as unknown as Parameters<
        typeof ceoChatNotifier.dispatchVideoFinalCut
      >[0]["bundle"],
      telegram: sender,
      log: () => {},
      fetcher,
    });

    const videoCall = calls.find((c) => c.kind === "video")!;
    expect(videoCall.bodyBytes.equals(fileContents["final.mp4"]!)).toBe(true);
    // Legacy: fetcher hit /edit/, NOT /edit-final/.
    for (const reqPath of agentFs.getRequestPaths) {
      expect(reqPath.includes("/edit/")).toBe(true);
      expect(reqPath.includes("/edit-final/")).toBe(false);
    }
  });

  it("degraded path: brief.json missing -> mp4 still delivers, brief slot is silently skipped", async () => {
    // Exercises Plan 5 Fix 3: gate now requires only final.mp4. When
    // brief.json was never uploaded (e.g. finalize.py's agent-fs
    // fallback 404'd on /copy/brief.json), the dispatcher must still
    // deliver the mp4 + whatever bundle files did make it.
    const requestId = "smoke-degraded-1";
    const outDir = path.join(sandboxDir, "artifacts", "out");
    await fsp.writeFile(
      path.join(outDir, "final.mp4"),
      Buffer.from("DEGRADED-only-mp4"),
    );
    // NB: no brief.json, no captions.

    const uploadClient = httpArtifactUploadClient({ url: agentFs.baseUrl, token });
    const uploadResult = await uploadWorkerArtifacts({
      agentHomeDir: sandboxDir,
      requestId,
      stage: "edit-final",
      uploadClient,
      logger: noopLogger,
    });
    expect(uploadResult.uploaded).toEqual(["final.mp4"]);

    const emit = buildHeartbeatEmit({
      requestId,
      uploadStage: "edit-final",
      uploaded: uploadResult.uploaded,
    });
    // brief_path / srt_path / etc. NOT present in degraded emit.
    expect(emit.brief_path).toBeUndefined();
    expect(emit.srt_path).toBeUndefined();

    const fetcher = ceoChatFetcher.httpArtifactFetcher({ url: agentFs.baseUrl, token });
    const { sender, calls } = makeRecordingSender();
    const logLines: string[] = [];
    await ceoChatNotifier.dispatchVideoFinalCut({
      chatId: 1,
      bundle: emit as unknown as Parameters<
        typeof ceoChatNotifier.dispatchVideoFinalCut
      >[0]["bundle"],
      telegram: sender,
      log: (msg) => {
        logLines.push(msg);
      },
      fetcher,
    });

    // 1 video, 0 docs (each doc fetch 404s on the dispatcher's fallback
    // /edit-final/<file>; the dispatcher silently skips per-file 404s).
    expect(calls.filter((c) => c.kind === "video").length).toBe(1);
    expect(calls.filter((c) => c.kind === "doc").length).toBe(0);
    const videoCall = calls.find((c) => c.kind === "video")!;
    expect(videoCall.bodyBytes.toString()).toBe("DEGRADED-only-mp4");
    // Dispatcher should log "delivered 1 of 5".
    expect(
      logLines.some((m) => m.includes("delivered") && m.includes("1 of 5")),
      `expected 1/5 delivery summary, got ${JSON.stringify(logLines)}`,
    ).toBe(true);
  });

  it("poisoned emit: attacker INSERT cannot exfiltrate non-bundle files", async () => {
    // Adversarial: an attacker-controlled INSERT puts a row with
    // mp4_path: agent-fs:/<id>/admin/passwd. The dispatcher must
    // reject the poisoned stage + fall back to the Plan 5 default.
    // The fetcher then tries /edit-final/final.mp4 (correctly), gets
    // 404 (no real file there), and delivers nothing -- but does NOT
    // exfiltrate /admin/passwd.
    const requestId = "smoke-poisoned-1";

    // Pre-seed a "secret" file at /<id>/admin/passwd (simulating any
    // out-of-bundle file the attacker might target).
    agentFs.put(requestId, "admin", "passwd", Buffer.from("SECRET-CONTENT"));

    const poisonedEmit = {
      request_id: requestId,
      mp4_path: `agent-fs:/${requestId}/admin/passwd`,
    };

    const fetcher = ceoChatFetcher.httpArtifactFetcher({ url: agentFs.baseUrl, token });
    const { sender, calls } = makeRecordingSender();
    await ceoChatNotifier.dispatchVideoFinalCut({
      chatId: 1,
      bundle: poisonedEmit as unknown as Parameters<
        typeof ceoChatNotifier.dispatchVideoFinalCut
      >[0]["bundle"],
      telegram: sender,
      log: () => {},
      fetcher,
    });

    // CRITICAL: no fetch ever hit /admin/ -- the poisoned mp4_path was
    // rejected by the parser whitelist and the dispatcher fell back
    // to the default stage.
    for (const reqPath of agentFs.getRequestPaths) {
      expect(reqPath.includes("/admin/"), `LEAK: poisoned fetch reached ${reqPath}`).toBe(false);
    }
    // SECRET-CONTENT must NOT have been sent to Telegram.
    for (const call of calls) {
      expect(call.bodyBytes.toString()).not.toContain("SECRET");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Full-pipeline simulation: walks every Plan 5 stage in order, exercising
  // the upload contract at each substage and the chain dependency between
  // them (stitch reads scene mp4s, motion-graphics reads stitched, etc).
  //
  // What this catches that the single-stage smoke doesn't:
  //   - Wrong namespace for ANY intermediate substage (not just edit-final)
  //   - Chain dependency mismatch: stitch.py's expected fetch path must
  //     match where edit-scene-N actually uploaded.
  //   - render-log.json (per-substage provenance) doesn't accidentally
  //     leak into the operator's 5-file bundle.
  //   - The Plan 5 default + per-file path resolution stays consistent
  //     across all substage uploads from a single full run.
  // ─────────────────────────────────────────────────────────────────────────
  it("FULL pipeline: research -> strategy -> copy -> 10 edit substages -> emit -> Telegram", async () => {
    const requestId = "smoke-full-pipeline-1";

    // ── Stages 1-3: creative LLM stages (research, strategy, copy) ────────
    // These stay on the LLM-adapter path (not Phase B). Their outputs are
    // what downstream edit substages depend on, so we pre-seed agent-fs
    // with the exact uploads those workers would produce.
    const researchBundle = { topic: "smoke ad topic", angles: ["angle-a"] };
    const creativeBrief = { brief: "smoke creative brief", tone: "punchy" };
    const script = {
      scenes: [
        { scene: 1, voText: "scene 1 vo", displayText: "Scene 1", durationS: 5 },
        { scene: 2, voText: "scene 2 vo", displayText: "Scene 2", durationS: 5 },
        { scene: 3, voText: "scene 3 vo", displayText: "Scene 3", durationS: 5 },
        { scene: 4, voText: "scene 4 vo", displayText: "Scene 4", durationS: 5 },
        { scene: 5, voText: "scene 5 vo", displayText: "Scene 5", durationS: 5 },
      ],
    };
    const captionsSrt =
      "1\n00:00:00,500 --> 00:00:04,700\nFull-pipeline smoke caption.\n";
    const captionVariants = { variants: ["smoke v1", "smoke v2"] };
    const captionText = "Full-pipeline smoke caption.\n";
    const briefJson = {
      rubric_pass: { item_1: true, item_2: true, item_3: false },
      ai_disclosure_required: true,
    };

    agentFs.put(requestId, "research", "research-bundle.json", Buffer.from(JSON.stringify(researchBundle)));
    agentFs.put(requestId, "strategy", "creative-brief.json", Buffer.from(JSON.stringify(creativeBrief)));
    agentFs.put(requestId, "copy", "script.json", Buffer.from(JSON.stringify(script)));
    agentFs.put(requestId, "copy", "captions.srt", Buffer.from(captionsSrt));
    agentFs.put(requestId, "copy", "caption_variants.json", Buffer.from(JSON.stringify(captionVariants)));
    agentFs.put(requestId, "copy", "caption_text.txt", Buffer.from(captionText));
    agentFs.put(requestId, "copy", "brief.json", Buffer.from(JSON.stringify(briefJson)));

    const uploadClient = httpArtifactUploadClient({ url: agentFs.baseUrl, token });

    // Helper: run a single substage's upload contract by writing the
    // worker's outputs to a fresh sandbox, calling the REAL
    // uploadWorkerArtifacts, and returning the result for assertions.
    async function runSubstage(args: {
      stage: string;
      outputs: Record<string, Buffer>;
    }): Promise<{ uploaded: string[]; failed: Array<{ filename: string; reason: string }> }> {
      const substageSandbox = await fsp.mkdtemp(
        path.join(os.tmpdir(), `plan5-pipeline-${args.stage}-`),
      );
      const subOutDir = path.join(substageSandbox, "artifacts", "out");
      await fsp.mkdir(subOutDir, { recursive: true });
      for (const [name, body] of Object.entries(args.outputs)) {
        await fsp.writeFile(path.join(subOutDir, name), body);
      }
      const result = await uploadWorkerArtifacts({
        agentHomeDir: substageSandbox,
        requestId,
        stage: args.stage,
        uploadClient,
        logger: noopLogger,
      });
      // Cleanup substage sandbox.
      await fsp.rm(substageSandbox, { recursive: true, force: true }).catch(() => {});
      return result;
    }

    // ── Stages 4-8: edit-scene-1 .. edit-scene-5 ──────────────────────────
    const sceneBytes: Record<number, Buffer> = {};
    for (let n = 1; n <= 5; n++) {
      // Distinct per-scene payload so any cross-wiring shows up as a
      // mismatched assertion later.
      const body = Buffer.from(`scene-${n}-mp4-payload-unique`, "utf-8");
      sceneBytes[n] = body;
      const renderLog = { scene: n, model: "kling-2.1-pro-stub", elapsed_s: 0.1 };

      const res = await runSubstage({
        stage: `edit-scene-${n}`,
        outputs: {
          [`scene-${n}.mp4`]: body,
          "render-log.json": Buffer.from(JSON.stringify(renderLog)),
        },
      });
      expect(res.failed).toEqual([]);
      expect(res.uploaded.sort()).toEqual([`scene-${n}.mp4`, "render-log.json"].sort());
      expect(agentFs.has(requestId, `edit-scene-${n}`, `scene-${n}.mp4`)).toBe(true);
    }

    // ── CHAIN DEPENDENCY CHECK: edit-stitch reads each scene from
    //    agent-fs at /<id>/edit-scene-N/scene-N.mp4. Verify each is
    //    fetchable + byte-equal to what we uploaded.
    const fetcherProbe = ceoChatFetcher.httpArtifactFetcher({
      url: agentFs.baseUrl,
      token,
    });
    for (let n = 1; n <= 5; n++) {
      const tmp = path.join(os.tmpdir(), `pipeline-probe-scene-${n}-${Date.now()}.bin`);
      await fetcherProbe.fetchArtifactToFile(requestId, `edit-scene-${n}`, `scene-${n}.mp4`, tmp);
      const fetched = readFileSync(tmp);
      expect(fetched.equals(sceneBytes[n]!)).toBe(true);
      await fsp.rm(tmp, { force: true });
    }

    // ── Stage 9: edit-stitch ──────────────────────────────────────────────
    const stitchedBytes = Buffer.from("stitched-mp4-from-5-scenes", "utf-8");
    {
      const res = await runSubstage({
        stage: "edit-stitch",
        outputs: {
          "stitched.mp4": stitchedBytes,
          "render-log.json": Buffer.from(JSON.stringify({ scenes: 5 })),
        },
      });
      expect(res.failed).toEqual([]);
      expect(agentFs.has(requestId, "edit-stitch", "stitched.mp4")).toBe(true);
      // CRITICAL: must NOT have leaked into legacy /edit/ namespace.
      expect(agentFs.has(requestId, "edit", "stitched.mp4")).toBe(false);
    }

    // CHAIN: motion-graphics fetches stitched.mp4 from /<id>/edit-stitch/.
    {
      const tmp = path.join(os.tmpdir(), `pipeline-probe-stitched-${Date.now()}.bin`);
      await fetcherProbe.fetchArtifactToFile(requestId, "edit-stitch", "stitched.mp4", tmp);
      expect(readFileSync(tmp).equals(stitchedBytes)).toBe(true);
      await fsp.rm(tmp, { force: true });
    }

    // ── Stage 10: edit-motion-graphics ────────────────────────────────────
    const motionGraphicsBytes = Buffer.from("motion-graphics-mp4-overlaid-cards", "utf-8");
    {
      const res = await runSubstage({
        stage: "edit-motion-graphics",
        outputs: {
          "motion-graphics.mp4": motionGraphicsBytes,
          "render-log.json": Buffer.from(JSON.stringify({ cards: 3 })),
        },
      });
      expect(res.failed).toEqual([]);
      expect(agentFs.has(requestId, "edit-motion-graphics", "motion-graphics.mp4")).toBe(true);
    }

    // ── Stage 11: edit-screenshots ────────────────────────────────────────
    const balancedBytes = Buffer.from("balanced-mp4-with-operator-screenshots", "utf-8");
    {
      const res = await runSubstage({
        stage: "edit-screenshots",
        outputs: {
          "balanced.mp4": balancedBytes,
          "render-log.json": Buffer.from(JSON.stringify({ screenshots: 0 })),
        },
      });
      expect(res.failed).toEqual([]);
      expect(agentFs.has(requestId, "edit-screenshots", "balanced.mp4")).toBe(true);
    }

    // ── Stage 12: edit-captions ───────────────────────────────────────────
    // Real captions.py reads balanced.mp4 from /<id>/edit-screenshots/
    // AND captions.srt from /<id>/copy/ (via get_text fallback when the
    // dispatcher mirror is missing). Both paths already work in agent-fs.
    const captionedBytes = Buffer.from("captioned-mp4-with-burnt-in-caps", "utf-8");
    {
      const res = await runSubstage({
        stage: "edit-captions",
        outputs: {
          "captioned.mp4": captionedBytes,
          "render-log.json": Buffer.from(JSON.stringify({ cues: 5 })),
        },
      });
      expect(res.failed).toEqual([]);
      expect(agentFs.has(requestId, "edit-captions", "captioned.mp4")).toBe(true);
    }

    // CHAIN: edit-final fetches the most-processed cut (captioned.mp4
    // from /<id>/edit-captions/) via finalize.py's _CUT_STAGE map.
    {
      const tmp = path.join(os.tmpdir(), `pipeline-probe-captioned-${Date.now()}.bin`);
      await fetcherProbe.fetchArtifactToFile(requestId, "edit-captions", "captioned.mp4", tmp);
      expect(readFileSync(tmp).equals(captionedBytes)).toBe(true);
      await fsp.rm(tmp, { force: true });
    }

    // ── Stage 13: edit-final ──────────────────────────────────────────────
    // What finalize.py would produce in its artifacts/out/ after a real
    // run: final.mp4 (ffmpeg-remuxed from captioned.mp4) + the 4 bundle
    // files mirrored from /<id>/copy/ via the agent-fs fallback Fix 1
    // added + a render-log.json. The upload hook then pushes ALL of
    // these to /<id>/edit-final/.
    const finalMp4Bytes = Buffer.from("final-mp4-faststart-remux-of-captioned", "utf-8");
    {
      const res = await runSubstage({
        stage: "edit-final",
        outputs: {
          "final.mp4": finalMp4Bytes,
          "captions.srt": Buffer.from(captionsSrt),
          "caption_text.txt": Buffer.from(captionText),
          "caption_variants.json": Buffer.from(JSON.stringify(captionVariants)),
          "brief.json": Buffer.from(JSON.stringify(briefJson)),
          "render-log.json": Buffer.from(JSON.stringify({ source_cut: "captioned.mp4" })),
        },
      });
      expect(res.failed).toEqual([]);
      // All 5 bundle files + render-log landed at /edit-final/.
      for (const name of [
        "final.mp4",
        "captions.srt",
        "caption_text.txt",
        "caption_variants.json",
        "brief.json",
        "render-log.json",
      ]) {
        expect(agentFs.has(requestId, "edit-final", name), `missing /edit-final/${name}`).toBe(true);
      }
    }

    // ── Heartbeat emit: synthesise the exact row the upload hook fires.
    const emit = buildHeartbeatEmit({
      requestId,
      uploadStage: "edit-final",
      uploaded: [
        "final.mp4",
        "captions.srt",
        "caption_text.txt",
        "caption_variants.json",
        "brief.json",
      ],
    });

    // ── ceo-chat dispatch: REAL dispatcher, REAL fetcher, REAL agent-fs.
    const fetcher = ceoChatFetcher.httpArtifactFetcher({ url: agentFs.baseUrl, token });
    const { sender, calls } = makeRecordingSender();
    const logLines: string[] = [];

    await ceoChatNotifier.dispatchVideoFinalCut({
      chatId: 99999,
      bundle: emit as unknown as Parameters<
        typeof ceoChatNotifier.dispatchVideoFinalCut
      >[0]["bundle"],
      telegram: sender,
      log: (msg) => {
        logLines.push(msg);
      },
      fetcher,
    });

    // ── End-to-end assertions ─────────────────────────────────────────────

    // 1 video + 4 docs, all delivered.
    expect(calls.length).toBe(5);
    expect(calls.filter((c) => c.kind === "video").length).toBe(1);
    expect(calls.filter((c) => c.kind === "doc").length).toBe(4);

    // Byte equality on the mp4: the byte-stream from edit-captions ->
    // (simulated) finalize.py -> edit-final upload -> ceo-chat fetch ->
    // Telegram is identical to what we said the finalize remux produced.
    const videoCall = calls.find((c) => c.kind === "video")!;
    expect(videoCall.bodyBytes.equals(finalMp4Bytes)).toBe(true);
    expect(videoCall.chatId).toBe(99999);

    // captions.srt round-trips byte-equal.
    const srtCall = calls.find((c) => c.filename === "captions.srt")!;
    expect(srtCall.bodyBytes.toString("utf-8")).toBe(captionsSrt);

    // brief.json delivered with the rubric the worker wrote.
    const briefCall = calls.find((c) => c.filename === "brief.json")!;
    expect(JSON.parse(briefCall.bodyBytes.toString("utf-8"))).toEqual(briefJson);

    // 5/5 delivery summary in the log.
    expect(
      logLines.some((m) => m.includes("delivered") && m.includes("5 of 5")),
      `expected 5/5 summary, got: ${JSON.stringify(logLines)}`,
    ).toBe(true);

    // render-log.json was uploaded per-substage but is NOT in the
    // dispatcher's hardcoded bundle list -- assert it never made it
    // to Telegram (operator gets the 5-file delivery, not stage
    // provenance noise).
    for (const c of calls) {
      expect(c.filename).not.toBe("render-log.json");
    }

    // EVERY substage upload landed at the per-substage namespace,
    // NEVER at the legacy /edit/ flat namespace. This rules out any
    // regression to the pre-Plan-5 path assumption.
    const editSubstageUploads = agentFs.putRequestPaths.filter((p) =>
      p.includes(`/${requestId}/edit-`),
    );
    const legacyEditUploads = agentFs.putRequestPaths.filter((p) =>
      p.match(new RegExp(`/${requestId}/edit/`)),
    );
    expect(editSubstageUploads.length).toBeGreaterThan(0);
    expect(legacyEditUploads.length).toBe(0);

    // EVERY dispatcher fetch hit /<id>/edit-final/ -- confirms the
    // bundleStage resolution stayed at Plan 5 for the full bundle.
    for (const reqPath of agentFs.getRequestPaths.filter((p) => p.includes(requestId))) {
      // probe fetches at scene/stitch/captions namespaces are OK (they
      // were our chain-dependency assertions, not dispatcher); the
      // dispatcher's 5 fetches all hit /edit-final/.
      const isDispatcherFetch =
        reqPath.includes("/final.mp4/binary") ||
        reqPath.includes("/captions.srt/binary") ||
        reqPath.includes("/caption_variants.json/binary") ||
        reqPath.includes("/caption_text.txt/binary") ||
        reqPath.includes("/brief.json/binary");
      if (isDispatcherFetch) {
        expect(
          reqPath.includes("/edit-final/"),
          `dispatcher fetch landed at wrong stage: ${reqPath}`,
        ).toBe(true);
      }
    }
  });
});
