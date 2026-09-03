import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";

import serverPackageJson from "../package.json" with { type: "json" };
import { buildPublishManifest, createVpPmPublishArgs } from "./cli.ts";

const workspaceConfig = {
  catalog: Object.fromEntries(
    Object.keys(serverPackageJson.dependencies).map((name) => [name, "0.0.0-test"]),
  ),
  overrides: {},
};

it("builds the default manifest from the workspace package.json", () => {
  const manifest = buildPublishManifest({ version: "1.2.3", workspaceConfig });

  assert.equal(manifest.name, "t3");
  assert.deepStrictEqual(manifest.bin, { t3: "./dist/bin.mjs" });
  assert.deepStrictEqual(manifest.repository, serverPackageJson.repository);
  assert.equal(manifest.version, "1.2.3");
  assert.deepStrictEqual(Object.keys(manifest), [
    "name",
    "repository",
    "bin",
    "type",
    "version",
    "engines",
    "files",
    "dependencies",
    "overrides",
  ]);
  assert.isFalse(Object.values(manifest.dependencies).some((spec) => spec.startsWith("catalog:")));
});

it("applies package name, bin name and repository overrides", () => {
  const manifest = buildPublishManifest({
    version: "1.2.3",
    workspaceConfig,
    packageName: "lecturn",
    binName: "lecturn",
    githubRepository: "Nurozen/lecturn",
  });

  assert.equal(manifest.name, "lecturn");
  assert.deepStrictEqual(manifest.bin, { lecturn: "./dist/bin.mjs" });
  assert.deepStrictEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/Nurozen/lecturn",
    directory: "apps/server",
  });
});

it("keeps the package.json repository when GITHUB_REPOSITORY is empty", () => {
  const manifest = buildPublishManifest({
    version: "1.2.3",
    workspaceConfig,
    githubRepository: "",
  });

  assert.deepStrictEqual(manifest.repository, serverPackageJson.repository);
});

it("filters pnpm publish by the published package name", () => {
  const base = { access: "public", tag: "latest", provenance: false, dryRun: false };

  assert.deepStrictEqual(createVpPmPublishArgs({ ...base, packageName: Option.none() }), [
    "publish",
    "--filter",
    "t3",
    "--access",
    "public",
    "--tag",
    "latest",
    "--no-git-checks",
  ]);
  assert.deepStrictEqual(
    createVpPmPublishArgs({
      ...base,
      packageName: Option.some("lecturn"),
      provenance: true,
      dryRun: true,
    }),
    [
      "publish",
      "--filter",
      "lecturn",
      "--access",
      "public",
      "--tag",
      "latest",
      "--no-git-checks",
      "--provenance",
      "--dry-run",
    ],
  );
});
