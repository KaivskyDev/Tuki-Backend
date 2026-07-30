import { randomUUID } from "node:crypto";

const ruleProperties = Object.freeze({
  name: { type: "string", minLength: 1, maxLength: 80 },
  type: {
    enum: ["keyword", "mention_spam", "link_block", "rapid_messages"],
  },
  enabled: { type: "boolean" },
  action: { enum: ["block", "flag", "timeout"] },
  threshold: { type: "integer", minimum: 1, maximum: 100 },
  timeout_seconds: {
    anyOf: [
      { type: "integer", minimum: 60, maximum: 2_419_200 },
      { type: "null" },
    ],
  },
  values: {
    type: "array",
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 120 },
  },
  exempt_role_ids: {
    type: "array",
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 64 },
  },
  exempt_channel_ids: {
    type: "array",
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 64 },
  },
});

export async function registerModerationRoutes(
  app,
  { db, authenticate, isServerOwner },
) {
  const ownerOnly = async (request, reply) => {
    if (!(await isServerOwner(request, request.params.serverId))) {
      return reply.code(403).send({
        error: "server_owner_required",
        message: "Only the community owner can manage AutoMod and audit logs.",
      });
    }
  };

  app.get("/v1/servers/:serverId/audit-log", {
    preHandler: [authenticate, ownerOnly],
    schema: {
      params: serverParams,
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", minLength: 1, maxLength: 80 },
          before: { type: "string", format: "date-time" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request) => {
    const filter = { server_id: request.params.serverId };
    if (request.query.action) filter.action = request.query.action;
    if (request.query.before) {
      filter.created_at = { $lt: new Date(request.query.before) };
    }
    const items = await db.collection("server_audit_events")
      .find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1, id: -1 })
      .limit(request.query.limit ?? 50)
      .toArray();
    return {
      items,
      next_before: items.length
        ? new Date(items.at(-1).created_at).toISOString()
        : null,
    };
  });

  app.get("/v1/servers/:serverId/automod/rules", {
    preHandler: [authenticate, ownerOnly],
    schema: { params: serverParams },
  }, async (request) => ({
    items: await db.collection("automod_rules")
      .find(
        { server_id: request.params.serverId },
        { projection: { _id: 0 } },
      )
      .sort({ created_at: 1 })
      .toArray(),
  }));

  app.post("/v1/servers/:serverId/automod/rules", {
    preHandler: [authenticate, ownerOnly],
    config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
    schema: {
      params: serverParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "action"],
        properties: ruleProperties,
      },
    },
  }, async (request, reply) => {
    const validation = validateRule(request.body);
    if (validation) return reply.code(422).send(validation);

    const now = new Date();
    const rule = normaliseRule({
      id: randomUUID(),
      server_id: request.params.serverId,
      enabled: true,
      threshold: defaultThreshold(request.body.type),
      timeout_seconds: null,
      values: [],
      exempt_role_ids: [],
      exempt_channel_ids: [],
      ...request.body,
      created_by: request.tukiUser.id,
      updated_by: request.tukiUser.id,
      created_at: now,
      updated_at: now,
    });
    await db.collection("automod_rules").insertOne(rule);
    await recordServerAuditEvent(db, request, {
      serverId: rule.server_id,
      action: "automod.rule.created",
      targetType: "automod_rule",
      targetId: rule.id,
      changes: publicRuleConfiguration(rule),
    });
    return reply.code(201).send(rule);
  });

  app.patch("/v1/servers/:serverId/automod/rules/:ruleId", {
    preHandler: [authenticate, ownerOnly],
    config: { rateLimit: { max: 60, timeWindow: "1 hour" } },
    schema: {
      params: ruleParams,
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: ruleProperties,
      },
    },
  }, async (request, reply) => {
    const rules = db.collection("automod_rules");
    const existing = await rules.findOne({
      id: request.params.ruleId,
      server_id: request.params.serverId,
    });
    if (!existing) {
      return reply.code(404).send({ error: "automod_rule_not_found" });
    }
    const candidate = { ...existing, ...request.body };
    const validation = validateRule(candidate);
    if (validation) return reply.code(422).send(validation);

    const updatedAt = new Date();
    const changes = normaliseRule({
      ...request.body,
      updated_by: request.tukiUser.id,
      updated_at: updatedAt,
    });
    await rules.updateOne(
      { id: existing.id, server_id: existing.server_id },
      { $set: changes },
    );
    await recordServerAuditEvent(db, request, {
      serverId: existing.server_id,
      action: "automod.rule.updated",
      targetType: "automod_rule",
      targetId: existing.id,
      changes: publicRuleConfiguration(changes),
    });
    return { ...existing, ...changes };
  });

  app.delete("/v1/servers/:serverId/automod/rules/:ruleId", {
    preHandler: [authenticate, ownerOnly],
    schema: { params: ruleParams },
  }, async (request, reply) => {
    const result = await db.collection("automod_rules").deleteOne({
      id: request.params.ruleId,
      server_id: request.params.serverId,
    });
    if (!result.deletedCount) {
      return reply.code(404).send({ error: "automod_rule_not_found" });
    }
    await recordServerAuditEvent(db, request, {
      serverId: request.params.serverId,
      action: "automod.rule.deleted",
      targetType: "automod_rule",
      targetId: request.params.ruleId,
    });
    return reply.code(204).send();
  });
}

export async function recordServerAuditEvent(db, request, {
  serverId,
  action,
  targetType = null,
  targetId = null,
  changes = {},
}) {
  await db.collection("server_audit_events").insertOne({
    id: randomUUID(),
    server_id: serverId,
    actor_id: request.tukiUser.id,
    action,
    target_type: targetType,
    target_id: targetId,
    changes,
    request_id: request.id,
    created_at: new Date(),
  });
}

function validateRule(rule) {
  if (rule.type === "keyword" && !(rule.values?.length > 0)) {
    return {
      error: "invalid_automod_rule",
      field: "values",
      message: "A keyword rule requires at least one keyword.",
    };
  }
  if (rule.action === "timeout" && !rule.timeout_seconds) {
    return {
      error: "invalid_automod_rule",
      field: "timeout_seconds",
      message: "A timeout action requires timeout_seconds.",
    };
  }
  return null;
}

function normaliseRule(rule) {
  const result = { ...rule };
  if (typeof result.name === "string") result.name = result.name.trim();
  for (const key of ["values", "exempt_role_ids", "exempt_channel_ids"]) {
    if (result[key]) {
      result[key] = [...new Set(result[key].map((value) => value.trim()))]
        .filter(Boolean);
    }
  }
  return result;
}

function defaultThreshold(type) {
  if (type === "mention_spam") return 8;
  if (type === "rapid_messages") return 6;
  return 1;
}

function publicRuleConfiguration(rule) {
  return Object.fromEntries(
    Object.entries(rule).filter(([key]) => ruleProperties[key]),
  );
}

const serverParams = {
  type: "object",
  additionalProperties: false,
  required: ["serverId"],
  properties: {
    serverId: { type: "string", minLength: 1, maxLength: 64 },
  },
};

const ruleParams = {
  type: "object",
  additionalProperties: false,
  required: ["serverId", "ruleId"],
  properties: {
    ...serverParams.properties,
    ruleId: { type: "string", minLength: 1, maxLength: 64 },
  },
};
