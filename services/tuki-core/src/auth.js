export function createAuth(config) {
  return async function authenticate(request, reply) {
    const sessionToken = request.headers["x-session-token"];
    const botToken = request.headers["x-bot-token"];

    if (!sessionToken && !botToken) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "A Tuki session is required.",
      });
    }

    const headerName = sessionToken ? "X-Session-Token" : "X-Bot-Token";
    const token = sessionToken ?? botToken;

    let response;
    try {
      response = await fetch(`${config.identityUrl}/users/@me`, {
        headers: { [headerName]: token },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return reply.code(503).send({
        error: "identity_unavailable",
        message: "The identity service is temporarily unavailable.",
      });
    }

    if (!response.ok) {
      return reply.code(401).send({
        error: "invalid_session",
        message: "The Tuki session is invalid or expired.",
      });
    }

    const user = await response.json();
    request.tukiUser = {
      id: user._id,
      username: user.username,
      bot: Boolean(user.bot),
    };
  };
}

export function requireAdmin(config) {
  return async function adminOnly(request, reply) {
    if (!config.adminUserIds.has(request.tukiUser.id)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "This operation requires Tuki Trust & Safety access.",
      });
    }
  };
}

export async function hasServerAccess(config, request, serverId) {
  const sessionToken = request.headers["x-session-token"];
  const botToken = request.headers["x-bot-token"];
  const headerName = sessionToken ? "X-Session-Token" : "X-Bot-Token";
  const token = sessionToken ?? botToken;
  if (!token || !serverId) return false;

  try {
    const response = await fetch(
      `${config.identityUrl}/servers/${encodeURIComponent(serverId)}`,
      {
        headers: { [headerName]: token },
        signal: AbortSignal.timeout(5000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
