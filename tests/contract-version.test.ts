import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_CONTRACT_VERSION } from "../src/foundation.js";

it("bumps the runtime contract for local review candidates", () => {
  expect(readFileSync(join(process.cwd(), "AGENTS.md"), "utf8")).toMatch(/INSTRUCTION_CONTRACT_VERSION:\s*46/u);
  expect(RUNTIME_CONTRACT_VERSION).toBe(30);
});
