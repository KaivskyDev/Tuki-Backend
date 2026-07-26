const startedAt = Date.now();
let requests = 0;
let errors = 0;

export function recordRequest(reply) {
  requests += 1;
  if (reply.statusCode >= 500) errors += 1;
}

export function renderMetrics() {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  return [
    "# HELP tuki_core_up Whether Tuki Core is running.",
    "# TYPE tuki_core_up gauge",
    "tuki_core_up 1",
    "# HELP tuki_core_uptime_seconds Process uptime.",
    "# TYPE tuki_core_uptime_seconds counter",
    `tuki_core_uptime_seconds ${uptime}`,
    "# HELP tuki_core_http_requests_total HTTP responses.",
    "# TYPE tuki_core_http_requests_total counter",
    `tuki_core_http_requests_total ${requests}`,
    "# HELP tuki_core_http_errors_total HTTP 5xx responses.",
    "# TYPE tuki_core_http_errors_total counter",
    `tuki_core_http_errors_total ${errors}`,
    "",
  ].join("\n");
}
