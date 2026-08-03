export async function verifyIdentitySession({
  identityUrl,
  session,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${identityUrl}/users/@me`, {
    headers: { "X-Session-Token": session.token },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("oauth_session_rejected_by_identity");
  const user = await response.json();
  if (String(user._id) !== String(session.user_id)) {
    throw new Error("oauth_session_user_mismatch");
  }
  return { userId: String(user._id) };
}

export function verifyGatewaySession({
  gatewayUrl,
  token,
  WebSocketImpl = WebSocket,
  timeoutMs = 8_000,
}) {
  return new Promise((resolve, reject) => {
    const url = new URL(gatewayUrl);
    url.searchParams.set("version", "1");
    url.searchParams.set("format", "json");
    url.searchParams.set("token", token);
    let ready = false;
    const socket = new WebSocketImpl(url);
    const timeout = setTimeout(() => finish(new Error("oauth_gateway_timeout")), timeoutMs);

    const finish = (error) => {
      clearTimeout(timeout);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
      if (error) reject(error);
      else resolve({ ready: true });
    };

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type === "Error") return finish(new Error("oauth_gateway_rejected"));
      if (payload.type === "Ready") {
        ready = true;
        finish();
      }
    });
    socket.addEventListener("error", () => finish(new Error("oauth_gateway_connection_failed")));
    socket.addEventListener("close", () => {
      if (!ready) finish(new Error("oauth_gateway_closed_before_ready"));
    });
  });
}
