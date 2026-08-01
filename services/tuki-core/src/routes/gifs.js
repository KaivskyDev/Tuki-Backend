const GIPHY_API = "https://api.giphy.com/v1/gifs";
const MAX_GIF_BYTES = 10_000_000;

export function isTrustedGifUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (hostname === "giphy.com" ||
        hostname.endsWith(".giphy.com") ||
        hostname === "tenor.com" ||
        hostname.endsWith(".tenor.com"))
    );
  } catch {
    return false;
  }
}

function clampLimit(value) {
  const parsed = Number.parseInt(value ?? "24", 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 24, 1), 50);
}

function mapGif(item) {
  const preview =
    item.images?.fixed_width?.webp ??
    item.images?.fixed_height_small?.webp ??
    item.images?.downsized?.url ??
    item.images?.original?.url;
  const original = item.images?.original?.url ?? preview;

  return {
    id: item.id,
    title: item.title || "GIF",
    url: original,
    preview_url: preview,
    width: Number(item.images?.fixed_width?.width ?? 200),
    height: Number(item.images?.fixed_width?.height ?? 120),
  };
}

async function giphyRequest(config, path, params, request) {
  if (!config.giphyApiKey) {
    const error = new Error("GIF provider is not configured");
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(`${GIPHY_API}/${path}`);
  url.search = new URLSearchParams({
    api_key: config.giphyApiKey,
    rating: "pg-13",
    bundle: "messaging_non_clips",
    ...params,
  });
  const response = await fetch(url, {
    headers: { "user-agent": "Tuki/1.0 (https://chat.muzes.xyz)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    request.log.warn(
      { status: response.status, provider: "giphy" },
      "GIF provider request failed",
    );
    const error = new Error("GIF provider is temporarily unavailable");
    error.statusCode = 502;
    throw error;
  }
  return response.json();
}

export function registerGifRoutes(app, { config, authenticate }) {
  app.get(
    "/v1/gifs/file",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const source = typeof request.query.url === "string" ? request.query.url : "";
      if (!isTrustedGifUrl(source)) {
        return reply.code(400).send({ error: "invalid_gif_url" });
      }

      let response;
      try {
        response = await fetch(source, {
          headers: { "user-agent": "Tuki/1.0 (https://chat.muzes.xyz)" },
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        return reply.code(502).send({ error: "gif_download_failed" });
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0];
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok || !contentType?.startsWith("image/")) {
        return reply.code(502).send({ error: "gif_download_failed" });
      }
      if (contentLength > MAX_GIF_BYTES) {
        return reply.code(413).send({
          error: "file_too_large",
          max_bytes: MAX_GIF_BYTES,
        });
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > MAX_GIF_BYTES) {
        return reply.code(413).send({
          error: "file_too_large",
          max_bytes: MAX_GIF_BYTES,
        });
      }

      return reply
        .header("content-type", contentType)
        .header("content-length", String(body.byteLength))
        .header("cache-control", "private, max-age=300")
        .header("x-content-type-options", "nosniff")
        .send(body);
    },
  );

  app.get(
    "/v1/gifs/trending",
    { preHandler: authenticate },
    async (request) => {
      const payload = await giphyRequest(
        config,
        "trending",
        {
          limit: String(clampLimit(request.query.limit)),
        },
        request,
      );
      return { results: payload.data.map(mapGif) };
    },
  );

  app.get(
    "/v1/gifs/search",
    { preHandler: authenticate },
    async (request, reply) => {
      const query =
        typeof request.query.q === "string" ? request.query.q.trim() : "";
      if (!query || query.length > 50) {
        return reply.code(400).send({ error: "invalid_gif_query" });
      }
      const payload = await giphyRequest(
        config,
        "search",
        {
          q: query,
          limit: String(clampLimit(request.query.limit)),
          lang: request.query.lang === "pl" ? "pl" : "en",
        },
        request,
      );
      return { results: payload.data.map(mapGif) };
    },
  );
}
