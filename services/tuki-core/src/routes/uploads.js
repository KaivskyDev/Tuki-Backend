import { publicMembership } from "./payments.js";

const UPLOAD_TAGS = new Set([
  "attachments",
  "avatars",
  "backgrounds",
  "banners",
  "icons",
  "emojis",
]);

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function uploadTag(value) {
  try {
    const pathname = new URL(String(value ?? "/"), "https://cdn.muzes.xyz")
      .pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return null;
    const tag = segments[0] ?? "";
    return UPLOAD_TAGS.has(tag) ? tag : null;
  } catch {
    return null;
  }
}

export function monthWindow(now) {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const expiresAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1),
  );
  return { month, expiresAt };
}

async function reserveMonthlyUsage(collection, userId, bytes, quota, now) {
  const { month, expiresAt } = monthWindow(now);
  try {
    const result = await collection.findOneAndUpdate(
      {
        user_id: userId,
        month,
        $or: [
          { bytes: { $exists: false } },
          { bytes: { $lte: quota - bytes } },
        ],
      },
      {
        $inc: { bytes },
        $set: { updated_at: now, expires_at: expiresAt },
        $setOnInsert: { user_id: userId, month, created_at: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    return result;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

export async function registerUploadRoutes(app, { config, db, authenticate }) {
  const memberships = db.collection("memberships");
  const usage = db.collection("upload_usage");

  app.get(
    "/v1/uploads/authorize",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const method = String(
        request.headers["x-tuki-upload-method"] ??
          request.headers["x-forwarded-method"] ??
          "POST",
      ).toUpperCase();
      const tag = uploadTag(
        request.headers["x-tuki-upload-uri"] ??
          request.headers["x-forwarded-uri"],
      );
      const requestBytes = positiveInteger(
        request.headers["x-tuki-upload-size"] ??
          request.headers["x-original-content-length"],
      );

      if (method !== "POST" || !tag || !requestBytes) {
        return reply.code(400).send({ error: "invalid_upload_request" });
      }

      const now = new Date();
      const membership = publicMembership(
        await memberships.findOne({ user_id: request.tukiUser.id }),
        now,
      );
      const maxEntitlement = positiveInteger(
        membership.entitlements?.max_attachment_bytes,
      );
      const isOrbitMax =
        membership.active &&
        membership.plan === "orbit_max_30d" &&
        maxEntitlement !== null;
      const limit =
        tag === "emojis"
          ? config.uploads.emojiBytes
          : tag === "attachments" && isOrbitMax
            ? Math.min(
                maxEntitlement,
                config.uploads.orbitMaxAttachmentBytes,
              )
            : config.uploads.attachmentBytes;

      // Multipart framing adds a small amount over the actual file size.
      const multipartAllowance = 64 * 1024;
      if (requestBytes > limit + multipartAllowance) {
        reply.header("X-Tuki-Upload-Limit", String(limit));
        return reply.code(403).send({
          error: "upload_too_large",
          max_bytes: limit,
        });
      }

      if (tag === "attachments" && isOrbitMax) {
        const reservation = await reserveMonthlyUsage(
          usage,
          request.tukiUser.id,
          requestBytes,
          config.uploads.orbitMaxMonthlyBytes,
          now,
        );
        if (!reservation) {
          reply.header(
            "X-Tuki-Monthly-Upload-Limit",
            String(config.uploads.orbitMaxMonthlyBytes),
          );
          return reply.code(403).send({
            error: "monthly_upload_limit_reached",
            max_bytes: config.uploads.orbitMaxMonthlyBytes,
          });
        }
        reply.header(
          "X-Tuki-Monthly-Upload-Remaining",
          String(
            Math.max(
              0,
              config.uploads.orbitMaxMonthlyBytes - reservation.bytes,
            ),
          ),
        );
      }

      reply.header("X-Tuki-Upload-Limit", String(limit));
      reply.header("Cache-Control", "no-store");
      return reply.code(204).send();
    },
  );
}
