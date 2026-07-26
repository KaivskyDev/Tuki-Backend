import assert from "node:assert/strict";
import test from "node:test";

import { hasServerAccess } from "../src/auth.js";

test("server access forwards the current session without exposing it", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  let received;
  globalThis.fetch = async (url, options) => {
    received = { url, options };
    return new Response("{}", { status: 200 });
  };

  const allowed = await hasServerAccess(
    { identityUrl: "http://api:14702" },
    { headers: { "x-session-token": "secret-session" } },
    "server/with unsafe chars",
  );

  assert.equal(allowed, true);
  assert.equal(
    received.url,
    "http://api:14702/servers/server%2Fwith%20unsafe%20chars",
  );
  assert.equal(received.options.headers["X-Session-Token"], "secret-session");
});

test("server access fails closed when the identity service is unavailable", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  assert.equal(
    await hasServerAccess(
      { identityUrl: "http://api:14702" },
      { headers: { "x-session-token": "secret-session" } },
      "server-id",
    ),
    false,
  );
});
