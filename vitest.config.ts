import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // GH-161. CI inflates this repo's I/O-bound tests far past their local time:
    // the worst per-test CI observation is 5,795 ms (168 ms locally) inside a
    // server.test.ts run that took 28,669 ms. 15 s clears that by 2.59x and still
    // fails a genuine hang in half the suite's worst-case wall clock.
    testTimeout: 15_000,
  },
});
