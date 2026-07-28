import assert from "node:assert/strict";
import test from "node:test";

import { purgeExpiredAccounts } from "../src/routes/account.js";

test("expired account deletion is claimed once and removes linked data", async () => {
  const deletion = {
    _id: "mongo-id",
    id: "deletion-id",
    user_id: "user-1",
    status: "pending",
    scheduled_for: new Date(0),
  };
  const calls = [];
  let completedUpdate;

  const deletionCollection = {
    async findOneAndUpdate(filter, update) {
      calls.push(["claim", filter, update]);
      if (deletion.status !== "pending") return null;
      deletion.status = "purging";
      return { ...deletion };
    },
    async updateOne(filter, update) {
      completedUpdate = { filter, update };
      deletion.status = update.$set?.status ?? deletion.status;
      return { modifiedCount: 1 };
    },
  };
  const database = (identity = false) => ({
    collection(name) {
      if (!identity && name === "account_deletions") return deletionCollection;
      return {
        async updateMany(filter, update) {
          calls.push([identity ? "identity-update" : "core-update", name, filter, update]);
          return { modifiedCount: 1 };
        },
        async deleteMany(filter) {
          calls.push([identity ? "identity-delete" : "core-delete", name, filter]);
          return { deletedCount: 1 };
        },
      };
    },
  });

  await purgeExpiredAccounts({
    db: database(),
    identityDb: database(true),
    logger: { info() {}, error() {} },
  });

  assert.equal(deletion.status, "completed");
  assert.equal(completedUpdate.update.$set.user_id, null);
  assert.equal(completedUpdate.update.$set.request_ip, null);
  assert.ok(
    calls.some(
      ([type, name, filter]) =>
        type === "identity-delete" &&
        name === "messages" &&
        filter.author === "user-1",
    ),
  );
  assert.ok(
    calls.some(
      ([type, name, filter]) =>
        type === "core-delete" &&
        name === "profiles" &&
        filter.user_id === "user-1",
    ),
  );
});
