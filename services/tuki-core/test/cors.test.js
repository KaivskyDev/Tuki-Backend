import assert from "node:assert/strict";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify from "fastify";

import { createCorsOptions } from "../src/cors.js";

const allowedOrigins = [
  "https://chat.muzes.xyz",
  "http://localhost:8494",
  "http://127.0.0.1:8494",
];

async function buildApp() {
  const app = Fastify();
  await app.register(cors, createCorsOptions({ allowedOrigins }));
  app.get("/test", async () => ({ ok: true }));
  return app;
}

for (const origin of allowedOrigins) {
  test(`CORS preflight permits ${origin} with credentials`, async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-session-token",
      },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
    assert.match(
      response.headers["access-control-allow-headers"],
      /X-Session-Token/i,
    );
    await app.close();
  });
}

test("CORS rejects an origin outside the allowlist", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "OPTIONS",
    url: "/test",
    headers: {
      origin: "https://example.invalid",
      "access-control-request-method": "GET",
    },
  });

  assert.notEqual(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  await app.close();
});
