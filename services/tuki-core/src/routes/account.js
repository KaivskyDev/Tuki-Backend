import { randomUUID } from "node:crypto";

const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export async function registerAccountRoutes(app, { db, identityDb, authenticate }) {
  app.get("/v1/account/sessions", {
    preHandler: authenticate,
    schema: {
      response: {
        200: {
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "name", "current"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  current: { type: "boolean" },
                  origin: { type: ["string", "null"] },
                  last_seen: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const sessions = identityDb.collection("sessions");
    const token = request.headers["x-session-token"];
    const current = token
      ? await sessions.findOne(
          { user_id: request.tukiUser.id, token },
          { projection: { _id: 1 } },
        )
      : null;
    const items = await sessions
      .find(
        { user_id: request.tukiUser.id },
        {
          projection: {
            _id: 1,
            name: 1,
            origin: 1,
            last_seen: 1,
          },
        },
      )
      .sort({ last_seen: -1 })
      .limit(100)
      .toArray();

    return {
      items: items.map((session) => ({
        id: String(session._id),
        name: session.name || "Tuki session",
        origin: session.origin ?? null,
        last_seen: session.last_seen
          ? new Date(session.last_seen).toISOString()
          : null,
        current: String(session._id) === String(current?._id),
      })),
    };
  });

  app.delete("/v1/account/sessions/:sessionId", {
    preHandler: authenticate,
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    if (request.tukiUser.bot) {
      return reply.code(403).send({ error: "user_account_required" });
    }
    const result = await identityDb.collection("sessions").deleteOne({
      _id: request.params.sessionId,
      user_id: request.tukiUser.id,
    });
    if (!result.deletedCount) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    await securityEvent(db, request, "session_revoked", {
      session_id: request.params.sessionId,
    });
    return reply.code(204).send();
  });

  app.post("/v1/account/sessions/revoke-others", {
    preHandler: authenticate,
    config: { rateLimit: { max: 6, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    if (request.tukiUser.bot) {
      return reply.code(403).send({ error: "user_account_required" });
    }
    const sessions = identityDb.collection("sessions");
    const current = await sessions.findOne({
      user_id: request.tukiUser.id,
      token: request.headers["x-session-token"],
    });
    if (!current) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    const result = await sessions.deleteMany({
      user_id: request.tukiUser.id,
      _id: { $ne: current._id },
    });
    await securityEvent(db, request, "other_sessions_revoked", {
      count: result.deletedCount,
    });
    return { revoked: result.deletedCount };
  });

  app.get("/v1/account/deletion", { preHandler: authenticate }, async (request) => {
    const deletion = await db.collection("account_deletions").findOne(
      { user_id: request.tukiUser.id, status: "pending" },
      { projection: { _id: 0, user_id: 0, mfa_ticket_hash: 0 } },
    );
    return deletion ?? { status: "none" };
  });

  app.post("/v1/account/deletion", {
    preHandler: authenticate,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["confirmation", "mfa_ticket"],
        properties: {
          confirmation: { const: "DELETE" },
          mfa_ticket: { type: "string", minLength: 16, maxLength: 512 },
        },
      },
    },
  }, async (request, reply) => {
    if (request.tukiUser.bot) {
      return reply.code(403).send({ error: "user_account_required" });
    }
    const ownedServers = await identityDb.collection("servers").countDocuments(
      { owner: request.tukiUser.id },
      { limit: 1 },
    );
    if (ownedServers) {
      return reply.code(409).send({ error: "owned_servers_must_be_transferred" });
    }

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + DELETION_GRACE_MS);
    const deletion = {
      id: randomUUID(),
      user_id: request.tukiUser.id,
      status: "pending",
      requested_at: now,
      scheduled_for: scheduledFor,
      cancelled_at: null,
      completed_at: null,
      request_ip: request.ip,
      request_user_agent:
        request.headers["user-agent"]?.slice(0, 300) ?? null,
      // The upstream ticket is deliberately never persisted.
    };
    await db.collection("account_deletions").updateOne(
      { user_id: request.tukiUser.id, status: "pending" },
      { $setOnInsert: deletion },
      { upsert: true },
    );
    await securityEvent(db, request, "account_deletion_scheduled", {
      scheduled_for: scheduledFor,
    });
    return reply.code(202).send({
      status: "pending",
      requested_at: now,
      scheduled_for: scheduledFor,
      can_cancel: true,
    });
  });

  app.delete("/v1/account/deletion", {
    preHandler: authenticate,
    config: { rateLimit: { max: 6, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const result = await db.collection("account_deletions").findOneAndUpdate(
      {
        user_id: request.tukiUser.id,
        status: "pending",
        scheduled_for: { $gt: new Date() },
      },
      {
        $set: {
          status: "cancelled",
          cancelled_at: new Date(),
          request_ip: null,
          request_user_agent: null,
        },
      },
      { returnDocument: "after", projection: { _id: 0, user_id: 0 } },
    );
    if (!result) {
      return reply.code(404).send({ error: "deletion_not_pending" });
    }
    await securityEvent(db, request, "account_deletion_cancelled");
    return result;
  });

  app.get("/v1/account/privacy", { preHandler: authenticate }, async (request) => {
    const saved = await db.collection("privacy_preferences").findOne(
      { user_id: request.tukiUser.id },
      { projection: { _id: 0, user_id: 0 } },
    );
    return { ...defaultPrivacy, ...saved };
  });

  app.put("/v1/account/privacy", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(defaultPrivacy),
        properties: privacyProperties,
      },
    },
  }, replacePrivacyPreferences);

  app.patch("/v1/account/privacy", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: privacyProperties,
      },
    },
  }, async (request) => {
    const now = new Date();
    const current = await db.collection("privacy_preferences").findOne(
      { user_id: request.tukiUser.id },
      { projection: { _id: 0, user_id: 0 } },
    );
    const preferences = {
      ...defaultPrivacy,
      ...current,
      ...request.body,
      updated_at: now,
    };
    await db.collection("privacy_preferences").updateOne(
      { user_id: request.tukiUser.id },
      {
        $set: preferences,
        $setOnInsert: {
          user_id: request.tukiUser.id,
          created_at: now,
        },
      },
      { upsert: true },
    );
    return preferences;
  });

  async function replacePrivacyPreferences(request) {
    const now = new Date();
    const preferences = { ...request.body, updated_at: now };
    await db.collection("privacy_preferences").updateOne(
      { user_id: request.tukiUser.id },
      {
        $set: preferences,
        $setOnInsert: {
          user_id: request.tukiUser.id,
          created_at: now,
        },
      },
      { upsert: true },
    );
    return preferences;
  }
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
  }, async (_request, reply) => {
    return reply.code(501).send({
      error: "identity_integration_required",
      message: "Recovery codes must be issued and verified by the identity service.",
    });
  });

  app.get("/v1/account/security-capabilities", { preHandler: authenticate }, async () => ({
    totp: "requires_identity_service_integration",
    passkeys: "requires_identity_service_integration",
    recovery_codes: "requires_identity_service_integration",
    device_history: "available",
    upstream_session_revocation: "available",
  }));
}

export async function purgeExpiredAccounts({ db, identityDb, logger }) {
  while (true) {
    const deletion = await db.collection("account_deletions").findOneAndUpdate(
      { status: "pending", scheduled_for: { $lte: new Date() } },
      { $set: { status: "purging", purge_started_at: new Date() } },
      { returnDocument: "after" },
    );
    if (!deletion) return;

    const userId = deletion.user_id;
    try {
      const tukiFilters = new Map([
        ["profiles", { user_id: userId }],
        ["bookmarks", { user_id: userId }],
        ["notification_preferences", { user_id: userId }],
        ["privacy_preferences", { user_id: userId }],
        ["security_events", { user_id: userId }],
        ["devices", { user_id: userId }],
        ["developer_apps", { owner_id: userId }],
        ["webhooks", { owner_id: userId }],
        ["inbox_items", { user_id: userId }],
        ["entitlements", { user_id: userId }],
        ["oauth_identities", { user_id: userId }],
        ["oauth_exchanges", { user_id: userId }],
        ["events", { author_id: userId }],
        ["forum_threads", { author_id: userId }],
        ["forum_posts", { author_id: userId }],
        ["reports", {
          $or: [
            { reporter_id: userId },
            { target_type: "user", target_id: userId },
          ],
        }],
        ["moderation_actions", {
          $or: [{ target_user_id: userId }, { moderator_id: userId }],
        }],
        ["appeals", { user_id: userId }],
      ]);
      const identityFilters = new Map([
        ["users", { _id: userId }],
        ["sessions", { user_id: userId }],
        ["messages", { author: userId }],
        ["members", { user: userId }],
        ["channel_unreads", { user_id: userId }],
        ["relationships", { $or: [{ user_id: userId }, { from_id: userId }, { to_id: userId }] }],
        ["bots", { owner: userId }],
        ["emojis", { creator_id: userId }],
        ["invites", { creator: userId }],
        ["webhooks", { creator_id: userId }],
      ]);

      await Promise.all([
        db.collection("polls").updateMany(
          { "options.votes": userId },
          { $pull: { "options.$[].votes": userId } },
        ),
        db.collection("events").updateMany(
          { attendees: userId },
          { $pull: { attendees: userId } },
        ),
      ]);

      const results = await Promise.all([
        ...[...tukiFilters].map(([name, filter]) =>
          db.collection(name).deleteMany(filter),
        ),
        ...[...identityFilters].map(([name, filter]) =>
          identityDb.collection(name).deleteMany(filter),
        ),
      ]);
      const deletedDocuments = results.reduce(
        (sum, result) => sum + result.deletedCount,
        0,
      );
      await db.collection("account_deletions").updateOne(
        { _id: deletion._id, status: "purging" },
        {
          $set: {
            status: "completed",
            completed_at: new Date(),
            deleted_documents: deletedDocuments,
            user_id: null,
            request_ip: null,
            request_user_agent: null,
          },
          $unset: { purge_started_at: "" },
        },
      );
      logger?.info(
        { deletion_id: deletion.id, deleted_documents: deletedDocuments },
        "account data purge completed",
      );
    } catch (error) {
      await db.collection("account_deletions").updateOne(
        { _id: deletion._id, status: "purging" },
        {
          $set: {
            status: "pending",
            last_error_at: new Date(),
          },
          $unset: { purge_started_at: "" },
        },
      );
      logger?.error({ err: error, deletion_id: deletion.id }, "account data purge failed");
      return;
    }
  }
}

const defaultPrivacy = Object.freeze({
  friend_requests: "mutuals",
  message_requests: "mutuals",
  server_invites: "friends",
  group_invites: "friends",
  direct_messages: "friends",
  activity: "friends",
  online_status: "friends",
  read_receipts: true,
  mutual_friends: true,
  profile_servers: false,
  discover_by_email: false,
  suspicious_message_filter: true,
  spam_message_requests: false,
  block_nsfw: true,
});

const privacyProperties = Object.freeze({
  friend_requests: { enum: ["everyone", "mutuals", "nobody"] },
  message_requests: { enum: ["everyone", "mutuals", "nobody"] },
  server_invites: { enum: ["everyone", "friends", "nobody"] },
  group_invites: { enum: ["everyone", "friends", "nobody"] },
  direct_messages: { enum: ["everyone", "friends", "nobody"] },
  activity: { enum: ["everyone", "friends", "nobody"] },
  online_status: { enum: ["everyone", "friends", "nobody"] },
  read_receipts: { type: "boolean" },
  mutual_friends: { type: "boolean" },
  profile_servers: { type: "boolean" },
  discover_by_email: { type: "boolean" },
  suspicious_message_filter: { type: "boolean" },
  spam_message_requests: { type: "boolean" },
  block_nsfw: { type: "boolean" },
});

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
