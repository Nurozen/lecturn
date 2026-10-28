import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import embedPackageJson from "../../../packages/embed/package.json" with { type: "json" };
import { shouldBundleCliDependency } from "../../../scripts/lib/cli-external-packages.ts";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  buildPackDescriptor,
  buildPublishManifest,
  createVpPmPackArgs,
  createVpPmPublishArgs,
  derivePackBuildFacts,
  findWorkspacePackageImports,
  packTarballName,
  readWorkspaceConfig,
} from "./cli.ts";

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

it("declares only runtime externals in a pack manifest, so a clean install never needs workspace packages", () => {
  const published = buildPublishManifest({ version: "1.2.3", workspaceConfig });
  const packed = buildPublishManifest({
    version: "1.2.3",
    workspaceConfig,
    runtimeExternalsOnly: true,
  });

  // Workspace packages are bundled into dist, so neither manifest lists them.
  assert.isFalse(Object.keys(published.dependencies).some((name) => name.startsWith("@lecturn/")));
  assert.deepStrictEqual(Object.keys(packed.dependencies).toSorted(), [
    "@cursor/sdk",
    "@ff-labs/fff-node",
    "@napi-rs/keyring",
    "node-pty",
    "playwright-core",
    "undici",
  ]);
  assert.isFalse(
    Object.values(packed.dependencies).some(
      (spec) => spec.startsWith("workspace:") || spec.startsWith("catalog:"),
    ),
  );
});

it("packs the published package name into the requested directory", () => {
  assert.deepStrictEqual(createVpPmPackArgs(Option.none(), "/tmp/out"), [
    "pack",
    "--filter",
    "lecturn",
    "--pack-destination",
    "/tmp/out",
  ]);
  assert.deepStrictEqual(
    createVpPmPackArgs(Option.some("lecturn-nightly"), "/tmp/out").at(2),
    "lecturn-nightly",
  );
});

it("names tarballs the way pnpm pack does", () => {
  assert.equal(packTarballName("lecturn", "0.0.50"), "lecturn-0.0.50.tgz");
  assert.equal(packTarballName("@lecturn/embed", "0.0.50"), "lecturn-embed-0.0.50.tgz");
});

const noEnvBuild = derivePackBuildFacts({ env: {}, repoEnvFile: false, version: "0.0.50" });

it.effect("hands the host exactly the patches and builds its runtime dependencies need", () =>
  Effect.gen(function* () {
    const workspace = yield* readWorkspaceConfig();
    const descriptor = buildPackDescriptor({
      server: buildPublishManifest({
        version: "0.0.50",
        workspaceConfig: workspace,
        runtimeExternalsOnly: true,
      }),
      embed: embedPackageJson,
      workspaceConfig: workspace,
      build: noEnvBuild,
    });

    assert.deepStrictEqual(
      Object.keys(descriptor.pnpm.patchedDependencies).map((selector) =>
        selector.slice(0, selector.lastIndexOf("@")),
      ),
      ["@ff-labs/fff-node", "node-pty"],
    );
    for (const [selector, target] of Object.entries(descriptor.pnpm.patchedDependencies)) {
      assert.isDefined(workspace.patchedDependencies?.[selector]);
      assert.match(target, /^patches\/[^/]+\.patch$/);
    }
    assert.deepStrictEqual(descriptor.pnpm.allowBuilds, { "node-pty": true });
    assert.equal(descriptor.pnpm.nodeLinker, "hoisted");
    assert.deepStrictEqual(descriptor.pnpm.publicHoistPattern, ["@cursor/sdk-*"]);
    assert.deepStrictEqual(descriptor.packages.embed, {
      name: "@lecturn/embed",
      version: embedPackageJson.version,
      tarball: `lecturn-embed-${embedPackageJson.version}.tgz`,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("records that a build without a repo .env has no Connect or telemetry keys", () => {
  assert.deepStrictEqual(noEnvBuild, {
    repoEnvFile: false,
    lecturnConnect: false,
    telemetry: false,
    icons: "production",
  });
  const descriptor = buildPackDescriptor({
    server: {
      name: "lecturn",
      version: "0.0.50",
      bin: { lecturn: "./dist/bin.mjs" },
      dependencies: {},
    },
    embed: { name: "@lecturn/embed", version: "0.0.50" },
    workspaceConfig: {},
    build: noEnvBuild,
  });
  assert.isTrue(
    descriptor.notes.some(
      (note) => note.includes("without a repo .env") && note.includes("Connect unavailable"),
    ),
  );

  const configuredEnv = {
    LECTURN_RELAY_URL: "https://relay.example.test",
    LECTURN_CLERK_PUBLISHABLE_KEY: "pk_test_x",
    LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "client",
    LECTURN_POSTHOG_KEY: "phc_x",
  };
  const configured = derivePackBuildFacts({
    env: configuredEnv,
    repoEnvFile: true,
    version: "0.0.51-nightly.20261025",
  });
  assert.deepStrictEqual(configured, {
    repoEnvFile: true,
    lecturnConnect: true,
    telemetry: true,
    icons: "nightly",
  });
  assert.isFalse(
    derivePackBuildFacts({
      env: { ...configuredEnv, LECTURN_RELAY_URL: "http://relay.example.test" },
      repoEnvFile: true,
      version: "0.0.50",
    }).lecturnConnect,
  );
});

it("finds workspace imports an embed bundle failed to inline", () => {
  const source = [
    'import { AppId } from "@lecturn/contracts/apps";',
    'export * from "@lecturn/shared/mcpApp";',
    'type Bridge = import("@lecturn/contracts/embedBridge").EmbedBridge;',
    'const preload = require("@lecturn/shared/channels");',
    'import "effect/Schema";',
    'const label = "@lecturn/embed";',
    'const channel = "lecturn-embed:bounds";',
  ].join("\n");
  assert.deepStrictEqual(findWorkspacePackageImports(source), [
    "@lecturn/contracts/apps",
    "@lecturn/contracts/embedBridge",
    "@lecturn/shared/channels",
    "@lecturn/shared/mcpApp",
  ]);
});
