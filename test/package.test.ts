import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as aikraft from "../src/index.js";

it("exposes the package.json version", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  expect(aikraft.VERSION).toBe(version);
});
