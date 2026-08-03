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
    db.collection("automod_rules").createIndex(
      { server_id: 1, id: 1 },
      {
        unique: true,
        partialFilterExpression: { id: { $type: "string" } },
      },
    ),
    db.collection("server_audit_events").createIndex(
      { server_id: 1, created_at: -1, id: -1 },
    ),
    db.collection("server_audit_events").createIndex(
      { server_id: 1, action: 1, created_at: -1 },
    ),
    db
      .collection("notification_preferences")
      .createIndex({ user_id: 1 }, { unique: true }),
    db
      .collection("privacy_preferences")
      .createIndex({ user_id: 1 }, { unique: true }),
    db.collection("communities").createIndex({ server_id: 1 }, { unique: true }),
    db.collection("communities").createIndex({ published: 1, member_count: -1 }),
    db.collection("communities").createIndex({ published: 1, created_at: -1 }),
    db.collection("community_presence").createIndex(
      { server_id: 1, user_id: 1 },
      { unique: true },
    ),
    db.collection("community_presence").createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection("managed_invites").createIndex({ code: 1 }, { unique: true }),
    db.collection("managed_invites").createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection("managed_invites").createIndex(
      { created_by: 1, created_at: -1 },
    ),
    db.collection("forum_threads").createIndex({ channel_id: 1, bumped_at: -1 }),
    db.collection("forum_threads").createIndex(
      { title: "text", body: "text", tags: "text" },
      { name: "forum_search" },
    ),
    db.collection("forum_posts").createIndex({ thread_id: 1, created_at: 1 }),
    db.collection("security_events").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("devices").createIndex({ user_id: 1, device_id: 1 }, { unique: true }),
    db.collection("account_deletions").createIndex(
      { user_id: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "pending" },
      },
    ),
    db.collection("account_deletions").createIndex({ status: 1, scheduled_for: 1 }),
    db.collection("account_deletions").createIndex(
      { completed_at: 1 },
      {
        expireAfterSeconds: 90 * 24 * 60 * 60,
        partialFilterExpression: { status: "completed" },
      },
    ),
    db.collection("developer_apps").createIndex({ owner_id: 1, created_at: -1 }),
    db.collection("developer_apps").createIndex({ client_id: 1 }, { unique: true }),
    db.collection("webhooks").createIndex({ owner_id: 1, created_at: -1 }),
    db.collection("inbox_items").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("inbox_items").createIndex({ user_id: 1, unread: 1 }),
    db.collection("inbox_items").createIndex(
      { dedupe_key: 1 },
      {
        unique: true,
        partialFilterExpression: { dedupe_key: { $type: "string" } },
      },
    ),
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
    db.collection("oauth_identities").createIndex(
      { user_id: 1, provider: 1 },
      { unique: true },
    ),
    db.collection("payment_orders").createIndex({ id: 1 }, { unique: true }),
    db.collection("payment_orders").createIndex({ user_id: 1, created_at: -1 }),
    db.collection("payment_orders").createIndex(
      { payment_id: 1 },
      {
        unique: true,
        partialFilterExpression: { payment_id: { $type: "string" } },
      },
    ),
    db.collection("memberships").createIndex({ user_id: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ expires_at: 1 }),
    db
      .collection("upload_usage")
      .createIndex({ user_id: 1, month: 1 }, { unique: true }),
    db.collection("upload_usage").createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
  ]);

  return { client, db, identityDb };
}
