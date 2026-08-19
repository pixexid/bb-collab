import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "server.ts"), "utf8");

describe("deployed dist automation", () => {
  it("keeps the read-only deployed check on the recurring fleet schedule", () => {
    const schedule = /bb\.background\.schedule\("fleet-watchdog", "\*\/5 \* \* \* \*", \(\) => \{([\s\S]*?)\n  \}\);/u.exec(source)?.[1] ?? "";
    expect(schedule).toContain("checkDeployedDist();");
    expect(schedule).toContain("return fleetWatchdogCycle();");
    expect(source).toContain('"--deployed"');
  });
});
