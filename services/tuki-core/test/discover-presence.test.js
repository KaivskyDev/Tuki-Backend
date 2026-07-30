import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerSocialRoutes } from "../src/routes/social.js";

test("discover presence is verified and exposed as a live counter", async () => {
  const presence = [];
  const communities = [
    {
      server_id: "community",
      name: "Tuki",
      published: true,
      member_count: 1,
    },
  ];
  const collection = (name) => {
    if (name === "communities") {
      return {
        find: () => ({
          sort: () => ({
            limit: () => ({ toArray: async () => communities }),
          }),
        }),
      };
    }
    if (name === "community_presence") {
      return {
        bulkWrite: async (operations) => {
          for (const operation of operations) {
            presence.push({
              ...operation.updateOne.update.$setOnInsert,
              ...operation.updateOne.update.$set,
            });
          }
        },
        aggregate: () => ({
          toArray: async () => [
            { _id: "community", count: presence.length },
          ],
        }),
      };
    }
    return {};
  };
  const db = { collection };
  const identityDb = {
    collection: (name) => ({
      aggregate: () => ({
        toArray: async () => [{ _id: "community", count: 12 }],
      }),
      find: (filter) => ({
        toArray: async () =>
          name === "members"
            ? filter.server.$in.includes("community")
              ? [{ server: "community" }]
              : []
            : [],
      }),
    }),
  };
  const app = Fastify();
  const authenticate = async (request) => {
    request.tukiUser = { id: "user" };
  };
  await registerSocialRoutes(app, {
    db,
    identityDb,
    authenticate,
    adminOnly: async () => {},
    hasServerAccess: async () => true,
    isServerOwner: async () => true,
  });

  const heartbeat = await app.inject({
    method: "POST",
    url: "/v1/discover/presence",
    payload: { server_ids: ["community", "blocked"] },
  });
  assert.equal(heartbeat.statusCode, 200);
  assert.deepEqual(heartbeat.json().accepted, ["community"]);

  const discover = await app.inject({
    method: "GET",
    url: "/v1/discover/communities",
  });
  assert.equal(discover.statusCode, 200);
  assert.equal(discover.json().items[0].online_count, 1);
  assert.equal(discover.json().items[0].member_count, 12);

  await app.close();
});
