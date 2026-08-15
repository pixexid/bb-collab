import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const operations = readFileSync("docs/operations-model.md", "utf8");
const roadmap = readFileSync("docs/roadmap.md", "utf8");
const compact = (text: string) => text.replace(/\s+/gu, " ");
const compactOperations = compact(operations);
const compactRoadmap = compact(roadmap);

describe("issue #78 gate-epic throughput policy", () => {
  it("requires decomposition metadata for gate epics", () => {
    expect(operations).toContain("workShape: epic");
    for (const field of ["sliceId", "dependsOn", "readiness", "estimateHours"]) {
      expect(operations).toContain(`\`${field}\``);
    }
    expect(operations).toContain("mergeable child slices");
  });

  it("keeps the per-child estimate at the eight-hour ceiling", () => {
    expect(compactOperations).toContain("every child estimate is at most 8 hours");
    expect(compactOperations).toContain("estimated above 8 hours");
    expect(compactRoadmap).toContain("no child estimate may exceed 8 hours");
  });

  it("requires merged dependencies and readiness before a child starts", () => {
    expect(compactOperations).toContain("every listed dependency is merged");
    expect(compactOperations).toContain("readiness gate is true");
    expect(compactRoadmap).toContain("dependencies are merged and readiness is true");
  });

  it("preserves deferred reservations without blocking read-only work", () => {
    expect(compactOperations).toContain("deferred child retains the existing `queueBlocked: false` behavior");
    expect(compactOperations).toContain("its writer reservation");
    expect(compactOperations).toContain("ready writing lanes beyond the remaining cap may be `queueBlocked: true`");
    expect(compactOperations).toContain("Read-only lanes remain unaffected");
    expect(compactRoadmap).toContain("writer reservation can queue-block ready writing lanes beyond the remaining cap");
    expect(compactRoadmap).toContain("never read-only lanes");
    expect(compactOperations).toContain("#31 gate program is the counterexample");
    expect(compactOperations).toContain("52 hours across four");
  });
});
