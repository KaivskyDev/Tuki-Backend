import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerSocialRoutes } from "../src/routes/social.js";

test("managed invite expiry and usage limits are enforced atomically", async () => {
  let stored;
  const managedInvites = {
    insertOne: async (value) => {
      stored = { ...value };
    },
    findOne: async (filter) =>
      matchesActiveInvite(stored, filter.code) ? stored : null,
    findOneAndUpdate: async (filter, update) => {
      if (!matchesActiveInvite(stored, filter.code)) return null;
      const previous = { ...stored };
      stored.uses += update.$inc.uses;
      stored.last_used_at = update.$set.last_used_at;
      return previous;
    },
  };
  const db = {
    collection: (name) =>
      name === "managed_invites" ? managedInvites : {},
  };
  const app = Fastify();
  await registerSocialRoutes(app, {
    db,
    identityDb: { collection: () => ({}) },
    authenticate: async (request) => {
      request.tukiUser = { id: "user" };
    },
    adminOnly: async () => {},
    hasServerAccess: async () => true,
    isServerOwner: async () => true,
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/invites",
    payload: {
      server_id: "server",
      channel_id: "channel",
      invite_code: "native",
      expires_in_seconds: 3600,
      max_uses: 1,
    },
  });
  assert.equal(created.statusCode, 201);
  const code = created.json().code;

  const resolved = await app.inject({
    method: "GET",
    url: `/v1/invites/${code}`,
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().invite_code, "native");

  const firstUse = await app.inject({
    method: "POST",
    url: `/v1/invites/${code}/use`,
  });
  assert.equal(firstUse.statusCode, 200);
  assert.equal(firstUse.json().invite_code, "native");

  const secondUse = await app.inject({
    method: "POST",
    url: `/v1/invites/${code}/use`,
  });
  assert.equal(secondUse.statusCode, 410);

  await app.close();
});

function matchesActiveInvite(invite, code) {
  if (!invite || invite.code !== code || invite.revoked) return false;
  if (invite.expires_at && invite.expires_at <= new Date()) return false;
  return invite.max_uses === null || invite.uses < invite.max_uses;
}
