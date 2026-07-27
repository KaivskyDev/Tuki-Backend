import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify from "fastify";

import { createAuth, hasServerAccess, requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { connectDatabase } from "./database.js";
import { recordRequest, renderMetrics } from "./metrics.js";
import { sanitisePoll } from "./polls.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerDeveloperRoutes } from "./routes/developers.js";
import { registerProductRoutes } from "./routes/product.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerSocialRoutes } from "./routes/social.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.x-session-token",
      "req.headers.x-bot-token",
    ],
  },
  trustProxy: config.trustProxy,
  requestIdHeader: "x-request-id",
  genReqId: (request) => request.headers["x-request-id"] ?? randomUUID(),
});

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed"), false);
  },
  allowedHeaders: [
    "Content-Type",
    "X-Session-Token",
    "X-Bot-Token",
    "X-Request-Id",
  ],
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

await app.register(rateLimit, {
  max: 180,
  timeWindow: "1 minute",
  keyGenerator: (request) => request.tukiUser?.id ?? request.ip,
});

await app.register(swagger, {
  openapi: {
    info: {
      title: "Tuki Core API",
      version: "1.0.0",
      description: "Product-specific API for Tuki by Muzes.",
    },
    servers: [{ url: "https://core.muzes.xyz" }],
    components: {
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "X-Session-Token",
        },
      },
    },
  },
});

const database = await connectDatabase(config);
const { db, identityDb } = database;
const authenticate = createAuth(config);
const adminOnly = requireAdmin(config);

app.decorateRequest("tukiUser", null);
registerTelemetryRoutes(app);
registerOAuthRoutes(app, { config, db, identityDb });
app.addHook("onResponse", async (_request, reply) => recordRequest(reply));
app.addHook("onClose", async () => database.client.close());

app.get("/health/live", async () => ({
  status: "ok",
  service: "tuki-core",
  version: "1.0.0",
}));

app.get("/health/ready", async (_request, reply) => {
  try {
    await db.command({ ping: 1 });
    return { status: "ready", database: "connected" };
  } catch {
    return reply.code(503).send({ status: "not_ready", database: "offline" });
  }
});

app.get("/metrics", async (_request, reply) => {
  reply.type("text/plain; version=0.0.4");
  return renderMetrics();
});

app.get("/openapi.json", async () => app.swagger());

await registerSocialRoutes(app, {
  db,
  authenticate,
  adminOnly,
  hasServerAccess: (request, serverId) => hasServerAccess(config, request, serverId),
});
await registerAccountRoutes(app, { db, authenticate });
await registerDeveloperRoutes(app, { db, authenticate });
await registerProductRoutes(app, { db, authenticate, adminOnly });

app.get("/v1/profile", { preHandler: authenticate }, async (request) => {
  const profile = await db
    .collection("profiles")
    .findOne({ user_id: request.tukiUser.id }, { projection: { _id: 0 } });

  return (
    profile ?? {
      user_id: request.tukiUser.id,
      bio: "",
      links: [],
      favourite_music: null,
      privacy: {
        activity: "friends",
        links: "everyone",
        mutuals: "everyone",
      },
    }
  );
});

app.patch(
  "/v1/profile",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          bio: { type: "string", maxLength: 500 },
          links: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "url"],
              properties: {
                label: { type: "string", minLength: 1, maxLength: 32 },
                url: { type: "string", pattern: "^https://" },
              },
            },
          },
          favourite_music: {
            anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }],
          },
          privacy: {
            type: "object",
            additionalProperties: false,
            properties: {
              activity: { enum: ["everyone", "friends", "nobody"] },
              links: { enum: ["everyone", "friends", "nobody"] },
              mutuals: { enum: ["everyone", "friends", "nobody"] },
            },
          },
        },
      },
    },
  },
  async (request) => {
    const updatedAt = new Date();
    await db.collection("profiles").updateOne(
      { user_id: request.tukiUser.id },
      {
        $set: { ...request.body, updated_at: updatedAt },
        $setOnInsert: {
          user_id: request.tukiUser.id,
          created_at: updatedAt,
        },
      },
      { upsert: true },
    );
    return { updated: true, updated_at: updatedAt };
  },
);

app.get("/v1/bookmarks", { preHandler: authenticate }, async (request) => ({
  items: await db
    .collection("bookmarks")
    .find({ user_id: request.tukiUser.id }, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(100)
    .toArray(),
}));

app.post(
  "/v1/bookmarks",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["message_id", "channel_id"],
        properties: {
          message_id: { type: "string", minLength: 1, maxLength: 64 },
          channel_id: { type: "string", minLength: 1, maxLength: 64 },
          server_id: { type: ["string", "null"], maxLength: 64 },
          note: { type: "string", maxLength: 240 },
        },
      },
    },
  },
  async (request, reply) => {
    const bookmark = {
      id: randomUUID(),
      user_id: request.tukiUser.id,
      message_id: request.body.message_id,
      channel_id: request.body.channel_id,
      server_id: request.body.server_id ?? null,
      note: request.body.note ?? "",
      created_at: new Date(),
    };

    await db.collection("bookmarks").updateOne(
      {
        user_id: bookmark.user_id,
        message_id: bookmark.message_id,
      },
      { $setOnInsert: bookmark },
      { upsert: true },
    );
    return reply.code(201).send(bookmark);
  },
);

app.delete(
  "/v1/bookmarks/:messageId",
  { preHandler: authenticate },
  async (request, reply) => {
    const result = await db.collection("bookmarks").deleteOne({
      user_id: request.tukiUser.id,
      message_id: request.params.messageId,
    });
    return result.deletedCount
      ? reply.code(204).send()
      : reply.code(404).send({ error: "bookmark_not_found" });
  },
);

app.post(
  "/v1/polls",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["channel_id", "question", "options"],
        properties: {
          channel_id: { type: "string", minLength: 1, maxLength: 64 },
          server_id: { type: ["string", "null"], maxLength: 64 },
          question: { type: "string", minLength: 1, maxLength: 240 },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 100 },
          },
          multiple: { type: "boolean" },
          closes_at: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  },
  async (request, reply) => {
    if (
      request.body.server_id &&
      !(await hasServerAccess(config, request, request.body.server_id))
    ) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const poll = {
      id: randomUUID(),
      author_id: request.tukiUser.id,
      channel_id: request.body.channel_id,
      server_id: request.body.server_id ?? null,
      question: request.body.question,
      options: request.body.options.map((label) => ({
        id: randomUUID(),
        label,
        votes: [],
      })),
      multiple: request.body.multiple ?? false,
      closes_at: request.body.closes_at
        ? new Date(request.body.closes_at)
        : null,
      created_at: new Date(),
    };
    await db.collection("polls").insertOne(poll);
    return reply.code(201).send(sanitisePoll(poll, request.tukiUser.id));
  },
);

app.get(
  "/v1/polls/:pollId",
  { preHandler: authenticate },
  async (request, reply) => {
    const poll = await db.collection("polls").findOne({
      id: request.params.pollId,
    });
    if (
      poll?.server_id &&
      !(await hasServerAccess(config, request, poll.server_id))
    ) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    return poll
      ? sanitisePoll(poll, request.tukiUser.id)
      : reply.code(404).send({ error: "poll_not_found" });
  },
);

app.post(
  "/v1/polls/:pollId/votes",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["option_ids"],
        properties: {
          option_ids: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            uniqueItems: true,
            items: { type: "string" },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const polls = db.collection("polls");
    const poll = await polls.findOne({ id: request.params.pollId });
    if (!poll) return reply.code(404).send({ error: "poll_not_found" });
    if (
      poll.server_id &&
      !(await hasServerAccess(config, request, poll.server_id))
    ) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    if (poll.closes_at && new Date(poll.closes_at) <= new Date()) {
      return reply.code(409).send({ error: "poll_closed" });
    }
    if (!poll.multiple && request.body.option_ids.length > 1) {
      return reply.code(400).send({ error: "single_choice_poll" });
    }

    const selected = new Set(request.body.option_ids);
    const valid = new Set(poll.options.map((option) => option.id));
    if ([...selected].some((id) => !valid.has(id))) {
      return reply.code(400).send({ error: "invalid_poll_option" });
    }

    poll.options = poll.options.map((option) => ({
      ...option,
      votes: selected.has(option.id)
        ? [...new Set([...option.votes, request.tukiUser.id])]
        : option.votes.filter((id) => id !== request.tukiUser.id),
    }));
    await polls.updateOne({ id: poll.id }, { $set: { options: poll.options } });
    return sanitisePoll(poll, request.tukiUser.id);
  },
);

app.get("/v1/events", { preHandler: authenticate }, async (request) => {
  if (
    request.query.server_id &&
    !(await hasServerAccess(config, request, request.query.server_id))
  ) {
    return { items: [] };
  }
  const filter = request.query.server_id
    ? { server_id: request.query.server_id }
    : { $or: [{ author_id: request.tukiUser.id }, { attendees: request.tukiUser.id }] };
  return {
    items: await db
      .collection("events")
      .find(filter, { projection: { _id: 0 } })
      .sort({ starts_at: 1 })
      .limit(100)
      .toArray(),
  };
});

app.post(
  "/v1/events",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["server_id", "title", "starts_at"],
        properties: {
          server_id: { type: "string", minLength: 1, maxLength: 64 },
          channel_id: { type: ["string", "null"], maxLength: 64 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 1000 },
          starts_at: { type: "string", format: "date-time" },
          ends_at: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  },
  async (request, reply) => {
    if (!(await hasServerAccess(config, request, request.body.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const event = {
      id: randomUUID(),
      author_id: request.tukiUser.id,
      server_id: request.body.server_id,
      channel_id: request.body.channel_id ?? null,
      title: request.body.title,
      description: request.body.description ?? "",
      starts_at: new Date(request.body.starts_at),
      ends_at: request.body.ends_at ? new Date(request.body.ends_at) : null,
      attendees: [request.tukiUser.id],
      created_at: new Date(),
    };
    await db.collection("events").insertOne(event);
    return reply.code(201).send(event);
  },
);

app.post(
  "/v1/events/:eventId/rsvp",
  { preHandler: authenticate },
  async (request, reply) => {
    const event = await db.collection("events").findOne({
      id: request.params.eventId,
    });
    if (!event) return reply.code(404).send({ error: "event_not_found" });
    if (!(await hasServerAccess(config, request, event.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const result = await db.collection("events").findOneAndUpdate(
      { id: request.params.eventId },
      { $addToSet: { attendees: request.tukiUser.id } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return result ?? reply.code(404).send({ error: "event_not_found" });
  },
);

app.get("/v1/inbox", { preHandler: authenticate }, async (request) => {
  const now = new Date();
  const [bookmarks, events] = await Promise.all([
    db
      .collection("bookmarks")
      .find({ user_id: request.tukiUser.id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray(),
    db
      .collection("events")
      .find(
        {
          attendees: request.tukiUser.id,
          starts_at: { $gte: now },
        },
        { projection: { _id: 0 } },
      )
      .sort({ starts_at: 1 })
      .limit(20)
      .toArray(),
  ]);
  return { bookmarks, upcoming_events: events };
});

app.post(
  "/v1/reports",
  {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["target_type", "target_id", "reason"],
        properties: {
          target_type: { enum: ["message", "user", "server"] },
          target_id: { type: "string", minLength: 1, maxLength: 64 },
          reason: {
            enum: [
              "spam",
              "harassment",
              "malware",
              "illegal_content",
              "impersonation",
              "other",
            ],
          },
          details: { type: "string", maxLength: 2000 },
          context: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel_id: { type: "string", maxLength: 64 },
              server_id: { type: "string", maxLength: 64 },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const report = {
      id: randomUUID(),
      reporter_id: request.tukiUser.id,
      ...request.body,
      status: "open",
      evidence_locked_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    await db.collection("reports").insertOne(report);
    return reply.code(201).send({
      id: report.id,
      status: report.status,
      created_at: report.created_at,
    });
  },
);

app.get(
  "/v1/admin/reports",
  { preHandler: [authenticate, adminOnly] },
  async (request) => ({
    items: await db
      .collection("reports")
      .find(
        request.query.status ? { status: request.query.status } : {},
        { projection: { _id: 0 } },
      )
      .sort({ created_at: -1 })
      .limit(100)
      .toArray(),
  }),
);

app.patch(
  "/v1/admin/reports/:reportId",
  {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { enum: ["open", "reviewing", "actioned", "dismissed"] },
          moderator_note: { type: "string", maxLength: 2000 },
        },
      },
    },
  },
  async (request, reply) => {
    const report = await db.collection("reports").findOneAndUpdate(
      { id: request.params.reportId },
      {
        $set: {
          ...request.body,
          moderator_id: request.tukiUser.id,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return report ?? reply.code(404).send({ error: "report_not_found" });
  },
);

app.get(
  "/v1/admin/automod/:serverId",
  { preHandler: [authenticate, adminOnly] },
  async (request) => ({
    items: await db
      .collection("automod_rules")
      .find(
        { server_id: request.params.serverId },
        { projection: { _id: 0 } },
      )
      .toArray(),
  }),
);

app.put(
  "/v1/admin/automod/:serverId/rules/:ruleId",
  {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["type", "enabled", "action"],
        properties: {
          type: {
            enum: ["keyword", "mention_spam", "link_block", "rapid_messages"],
          },
          enabled: { type: "boolean" },
          action: { enum: ["block", "flag", "timeout"] },
          threshold: { type: "integer", minimum: 1, maximum: 100 },
          values: {
            type: "array",
            maxItems: 100,
            items: { type: "string", maxLength: 120 },
          },
        },
      },
    },
  },
  async (request) => {
    const rule = {
      server_id: request.params.serverId,
      rule_id: request.params.ruleId,
      ...request.body,
      updated_by: request.tukiUser.id,
      updated_at: new Date(),
    };
    await db.collection("automod_rules").updateOne(
      {
        server_id: rule.server_id,
        rule_id: rule.rule_id,
      },
      { $set: rule },
      { upsert: true },
    );
    return rule;
  },
);

app.get(
  "/v1/notification-preferences",
  { preHandler: authenticate },
  async (request) =>
    (await db.collection("notification_preferences").findOne(
      { user_id: request.tukiUser.id },
      { projection: { _id: 0 } },
    )) ?? {
      user_id: request.tukiUser.id,
      quiet_hours: null,
      digest: "off",
    },
);

app.put(
  "/v1/notification-preferences",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          digest: { enum: ["off", "daily", "weekly"] },
          quiet_hours: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["start", "end", "timezone"],
                properties: {
                  start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
                  end: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
                  timezone: { type: "string", maxLength: 64 },
                },
              },
            ],
          },
        },
      },
    },
  },
  async (request) => {
    const preferences = {
      user_id: request.tukiUser.id,
      ...request.body,
      updated_at: new Date(),
    };
    await db.collection("notification_preferences").updateOne(
      { user_id: request.tukiUser.id },
      { $set: preferences },
      { upsert: true },
    );
    return preferences;
  },
);

app.setErrorHandler((error, request, reply) => {
  request.log.warn({ err: error }, "request failed");
  if (error.validation) {
    return reply.code(400).send({
      error: "invalid_request",
      message: error.message,
      request_id: request.id,
    });
  }
  return reply.code(error.statusCode ?? 500).send({
    error: error.statusCode ? "request_failed" : "internal_error",
    message:
      error.statusCode && error.statusCode < 500
        ? error.message
        : "An unexpected error occurred.",
    request_id: request.id,
  });
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
