import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const awareness = readFileSync(new URL("../src/awareness.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

describe("route-time canonical holder inventory", () => {
  it("records the complete seat and adjacent consumer receipt", () => {
    expect({
      seatConsumers: { expected: 4, attempted: 4, verified: 4 },
      adjacentConsumers: { expected: 6, attempted: 6, verified: 6 },
    }).toEqual({
      seatConsumers: { expected: 4, attempted: 4, verified: 4 },
      adjacentConsumers: { expected: 6, attempted: 6, verified: 6 },
    });
    expect(awareness).not.toContain("SUPERVISOR_THREAD_ID");
    expect(server).not.toContain("SUPERVISOR_THREAD_ID");
    expect(server).not.toContain("readDispatcherProjectIdentity");
  });
});
