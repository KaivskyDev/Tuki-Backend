import { createHash, randomBytes, randomUUID } from "node:crypto";

const allowedScopes = [
  "identify",
  "profile.read",
  "servers.read",
  "messages.read",
  "messages.write",
  "webhooks.write",
  "bot",
];

export async function registerDeveloperRoutes(app, { db, authenticate }) {
  app.get("/v1/discover/bots", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 24), 50);
    const filter = { published: true, scopes: "bot" };
    if (request.query.category) filter.category = request.query.category;
    if (request.query.q) {
      const expression = { $regex: escapeRegex(String(request.query.q)), $options: "i" };
      filter.$or = [{ name: expression }, { description: expression }, { tags: expression }];
    }
    return {
      items: await db.collection("developer_apps")
        .find(filter, { projection: { _id: 0, secret_hash: 0, secret_last_four: 0, redirect_uris: 0 } })
        .sort({ verified: -1, server_count: -1, name: 1 })
        .limit(limit)
        .toArray(),
    };
  });

  app.get("/v1/discover/bots/:appId", async (request, reply) => {
    const bot = await db.collection("developer_apps").findOne(
      { id: request.params.appId, published: true, scopes: "bot" },
      { projection: { _id: 0, secret_hash: 0, secret_last_four: 0, redirect_uris: 0 } },
    );
    return bot ?? reply.code(404).send({ error: "bot_not_found" });
  });

  app.get("/v1/developers/apps", { preHandler: authenticate }, async (request) => ({
    items: await db.collection("developer_apps")
      .find({ owner_id: request.tukiUser.id }, { projection: { _id: 0, secret_hash: 0 } })
      .sort({ created_at: -1 })
      .toArray(),
  }));

  app.post("/v1/developers/apps", {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 day" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          description: { type: "string", maxLength: 300 },
          redirect_uris: {
            type: "array",
            maxItems: 10,
            uniqueItems: true,
            items: { type: "string", pattern: "^https://" },
          },
          scopes: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { enum: allowedScopes },
          },
          icon_url: { type: ["string", "null"], maxLength: 500 },
          banner_url: { type: ["string", "null"], maxLength: 500 },
          website_url: { type: ["string", "null"], pattern: "^https://" },
          category: { enum: ["moderation", "music", "utility", "social", "games", "other"] },
          tags: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 24 } },
          published: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const secret = `tuki_${randomBytes(32).toString("base64url")}`;
    const appRecord = {
      id: randomUUID(),
      client_id: randomBytes(16).toString("hex"),
      owner_id: request.tukiUser.id,
      name: request.body.name,
      description: request.body.description ?? "",
      redirect_uris: request.body.redirect_uris ?? [],
      scopes: request.body.scopes ?? ["identify"],
      icon_url: request.body.icon_url ?? null,
      banner_url: request.body.banner_url ?? null,
      website_url: request.body.website_url ?? null,
      category: request.body.category ?? "other",
      tags: request.body.tags ?? [],
      published: request.body.published === true && (request.body.scopes ?? []).includes("bot"),
      verified: false,
      server_count: 0,
      secret_hash: hash(secret),
      secret_last_four: secret.slice(-4),
      created_at: new Date(),
      updated_at: new Date(),
    };
    await db.collection("developer_apps").insertOne(appRecord);
    const { _id, secret_hash, ...safe } = appRecord;
    return reply.code(201).send({ ...safe, client_secret: secret });
  });

  app.patch("/v1/developers/apps/:appId/discover", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", minLength: 0, maxLength: 300 },
          icon_url: { type: ["string", "null"], maxLength: 500 },
          banner_url: { type: ["string", "null"], maxLength: 500 },
          website_url: { type: ["string", "null"], pattern: "^https://" },
          category: { enum: ["moderation", "music", "utility", "social", "games", "other"] },
          tags: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 24 } },
          published: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const current = await db.collection("developer_apps").findOne({
      id: request.params.appId,
      owner_id: request.tukiUser.id,
    });
    if (!current) return reply.code(404).send({ error: "app_not_found" });
    if (!current.scopes.includes("bot")) {
      return reply.code(409).send({ error: "bot_scope_required" });
    }
    if (request.body.published && String(request.body.description ?? current.description).trim().length < 10) {
      return reply.code(400).send({ error: "discover_description_too_short" });
    }
    const updated = await db.collection("developer_apps").findOneAndUpdate(
      { id: current.id, owner_id: request.tukiUser.id },
      { $set: { ...request.body, updated_at: new Date() } },
      { returnDocument: "after", projection: { _id: 0, secret_hash: 0 } },
    );
    return updated;
  });

  app.post("/v1/developers/apps/:appId/rotate-secret", {
    preHandler: authenticate,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const secret = `tuki_${randomBytes(32).toString("base64url")}`;
    const result = await db.collection("developer_apps").findOneAndUpdate(
      { id: request.params.appId, owner_id: request.tukiUser.id },
      { $set: { secret_hash: hash(secret), secret_last_four: secret.slice(-4), updated_at: new Date() } },
      { returnDocument: "after", projection: { _id: 0, secret_hash: 0 } },
    );
    return result
      ? { ...result, client_secret: secret }
      : reply.code(404).send({ error: "app_not_found" });
  });

  app.delete("/v1/developers/apps/:appId", { preHandler: authenticate }, async (request, reply) => {
    const result = await db.collection("developer_apps").deleteOne({
      id: request.params.appId,
      owner_id: request.tukiUser.id,
    });
    if (!result.deletedCount) return reply.code(404).send({ error: "app_not_found" });
    await db.collection("webhooks").deleteMany({ app_id: request.params.appId, owner_id: request.tukiUser.id });
    return reply.code(204).send();
  });

  app.get("/v1/developers/usage", { preHandler: authenticate }, async (request) => ({
    items: await db.collection("developer_usage")
      .find({ owner_id: request.tukiUser.id }, { projection: { _id: 0 } })
      .sort({ day: -1 })
      .limit(90)
      .toArray(),
    rate_limits: { standard: 60, burst: 120, unit: "requests_per_minute" },
  }));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
