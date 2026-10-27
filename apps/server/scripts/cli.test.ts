import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { shouldBundleCliDependency } from "../../../scripts/lib/cli-external-packages.ts";
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

  assert.equal(manifest.name, "lecturn");
  assert.deepStrictEqual(manifest.bin, { lecturn: "./dist/bin.mjs" });
  assert.deepStrictEqual(manifest.repository, serverPackageJson.repository);
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.license, "MIT");
  assert.deepStrictEqual(Object.keys(manifest), [
    "license",
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

it("publishes bundled workspace modules without private registry dependencies", () => {
  const manifest = buildPublishManifest({ version: "1.2.3", workspaceConfig });

  assert.isUndefined(manifest.dependencies["@lecturn/provider-acp"]);
  assert.isUndefined(manifest.dependencies["@lecturn/source-control-github"]);
  for (const [name, spec] of Object.entries(serverPackageJson.dependencies)) {
    if (spec.startsWith("workspace:")) {
      assert.isTrue(shouldBundleCliDependency(name), `${name} must be bundled before omitting it`);
      assert.isUndefined(manifest.dependencies[name], name);
    }
  }
  assert.isFalse(
    Object.values(manifest.dependencies).some((spec) => spec.startsWith("workspace:")),
  );
  assert.equal(manifest.dependencies["node-pty"], serverPackageJson.dependencies["node-pty"]);
  assert.equal(manifest.dependencies["@cursor/sdk"], serverPackageJson.dependencies["@cursor/sdk"]);
  assert.equal(manifest.dependencies["effect"], workspaceConfig.catalog["effect"]);
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
    "lecturn",
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
