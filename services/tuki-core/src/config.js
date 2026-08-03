function list(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = Object.freeze({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 14800),
  mongoUrl: process.env.TUKI_MONGO_URL ?? "mongodb://database:27017",
  databaseName: process.env.TUKI_DATABASE_NAME ?? "tuki",
  identityDatabaseName: process.env.TUKI_IDENTITY_DATABASE_NAME ?? "revolt",
  identityUrl: process.env.TUKI_IDENTITY_URL ?? "http://api:14702",
  gatewayUrl: process.env.TUKI_GATEWAY_URL ?? "ws://events:14703",
  publicUrl: process.env.TUKI_PUBLIC_URL ?? "https://core.muzes.xyz",
  oauthReturnUrls: list(
    process.env.TUKI_OAUTH_RETURN_URLS ??
      "https://chat.muzes.xyz/login/oauth",
  ),
  oauthSettingsReturnUrl:
    process.env.TUKI_OAUTH_SETTINGS_RETURN_URL ??
    "https://chat.muzes.xyz/settings?section=connections",
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
  uploads: {
    emojiBytes: positiveInteger(
      process.env.TUKI_EMOJI_UPLOAD_LIMIT_BYTES,
      4_000_000,
    ),
    attachmentBytes: positiveInteger(
      process.env.TUKI_ATTACHMENT_UPLOAD_LIMIT_BYTES,
      10_000_000,
    ),
    orbitMaxAttachmentBytes: positiveInteger(
      process.env.TUKI_ORBIT_MAX_ATTACHMENT_LIMIT_BYTES,
      500_000_000,
    ),
    orbitMaxMonthlyBytes: positiveInteger(
      process.env.TUKI_ORBIT_MAX_MONTHLY_UPLOAD_BYTES,
      50_000_000_000,
    ),
  },
  hotpay: {
    paymentUrl:
      process.env.TUKI_HOTPAY_PAYMENT_URL ?? "https://platnosc.hotpay.pl/",
    serviceSecret: process.env.TUKI_HOTPAY_SERVICE_SECRET ?? "",
    notificationPassword:
      process.env.TUKI_HOTPAY_NOTIFICATION_PASSWORD ?? "",
    returnUrl:
      process.env.TUKI_HOTPAY_RETURN_URL ??
      "https://chat.muzes.xyz/orbit?payment=return",
    notificationAllowedIps: new Set(
      list(
        process.env.TUKI_HOTPAY_NOTIFICATION_IPS ??
          "18.197.55.26,3.126.108.86,3.64.128.101,18.184.99.42,3.72.152.155,35.159.7.168",
      ),
    ),
    enforceNotificationIpAllowlist:
      process.env.TUKI_HOTPAY_ENFORCE_IP_ALLOWLIST !== "false",
    orbitPricePln: process.env.TUKI_HOTPAY_ORBIT_PRICE_PLN ?? "22.99",
    orbitMaxPricePln:
      process.env.TUKI_HOTPAY_ORBIT_MAX_PRICE_PLN ?? "75.99",
    orbitMaxEnabled: process.env.TUKI_HOTPAY_ORBIT_MAX_ENABLED === "true",
    planDurationDays: Number(
      process.env.TUKI_HOTPAY_ORBIT_DURATION_DAYS ?? 30,
    ),
  },
  allowedOrigins: list(
    process.env.TUKI_ALLOWED_ORIGINS ?? "https://chat.muzes.xyz",
  ),
  adminUserIds: new Set(list(process.env.TUKI_ADMIN_USER_IDS)),
  trustProxy: process.env.TUKI_TRUST_PROXY === "true",
});
