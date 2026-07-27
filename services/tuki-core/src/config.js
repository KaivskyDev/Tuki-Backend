function list(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 14800),
  mongoUrl: process.env.TUKI_MONGO_URL ?? "mongodb://database:27017",
  databaseName: process.env.TUKI_DATABASE_NAME ?? "tuki",
  identityDatabaseName: process.env.TUKI_IDENTITY_DATABASE_NAME ?? "revolt",
  identityUrl: process.env.TUKI_IDENTITY_URL ?? "http://api:14702",
  publicUrl: process.env.TUKI_PUBLIC_URL ?? "https://core.muzes.xyz",
  oauthReturnUrls: list(
    process.env.TUKI_OAUTH_RETURN_URLS ??
      "https://chat.muzes.xyz/login/oauth",
  ),
  oauth: {
    stateSecret: process.env.TUKI_OAUTH_STATE_SECRET ?? "",
    google: {
      clientId: process.env.TUKI_OAUTH_GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.TUKI_OAUTH_GOOGLE_CLIENT_SECRET ?? "",
    },
    discord: {
      clientId: process.env.TUKI_OAUTH_DISCORD_CLIENT_ID ?? "",
      clientSecret: process.env.TUKI_OAUTH_DISCORD_CLIENT_SECRET ?? "",
    },
  },
  giphyApiKey: process.env.TUKI_GIPHY_API_KEY ?? "",
  allowedOrigins: list(
    process.env.TUKI_ALLOWED_ORIGINS ?? "https://chat.muzes.xyz",
  ),
  adminUserIds: new Set(list(process.env.TUKI_ADMIN_USER_IDS)),
  trustProxy: process.env.TUKI_TRUST_PROXY === "true",
});
