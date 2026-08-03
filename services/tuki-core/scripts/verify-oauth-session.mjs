import { verifyGatewaySession, verifyIdentitySession } from "../src/oauth-session.js";

const token = process.env.TUKI_SMOKE_SESSION_TOKEN;
const expectedUserId = process.env.TUKI_SMOKE_USER_ID;
const identityUrl = process.env.TUKI_IDENTITY_URL ?? "http://api:14702";
const gatewayUrl = process.env.TUKI_GATEWAY_URL ?? "ws://events:14703";

if (!token || !expectedUserId) {
  throw new Error("Set TUKI_SMOKE_SESSION_TOKEN and TUKI_SMOKE_USER_ID for a disposable test session.");
}

const identity = await verifyIdentitySession({
  identityUrl,
  session: { token, user_id: expectedUserId },
});
await verifyGatewaySession({ gatewayUrl, token });
console.log(JSON.stringify({ identity: "ok", gateway: "ok", user_id: identity.userId }));
