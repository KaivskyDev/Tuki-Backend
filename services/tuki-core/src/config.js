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
  identityUrl: process.env.TUKI_IDENTITY_URL ?? "http://api:14702",
  allowedOrigins: list(
    process.env.TUKI_ALLOWED_ORIGINS ?? "https://chat.muzes.xyz",
  ),
  adminUserIds: new Set(list(process.env.TUKI_ADMIN_USER_IDS)),
  trustProxy: process.env.TUKI_TRUST_PROXY === "true",
});
