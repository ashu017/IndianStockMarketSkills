import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { environment: "node", globals: true },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // `server-only` throws on import unless it's resolved under the
      // "react-server" condition, which vitest doesn't set — so importing a
      // server module (lib/backtest.ts, lib/strategies.ts) from a test would
      // fail on the marker rather than on anything real. Point it at the
      // package's own no-op entry, which is exactly what Next resolves it to on
      // the server. Scoped to tests only; the app's own resolution is untouched.
      "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
