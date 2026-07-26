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
      secret_hash: hash(secret),
      secret_last_four: secret.slice(-4),
      created_at: new Date(),
      updated_at: new Date(),
    };
    await db.collection("developer_apps").insertOne(appRecord);
    const { _id, secret_hash, ...safe } = appRecord;
    return reply.code(201).send({ ...safe, client_secret: secret });
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
