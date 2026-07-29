import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerAccountRoutes } from "../src/routes/account.js";

function database(collections = {}) {
  return {
    collection(name) {
      return collections[name] ?? {
        async insertOne() {},
      };
    },
  };
}

function sessionCursor(items) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    async toArray() {
      return items;
    },
  };
}

async function appWithSessions(sessions, core = database()) {
  const app = Fastify();
  const identityDb = database({ sessions });
  const authenticate = async (request) => {
    request.tukiUser = { id: "user-1", username: "test", bot: false };
  };
  await registerAccountRoutes(app, { db: core, identityDb, authenticate });
  return app;
}

test("session listing never exposes tokens and identifies the active session", async () => {
  const sessions = {
    async findOne(filter) {
      return filter.token === "current-token" ? { _id: "current" } : null;
    },
    find() {
      return sessionCursor([
        {
          _id: "current",
          token: "must-not-leak",
          name: "Chrome",
          last_seen: "2026-07-28T10:00:00.000Z",
        },
        { _id: "other", token: "also-secret", name: "Phone" },
      ]);
    },
  };
  const app = await appWithSessions(sessions);
  const response = await app.inject({
    method: "GET",
    url: "/v1/account/sessions",
    headers: { "x-session-token": "current-token" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].current, true);
  assert.equal(response.json().items[1].current, false);
  assert.equal(response.body.includes("must-not-leak"), false);
  await app.close();
});

test("a user cannot revoke another user's session", async () => {
  const sessions = {
    async deleteOne(filter) {
      assert.deepEqual(filter, { _id: "foreign", user_id: "user-1" });
      return { deletedCount: 0 };
    },
  };
  const app = await appWithSessions(sessions);
  const response = await app.inject({
    method: "DELETE",
    url: "/v1/account/sessions/foreign",
    headers: { "x-session-token": "current-token" },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "session_not_found" });
  await app.close();
});

test("revoke-others preserves the current session", async () => {
  let deletionFilter;
  const sessions = {
    async findOne() {
      return { _id: "current" };
    },
    async deleteMany(filter) {
      deletionFilter = filter;
      return { deletedCount: 2 };
    },
  };
  const securityEvents = {
    async insertOne() {},
  };
  const app = await appWithSessions(
    sessions,
    database({ security_events: securityEvents }),
  );
  const response = await app.inject({
    method: "POST",
    url: "/v1/account/sessions/revoke-others",
    headers: { "x-session-token": "current-token" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { revoked: 2 });
  assert.deepEqual(deletionFilter, {
    user_id: "user-1",
    _id: { $ne: "current" },
  });
  await app.close();
});
