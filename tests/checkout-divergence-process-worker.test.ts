import { writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { readCheckoutDivergence } from "../src/checkout-divergence.js";

const checkoutRoot = process.env.CHECKOUT_DIVERGENCE_ROOT;
const resultPath = process.env.CHECKOUT_DIVERGENCE_RESULT;

describe.skipIf(!checkoutRoot || !resultPath)("checkout-divergence process worker", () => {
  it("runs one checkout probe for its parent test", () => {
    let requestedProcessGroupId: number | null = null;
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) requestedProcessGroupId = -pid;
      return realKill(pid, signal);
    });
    try {
      const result = readCheckoutDivergence(checkoutRoot!);
      writeFileSync(resultPath!, JSON.stringify({ ...result, requestedProcessGroupId }));
    } finally {
      killSpy.mockRestore();
    }
  });
});
