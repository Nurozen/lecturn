#!/usr/bin/env node
import { LECTURN_LEGAL_NOTICES } from "@lecturn/shared/legalNotices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { selectCliRuntimeExternalDependencies } from "../../../scripts/lib/cli-external-packages.ts";
import {
  LECTURN_PACK_DESCRIPTOR_FILE,
  type LecturnPackDescriptor,
} from "../../../scripts/lib/lecturn-pack.ts";
import { loadRepoEnv, resolvePublicConfig } from "../../../scripts/lib/public-config.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { normalizeSecureRelayUrl } from "@lecturn/shared/relayUrl";
import { fromJsonStringPretty } from "@lecturn/shared/schemaJson";
import { fromYaml } from "@lecturn/shared/schemaYaml";
import { resolveSpawnCommand } from "@lecturn/shared/shell";
import { STAVE_PLATFORM_KEYS } from "@lecturn/shared/stave";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliEmbedBuildMissingError,
  ServerCliEmbedWorkspaceImportError,
  ServerCliExecutableImportError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";

interface PackageJson {
  license: string;
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

export const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const brand = resolveWebAssetBrandForPackageVersion(version);
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    Effect.all({
      original: fs.readFile(icon.targetPath),
      publish: fs.readFile(icon.sourcePath),
    }).pipe(Effect.map((contents) => ({ ...icon, ...contents }))),
  );
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      yield* fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(serverDir, "dist/LICENSE"));
      yield* fs.writeFileString(
        path.join(serverDir, "dist/THIRD_PARTY_NOTICES.txt"),
        LECTURN_LEGAL_NOTICES,
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

/**
 * Asserts the bundled Stave binary is present for every supported platform key
 * under dist/stave before publishing. Release CI fetches these with
 * `scripts/fetch-stave.ts --all`; a missing key means the npm package would
 * ship without Stave for that host, so publishing stops at the first gap.
 */
const assertStaveBinaries = Effect.fn("assertStaveBinaries")(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const platformKey of STAVE_PLATFORM_KEYS) {
    const binaryName = platformKey.startsWith("win32-") ? "stave.exe" : "stave";
    const assetPath = path.join(serverDir, "dist/stave", platformKey, binaryName);
    if (!(yield* fs.exists(assetPath))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath });
    }
  }

  yield* Effect.log(`[cli] Bundled Stave binaries present for: ${STAVE_PLATFORM_KEYS.join(", ")}`);
});

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            LECTURN_PACK_EXE: "1",
            ...Option.match(config.target, {
              onNone: () => ({}),
              onSome: (target) => ({ LECTURN_PACK_EXE_TARGET: target }),
            }),
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // The executable can only `import` built-ins. A file-backed import
      // passes the bundler and `node dist/bin.mjs`, then throws inside the
      // binary, so read the emitted module graph rather than trusting config.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/lecturn (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    "Build the server as a Node single-executable (needs a Node 25.7+ host for --build-sea). The binary still resolves native packages from a node_modules tree beside it.",
  ),
);

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
  readonly packageName: Option.Option<string>;
}

export const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    // pnpm matches --filter against the manifest name, which has already been
    // rewritten by the time publish runs, so follow the published name.
    Option.getOrElse(config.packageName, () => "lecturn"),
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

export const createVpPmPackArgs = (
  packageName: Option.Option<string>,
  outDir: string,
): ReadonlyArray<string> => [
  "pack",
  "--filter",
  Option.getOrElse(packageName, () => "lecturn"),
  "--pack-destination",
  outDir,
];

export interface PublishManifestInput {
  readonly version: string;
  readonly workspaceConfig: WorkspaceConfig;
  readonly packageName?: string | undefined;
  readonly binName?: string | undefined;
  readonly githubRepository?: string | undefined;
  /**
   * vp pack inlines every other dependency, and the private workspace ones are
   * not on npm, so a clean install of a vendored tarball fails unless the
   * manifest declares only what dist/ still imports at runtime.
   */
  readonly runtimeExternalsOnly?: boolean | undefined;
}

export const buildPublishManifest = (input: PublishManifestInput): PackageJson => {
  const workspaceCatalog = input.workspaceConfig.catalog ?? {};
  const workspaceOverrides = input.workspaceConfig.overrides ?? {};
  const dependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    workspaceCatalog,
    "apps/server",
  );
  return {
    license: serverPackageJson.license,
    name: input.packageName ?? serverPackageJson.name,
    repository: input.githubRepository
      ? { ...serverPackageJson.repository, url: `https://github.com/${input.githubRepository}` }
      : serverPackageJson.repository,
    bin:
      input.binName === undefined
        ? serverPackageJson.bin
        : { [input.binName]: serverPackageJson.bin.lecturn },
    type: serverPackageJson.type,
    version: input.version,
    engines: serverPackageJson.engines,
    files: serverPackageJson.files,
    dependencies: input.runtimeExternalsOnly
      ? selectCliRuntimeExternalDependencies(dependencies)
      : dependencies,
    overrides: resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/server"),
  };
};

/** The file name `pnpm pack` gives a package's tarball. */
export const packTarballName = (name: string, version: string): string =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

const patchSelectorPackageName = (selector: string): string => {
  const versionAt = selector.lastIndexOf("@");
  return versionAt > 0 ? selector.slice(0, versionAt) : selector;
};

/** Keeps the patches whose package (`<name>@<version>` selector) is a declared dependency. */
const selectPackPatchedDependencies = (
  patchedDependencies: Readonly<Record<string, string>>,
  dependencyNames: ReadonlyArray<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(patchedDependencies).filter(([selector]) =>
      dependencyNames.includes(patchSelectorPackageName(selector)),
    ),
  );

/**
 * @lecturn/embed must inline its private workspace imports (contracts,
 * shared) into dist, declarations included, because those packages are not on
 * npm. Source maps are skipped: their sourcesContent quotes the originals.
 */
export const findWorkspacePackageImports = (source: string): ReadonlyArray<string> => {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(
    /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](@lecturn\/[^"']+)["']/g,
  )) {
    if (match[1] !== undefined) specifiers.add(match[1]);
  }
  return [...specifiers].toSorted();
};

const collectPublishedExportTargets = (
  exports: Readonly<Record<string, string | Readonly<Record<string, string>>>>,
): ReadonlyArray<string> => [
  ...new Set(
    Object.values(exports).flatMap((target) =>
      typeof target === "string" ? [target] : Object.values(target),
    ),
  ),
];

export interface PackBuildFactsInput {
  /** What `lecturn#build` read: the repo .env and .env.local over the process env (vite.config.ts). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoEnvFile: boolean;
  readonly version: string;
}

/** Mirrors hasCloudPublicConfig and AnalyticsService, which read these keys as build-time defines. */
export const derivePackBuildFacts = (
  input: PackBuildFactsInput,
): LecturnPackDescriptor["build"] => {
  const publicConfig = resolvePublicConfig(input.env);
  return {
    repoEnvFile: input.repoEnvFile,
    lecturnConnect: Boolean(
      normalizeSecureRelayUrl(publicConfig.relayUrl ?? "") &&
      publicConfig.clerkPublishableKey &&
      publicConfig.clerkCliOAuthClientId,
    ),
    telemetry: Boolean(input.env.LECTURN_POSTHOG_KEY?.trim()),
    // withPackageManifest swaps the release icons in for the pack, as for publish.
    icons: resolveWebAssetBrandForPackageVersion(input.version),
  };
};

// @cursor/sdk finds its platform helper (sandbox, rg, tree-sitter) by walking
// up from argv[1] for node_modules/@cursor/sdk-<platform>-<arch>.
const CURSOR_HELPER_HOIST_PATTERN = "@cursor/sdk-*";

export interface PackDescriptorInput {
  readonly server: Pick<PackageJson, "name" | "version" | "bin" | "dependencies">;
  readonly embed: {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: Readonly<Record<string, string>> | undefined;
  };
  readonly workspaceConfig: WorkspaceConfig;
  readonly build: LecturnPackDescriptor["build"];
}

export const buildPackDescriptor = (input: PackDescriptorInput): LecturnPackDescriptor => {
  const dependencyNames = [
    ...Object.keys(input.server.dependencies),
    ...Object.keys(input.embed.dependencies ?? {}),
  ];
  const patched = selectPackPatchedDependencies(
    input.workspaceConfig.patchedDependencies ?? {},
    dependencyNames,
  );
  return {
    version: 1,
    packages: {
      lecturn: {
        name: input.server.name,
        version: input.server.version,
        tarball: packTarballName(input.server.name, input.server.version),
        bin: input.server.bin,
      },
      embed: {
        name: input.embed.name,
        version: input.embed.version,
        tarball: packTarballName(input.embed.name, input.embed.version),
      },
    },
    pnpm: {
      nodeLinker: "hoisted",
      publicHoistPattern: [CURSOR_HELPER_HOIST_PATTERN],
      allowBuilds: Object.fromEntries(
        Object.entries(input.workspaceConfig.allowBuilds ?? {}).filter(([name]) =>
          dependencyNames.includes(name),
        ),
      ),
      patchedDependencies: Object.fromEntries(
        Object.entries(patched).map(([selector, patchPath]) => [
          selector,
          `patches/${patchPath.slice(patchPath.lastIndexOf("/") + 1)}`,
        ]),
      ),
    },
    notes: [
      `Install hoisted (nodeLinker: hoisted). An isolated install also needs publicHoistPattern ["${CURSOR_HELPER_HOIST_PATTERN}"]: @cursor/sdk finds its platform helper by walking up from argv[1], and without the hoist it stays inside the virtual store.`,
      "patchedDependencies paths are relative to this file. The @ff-labs/fff-node patch is required when the tree is packed into an asar (it loads libfff_c from *.asar.unpacked); the node-pty patch only changes Windows.",
      "Inside an asar on macOS and Linux, name the archive app.asar or node_modules.asar (node-pty only rewrites those to .unpacked for spawn-helper), unpack *.node, *.dylib, *.so*, *.dll and spawn-helper, and copy @cursor/sdk-* beside the archive as real files.",
      `Built ${input.build.repoEnvFile ? "with" : "without"} a repo .env: Lecturn Connect ${input.build.lecturnConnect ? "available" : "unavailable (lecturn connect reports missing public configuration)"}, telemetry ${input.build.telemetry ? "enabled" : "off (no PostHog key)"}, ${input.build.icons} icons.`,
    ],
    build: input.build,
  };
};

interface ManifestFlags {
  readonly appVersion: Option.Option<string>;
  readonly packageName: Option.Option<string>;
  readonly binName: Option.Option<string>;
  readonly verbose: boolean;
}

interface PublishFlags extends PublishCommandConfig, ManifestFlags {
  readonly requireStave: boolean;
}

/**
 * Rewrites the apps/server manifest (resolved catalog versions, package/bin
 * name, repository) and release icons for the duration of `use`, then restores
 * them. `use` runs vp pm from the workspace root so pnpm-only workspace
 * config, including override selectors, is interpreted correctly.
 */
const withPackageManifest = <A, E, R>(
  config: ManifestFlags & { readonly runtimeExternalsOnly: boolean },
  use: (manifest: PackageJson) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = yield* RepoRoot;
    const serverDir = path.join(repoRoot, "apps/server");
    const packageJsonPath = path.join(serverDir, "package.json");

    for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
      const abs = path.join(serverDir, relPath);
      if (!(yield* fs.exists(abs))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
      }
    }

    return yield* Effect.acquireUseRelease(
      // Acquire: resolve publish metadata and read every original before mutation.
      Effect.gen(function* () {
        const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
        const workspaceConfig = yield* readWorkspaceConfig();
        const pkg = buildPublishManifest({
          version,
          workspaceConfig,
          packageName: Option.getOrUndefined(config.packageName),
          binName: Option.getOrUndefined(config.binName),
          githubRepository: process.env.GITHUB_REPOSITORY,
          runtimeExternalsOnly: config.runtimeExternalsOnly,
        });

        return {
          pkg,
          packageJsonString: yield* encodePackageJson(pkg),
          originalPackageJson: yield* fs.readFile(packageJsonPath),
          icons: yield* preparePublishIcons(repoRoot, serverDir, version),
        };
      }),
      (resource) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(packageJsonPath, `${resource.packageJsonString}\n`);
          for (const icon of resource.icons) {
            yield* fs.writeFile(icon.targetPath, icon.publish);
          }
          yield* Effect.log("[cli] Applied package metadata and publish icon overrides");
          return yield* use(resource.pkg);
        }),
      // Release: restore every file even if applying overrides or `use` fails.
      (resource) =>
        Effect.gen(function* () {
          yield* fs.writeFile(packageJsonPath, resource.originalPackageJson);
          for (const icon of resource.icons) {
            yield* fs.writeFile(icon.targetPath, icon.original);
          }
          if (config.verbose) yield* Effect.log("[cli] Restored original publish assets");
        }),
    );
  });

const runVpPm = Effect.fn("runVpPm")(function* (args: ReadonlyArray<string>, verbose: boolean) {
  const repoRoot = yield* RepoRoot;
  const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);
  yield* Effect.log(`[cli] Running: vp pm ${args.join(" ")}`);
  yield* runCommand(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: repoRoot,
      stdout: verbose ? "inherit" : "ignore",
      stderr: "inherit",
      shell: spawnCommand.shell,
    }),
  );
});

/** Publishes apps/server itself as the Node-script `lecturn` package. */
const publishNodePackage = Effect.fn("publishNodePackage")(function* (config: PublishFlags) {
  if (config.requireStave) {
    const path = yield* Path.Path;
    yield* assertStaveBinaries(path.join(yield* RepoRoot, "apps/server"));
  }
  yield* withPackageManifest({ ...config, runtimeExternalsOnly: false }, () =>
    runVpPm(createVpPmPublishArgs(config), config.verbose),
  );
});

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.String("app-version").pipe(Flag.optional),
    packageName: Flag.String("package-name").pipe(Flag.optional),
    binName: Flag.String("bin-name").pipe(Flag.optional),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    requireStave: Flag.Boolean("require-stave").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  publishNodePackage,
).pipe(Command.withDescription("Publish apps/server to npm as the lecturn Node package."));

const EmbedPackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  publishConfig: Schema.Struct({
    exports: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
    ),
  }),
});
const decodeEmbedPackageJson = Schema.decodeEffect(Schema.fromJsonString(EmbedPackageJson));

/** Every published export must exist, and no emitted file may still import a workspace package. */
const assertEmbedBuilt = Effect.fn("assertEmbedBuilt")(function* (embedDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* decodeEmbedPackageJson(
    yield* fs.readFileString(path.join(embedDir, "package.json")),
  );
  for (const target of collectPublishedExportTargets(manifest.publishConfig.exports)) {
    const assetPath = path.join(embedDir, target);
    if (!(yield* fs.exists(assetPath))) {
      return yield* new ServerCliEmbedBuildMissingError({ assetPath });
    }
  }
  const distDir = path.join(embedDir, "dist");
  for (const file of yield* fs.readDirectory(distDir, { recursive: true })) {
    if (!/\.(?:[cm]?js|d\.[cm]?ts)$/.test(file)) continue;
    const filePath = path.join(distDir, file);
    const specifiers = findWorkspacePackageImports(yield* fs.readFileString(filePath));
    if (specifiers.length > 0) {
      return yield* new ServerCliEmbedWorkspaceImportError({ filePath, specifiers });
    }
  }
  return manifest;
});

const decodeJsonObject = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * pnpm pack resolves every `workspace:` spec, devDependencies included, and
 * fails on @lecturn/shared, which has no version. A consumer never installs
 * devDependencies, and the workspace ones are bundled into dist, so the packed
 * manifest drops them; the original is restored afterwards.
 */
const withEmbedPackManifest = <A, E, R>(embedDir: string, use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const packageJsonPath = path.join(embedDir, "package.json");
    return yield* Effect.acquireUseRelease(
      fs.readFile(packageJsonPath),
      (original) =>
        Effect.gen(function* () {
          const { devDependencies: _devDependencies, ...packed } = yield* decodeJsonObject(
            new TextDecoder().decode(original),
          );
          yield* fs.writeFileString(packageJsonPath, `${yield* encodePackageJson(packed)}\n`);
          return yield* use;
        }),
      (original) => fs.writeFile(packageJsonPath, original),
    );
  });

const readPackBuildFacts = Effect.fn("readPackBuildFacts")(function* (
  repoRoot: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoEnvFile =
    (yield* fs.exists(path.join(repoRoot, ".env"))) ||
    (yield* fs.exists(path.join(repoRoot, ".env.local")));
  const env = yield* Effect.sync(() => loadRepoEnv({ repoRoot }));
  return derivePackBuildFacts({ env, repoEnvFile, version });
});

/**
 * Emits the vendoring kit an embedding host installs from: the lecturn and
 * @lecturn/embed tarballs, the patches their runtime dependencies need, and
 * lecturn-pack.json with the pnpm settings and build facts.
 */
const packVendorKit = Effect.fn("packVendorKit")(function* (
  config: ManifestFlags & { readonly outDir: string },
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const outDir = path.resolve(config.outDir);

  const embedDir = path.join(repoRoot, "packages/embed");
  const embed = yield* assertEmbedBuilt(embedDir);
  yield* fs.makeDirectory(outDir, { recursive: true });
  const server = yield* withPackageManifest({ ...config, runtimeExternalsOnly: true }, (manifest) =>
    runVpPm(createVpPmPackArgs(config.packageName, outDir), config.verbose).pipe(
      Effect.as(manifest),
    ),
  );
  yield* withEmbedPackManifest(
    embedDir,
    runVpPm(createVpPmPackArgs(Option.some(embed.name), outDir), config.verbose),
  );

  const workspaceConfig = yield* readWorkspaceConfig();
  const descriptor = buildPackDescriptor({
    server,
    embed,
    workspaceConfig,
    build: yield* readPackBuildFacts(repoRoot, server.version),
  });
  for (const { tarball } of Object.values(descriptor.packages)) {
    const assetPath = path.join(outDir, tarball);
    if (!(yield* fs.exists(assetPath))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath });
    }
  }

  const patchesDir = path.join(outDir, "patches");
  yield* fs.remove(patchesDir, { recursive: true, force: true });
  yield* fs.makeDirectory(patchesDir, { recursive: true });
  for (const [selector, target] of Object.entries(descriptor.pnpm.patchedDependencies)) {
    const source = workspaceConfig.patchedDependencies?.[selector];
    if (source === undefined) continue;
    yield* fs.copyFile(path.join(repoRoot, source), path.join(outDir, target));
  }
  yield* fs.writeFileString(
    path.join(outDir, LECTURN_PACK_DESCRIPTOR_FILE),
    `${yield* encodePackageJson(descriptor)}\n`,
  );
  yield* Effect.log(
    `[cli] Packed ${descriptor.packages.lecturn.tarball} and ${descriptor.packages.embed.tarball} into ${outDir}`,
  );
});

const packCmd = Command.make(
  "pack",
  {
    outDir: Flag.String("out-dir").pipe(
      Flag.withDescription("Directory that receives the vendoring kit (created if missing)."),
    ),
    appVersion: Flag.String("app-version").pipe(Flag.optional),
    packageName: Flag.String("package-name").pipe(Flag.optional),
    binName: Flag.String("bin-name").pipe(Flag.optional),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  packVendorKit,
).pipe(
  Command.withDescription(
    "Pack the built apps/server and packages/embed as vendorable tarballs, with the patches and lecturn-pack.json an embedding host installs from.",
  ),
);

const cli = Command.make("cli").pipe(
  Command.withDescription("Lecturn server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd, packCmd]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
