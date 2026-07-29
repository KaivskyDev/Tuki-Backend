import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

const PROVIDERS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    profile: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
  },
  discord: {
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    profile: "https://discord.com/api/v10/users/@me",
    scope: "identify email",
  },
};

const base64url = (value) => Buffer.from(value).toString("base64url");
const sha256 = (value) =>
  createHash("sha256").update(value).digest("base64url");
const stateHash = (value, secret) =>
  createHmac("sha256", secret).update(value).digest("base64url");

function ulid() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let result = "";
  for (let index = 0; index < 10; index++) {
    result = alphabet[time % 32] + result;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return result.slice(0, 26);
}

function safeUsername(profile) {
  const source = profile.name || profile.username || "Tuki User";
  const value = source
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_ .-]/gu, "")
    .trim()
    .slice(0, 32);
  return value.length >= 2 ? value : "Tuki User";
}

async function providerProfile(provider, code, verifier, config) {
  const definition = PROVIDERS[provider];
  const redirectUri = `${config.publicUrl}/v1/oauth/${provider}/callback`;
  const body = new URLSearchParams({
    client_id: config.oauth[provider].clientId,
    client_secret: config.oauth[provider].clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch(definition.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw new Error("oauth_token_exchange_failed");
  const token = await tokenResponse.json();
  const profileResponse = await fetch(definition.profile, {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) throw new Error("oauth_profile_failed");
  const profile = await profileResponse.json();
  if (!profile.email || profile.email_verified === false || profile.verified === false) {
    throw new Error("verified_email_required");
  }
  return {
    subject: String(profile.sub ?? profile.id),
    email: profile.email.toLowerCase().trim(),
    name: profile.name ?? profile.global_name ?? profile.username,
    username: profile.preferred_username ?? profile.username,
  };
}

async function createIdentitySession({ db, identityDb, provider, profile }) {
  const identities = db.collection("oauth_identities");
  let identity = await identities.findOne({
    provider,
    subject: profile.subject,
  });
  let userId = identity?.user_id;
  const accounts = identityDb.collection("accounts");
  const users = identityDb.collection("users");

  if (!userId) {
    const account = await accounts.findOne({ email_normalised: profile.email });
    userId = account?._id ?? ulid();
    if (!account) {
      await accounts.insertOne({
        _id: userId,
        email: profile.email,
        email_normalised: profile.email,
        // OAuth-only accounts get a unique, unguessable value. They never
        // share a sentinel password and cannot authenticate with it.
        password: base64url(randomBytes(48)),
        disabled: false,
        verification: { status: "Verified" },
        password_reset: null,
        deletion: null,
        lockout: null,
        mfa: {},
      });
    }
    if (!(await users.findOne({ _id: userId }))) {
      let discriminator;
      do {
        discriminator = String(randomInt(2, 9999)).padStart(4, "0");
      } while (
        await users.findOne({
          username: safeUsername(profile),
          discriminator,
        })
      );
      await users.insertOne({
        _id: userId,
        username: safeUsername(profile),
        discriminator,
        display_name: profile.name?.slice(0, 32) ?? null,
        last_acknowledged_policy_change: new Date().toISOString(),
      });
    }
    await identities.updateOne(
      { provider, subject: profile.subject },
      {
        $setOnInsert: {
          provider,
          subject: profile.subject,
          user_id: userId,
          email: profile.email,
          created_at: new Date(),
        },
        $set: { last_login_at: new Date() },
      },
      { upsert: true },
    );
  }

  const session = {
    _id: ulid(),
    user_id: userId,
    token: base64url(randomBytes(48)),
    name: `${provider[0].toUpperCase()}${provider.slice(1)} OAuth`,
    last_seen: new Date().toISOString(),
    origin: "tuki-oauth",
    subscription: null,
  };
  await identityDb.collection("sessions").insertOne(session);
  return session;
}

export function registerOAuthRoutes(app, { config, db, identityDb }) {
  app.get("/v1/oauth/:provider/start", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
    schema: {
      params: {
        type: "object",
        required: ["provider"],
        properties: { provider: { enum: ["google", "discord"] } },
      },
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["return_to"],
        properties: { return_to: { type: "string", maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const { provider } = request.params;
    const definition = PROVIDERS[provider];
    const credentials = config.oauth[provider];
    if (
      !definition ||
      !credentials?.clientId ||
      !credentials?.clientSecret ||
      config.oauth.stateSecret.length < 32
    ) {
      return reply.code(404).send({ error: "oauth_provider_unavailable" });
    }
    const returnTo = request.query.return_to;
    if (!config.oauthReturnUrls.includes(returnTo)) {
      return reply.code(400).send({ error: "invalid_return_url" });
    }
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    await db.collection("oauth_states").insertOne({
      state_hash: stateHash(state, config.oauth.stateSecret),
      provider,
      verifier,
      return_to: returnTo,
      expires_at: new Date(Date.now() + 10 * 60_000),
    });
    const url = new URL(definition.authorize);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: `${config.publicUrl}/v1/oauth/${provider}/callback`,
      response_type: "code",
      scope: definition.scope,
      state,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
      prompt: provider === "google" ? "select_account" : "consent",
    });
    return reply.redirect(url.toString());
  });

  app.get("/v1/oauth/:provider/callback", {
    config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    schema: {
      params: {
        type: "object",
        required: ["provider"],
        properties: { provider: { enum: ["google", "discord"] } },
      },
      querystring: {
        type: "object",
        additionalProperties: true,
        properties: {
          code: { type: "string", maxLength: 2048 },
          state: { type: "string", maxLength: 512 },
          error: { type: "string", maxLength: 256 },
        },
      },
    },
  }, async (request, reply) => {
    const { provider } = request.params;
    const state = await db.collection("oauth_states").findOneAndDelete({
      state_hash: stateHash(
        request.query.state ?? "",
        config.oauth.stateSecret,
      ),
      provider,
      expires_at: { $gt: new Date() },
    });
    const returnTo = state?.return_to ?? config.oauthReturnUrls[0];
    try {
      if (!state || !request.query.code || request.query.error) {
        throw new Error("oauth_callback_rejected");
      }
      const profile = await providerProfile(
        provider,
        request.query.code,
        state.verifier,
        config,
      );
      const session = await createIdentitySession({
        db,
        identityDb,
        provider,
        profile,
      });
      const code = base64url(randomBytes(32));
      await db.collection("oauth_exchanges").insertOne({
        code_hash: sha256(code),
        session,
        expires_at: new Date(Date.now() + 60_000),
      });
      return reply.redirect(`${returnTo}?code=${encodeURIComponent(code)}`);
    } catch (error) {
      request.log.warn({ err: error, provider }, "OAuth callback failed");
      return reply.redirect(`${returnTo}?error=oauth_failed`);
    }
  });

  app.post("/v1/oauth/exchange", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string", minLength: 32, maxLength: 512 } },
      },
    },
  }, async (request, reply) => {
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    const exchange = await db.collection("oauth_exchanges").findOneAndDelete({
      code_hash: sha256(code),
      expires_at: { $gt: new Date() },
    });
    if (!exchange) return reply.code(400).send({ error: "invalid_exchange_code" });
    return {
      _id: exchange.session._id,
      token: exchange.session.token,
      user_id: exchange.session.user_id,
    };
  });
}
