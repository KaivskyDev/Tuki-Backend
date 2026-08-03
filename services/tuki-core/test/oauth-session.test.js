import assert from "node:assert/strict";
import test from "node:test";

import { verifyGatewaySession, verifyIdentitySession } from "../src/oauth-session.js";

test("OAuth session is accepted only for the expected identity user", async () => {
  const result = await verifyIdentitySession({
    identityUrl: "http://identity.test",
    session: { token: "secret", user_id: "user-1" },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers["X-Session-Token"], "secret");
      return { ok: true, json: async () => ({ _id: "user-1" }) };
    },
  });
  assert.deepEqual(result, { userId: "user-1" });
});

test("OAuth session rejects a mismatched identity user", async () => {
  await assert.rejects(
    verifyIdentitySession({
      identityUrl: "http://identity.test",
      session: { token: "secret", user_id: "user-1" },
      fetchImpl: async () => ({ ok: true, json: async () => ({ _id: "user-2" }) }),
    }),
    /oauth_session_user_mismatch/,
  );
});

test("OAuth session reaches Gateway Ready without exposing its token", async () => {
  let connectedUrl;
  class FakeWebSocket extends EventTarget {
    readyState = 0;
    constructor(url) {
      super();
      connectedUrl = new URL(url);
      queueMicrotask(() => {
        this.readyState = 1;
        const event = new Event("message");
        Object.defineProperty(event, "data", { value: JSON.stringify({ type: "Ready" }) });
        this.dispatchEvent(event);
      });
    }
    close() { this.readyState = 3; }
  }
  assert.deepEqual(
    await verifyGatewaySession({ gatewayUrl: "ws://gateway.test", token: "secret", WebSocketImpl: FakeWebSocket }),
    { ready: true },
  );
  assert.equal(connectedUrl.searchParams.get("token"), "secret");
  assert.equal(connectedUrl.searchParams.get("version"), "1");
});
