const GIPHY_API = "https://api.giphy.com/v1/gifs";

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
