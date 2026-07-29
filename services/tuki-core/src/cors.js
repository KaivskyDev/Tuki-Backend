export function createCorsOptions(config) {
  return {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "X-Session-Token",
      "X-Bot-Token",
      "X-Request-Id",
    ],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  };
}
