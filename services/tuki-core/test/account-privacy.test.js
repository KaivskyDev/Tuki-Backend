import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerAccountRoutes } from "../src/routes/account.js";

function emptyCollection() {
  return {
    async findOne() {
      return null;
    },
    async insertOne() {},
    async updateOne() {},
  };
}

async function privacyApp(initial = null) {
  let saved = initial;
  const privacy = {
    async findOne() {
      return saved;
    },
    async updateOne(_filter, update) {
      saved = {
        ...saved,
        ...update.$setOnInsert,
        ...update.$set,
      };
      return { modifiedCount: 1 };
    },
  };
  const db = {
    collection(name) {
      return name === "privacy_preferences" ? privacy : emptyCollection();
    },
  };
  const app = Fastify();
  const authenticate = async (request) => {
    request.tukiUser = { id: "user-1", bot: false };
  };
  await registerAccountRoutes(app, {
    db,
    identityDb: db,
    authenticate,
  });
  return app;
}

test("privacy defaults cover friend, message and invite requests", async () => {
  const app = await privacyApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/account/privacy",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().friend_requests, "mutuals");
  assert.equal(response.json().message_requests, "mutuals");
  assert.equal(response.json().server_invites, "friends");
  assert.equal(response.json().group_invites, "friends");
  assert.equal(response.json().spam_message_requests, false);
  await app.close();
});

test("privacy PATCH updates one preference without dropping the others", async () => {
  const app = await privacyApp({
    user_id: "user-1",
    friend_requests: "everyone",
    message_requests: "mutuals",
  });
  const response = await app.inject({
    method: "PATCH",
    url: "/v1/account/privacy",
    payload: { message_requests: "nobody", spam_message_requests: true },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().friend_requests, "everyone");
  assert.equal(response.json().message_requests, "nobody");
  assert.equal(response.json().spam_message_requests, true);
  assert.equal(response.json().server_invites, "friends");
  await app.close();
});

test("privacy PATCH rejects unknown and invalid values", async () => {
  const app = await privacyApp();
  const response = await app.inject({
    method: "PATCH",
    url: "/v1/account/privacy",
    payload: {
      message_requests: "followers",
      expose_session_token: true,
    },
  });

  assert.equal(response.statusCode, 400);
  await app.close();
});
