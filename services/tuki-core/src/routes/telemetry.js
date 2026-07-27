const SENTRY_HOST = "o4509396323729408.ingest.de.sentry.io";
const SENTRY_PROJECT_ID = "4511808031948880";
const SENTRY_PUBLIC_KEY = "a2723fcb39d6b5aaf4701bb7f758ae23";
const SENTRY_ENVELOPE_URL =
  `https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`;

function isAllowedEnvelope(envelope) {
  const firstLineEnd = envelope.indexOf("\n");
  if (firstLineEnd < 1) return false;

  try {
    const header = JSON.parse(envelope.slice(0, firstLineEnd));
    const dsn = new URL(header.dsn);
    return (
      dsn.protocol === "https:" &&
      dsn.hostname === SENTRY_HOST &&
      dsn.username === SENTRY_PUBLIC_KEY &&
      dsn.pathname === `/${SENTRY_PROJECT_ID}`
    );
  } catch {
    return false;
  }
}

export function registerTelemetryRoutes(app) {
  app.addContentTypeParser(
    "application/x-sentry-envelope",
    { parseAs: "string", bodyLimit: 1_000_000 },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/v1/sentry",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (
        typeof request.body !== "string" ||
        !isAllowedEnvelope(request.body)
      ) {
        return reply.code(400).send({ error: "invalid_sentry_envelope" });
      }

      const response = await fetch(SENTRY_ENVELOPE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "user-agent": "tuki-core-sentry-tunnel/1.0",
        },
        body: request.body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        request.log.warn(
          { sentryStatus: response.status },
          "Sentry rejected an envelope",
        );
        return reply.code(502).send({ error: "sentry_upstream_rejected" });
      }

      return reply.code(202).send();
    },
  );
}
