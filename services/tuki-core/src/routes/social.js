import { randomUUID } from "node:crypto";

const id = { type: "string", minLength: 1, maxLength: 64 };

export async function registerSocialRoutes(app, { db, authenticate, adminOnly, hasServerAccess }) {
  app.get("/v1/discover/communities", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 24), 50);
    const filter = { published: true };
    if (request.query.category) filter.category = request.query.category;
    if (request.query.language) filter.language = request.query.language;
    if (request.query.q) {
      filter.$or = [
        { name: { $regex: escapeRegex(request.query.q), $options: "i" } },
        { description: { $regex: escapeRegex(request.query.q), $options: "i" } },
      ];
    }
    return {
      items: await db.collection("communities")
        .find(filter, { projection: { _id: 0, submitted_by: 0 } })
        .sort({ verified: -1, member_count: -1, name: 1 })
        .limit(limit)
        .toArray(),
    };
  });

  app.put("/v1/admin/discover/communities/:serverId", {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "category", "language", "published"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          description: { type: "string", minLength: 10, maxLength: 400 },
          category: { enum: ["gaming", "music", "technology", "education", "art", "community", "other"] },
          language: { type: "string", minLength: 2, maxLength: 12 },
          icon_url: { type: ["string", "null"], maxLength: 500 },
          banner_url: { type: ["string", "null"], maxLength: 500 },
          member_count: { type: "integer", minimum: 0 },
          verified: { type: "boolean" },
          published: { type: "boolean" },
        },
      },
    },
  }, async (request) => {
    const community = {
      server_id: request.params.serverId,
      ...request.body,
      submitted_by: request.tukiUser.id,
      updated_at: new Date(),
    };
    await db.collection("communities").updateOne(
      { server_id: community.server_id },
      { $set: community, $setOnInsert: { created_at: new Date() } },
      { upsert: true },
    );
    return community;
  });

  app.get("/v1/forums/threads", { preHandler: authenticate }, async (request) => {
    const filter = request.query.server_id
      ? { server_id: request.query.server_id }
      : { author_id: request.tukiUser.id };
    if (request.query.server_id && !(await hasServerAccess(request, request.query.server_id))) {
      return { items: [] };
    }
    if (request.query.channel_id) filter.channel_id = request.query.channel_id;
    if (request.query.tag) filter.tags = request.query.tag;
    return {
      items: await db.collection("forum_threads")
        .find(filter, { projection: { _id: 0 } })
        .sort({ pinned: -1, bumped_at: -1 })
        .limit(100)
        .toArray(),
    };
  });

  app.post("/v1/forums/threads", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["server_id", "channel_id", "title", "body"],
        properties: {
          server_id: id,
          channel_id: id,
          title: { type: "string", minLength: 3, maxLength: 160 },
          body: { type: "string", minLength: 1, maxLength: 10000 },
          tags: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 24 } },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await hasServerAccess(request, request.body.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const now = new Date();
    const thread = {
      id: randomUUID(),
      ...request.body,
      tags: request.body.tags ?? [],
      author_id: request.tukiUser.id,
      post_count: 0,
      pinned: false,
      locked: false,
      created_at: now,
      bumped_at: now,
    };
    await db.collection("forum_threads").insertOne(thread);
    return reply.code(201).send(withoutMongoId(thread));
  });

  app.get("/v1/forums/threads/:threadId", { preHandler: authenticate }, async (request, reply) => {
    const thread = await db.collection("forum_threads").findOne(
      { id: request.params.threadId },
      { projection: { _id: 0 } },
    );
    if (thread && thread.author_id !== request.tukiUser.id && !(await hasServerAccess(request, thread.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const posts = thread
      ? await db.collection("forum_posts").find({ thread_id: request.params.threadId }, { projection: { _id: 0 } }).sort({ created_at: 1 }).limit(200).toArray()
      : [];
    return thread ? { ...thread, posts } : reply.code(404).send({ error: "thread_not_found" });
  });

  app.post("/v1/forums/threads/:threadId/posts", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string", minLength: 1, maxLength: 10000 } },
      },
    },
  }, async (request, reply) => {
    const threads = db.collection("forum_threads");
    const thread = await threads.findOne({ id: request.params.threadId });
    if (!thread) return reply.code(404).send({ error: "thread_not_found" });
    if (thread.author_id !== request.tukiUser.id && !(await hasServerAccess(request, thread.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    if (thread.locked) return reply.code(409).send({ error: "thread_locked" });
    const now = new Date();
    const post = {
      id: randomUUID(),
      thread_id: thread.id,
      author_id: request.tukiUser.id,
      body: request.body.body,
      created_at: now,
      updated_at: now,
    };
    await Promise.all([
      db.collection("forum_posts").insertOne(post),
      threads.updateOne({ id: thread.id }, { $inc: { post_count: 1 }, $set: { bumped_at: now } }),
    ]);
    return reply.code(201).send(withoutMongoId(post));
  });

  app.patch("/v1/admin/forums/threads/:threadId", {
    preHandler: [authenticate, adminOnly],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { pinned: { type: "boolean" }, locked: { type: "boolean" } },
      },
    },
  }, async (request, reply) => {
    const result = await db.collection("forum_threads").findOneAndUpdate(
      { id: request.params.threadId },
      { $set: { ...request.body, moderated_by: request.tukiUser.id, updated_at: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return result ?? reply.code(404).send({ error: "thread_not_found" });
  });

  app.get("/v1/search", { preHandler: authenticate }, async (request) => {
    const query = String(request.query.q ?? "").trim();
    if (query.length < 2) return { threads: [], communities: [], events: [] };
    const expression = { $regex: escapeRegex(query), $options: "i" };
    const [threads, communities, events] = await Promise.all([
      db.collection("forum_threads").find(
        { author_id: request.tukiUser.id, $or: [{ title: expression }, { body: expression }, { tags: expression }] },
        { projection: { _id: 0, body: 0 } },
      ).limit(20).toArray(),
      db.collection("communities").find(
        { published: true, $or: [{ name: expression }, { description: expression }] },
        { projection: { _id: 0, submitted_by: 0 } },
      ).limit(20).toArray(),
      db.collection("events").find(
        { $or: [{ title: expression }, { description: expression }] },
        { projection: { _id: 0, attendees: 0 } },
      ).limit(20).toArray(),
    ]);
    return { threads, communities, events };
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withoutMongoId(value) {
  const { _id, ...result } = value;
  return result;
}
