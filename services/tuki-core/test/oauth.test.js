import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import { registerOAuthRoutes } from "../src/routes/oauth.js";

const returnTo = "https://chat.muzes.xyz/login/oauth";

function oauthConfig(overrides = {}) {
  return {
    publicUrl: "https://core.muzes.xyz",
    oauthReturnUrls: [returnTo],
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
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb: db });

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
  registerOAuthRoutes(app, { config: oauthConfig(), db, identityDb: db });
  const response = await app.inject({
    method: "GET",
    url: "/v1/oauth/google/start?return_to=https%3A%2F%2Fevil.example",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid_return_url" });
  await app.close();
});
