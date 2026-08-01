import test from "node:test";
import assert from "node:assert/strict";

import { isTrustedGifUrl } from "../src/routes/gifs.js";
import { statusForResponse } from "../src/routes/status.js";
import { monthWindow, uploadTag } from "../src/routes/uploads.js";

test("GIF proxy accepts provider media and rejects SSRF targets", () => {
  assert.equal(isTrustedGifUrl("https://media.giphy.com/media/example/giphy.gif"), true);
  assert.equal(isTrustedGifUrl("https://media.tenor.com/example.gif"), true);
  assert.equal(isTrustedGifUrl("http://media.giphy.com/example.gif"), false);
  assert.equal(isTrustedGifUrl("https://giphy.com.attacker.example/file"), false);
  assert.equal(isTrustedGifUrl("http://127.0.0.1:9000/private"), false);
});

test("status monitor treats redirects and client responses as reachable", () => {
  assert.equal(statusForResponse(200), "operational");
  assert.equal(statusForResponse(308), "operational");
  assert.equal(statusForResponse(404), "operational");
  assert.equal(statusForResponse(502), "outage");
});

test("upload authorisation accepts only known Autumn upload collections", () => {
  assert.equal(uploadTag("/attachments"), "attachments");
  assert.equal(uploadTag("https://cdn.muzes.xyz/emojis?x=1"), "emojis");
  assert.equal(uploadTag("/attachments/private/file"), null);
  assert.equal(uploadTag("/admin"), null);
});

test("monthly upload window expires after the following full month", () => {
  const window = monthWindow(new Date("2026-08-20T10:00:00Z"));
  assert.equal(window.month, "2026-08");
  assert.equal(window.expiresAt.toISOString(), "2026-10-01T00:00:00.000Z");
});
