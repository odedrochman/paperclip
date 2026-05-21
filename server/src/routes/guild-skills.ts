/**
 * Plan 3 v2 organisation — guild-skills HTTP routes.
 *
 * Distinct from `companySkillRoutes` (the upstream skill catalog) — these
 * routes serve the per-guild knowledge library workers write into.
 *
 * Path convention (matches the plan's spec, scoped under company for
 * consistency with the rest of the API):
 *
 *   GET    /companies/:companyId/guilds/:guildId/skills?provenance=…
 *   GET    /companies/:companyId/guilds/:guildId/skills/:skillId
 *   POST   /companies/:companyId/guilds/:guildId/skills
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/promote
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/record-use
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/retire
 *
 * All routes require company access. Writes (POST) additionally enforce:
 *   - create: any actor with company write access. Workers (agent kind
 *     'worker') and persistent agents may both write — the schema
 *     guarantees provenance='provisional' regardless of caller.
 *   - promote: any non-agent actor. Promoting a skill to canonical
 *     requires human (or future PM/COO orchestrator) approval; we
 *     refuse promote calls from agent-bearer tokens.
 *   - record-use: any actor. Both workers and humans may report
 *     outcomes; the counts power the future auto-promotion vote in
 *     Plan 3b.
 *   - retire: any non-agent actor. Same rationale as promote: retiring
 *     is an operator decision.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  guildSkillCreateSchema,
  guildSkillListQuerySchema,
  guildSkillRecordUseSchema,
} from "@paperclipai/shared";

import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { guildSkillService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function guildSkillRoutes(db: Db) {
  const router = Router();
  const svc = guildSkillService(db);

  function assertNonAgentActor(req: Parameters<typeof assertCompanyAccess>[0]) {
    if (req.actor.type === "agent") {
      throw forbidden(
        "Promote / retire requires operator approval; agent-bearer " +
          "tokens cannot promote or retire skills.",
      );
    }
  }

  router.get(
    "/companies/:companyId/guilds/:guildId/skills",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      const parsed = guildSkillListQuerySchema.parse(req.query);
      const skills = await svc.list(companyId, guildId, parsed);
      res.json(skills);
    },
  );

  router.get(
    "/companies/:companyId/guilds/:guildId/skills/:skillId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const skill = await svc.get(companyId, guildId, skillId);
      res.json(skill);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills",
    validate(guildSkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      // No actor-type gate here: workers + humans can both create
      // provisional skills. The service forces provenance='provisional'
      // on every insert, so a worker cannot mint a canonical skill
      // even if it tries.
      const created = await svc.create(companyId, guildId, req.body);
      res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/promote",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const promoted = await svc.promote(companyId, guildId, skillId);
      res.json(promoted);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/record-use",
    validate(guildSkillRecordUseSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const updated = await svc.recordUse(
        companyId,
        guildId,
        skillId,
        req.body.success,
      );
      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/retire",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const retired = await svc.retire(companyId, guildId, skillId);
      res.json(retired);
    },
  );

  return router;
}
