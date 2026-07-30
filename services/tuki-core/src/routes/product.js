import { randomUUID } from "node:crypto";

const plans = Object.freeze([
  {
    id: "free",
    name: "Tuki Free",
    price_monthly_eur: 0,
    upload_limit_mb: 25,
    storage_gb: 2,
    voice_bitrate_kbps: 96,
    features: ["communities", "forums", "events", "bookmarks"],
  },
  {
    id: "plus",
    name: "Tuki Plus",
    price_monthly_eur: 4.99,
    upload_limit_mb: 200,
    storage_gb: 50,
    voice_bitrate_kbps: 256,
    features: ["larger_uploads", "custom_profile", "longer_history", "priority_media"],
  },
]);

export async function registerProductRoutes(app, { db, authenticate, adminOnly }) {
  app.get("/v1/plans", async () => ({ items: plans }));

  app.get("/v1/entitlements", { preHandler: authenticate }, async (request) => {
    const entitlement = await db.collection("entitlements").findOne(
      { user_id: request.tukiUser.id },
      { projection: { _id: 0 } },
    );
    return entitlement ?? { user_id: request.tukiUser.id, plan_id: "free", source: "default" };
  });

  app.put("/v1/admin/entitlements/:userId", {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["plan_id", "reason"],
        properties: {
          plan_id: { enum: plans.map((plan) => plan.id) },
          reason: { type: "string", minLength: 3, maxLength: 300 },
          expires_at: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  }, async (request) => {
    const entitlement = {
      user_id: request.params.userId,
      plan_id: request.body.plan_id,
      reason: request.body.reason,
      expires_at: request.body.expires_at ? new Date(request.body.expires_at) : null,
      source: "admin",
      granted_by: request.tukiUser.id,
      updated_at: new Date(),
    };
    await db.collection("entitlements").updateOne(
      { user_id: entitlement.user_id },
      { $set: entitlement },
      { upsert: true },
    );
    return entitlement;
  });

  app.get("/v1/inbox/items", { preHandler: authenticate }, async (request) => {
    const filter = { user_id: request.tukiUser.id };
    if (request.query.kind) filter.kind = request.query.kind;
    if (request.query.unread === "true") filter.unread = true;
    if (request.query.server_id) filter.server_id = request.query.server_id;
    filter.$or = [{ snoozed_until: null }, { snoozed_until: { $lte: new Date() } }];
    return {
      items: await db.collection("inbox_items")
        .find(filter, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(100)
        .toArray(),
    };
  });

  app.patch("/v1/inbox/items/:itemId", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          unread: { type: "boolean" },
          snoozed_until: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  }, async (request, reply) => {
    const update = { ...request.body, updated_at: new Date() };
    if (request.body.unread === false) update.read_at = new Date();
    if (request.body.unread === true) update.read_at = null;
    if (update.snoozed_until) update.snoozed_until = new Date(update.snoozed_until);
    const item = await db.collection("inbox_items").findOneAndUpdate(
      { id: request.params.itemId, user_id: request.tukiUser.id },
      { $set: update },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return item ?? reply.code(404).send({ error: "inbox_item_not_found" });
  });

  app.post("/v1/inbox/read-all", { preHandler: authenticate }, async (request) => {
    const result = await db.collection("inbox_items").updateMany(
      { user_id: request.tukiUser.id, unread: true },
      { $set: { unread: false, read_at: new Date() } },
    );
    return { updated: result.modifiedCount };
  });

  app.post("/v1/inbox/channels/:channelId/read", {
    preHandler: authenticate,
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: {
          channelId: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request) => {
    const readAt = new Date();
    const result = await db.collection("inbox_items").updateMany(
      {
        user_id: request.tukiUser.id,
        channel_id: request.params.channelId,
        unread: true,
      },
      {
        $set: {
          unread: false,
          read_at: readAt,
          updated_at: readAt,
        },
      },
    );
    return { updated: result.modifiedCount };
  });

  app.post("/v1/admin/moderation/actions", {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["target_user_id", "action", "reason"],
        properties: {
          target_user_id: { type: "string", minLength: 1, maxLength: 64 },
          server_id: { type: ["string", "null"], maxLength: 64 },
          action: { enum: ["warn", "timeout", "kick", "ban", "global_block"] },
          reason: { type: "string", minLength: 3, maxLength: 1000 },
          expires_at: { type: ["string", "null"], format: "date-time" },
          report_id: { type: ["string", "null"], maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const action = {
      id: randomUUID(),
      ...request.body,
      expires_at: request.body.expires_at ? new Date(request.body.expires_at) : null,
      moderator_id: request.tukiUser.id,
      created_at: new Date(),
    };
    await db.collection("moderation_actions").insertOne(action);
    return reply.code(201).send(action);
  });

  app.get("/v1/admin/moderation/actions", {
    preHandler: [authenticate, adminOnly],
  }, async (request) => ({
    items: await db.collection("moderation_actions")
      .find(request.query.target_user_id ? { target_user_id: request.query.target_user_id } : {}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray(),
  }));

  app.post("/v1/appeals", {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: "1 day" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["action_id", "statement"],
        properties: {
          action_id: { type: "string", minLength: 1, maxLength: 64 },
          statement: { type: "string", minLength: 20, maxLength: 3000 },
        },
      },
    },
  }, async (request, reply) => {
    const action = await db.collection("moderation_actions").findOne({
      id: request.body.action_id,
      target_user_id: request.tukiUser.id,
    });
    if (!action) return reply.code(404).send({ error: "moderation_action_not_found" });
    const appeal = {
      id: randomUUID(),
      action_id: action.id,
      user_id: request.tukiUser.id,
      statement: request.body.statement,
      status: "open",
      created_at: new Date(),
    };
    await db.collection("appeals").insertOne(appeal);
    return reply.code(201).send(appeal);
  });

  app.put("/v1/admin/raid-mode/:serverId", {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: {
          enabled: { type: "boolean" },
          minimum_account_age_hours: { type: "integer", minimum: 0, maximum: 8760 },
          verification_level: { enum: ["normal", "elevated", "locked"] },
        },
      },
    },
  }, async (request) => {
    const state = {
      server_id: request.params.serverId,
      enabled: request.body.enabled,
      minimum_account_age_hours: request.body.minimum_account_age_hours ?? 24,
      verification_level: request.body.verification_level ?? "elevated",
      updated_by: request.tukiUser.id,
      updated_at: new Date(),
    };
    await db.collection("raid_modes").updateOne(
      { server_id: state.server_id },
      { $set: state },
      { upsert: true },
    );
    return state;
  });
}
