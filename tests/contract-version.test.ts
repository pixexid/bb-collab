import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_CONTRACT_VERSION } from "../src/foundation.js";

it("bumps the runtime contract for domain-scoped authority without changing the instruction contract", () => {
  expect(readFileSync(join(process.cwd(), "AGENTS.md"), "utf8")).toMatch(/INSTRUCTION_CONTRACT_VERSION:\s*45/u);
  expect(RUNTIME_CONTRACT_VERSION).toBe(28);
});
