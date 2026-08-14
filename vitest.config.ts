import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // convex-test loads the function modules itself; it must not be
    // pre-bundled or the module map won't line up.
    server: { deps: { inline: ["convex-test"] } },
  },
});
