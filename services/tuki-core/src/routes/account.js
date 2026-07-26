import { createHash, randomBytes, randomUUID } from "node:crypto";

export async function registerAccountRoutes(app, { db, authenticate }) {
  app.get("/v1/account/devices", { preHandler: authenticate }, async (request) => ({
    items: await db.collection("devices")
      .find({ user_id: request.tukiUser.id }, { projection: { _id: 0 } })
      .sort({ last_seen_at: -1 })
      .limit(50)
      .toArray(),
  }));

  app.post("/v1/account/devices/register", {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["device_id", "name", "platform"],
        properties: {
          device_id: { type: "string", minLength: 16, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 80 },
          platform: { enum: ["web", "windows", "macos", "linux", "android", "ios"] },
          push_subscription_id: { type: ["string", "null"], maxLength: 128 },
        },
      },
    },
  }, async (request) => {
    const now = new Date();
    const key = { user_id: request.tukiUser.id, device_id: request.body.device_id };
    const previous = await db.collection("devices").findOne(key);
    const device = {
      ...key,
      name: request.body.name,
      platform: request.body.platform,
      push_subscription_id: request.body.push_subscription_id ?? null,
      last_ip: request.ip,
      last_user_agent: request.headers["user-agent"]?.slice(0, 300) ?? null,
      last_seen_at: now,
      trusted: previous?.trusted ?? false,
    };
    await db.collection("devices").updateOne(
      key,
      { $set: device, $setOnInsert: { created_at: now } },
      { upsert: true },
    );
    if (!previous) {
      await securityEvent(db, request, "new_device", { device_id: device.device_id, platform: device.platform });
    }
    return device;
  });

  app.delete("/v1/account/devices/:deviceId", { preHandler: authenticate }, async (request, reply) => {
    const result = await db.collection("devices").deleteOne({
      user_id: request.tukiUser.id,
      device_id: request.params.deviceId,
    });
    if (!result.deletedCount) return reply.code(404).send({ error: "device_not_found" });
    await securityEvent(db, request, "device_removed", { device_id: request.params.deviceId });
    return reply.code(204).send();
  });

  app.get("/v1/account/security-events", { preHandler: authenticate }, async (request) => ({
    items: await db.collection("security_events")
      .find({ user_id: request.tukiUser.id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray(),
  }));

  app.post("/v1/account/recovery-codes", {
    preHandler: authenticate,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
  }, async (request) => {
    const codes = Array.from({ length: 10 }, () => formatCode(randomBytes(6).toString("hex")));
    await db.collection("recovery_codes").updateOne(
      { user_id: request.tukiUser.id },
      {
        $set: {
          hashes: codes.map(hash),
          remaining: codes.length,
          generated_at: new Date(),
        },
      },
      { upsert: true },
    );
    await securityEvent(db, request, "recovery_codes_regenerated");
    return { codes };
  });

  app.get("/v1/account/security-capabilities", { preHandler: authenticate }, async () => ({
    totp: "requires_identity_service_integration",
    passkeys: "requires_identity_service_integration",
    recovery_codes: "available",
    device_history: "available",
    upstream_session_revocation: "requires_identity_service_integration",
  }));
}

async function securityEvent(db, request, type, details = {}) {
  await db.collection("security_events").insertOne({
    id: randomUUID(),
    user_id: request.tukiUser.id,
    type,
    details,
    ip: request.ip,
    user_agent: request.headers["user-agent"]?.slice(0, 300) ?? null,
    created_at: new Date(),
  });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatCode(value) {
  return `${value.slice(0, 6)}-${value.slice(6)}`.toUpperCase();
}
