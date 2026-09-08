import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon; keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  // Next 16 blocks the HMR websocket from non-localhost-looking origins by
  // default; this box serves the dev server on 127.0.0.1, which trips that
  // guard and silently breaks client hydration (React effects/handlers never
  // run) rather than just disabling live-reload.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;

