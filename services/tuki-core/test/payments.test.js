import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCheckoutHash,
  createMembershipExpiryReminders,
  createNotificationHash,
  membershipBadge,
  normaliseAmount,
} from "../src/routes/payments.js";

test("HotPay checkout hash follows the documented field order", () => {
  const fields = {
    notificationPassword: "notification-password",
    amount: "59.00",
    serviceName: "Tuki Orbit - 30 days",
    returnUrl: "https://chat.muzes.xyz/orbit?payment=return",
    orderId: "tuki_order",
    serviceSecret: "service-secret",
  };
  const expected = createHash("sha256")
    .update(Object.values(fields).join(";"))
    .digest("hex");
  assert.equal(createCheckoutHash(fields), expected);
});

test("membership badge evolves at the configured milestones", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  assert.equal(membershipBadge(new Date("2026-08-01T00:00:00Z"), now).id, "seed");
  assert.equal(membershipBadge(new Date("2026-05-01T00:00:00Z"), now).id, "orbit");
  assert.equal(membershipBadge(new Date("2025-08-01T00:00:00Z"), now).id, "supernova");
  assert.equal(membershipBadge(new Date("2023-08-01T00:00:00Z"), now).id, "galaxy");
});

test("HotPay notification hash includes SECURE", () => {
  const fields = {
    notificationPassword: "notification-password",
    amount: "59.00",
    paymentId: "payment-id",
    orderId: "tuki_order",
    status: "SUCCESS",
    secure: "secure-transaction",
    serviceSecret: "service-secret",
  };
  const expected = createHash("sha256")
    .update(Object.values(fields).join(";"))
    .digest("hex");
  assert.equal(createNotificationHash(fields), expected);
});

test("payment amounts are canonical and reject malformed input", () => {
  assert.equal(normaliseAmount("59"), "59.00");
  assert.equal(normaliseAmount("59,9"), "59.90");
  assert.equal(normaliseAmount("59.999"), null);
  assert.equal(normaliseAmount("-1"), null);
});

test("membership expiry reminders are deduplicated per expiry and threshold", async () => {
  let operations;
  const expiresAt = new Date("2026-08-04T00:00:00Z");
  const db = {
    collection(name) {
      if (name === "memberships") {
        return {
          find: () => ({
            project: () => ({
              toArray: async () => [
                { user_id: "user", plan: "orbit_30d", expires_at: expiresAt },
              ],
            }),
          }),
        };
      }
      return {
        bulkWrite: async (value) => {
          operations = value;
          return { upsertedCount: 1 };
        },
      };
    },
  };
  const count = await createMembershipExpiryReminders({
    db,
    now: new Date("2026-08-01T00:00:00Z"),
  });
  assert.equal(count, 1);
  const item = operations[0].updateOne.update.$setOnInsert;
  assert.equal(item.metadata.days, 3);
  assert.match(item.dedupe_key, /membership-expiry:user:.*:3$/);
});
