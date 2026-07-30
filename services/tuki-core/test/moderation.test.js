import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerModerationRoutes } from "../src/routes/moderation.js";

function cursor(items) {
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

async function moderationApp({ owner = true } = {}) {
  const rules = [];
  const audit = [];
  const collections = {
    automod_rules: {
      find(filter) {
        return cursor(rules.filter((rule) => rule.server_id === filter.server_id));
      },
      async findOne(filter) {
        return rules.find(
          (rule) =>
            rule.server_id === filter.server_id && rule.id === filter.id,
        ) ?? null;
      },
      async insertOne(rule) {
        rules.push(rule);
      },
      async updateOne(filter, update) {
        const rule = rules.find(
          (item) => item.server_id === filter.server_id && item.id === filter.id,
        );
        Object.assign(rule, update.$set);
      },
      async deleteOne(filter) {
        const index = rules.findIndex(
          (item) => item.server_id === filter.server_id && item.id === filter.id,
        );
        if (index < 0) return { deletedCount: 0 };
        rules.splice(index, 1);
        return { deletedCount: 1 };
      },
    },
    server_audit_events: {
      find(filter) {
        return cursor(audit.filter((event) => event.server_id === filter.server_id));
      },
      async insertOne(event) {
        audit.push(event);
      },
    },
  };
  const db = {
    collection(name) {
      return collections[name];
    },
  };
  const app = Fastify();
  const authenticate = async (request) => {
    request.tukiUser = { id: "owner-1", bot: false };
  };
  await registerModerationRoutes(app, {
    db,
    authenticate,
    isServerOwner: async () => owner,
  });
  return { app, rules, audit };
}

test("community owners can create an AutoMod rule and receive an audit event", async () => {
  const { app, rules, audit } = await moderationApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/servers/server-1/automod/rules",
    payload: {
      name: "Blocked words",
      type: "keyword",
      action: "block",
      values: [" spam ", "spam", "scam"],
    },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().values, ["spam", "scam"]);
  assert.equal(rules.length, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "automod.rule.created");
  await app.close();
});

test("keyword and timeout rules have explicit conditional validation", async () => {
  const { app } = await moderationApp();
  const missingKeywords = await app.inject({
    method: "POST",
    url: "/v1/servers/server-1/automod/rules",
    payload: { name: "Empty", type: "keyword", action: "block" },
  });
  assert.equal(missingKeywords.statusCode, 422);
  assert.equal(missingKeywords.json().field, "values");

  const missingDuration = await app.inject({
    method: "POST",
    url: "/v1/servers/server-1/automod/rules",
    payload: {
      name: "Mentions",
      type: "mention_spam",
      action: "timeout",
    },
  });
  assert.equal(missingDuration.statusCode, 422);
  assert.equal(missingDuration.json().field, "timeout_seconds");
  await app.close();
});

test("non-owners cannot inspect community AutoMod configuration", async () => {
  const { app } = await moderationApp({ owner: false });
  const response = await app.inject({
    method: "GET",
    url: "/v1/servers/server-1/automod/rules",
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "server_owner_required");
  await app.close();
});
