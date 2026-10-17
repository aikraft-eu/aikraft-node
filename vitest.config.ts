import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __AIKRAFT_VERSION__: JSON.stringify(version) },
  test: { include: ["test/**/*.test.ts"] },
});
