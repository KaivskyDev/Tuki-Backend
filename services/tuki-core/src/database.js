import { MongoClient } from "mongodb";

export async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUrl, {
    appName: "tuki-core",
    maxPoolSize: 30,
    minPoolSize: 2,
  });

  await client.connect();
  const db = client.db(config.databaseName);
  const identityDb = client.db(config.identityDatabaseName);

  await Promise.all([
    db.collection("profiles").createIndex({ user_id: 1 }, { unique: true }),
    db
      .collection("bookmarks")
      .createIndex({ user_id: 1, message_id: 1 }, { unique: true }),
    db.collection("bookmarks").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("polls").createIndex({ channel_id: 1, created_at: -1 }),
    db.collection("events").createIndex({ server_id: 1, starts_at: 1 }),
    db.collection("events").createIndex({ attendees: 1, starts_at: 1 }),
    db.collection("reports").createIndex({ status: 1, created_at: -1 }),
    db.collection("automod_rules").createIndex({ server_id: 1, enabled: 1 }),
    db
      .collection("notification_preferences")
      .createIndex({ user_id: 1 }, { unique: true }),
    db.collection("communities").createIndex({ server_id: 1 }, { unique: true }),
    db.collection("communities").createIndex({ published: 1, member_count: -1 }),
    db.collection("forum_threads").createIndex({ channel_id: 1, bumped_at: -1 }),
    db.collection("forum_threads").createIndex(
      { title: "text", body: "text", tags: "text" },
      { name: "forum_search" },
    ),
    db.collection("forum_posts").createIndex({ thread_id: 1, created_at: 1 }),
    db.collection("security_events").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("devices").createIndex({ user_id: 1, device_id: 1 }, { unique: true }),
    db.collection("developer_apps").createIndex({ owner_id: 1, created_at: -1 }),
    db.collection("developer_apps").createIndex({ client_id: 1 }, { unique: true }),
    db.collection("webhooks").createIndex({ owner_id: 1, created_at: -1 }),
    db.collection("inbox_items").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("inbox_items").createIndex({ user_id: 1, unread: 1 }),
    db.collection("oauth_states").createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection("oauth_exchanges").createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection("oauth_identities").createIndex(
      { provider: 1, subject: 1 },
      { unique: true },
    ),
  ]);

  return { client, db, identityDb };
}
