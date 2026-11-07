import { assert, describe, it } from "vite-plus/test";

import { resolvePierreIconForEntry, LECTURN_PIERRE_ICONS } from "./pierre-icons";

describe("Pierre file icons", () => {
  it("uses detected types for extensionless files while keeping known filename icons", () => {
    assert.equal(
      resolvePierreIconForEntry("custom-script", "file", "text/x-python")?.token,
      "python",
    );
    assert.equal(resolvePierreIconForEntry("image", "file", "image/png")?.token, "image");
    assert.equal(
      resolvePierreIconForEntry("Dockerfile", "file", "text/x-shellscript")?.token,
      "docker",
    );
    assert.isNull(resolvePierreIconForEntry("folder.png", "directory", "image/png"));
    assert.equal(
      resolvePierreIconForEntry("unknown", "file", "application/octet-stream")?.token,
      "default",
    );
  });

  it("extends Pierre with Lecturn-specific exact filename icons", () => {
    assert.equal(resolvePierreIconForEntry("AGENTS.md", "file")?.name, "lecturn-file-icon-agents");
    assert.equal(resolvePierreIconForEntry("CLAUDE.md", "file")?.name, "lecturn-file-icon-claude");
    assert.equal(
      resolvePierreIconForEntry("pnpm-lock.yaml", "file")?.name,
      "lecturn-file-icon-pnpm",
    );
    assert.equal(
      resolvePierreIconForEntry("pnpm-workspace.yaml", "file")?.name,
      "lecturn-file-icon-pnpm",
    );
  });

  it("ships every custom icon referenced by the extended resolver", () => {
    const customIconNames = new Set(
      [
        ...Object.values(LECTURN_PIERRE_ICONS.byFileName),
        ...Object.values(LECTURN_PIERRE_ICONS.byFileExtension),
      ].filter((name) => name.startsWith("lecturn-")),
    );
    for (const iconName of customIconNames) {
      assert.include(LECTURN_PIERRE_ICONS.spriteSheet, `id="${iconName}"`);
    }
  });
});
