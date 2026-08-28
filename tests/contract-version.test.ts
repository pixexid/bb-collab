import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_CONTRACT_VERSION } from "../src/foundation.js";

it("keeps the instruction contract and bumps the runtime contract for policy-bound routing profiles", () => {
  expect(readFileSync(join(process.cwd(), "AGENTS.md"), "utf8")).toMatch(/INSTRUCTION_CONTRACT_VERSION:\s*47/u);
  expect(RUNTIME_CONTRACT_VERSION).toBe(34);
});
