import { assert, describe, it } from "vite-plus/test";

import {
  hasSpecificPierreIconForFileName,
  resolvePierreIconForEntry,
  LECTURN_PIERRE_ICONS,
} from "./pierre-icons";

describe("Pierre file icons", () => {
  it.each(["photo.heic", "photo.heif", "PHOTO.HEIC", "folder/photo.HEIF"])(
    "uses the image icon for %s",
    (name) => {
      assert.equal(resolvePierreIconForEntry(name, "file")?.token, "image");
      assert.isTrue(hasSpecificPierreIconForFileName(name));
    },
  );
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

  it.each([
    ["pdf", "pdf"],
    ["doc", "word"],
    ["docx", "word"],
    ["odt", "word"],
    ["rtf", "word"],
    ["xls", "spreadsheet"],
    ["xlsx", "spreadsheet"],
    ["ods", "spreadsheet"],
    ["csv", "spreadsheet"],
    ["tsv", "spreadsheet"],
    ["ppt", "slides"],
    ["pptx", "slides"],
    ["odp", "slides"],
    ["epub", "epub"],
  ])("uses the document family icon for %s", (extension, family) => {
    for (const path of [`report.${extension}`, `folder/REPORT.${extension.toUpperCase()}`]) {
      assert.equal(resolvePierreIconForEntry(path, "file")?.name, `lecturn-file-icon-${family}`);
      assert.isTrue(hasSpecificPierreIconForFileName(path));
    }
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
