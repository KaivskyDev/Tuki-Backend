import { createHash, randomBytes } from "node:crypto";
import { connect as connectTls } from "node:tls";

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const SERVICES = [
  { id: "web", url: "https://chat.muzes.xyz/" },
  { id: "core", url: "https://core.muzes.xyz/health/live" },
  { id: "gateway", url: "https://gateway.muzes.xyz/", kind: "websocket" },
  { id: "files", url: "https://cdn.muzes.xyz/" },
  { id: "media", url: "https://media.muzes.xyz/" },
  { id: "voice", url: "https://voice.muzes.xyz/" },
];

export function statusForResponse(status) {
  return status < 500 ? "operational" : "outage";
}

export function isValidWebSocketHandshake(headers, key) {
  const [statusLine, ...lines] = headers.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(statusLine)) return false;

  const values = new Map(
    lines
      .map((line) => {
        const separator = line.indexOf(":");
        return separator === -1
          ? ["", ""]
          : [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
      .filter(([name]) => name),
  );
  const expected = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  return (
    values.get("upgrade")?.toLowerCase() === "websocket" &&
    values.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade") &&
    values.get("sec-websocket-accept") === expected
  );
}

function probeWebSocket(url, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const key = randomBytes(16).toString("base64");
    let response = "";
    let settled = false;
    let socket;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      error ? reject(error) : resolve(101);
    };
    socket = connectTls({
      host: target.hostname,
      port: Number(target.port || 443),
      servername: target.hostname,
      rejectUnauthorized: true,
    });
    socket.setTimeout(timeoutMs, () => finish(new Error("WebSocketTimeout")));
    socket.once("error", finish);
    socket.once("secureConnect", () => {
      const path = `${target.pathname || "/"}${target.search}`;
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "User-Agent: Tuki-Status/1.0",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      const end = response.indexOf("\r\n\r\n");
      if (end === -1) return;
      if (isValidWebSocketHandshake(response.slice(0, end), key)) finish();
      else finish(new Error("InvalidWebSocketHandshake"));
    });
    socket.once("end", () => finish(new Error("WebSocketClosedBeforeHandshake")));
  });
}

async function observe(service) {
  const startedAt = performance.now();
  try {
    if (service.kind === "websocket") {
      const status = await probeWebSocket(service.url);
      return {
        service_id: service.id,
        checked_at: new Date(),
        latency_ms: Math.round(performance.now() - startedAt),
        status_code: status,
        status: "operational",
      };
    }
    const response = await fetch(service.url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    return {
      service_id: service.id,
      checked_at: new Date(),
      latency_ms: Math.round(performance.now() - startedAt),
      status_code: response.status,
      status: statusForResponse(response.status),
    };
  } catch (error) {
    return {
      service_id: service.id,
      checked_at: new Date(),
      latency_ms: Math.round(performance.now() - startedAt),
      status: "outage",
      error: error instanceof Error ? error.name : "ConnectionError",
    };
  }
}

async function runChecks(collection, log) {
  const observations = await Promise.all(SERVICES.map(observe));
  await collection.insertMany(observations);
  const failed = observations.filter((item) => item.status === "outage");
  if (failed.length) {
    log.warn({ services: failed.map((item) => item.service_id) }, "Status checks failed");
  }
}

export async function registerStatusRoutes(app, { db }) {
  const collection = db.collection("status_observations");
  await Promise.all([
    collection.createIndex({ service_id: 1, checked_at: -1 }),
    collection.createIndex(
      { checked_at: 1 },
      { expireAfterSeconds: Math.floor(RETENTION_MS / 1000) },
    ),
  ]);

  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      await runChecks(collection, app.log);
    } catch (error) {
      app.log.error({ error }, "Unable to persist status observations");
    } finally {
      running = false;
    }
  };
  const initialTimer = setTimeout(() => void check(), 2_000);
  const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
  initialTimer.unref();
  interval.unref();

  app.addHook("onClose", async () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
  });

  app.get("/v1/status/summary", async () => {
    const since = new Date(Date.now() - RETENTION_MS);
    const [latest, daily] = await Promise.all([
      collection
        .aggregate([
          { $sort: { checked_at: -1 } },
          { $group: { _id: "$service_id", observation: { $first: "$$ROOT" } } },
          { $replaceRoot: { newRoot: "$observation" } },
          { $project: { _id: 0 } },
        ])
        .toArray(),
      collection
        .aggregate([
          { $match: { checked_at: { $gte: since } } },
          {
            $group: {
              _id: {
                service_id: "$service_id",
                day: { $dateToString: { format: "%Y-%m-%d", date: "$checked_at" } },
              },
              checks: { $sum: 1 },
              operational: {
                $sum: { $cond: [{ $eq: ["$status", "operational"] }, 1, 0] },
              },
              latency_ms: { $avg: "$latency_ms" },
            },
          },
          { $sort: { "_id.day": 1 } },
        ])
        .toArray(),
    ]);

    const latestById = new Map(latest.map((item) => [item.service_id, item]));
    const dailyById = new Map();
    for (const item of daily) {
      const entries = dailyById.get(item._id.service_id) ?? [];
      entries.push({
        day: item._id.day,
        uptime: item.checks ? Math.round((item.operational / item.checks) * 10_000) / 100 : null,
        latency_ms: Math.round(item.latency_ms ?? 0),
      });
      dailyById.set(item._id.service_id, entries);
    }
    const days = Array.from({ length: 90 }, (_, index) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - (89 - index));
      return date.toISOString().slice(0, 10);
    });

    const services = SERVICES.map((definition) => {
      const current = latestById.get(definition.id);
      const measured = new Map(
        (dailyById.get(definition.id) ?? []).map((item) => [item.day, item]),
      );
      const history = days.map(
        (day) => measured.get(day) ?? { day, uptime: null, latency_ms: null },
      );
      const checks = history.filter((item) => item.uptime !== null);
      const uptime = checks.length
        ? Math.round((checks.reduce((sum, item) => sum + item.uptime, 0) / checks.length) * 100) / 100
        : null;
      return {
        id: definition.id,
        status: current?.status ?? "unknown",
        checked_at: current?.checked_at ?? null,
        latency_ms: current?.latency_ms ?? null,
        uptime_90d: uptime,
        history,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      status: services.some((service) => service.status === "outage")
        ? "degraded"
        : services.every((service) => service.status === "operational")
          ? "operational"
          : "unknown",
      services,
      incidents: [],
    };
  });
}
