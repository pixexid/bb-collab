import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { readCheckoutDivergence } from "../src/checkout-divergence.js";

const checkoutRoot = process.env.CHECKOUT_DIVERGENCE_ROOT;
const resultPath = process.env.CHECKOUT_DIVERGENCE_RESULT;

describe.skipIf(!checkoutRoot || !resultPath)("checkout-divergence process worker", () => {
  it("runs one checkout probe for its parent test", () => {
    writeFileSync(resultPath!, JSON.stringify(readCheckoutDivergence(checkoutRoot!)));
  });
});
