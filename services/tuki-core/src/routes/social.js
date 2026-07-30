import { randomUUID } from "node:crypto";

const id = { type: "string", minLength: 1, maxLength: 64 };

const PRESENCE_TTL_MS = 2 * 60 * 1000;
const DISCOVERY_ACTIVITY_WINDOW_DAYS = 7;
const DISCOVERY_NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DISCOVERY_ACTIVITY_CACHE_MS = 5 * 60 * 1000;
const communityActivityCache = new Map();

export async function registerSocialRoutes(app, {
  db,
  identityDb,
  authenticate,
  adminOnly,
  hasServerAccess,
  isServerOwner,
}) {
  app.get("/v1/discover/communities", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 24), 1), 50);
    const filter = { published: true };
    if (request.query.new_only === "true") {
      filter.created_at = {
        $gte: new Date(Date.now() - DISCOVERY_NEW_WINDOW_MS),
      };
    }
    if (request.query.category) filter.category = request.query.category;
    if (request.query.language) filter.language = request.query.language;
    if (request.query.q) {
      filter.$or = [
        { name: { $regex: escapeRegex(request.query.q), $options: "i" } },
        { description: { $regex: escapeRegex(request.query.q), $options: "i" } },
      ];
    }
    const sort =
      request.query.sort === "new"
        ? { created_at: -1, name: 1 }
        : { verified: -1, member_count: -1, name: 1 };
    const communities = await db.collection("communities")
        .find(filter, { projection: { _id: 0, submitted_by: 0 } })
        .sort(sort)
        .limit(request.query.sort === "activity" ? 50 : limit)
        .toArray();
    const items = await attachLiveCommunityStats(
      db,
      identityDb,
      communities,
    );
    if (request.query.sort === "activity") {
      items.sort(
        (left, right) =>
          right.activity.messages_per_day - left.activity.messages_per_day ||
          right.member_count - left.member_count,
      );
    }
    return {
      items: items.slice(0, limit),
      activity_window_days: DISCOVERY_ACTIVITY_WINDOW_DAYS,
    };
  });

  app.get("/v1/discover/communities/:serverId", async (request, reply) => {
    const community = await db.collection("communities").findOne(
      { server_id: request.params.serverId, published: true },
      { projection: { _id: 0, submitted_by: 0 } },
    );
    if (!community) {
      return reply.code(404).send({ error: "community_not_found" });
    }
    return (
      await attachLiveCommunityStats(db, identityDb, [community], {
        includeEmojis: true,
      })
    )[0];
  });

  app.post("/v1/discover/presence", {
    preHandler: authenticate,
    config: { rateLimit: { max: 4, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["server_ids"],
        properties: {
          server_ids: {
            type: "array",
            maxItems: 50,
            uniqueItems: true,
            items: id,
          },
        },
      },
    },
  }, async (request) => {
    const serverIds = request.body.server_ids;
    const [memberships, ownedServers] = await Promise.all([
      identityDb.collection("members").find(
        { user: request.tukiUser.id, server: { $in: serverIds } },
        { projection: { _id: 0, server: 1 } },
      ).toArray(),
      identityDb.collection("servers").find(
        { _id: { $in: serverIds }, owner: request.tukiUser.id },
        { projection: { _id: 1 } },
      ).toArray(),
    ]);
    const allowed = new Set([
      ...memberships.map((member) => member.server),
      ...ownedServers.map((server) => server._id),
    ]);
    const accepted = serverIds.filter((serverId) => allowed.has(serverId));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PRESENCE_TTL_MS);

    if (accepted.length) {
      await db.collection("community_presence").bulkWrite(
        accepted.map((serverId) => ({
          updateOne: {
            filter: { server_id: serverId, user_id: request.tukiUser.id },
            update: {
              $set: { updated_at: now, expires_at: expiresAt },
              $setOnInsert: {
                server_id: serverId,
                user_id: request.tukiUser.id,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }

    return { accepted, expires_at: expiresAt };
  });

  app.post("/v1/invites", {
    preHandler: authenticate,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["server_id", "channel_id", "invite_code"],
        properties: {
          server_id: id,
          channel_id: id,
          invite_code: id,
          expires_in_seconds: {
            type: ["integer", "null"],
            minimum: 60,
            maximum: 2592000,
          },
          max_uses: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: 1000,
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await hasServerAccess(request, request.body.server_id))) {
      return reply.code(403).send({ error: "server_access_required" });
    }
    const now = new Date();
    const managedInvite = {
      code: randomUUID().replaceAll("-", "").slice(0, 12),
      server_id: request.body.server_id,
      channel_id: request.body.channel_id,
      invite_code: request.body.invite_code,
      created_by: request.tukiUser.id,
      created_at: now,
      expires_at: request.body.expires_in_seconds
        ? new Date(now.getTime() + request.body.expires_in_seconds * 1000)
        : null,
      max_uses: request.body.max_uses ?? null,
      uses: 0,
      revoked: false,
    };
    await db.collection("managed_invites").insertOne(managedInvite);
    return reply.code(201).send(withoutMongoId(managedInvite));
  });

  app.get("/v1/invites/:code", async (request, reply) => {
    const invite = await db.collection("managed_invites").findOne(
      activeManagedInviteFilter(request.params.code),
      {
        projection: {
          _id: 0,
          code: 1,
          invite_code: 1,
          expires_at: 1,
          max_uses: 1,
          uses: 1,
        },
      },
    );
    return invite ?? reply.code(404).send({ error: "invite_not_found" });
  });

  app.post("/v1/invites/:code/use", {
    preHandler: authenticate,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const invite = await db.collection("managed_invites").findOneAndUpdate(
      activeManagedInviteFilter(request.params.code),
      { $inc: { uses: 1 }, $set: { last_used_at: new Date() } },
      { returnDocument: "before", projection: { _id: 0, invite_code: 1 } },
    );
    return invite ?? reply.code(410).send({ error: "invite_expired_or_used" });
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
          description: { type: "string", minLength: 0, maxLength: 400 },
          category: { enum: ["gaming", "music", "technology", "education", "art", "community", "other"] },
          language: { type: "string", minLength: 2, maxLength: 12 },
          icon_url: { type: ["string", "null"], maxLength: 500 },
          banner_url: { type: ["string", "null"], maxLength: 500 },
          tags: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 24 } },
          featured_channels: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } },
          moderation_level: { enum: ["standard", "enhanced", "strict"] },
          online_count: { type: "integer", minimum: 0 },
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

  app.get("/v1/discover/communities/:serverId/settings", {
    preHandler: authenticate,
  }, async (request, reply) => {
    if (!(await isServerOwner(request, request.params.serverId))) {
      return reply.code(403).send({ error: "server_owner_required" });
    }
    return (await db.collection("communities").findOne(
      { server_id: request.params.serverId },
      { projection: { _id: 0, submitted_by: 0 } },
    )) ?? { server_id: request.params.serverId, published: false };
  });

  app.put("/v1/discover/communities/:serverId/settings", {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "category", "language", "published"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          description: { type: "string", minLength: 0, maxLength: 400 },
          category: { enum: ["gaming", "music", "technology", "education", "art", "community", "other"] },
          language: { type: "string", minLength: 2, maxLength: 12 },
          icon_url: { type: ["string", "null"], maxLength: 500 },
          banner_url: { type: ["string", "null"], maxLength: 500 },
          tags: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 24 } },
          featured_channels: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } },
          moderation_level: { enum: ["standard", "enhanced", "strict"] },
          online_count: { type: "integer", minimum: 0 },
          invite_code: { type: ["string", "null"], minLength: 3, maxLength: 64 },
          member_count: { type: "integer", minimum: 0 },
          published: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await isServerOwner(request, request.params.serverId))) {
      return reply.code(403).send({ error: "server_owner_required" });
    }
    if (request.body.published && request.body.description.trim().length < 10) {
      return reply.code(400).send({ error: "discover_description_too_short" });
    }
    const community = {
      server_id: request.params.serverId,
      ...request.body,
      verified: false,
      submitted_by: request.tukiUser.id,
      updated_at: new Date(),
    };
    await db.collection("communities").updateOne(
      { server_id: community.server_id },
      { $set: community, $setOnInsert: { created_at: new Date() } },
      { upsert: true },
    );
    return withoutMongoId(community);
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

async function attachLiveCommunityStats(
  db,
  identityDb,
  communities,
  { includeEmojis = false } = {},
) {
  const serverIds = communities.map((community) => community.server_id);
  if (!serverIds.length) return communities;

  const now = new Date();
  const [presence, members, activityByServer, emojisByServer] = await Promise.all([
    db.collection("community_presence").aggregate([
      { $match: { server_id: { $in: serverIds }, expires_at: { $gt: now } } },
      { $group: { _id: "$server_id", count: { $sum: 1 } } },
    ]).toArray(),
    identityDb.collection("members").aggregate([
      { $match: { server: { $in: serverIds } } },
      { $group: { _id: "$server", count: { $sum: 1 } } },
    ]).toArray(),
    loadCommunityActivity(identityDb, serverIds),
    includeEmojis
      ? loadCommunityEmojis(identityDb, serverIds)
      : Promise.resolve(new Map()),
  ]);
  const onlineByServer = new Map(
    presence.map((entry) => [entry._id, entry.count]),
  );
  const membersByServer = new Map(
    members.map((entry) => [entry._id, entry.count]),
  );

  return communities.map((community) => {
    const messages =
      activityByServer.get(community.server_id)?.messages ?? 0;
    const messagesPerDay = Number(
      (messages / DISCOVERY_ACTIVITY_WINDOW_DAYS).toFixed(1),
    );
    const createdAt = community.created_at
      ? new Date(community.created_at)
      : null;
    return {
      ...community,
      is_new: Boolean(
        createdAt &&
        Number.isFinite(createdAt.getTime()) &&
        now.getTime() - createdAt.getTime() <=
          DISCOVERY_NEW_WINDOW_MS,
      ),
      member_count:
        membersByServer.get(community.server_id) ?? community.member_count ?? 0,
      online_count: onlineByServer.get(community.server_id) ?? 0,
      activity: {
        level: activityLevel(messagesPerDay),
        messages,
        messages_per_day: messagesPerDay,
        window_days: DISCOVERY_ACTIVITY_WINDOW_DAYS,
      },
      ...(includeEmojis
        ? { emojis: emojisByServer.get(community.server_id) ?? [] }
        : {}),
    };
  });
}

async function loadCommunityActivity(identityDb, serverIds) {
  const now = Date.now();
  const result = new Map();
  const missing = [];
  for (const serverId of serverIds) {
    const cached = communityActivityCache.get(serverId);
    if (cached && cached.expires_at > now) {
      result.set(serverId, { messages: cached.messages });
    } else {
      missing.push(serverId);
    }
  }
  if (!missing.length) return result;

  try {
    const channels = await identityDb.collection("channels").find(
      { server: { $in: missing } },
      { projection: { _id: 1, server: 1 } },
    ).toArray();
    if (!channels.length) {
      cacheMissingActivity(missing, result, now);
      return result;
    }

    const channelToServer = new Map(
      channels.map((channel) => [channel._id, channel.server]),
    );
    const channelIds = [...channelToServer.keys()];
    const earliest = minimumUlid(
      Date.now() - DISCOVERY_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const counts = await identityDb.collection("messages").aggregate([
      {
        $match: {
          channel: { $in: channelIds },
          _id: { $gte: earliest },
        },
      },
      { $group: { _id: "$channel", count: { $sum: 1 } } },
    ]).toArray();
    for (const entry of counts) {
      const serverId = channelToServer.get(entry._id);
      if (!serverId) continue;
      const current = result.get(serverId)?.messages ?? 0;
      result.set(serverId, { messages: current + Number(entry.count ?? 0) });
    }
    cacheMissingActivity(missing, result, now);
    return result;
  } catch (error) {
    appLogSafe("discover_activity_unavailable", error);
    return result;
  }
}

function cacheMissingActivity(serverIds, result, now) {
  for (const serverId of serverIds) {
    const messages = result.get(serverId)?.messages ?? 0;
    result.set(serverId, { messages });
    communityActivityCache.set(serverId, {
      messages,
      expires_at: now + DISCOVERY_ACTIVITY_CACHE_MS,
    });
  }
  if (communityActivityCache.size > 10_000) {
    for (const [serverId, entry] of communityActivityCache) {
      if (entry.expires_at <= now) communityActivityCache.delete(serverId);
    }
  }
}

async function loadCommunityEmojis(identityDb, serverIds) {
  try {
    const emojis = await identityDb.collection("emojis").find(
      {
        "parent.type": "Server",
        "parent.id": { $in: serverIds },
      },
      {
        projection: {
          _id: 1,
          name: 1,
          animated: 1,
          nsfw: 1,
          parent: 1,
        },
      },
    ).limit(200).toArray();
    const result = new Map();
    for (const emoji of emojis) {
      const serverId = emoji.parent?.id;
      if (!serverId || emoji.nsfw) continue;
      const entries = result.get(serverId) ?? [];
      entries.push({
        id: emoji._id,
        name: emoji.name,
        animated: Boolean(emoji.animated),
      });
      result.set(serverId, entries);
    }
    return result;
  } catch (error) {
    appLogSafe("discover_emojis_unavailable", error);
    return new Map();
  }
}

function activityLevel(messagesPerDay) {
  if (messagesPerDay >= 100) return "very_active";
  if (messagesPerDay >= 20) return "active";
  if (messagesPerDay >= 1) return "quiet";
  return "dormant";
}

function minimumUlid(timestamp) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = Math.max(0, Math.floor(timestamp));
  let prefix = "";
  for (let index = 0; index < 10; index += 1) {
    prefix = alphabet[value % 32] + prefix;
    value = Math.floor(value / 32);
  }
  return `${prefix}${"0".repeat(16)}`;
}

function appLogSafe(event, error) {
  if (process.env.NODE_ENV !== "test") {
    console.warn(event, error instanceof Error ? error.message : error);
  }
}

function activeManagedInviteFilter(code) {
  const now = new Date();
  return {
    code,
    revoked: false,
    $and: [
      {
        $or: [
          { expires_at: null },
          { expires_at: { $gt: now } },
        ],
      },
      {
        $or: [
          { max_uses: null },
          { $expr: { $lt: ["$uses", "$max_uses"] } },
        ],
      },
    ],
  };
}
