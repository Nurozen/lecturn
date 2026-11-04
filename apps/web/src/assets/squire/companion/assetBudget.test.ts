// @effect-diagnostics nodeBuiltinImport:off - measures the shipped asset files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// The companion figure parts ship lazily with the companion chunk; this keeps them in budget.
describe("squire companion part budget", () => {
  const dir = import.meta.dirname;
  const parts = NodeFS.readdirSync(dir).filter((name) => name.endsWith(".webp"));

  it("ships exactly the ten figure parts", () => {
    expect(parts).toHaveLength(10);
  });

  it("keeps the parts at or under 2.5 MB in total", () => {
    const total = parts.reduce(
      (sum, name) => sum + NodeFS.statSync(NodePath.join(dir, name)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(2_500_000);
  });
});
