import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import { registerOAuthRoutes } from "../src/routes/oauth.js";

const returnTo = "https://chat.muzes.xyz/login/oauth";
const authenticate = async (request) => {
  request.tukiUser = { id: "user-1", bot: false };
};

function oauthConfig(overrides = {}) {
  return {
    publicUrl: "https://core.muzes.xyz",
    identityUrl: "http://identity.test",
    oauthReturnUrls: [returnTo],
    oauthSettingsReturnUrl: "https://chat.muzes.xyz/settings?section=connections",
    oauth: {
      stateSecret: "a-secure-state-secret-with-more-than-32-characters",
      google: { clientId: "google-client", clientSecret: "google-secret" },
      discord: { clientId: "discord-client", clientSecret: "discord-secret" },
      ...overrides,
    },
  };
}

test("OAuth start stores only an HMAC of state and uses PKCE", async () => {
  let stored;
  const db = {
    collection() {
      return {
        async insertOne(value) {
          stored = value;
        },
      };
    },
  };
  const app = Fastify();
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb: db, authenticate });

  const response = await app.inject({
    method: "GET",
    url: `/v1/oauth/google/start?return_to=${encodeURIComponent(returnTo)}`,
  });
  const redirect = new URL(response.headers.location);
  const state = redirect.searchParams.get("state");

  assert.equal(response.statusCode, 302);
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.ok(redirect.searchParams.get("code_challenge"));
  assert.notEqual(stored.state_hash, state);
  assert.equal(
    stored.state_hash,
    createHmac(
      "sha256",
      "a-secure-state-secret-with-more-than-32-characters",
    )
      .update(state)
      .digest("base64url"),
  );
  assert.equal("state" in stored, false);
  await app.close();
});

test("OAuth remains disabled when the state-signing secret is unsafe", async () => {
  const db = { collection() { return {}; } };
  const app = Fastify();
  registerOAuthRoutes(app, {
    config: oauthConfig({ stateSecret: "short" }),
    db,
    identityDb: db,
    authenticate,
  });
  const response = await app.inject({
    method: "GET",
    url: `/v1/oauth/discord/start?return_to=${encodeURIComponent(returnTo)}`,
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "oauth_provider_unavailable" });
  await app.close();
});

test("OAuth rejects redirect targets outside the allowlist", async () => {
  const db = { collection() { return {}; } };
  const app = Fastify();
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb: db, authenticate });
  const response = await app.inject({
    method: "GET",
    url: "/v1/oauth/google/start?return_to=https%3A%2F%2Fevil.example",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid_return_url" });
  await app.close();
});

test("authenticated users can start a provider-link flow bound to their user", async () => {
  let stored;
  const db = {
    collection() {
      return {
        async insertOne(value) { stored = value; },
      };
    },
  };
  const app = Fastify();
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb: db, authenticate });
  const response = await app.inject({
    method: "POST",
    url: "/v1/account/oauth/google/start",
    headers: { "x-session-token": "session" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(new URL(response.json().url).hostname, "accounts.google.com");
  assert.equal(stored.mode, "link");
  assert.equal(stored.user_id, "user-1");
  assert.equal(stored.return_to, "https://chat.muzes.xyz/settings?section=connections");
  await app.close();
});

test("connected providers can be listed and safely disconnected", async () => {
  let removed;
  const linked = [{
    provider: "google",
    email: "user@example.com",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_login_at: new Date("2026-01-02T00:00:00Z"),
  }];
  const cursor = {
    sort() { return this; },
    project() { return this; },
    async toArray() { return linked; },
  };
  const db = {
    collection(name) {
      if (name === "oauth_identities") return {
        find() { return cursor; },
        async deleteOne(query) { removed = query; return { deletedCount: 1 }; },
      };
      if (name === "security_events") return { async insertOne() {} };
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const identityDb = {
    collection(name) {
      assert.equal(name, "accounts");
      return { async findOne() { return { password: "$argon2id$v=19$hash", oauth_only: false }; } };
    },
  };
  const app = Fastify();
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb, authenticate });

  const list = await app.inject({ method: "GET", url: "/v1/account/oauth" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().items[0], {
    provider: "google",
    email: "user@example.com",
    created_at: "2026-01-01T00:00:00.000Z",
    last_login_at: "2026-01-02T00:00:00.000Z",
  });
  const remove = await app.inject({ method: "DELETE", url: "/v1/account/oauth/google" });
  assert.equal(remove.statusCode, 204);
  assert.deepEqual(removed, { user_id: "user-1", provider: "google" });
  await app.close();
});
