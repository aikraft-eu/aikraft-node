// Smoke test for the packed tarball: run from a directory where it is installed.
// Checks that ESM and CJS both load, and that buffered data is flushed when the process ends on its own.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const esm = await import("aikraft");
const cjs = require("aikraft");
if (!esm.VERSION || esm.VERSION !== cjs.VERSION) throw new Error(`version mismatch: ${esm.VERSION} / ${cjs.VERSION}`);

const child = `
  const aikraft = require("aikraft");
  aikraft.init({
    workspace: "ws", system: "sys", apiKey: "ak_test_x",
    fetch: async (url, init) => { console.log("SENT " + JSON.parse(init.body).windows[0].calls); return new Response("{}"); },
  });
  const client = aikraft.wrap({ messages: { create: async (p) => ({ model: p.model, content: [], stop_reason: "end_turn" }) } });
  client.messages.create({ model: "m" });
`;
const out = execFileSync(process.execPath, ["-e", child], { cwd: process.cwd(), timeout: 10_000 }).toString();
if (!out.includes("SENT 1")) throw new Error(`expected a flush at exit, got: ${out}`);
console.log(`aikraft ${esm.VERSION}: ESM and CJS load, exit flush works`);
