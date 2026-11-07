import { describe, expect, it } from "vite-plus/test";

import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";

describe("resolveThreadFeedFixedItemSize", () => {
  it("keeps fixed timeline chrome on the premeasured path", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold")).toBe(42);
    expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(28);
    expect(resolveThreadFeedFixedItemSize("import-divider")).toBe(34.5);
  });
});
