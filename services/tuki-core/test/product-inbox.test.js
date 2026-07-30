import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerProductRoutes } from "../src/routes/product.js";

test("opening a channel marks only the current user's matching inbox items as read", async () => {
  const calls = [];
  const db = {
    collection: (name) => {
      if (name !== "inbox_items") return {};
      return {
        updateMany: async (filter, update) => {
          calls.push({ filter, update });
          return { modifiedCount: 2 };
        },
      };
    },
  };
  const app = Fastify();
  const authenticate = async (request) => {
    request.tukiUser = { id: "current-user" };
  };

  await registerProductRoutes(app, {
    db,
    authenticate,
    adminOnly: async () => {},
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/inbox/channels/channel-1/read",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { updated: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filter, {
    user_id: "current-user",
    channel_id: "channel-1",
    unread: true,
  });
  assert.equal(calls[0].update.$set.unread, false);
  assert.ok(calls[0].update.$set.read_at instanceof Date);
  assert.ok(calls[0].update.$set.updated_at instanceof Date);

  await app.close();
});
