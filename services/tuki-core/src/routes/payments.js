import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const HOTPAY_STATUSES = new Set(["SUCCESS", "PENDING", "FAILURE"]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normaliseAmount(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,7})(?:[.,](\d{1,2}))?$/);
  if (!match) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

export function createCheckoutHash({
  notificationPassword,
  amount,
  serviceName,
  returnUrl,
  orderId,
  serviceSecret,
}) {
  return sha256(
    [
      notificationPassword,
      amount,
      serviceName,
      returnUrl,
      orderId,
      serviceSecret,
    ].join(";"),
  );
}

export function createNotificationHash({
  notificationPassword,
  amount,
  paymentId,
  orderId,
  status,
  secure,
  serviceSecret,
}) {
  return sha256(
    [
      notificationPassword,
      amount,
      paymentId,
      orderId,
      status,
      secure,
      serviceSecret,
    ].join(";"),
  );
}

export function parseHotPayInitialisation(value) {
  if (typeof value === "string" && /^https:\/\//i.test(value.trim())) {
    try {
      const redirectUrl = new URL(value.trim());
      const hostname = redirectUrl.hostname.toLowerCase();
      return hostname === "hotpay.pl" || hostname.endsWith(".hotpay.pl")
        ? redirectUrl.toString()
        : null;
    } catch {
      return null;
    }
  }
  let payload;
  try {
    payload = typeof value === "string"
      ? JSON.parse(value.replace(/^\uFEFF/, "").trim())
      : value;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const status = String(payload.STATUS ?? "").trim().toLowerCase();
  if (!(["true", "1"].includes(status) || payload.STATUS === true)) return null;

  try {
    const redirectUrl = new URL(String(payload.URL ?? ""));
    const hostname = redirectUrl.hostname.toLowerCase();
    if (
      redirectUrl.protocol !== "https:" ||
      !(hostname === "hotpay.pl" || hostname.endsWith(".hotpay.pl"))
    ) {
      return null;
    }
    return redirectUrl.toString();
  } catch {
    return null;
  }
}

function paymentConfigured(config) {
  return Boolean(
    config.hotpay.serviceSecret && config.hotpay.notificationPassword,
  );
}

function configuredPlans(config) {
  return [
    {
      id: "orbit_30d",
      name: "Tuki Orbit",
      amount: normaliseAmount(config.hotpay.orbitPricePln),
      duration_days: config.hotpay.planDurationDays,
      level: 1,
      available: true,
      entitlements: {
        animated_avatar: true,
        animated_profile_banner: true,
        evolving_badge: true,
        profile_accents: true,
      },
    },
    {
      id: "orbit_max_30d",
      name: "Tuki Orbit Max",
      amount: normaliseAmount(config.hotpay.orbitMaxPricePln),
      duration_days: config.hotpay.planDurationDays,
      level: 2,
      available: config.hotpay.orbitMaxEnabled,
      entitlements: {
        animated_avatar: true,
        animated_profile_banner: true,
        evolving_badge: true,
        profile_accents: true,
        max_attachment_bytes: 500_000_000,
        cross_community_emoji: true,
        cross_community_stickers: true,
        experimental_stream_quality: true,
      },
    },
  ];
}

function effectiveLimits(config, membership) {
  const entitledAttachmentBytes = Number(
    membership.entitlements?.max_attachment_bytes,
  );
  return {
    attachment_bytes:
      membership.active &&
      Number.isSafeInteger(entitledAttachmentBytes) &&
      entitledAttachmentBytes > 0
        ? Math.min(
            entitledAttachmentBytes,
            config.uploads.orbitMaxAttachmentBytes,
          )
        : config.uploads.attachmentBytes,
    emoji_bytes: config.uploads.emojiBytes,
    monthly_upload_bytes:
      membership.active && membership.plan === "orbit_max_30d"
        ? config.uploads.orbitMaxMonthlyBytes
        : null,
  };
}

export function membershipBadge(startedAt, now = new Date()) {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  let months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    start.getUTCMonth();
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  if (months >= 36) return { id: "galaxy", months: 36 };
  if (months >= 12) return { id: "supernova", months: 12 };
  if (months >= 3) return { id: "orbit", months: 3 };
  if (months >= 1) return { id: "spark", months: 1 };
  return { id: "seed", months: 0 };
}

export async function createMembershipExpiryReminders({ db, now = new Date() }) {
  const memberships = db.collection("memberships");
  const inbox = db.collection("inbox_items");
  const warningEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiring = await memberships
    .find({ expires_at: { $gt: now, $lte: warningEnd } })
    .project({ _id: 0, user_id: 1, plan: 1, expires_at: 1 })
    .toArray();

  if (!expiring.length) return 0;
  const operations = expiring.map((membership) => {
    const remainingDays = Math.max(
      1,
      Math.ceil(
        (new Date(membership.expires_at).getTime() - now.getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    );
    const threshold = remainingDays <= 1 ? 1 : remainingDays <= 3 ? 3 : 7;
    const expiryKey = new Date(membership.expires_at).toISOString();
    const dedupeKey = `membership-expiry:${membership.user_id}:${expiryKey}:${threshold}`;
    return {
      updateOne: {
        filter: { dedupe_key: dedupeKey },
        update: {
          $setOnInsert: {
            id: randomUUID(),
            dedupe_key: dedupeKey,
            user_id: membership.user_id,
            kind: "membership_expiry",
            title: "Tuki Orbit",
            preview: "Membership expires soon",
            metadata: {
              days: remainingDays,
              plan: membership.plan,
              expires_at: membership.expires_at,
            },
            link: "/orbit",
            server_id: null,
            channel_id: null,
            message_id: null,
            unread: true,
            created_at: now,
          },
        },
        upsert: true,
      },
    };
  });
  const result = await inbox.bulkWrite(operations, { ordered: false });
  return result.upsertedCount;
}

function requestIps(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim());
  return [
    request.headers["cf-connecting-ip"],
    request.headers["x-real-ip"],
    ...forwarded,
    request.ip,
  ]
    .filter(Boolean)
    .map((value) => String(value).replace(/^::ffff:/, ""));
}

async function notificationFields(request) {
  if (request.isMultipart()) {
    const result = {};
    for await (const part of request.parts()) {
      if (part.type !== "field") {
        part.file.resume();
        continue;
      }
      result[part.fieldname] = String(part.value ?? "");
    }
    return result;
  }
  return request.body && typeof request.body === "object" ? request.body : {};
}

export function publicMembership(membership, now = new Date()) {
  const expiresAt = membership?.expires_at
    ? new Date(membership.expires_at)
    : null;
  const active = Boolean(expiresAt && expiresAt > now);
  return {
    plan: active ? membership.plan : null,
    active,
    expires_at: active ? expiresAt : null,
    streak_started_at: active ? membership.streak_started_at ?? null : null,
    badge: active ? membershipBadge(membership.streak_started_at, now) : null,
    entitlements: active ? membership.entitlements ?? {} : {},
  };
}

export async function registerPaymentRoutes(app, { config, db, authenticate }) {
  const orders = db.collection("payment_orders");
  const memberships = db.collection("memberships");

  app.get("/v1/payments/plans", async () => ({
    provider: "hotpay",
    currency: "PLN",
    renewal: "manual",
    plans: configuredPlans(config).map(({ level, ...plan }) => plan),
  }));

  app.get(
    "/v1/payments/me",
    { preHandler: authenticate },
    async (request) => {
      const membership = publicMembership(
        await memberships.findOne({ user_id: request.tukiUser.id }),
      );
      return {
        membership,
        limits: effectiveLimits(config, membership),
        orders: await orders
        .find(
          { user_id: request.tukiUser.id },
          {
            projection: {
              _id: 0,
              id: 1,
              plan: 1,
              amount: 1,
              currency: 1,
              status: 1,
              created_at: 1,
              updated_at: 1,
            },
          },
        )
        .sort({ created_at: -1 })
        .limit(10)
        .toArray(),
      };
    },
  );

  app.get(
    "/v1/memberships/:userId/badge",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: {
            userId: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request) => {
      const membership = publicMembership(
        await memberships.findOne(
          { user_id: request.params.userId },
          {
            projection: {
              _id: 0,
              plan: 1,
              expires_at: 1,
              streak_started_at: 1,
            },
          },
        ),
      );
      return {
        active: membership.active,
        plan: membership.plan,
        badge: membership.badge,
      };
    },
  );

  app.post(
    "/v1/payments/hotpay/checkout",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["plan"],
          properties: { plan: { enum: ["orbit_30d", "orbit_max_30d"] } },
        },
      },
    },
    async (request, reply) => {
      if (!paymentConfigured(config)) {
        return reply.code(503).send({
          error: "payments_unavailable",
          message: "Payments are not configured.",
        });
      }

      const plan = configuredPlans(config).find(
        (candidate) => candidate.id === request.body.plan,
      );
      const amount = plan?.amount;
      if (!plan || !amount || config.hotpay.planDurationDays < 1) {
        request.log.error("invalid HotPay plan configuration");
        return reply.code(503).send({ error: "payments_unavailable" });
      }
      if (!plan.available) {
        return reply.code(409).send({
          error: "plan_not_available",
          message: "This plan is not available for purchase yet.",
        });
      }
      const currentMembership = publicMembership(
        await memberships.findOne({ user_id: request.tukiUser.id }),
      );
      const currentPlan = configuredPlans(config).find(
        (candidate) => candidate.id === currentMembership.plan,
      );
      if (
        currentMembership.active &&
        currentPlan &&
        currentPlan.level > plan.level
      ) {
        return reply.code(409).send({
          error: "downgrade_requires_expiry",
          message: "A lower membership can be purchased after the current plan expires.",
        });
      }

      const id = `tuki_${randomUUID()}`;
      const serviceName = `${plan.name} - ${config.hotpay.planDurationDays} days`;
      const order = {
        id,
        user_id: request.tukiUser.id,
        plan: plan.id,
        plan_name: plan.name,
        entitlements: plan.entitlements,
        provider: "hotpay",
        amount,
        currency: "PLN",
        duration_days: config.hotpay.planDurationDays,
        status: "CREATED",
        created_at: new Date(),
        updated_at: new Date(),
      };
      await orders.insertOne(order);

      const form = new FormData();
      const fields = {
        SEKRET: config.hotpay.serviceSecret,
        KWOTA: amount,
        NAZWA_USLUGI: serviceName,
        ADRES_WWW: config.hotpay.returnUrl,
        ID_ZAMOWIENIA: id,
        EMAIL: "",
        DANE_OSOBOWE: "",
        TYP: "INIT",
      };
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append(
        "HASH",
        createCheckoutHash({
          notificationPassword: config.hotpay.notificationPassword,
          amount,
          serviceName,
          returnUrl: config.hotpay.returnUrl,
          orderId: id,
          serviceSecret: config.hotpay.serviceSecret,
        }),
      );

      try {
        const response = await fetch(config.hotpay.paymentUrl, {
          method: "POST",
          body: form,
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
        const responseBody = await response.text();
        const redirectUrl =
          parseHotPayInitialisation(responseBody) ??
          parseHotPayInitialisation(response.headers.get("location"));
        if ((response.status < 200 || response.status >= 400) || !redirectUrl) {
          throw new Error("HotPay rejected checkout initialisation");
        }
        await orders.updateOne(
          { id },
          { $set: { status: "INITIALISED", updated_at: new Date() } },
        );
        return { order_id: id, redirect_url: redirectUrl };
      } catch (error) {
        request.log.error({ err: error, orderId: id }, "HotPay init failed");
        await orders.updateOne(
          { id },
          { $set: { status: "INITIALISATION_FAILED", updated_at: new Date() } },
        );
        return reply.code(502).send({
          error: "payment_provider_unavailable",
          message: "HotPay could not start the payment.",
        });
      }
    },
  );

  app.post(
    "/v1/payments/hotpay/notification",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!paymentConfigured(config)) {
        return reply.code(503).send("NOT_CONFIGURED");
      }
      if (
        config.hotpay.enforceNotificationIpAllowlist &&
        !requestIps(request).some((ip) =>
          config.hotpay.notificationAllowedIps.has(ip),
        )
      ) {
        request.log.warn({ ips: requestIps(request) }, "HotPay IP rejected");
        return reply.code(403).send("FORBIDDEN");
      }

      const fields = await notificationFields(request);
      const amount = normaliseAmount(fields.KWOTA);
      const status = String(fields.STATUS ?? "").toUpperCase();
      const orderId = String(fields.ID_ZAMOWIENIA ?? "");
      const paymentId = String(fields.ID_PLATNOSCI ?? "");
      const secure = String(fields.SECURE ?? "");
      const serviceSecret = String(fields.SEKRET ?? "");
      const hash = String(fields.HASH ?? "");

      if (
        !amount ||
        !orderId ||
        !paymentId ||
        !secure ||
        !HOTPAY_STATUSES.has(status) ||
        !safeEqual(serviceSecret, config.hotpay.serviceSecret)
      ) {
        return reply.code(400).send("INVALID");
      }
      const expectedHash = createNotificationHash({
        notificationPassword: config.hotpay.notificationPassword,
        amount,
        paymentId,
        orderId,
        status,
        secure,
        serviceSecret,
      });
      if (!safeEqual(hash.toLowerCase(), expectedHash)) {
        return reply.code(403).send("INVALID_HASH");
      }

      const order = await orders.findOne({ id: orderId });
      if (!order || order.amount !== amount) {
        return reply.code(404).send("ORDER_NOT_FOUND");
      }

      const updatedAt = new Date();
      const previous = await orders.findOneAndUpdate(
        { id: orderId, status: { $ne: "SUCCESS" } },
        {
          $set: {
            status,
            payment_id: paymentId,
            secure,
            updated_at: updatedAt,
          },
        },
        { returnDocument: "before" },
      );

      if (status === "SUCCESS" && previous) {
        const current = await memberships.findOne({ user_id: order.user_id });
        const now = new Date();
        const currentExpiry = current?.expires_at
          ? new Date(current.expires_at)
          : now;
        const startsAt = currentExpiry > now ? currentExpiry : now;
        const expiresAt = new Date(
          startsAt.getTime() + order.duration_days * 24 * 60 * 60 * 1000,
        );
        const streakGracePeriodMs = 3 * 24 * 60 * 60 * 1000;
        const continuesStreak =
          currentExpiry.getTime() + streakGracePeriodMs >= now.getTime();
        await memberships.updateOne(
          { user_id: order.user_id },
          {
            $set: {
              user_id: order.user_id,
              plan: order.plan,
              entitlements: order.entitlements,
              provider: "hotpay",
              expires_at: expiresAt,
              streak_started_at:
                continuesStreak && current?.streak_started_at
                  ? current.streak_started_at
                  : now,
              updated_at: now,
            },
            $setOnInsert: { created_at: now },
          },
          { upsert: true },
        );
        await db.collection("inbox_items").deleteMany({
          user_id: order.user_id,
          kind: "membership_expiry",
        });
      }

      reply.header("Cache-Control", "no-store");
      return reply.type("text/plain").send("OK");
    },
  );
}
