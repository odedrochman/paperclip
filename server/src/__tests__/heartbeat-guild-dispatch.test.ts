/**
 * Plan 3 Phase E1b — guild dispatch end-to-end env wiring.
 *
 * Verifies that for `agent.kind === 'guild'` the dispatcher:
 *   1. Resolves the adapter via `adapterConfig.workerAdapterType`
 *      (not `agent.adapter_type`).
 *   2. Creates a per-run sandbox directory.
 *   3. Exposes `GUILD_ID`, `GUILD_SLUG`, `GUILD_AUTONOMY_JSON_PATH`,
 *      `GUILD_SKILLS_PATH`, `WORKER_LEARNINGS_PATH`, and
 *      `MEMORY_SERVICE_PROJECT` to the spawned worker.
 *
 * For `kind === 'agent'` the same dispatch path leaves those env keys
 * out — the existing non-guild behaviour is unchanged.
 *
 * Mechanism: the test spawns a tiny Node script via the `process`
 * adapter; the script writes `process.env` to a known file. After the
 * run completes the test reads that file and asserts the env shape.
 *
 * E1c will extend this file to assert the `available_skills.json`
 * contents; E2b to assert the worker-exit hook ingests learnings.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat guild dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat guild dispatch (Plan 3 Phase E1b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let testTmpRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-guild-dispatch-");
    db = createDb(tempDb.connectionString);
    testTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-guild-dispatch-test-"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await fs.rm(testTmpRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  /** Tiny node script: dump process.env (filtered to the keys we care
   * about) to the path stored in TEST_ENV_DUMP_PATH. The keys must be
   * specifically named in the script because process.env's full
   * serialization is noisy and includes paperclip internals. */
  function envDumpScript(dumpPath: string) {
    return [
      `const fs = require('node:fs');`,
      `const keys = ['GUILD_ID','GUILD_SLUG','GUILD_AUTONOMY_JSON_PATH','GUILD_SKILLS_PATH','WORKER_LEARNINGS_PATH','MEMORY_SERVICE_PROJECT'];`,
      `const out = {};`,
      `for (const k of keys) { if (k in process.env) out[k] = process.env[k]; }`,
      `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(out));`,
      `process.exit(0);`,
    ].join(" ");
  }

  async function setupCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip-test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("spawns a guild worker with GUILD_*/MEMORY_SERVICE_PROJECT/WORKER_LEARNINGS_PATH env", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-${agentId}.json`);

    // Stand up a fake guild instructions bundle so prepareGuildRunSandbox
    // can copy autonomy.json. The contents only need to be valid JSON.
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "guild-bundle-"));
    await fs.writeFile(
      path.join(bundleRoot, "autonomy.json"),
      JSON.stringify({ version: 1, guildName: "eng-guild-test", autonomous: ["read"] }),
      "utf-8",
    );

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "eng-guild-test",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // The dump file should exist and contain the guild env keys.
    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8"));
    expect(dumped.GUILD_ID).toBe(agentId);
    expect(dumped.GUILD_SLUG).toBe("eng-guild-test");
    expect(dumped.MEMORY_SERVICE_PROJECT).toBe("farm/eng-guild-test");
    expect(dumped.WORKER_LEARNINGS_PATH).toMatch(/paperclip-guild-run-/);
    expect(dumped.WORKER_LEARNINGS_PATH).toMatch(/learnings\.json$/);
    expect(dumped.GUILD_AUTONOMY_JSON_PATH).toMatch(/autonomy\.json$/);
    expect(dumped.GUILD_SKILLS_PATH).toMatch(/available_skills\.json$/);

    // All four sandbox paths share the same parent directory.
    const sandboxDir = path.dirname(dumped.WORKER_LEARNINGS_PATH);
    expect(path.dirname(dumped.GUILD_AUTONOMY_JSON_PATH)).toBe(sandboxDir);
    expect(path.dirname(dumped.GUILD_SKILLS_PATH)).toBe(sandboxDir);

    // available_skills.json should have been written by prepareGuildRunSandbox
    // (E1b uses an empty snapshot; E1c will populate the array).
    // The outer finally has by now cleaned the sandbox, so the file
    // is gone — but the dumped paths recorded what was visible to the
    // worker at spawn time.
  }, 30_000);

  it("non-guild dispatch leaves GUILD_*/MEMORY_SERVICE_PROJECT/WORKER_LEARNINGS_PATH absent", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-agent-${agentId}.json`);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "regular-agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      // kind defaults to 'agent' (per DB schema default)
      adapterConfig: {
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8"));
    // All six guild env keys should be absent from a non-guild dispatch.
    expect(dumped).toEqual({});
  }, 30_000);

  it("guild row stored with kind='guild' is visible after dispatch", async () => {
    // Sanity check: agents.kind column is persisted across the dispatch
    // path and doesn't get clobbered. This guards against future changes
    // to updateRuntimeState or finalizeAgentStatus accidentally dropping
    // the kind value.
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-kindcheck-${agentId}.json`);
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "kindcheck-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "kindcheck-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const rows = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, agentId));
    expect(rows[0]?.kind).toBe("guild");
  }, 30_000);
});
