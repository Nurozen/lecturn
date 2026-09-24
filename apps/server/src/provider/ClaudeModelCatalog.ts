import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeCustomModelSlug,
} from "@lecturn/shared/model";
import { compareSemverVersions } from "@lecturn/shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import {
  BUNDLED_MODEL_MANIFEST,
  type ModelManifestData,
  resolveProviderCatalog,
} from "./ModelManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
}

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

function tryResolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog | null {
  const resolved = resolveProviderCatalog(manifest, CLAUDE);
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: entry.model,
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

export function resolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(manifest) ??
    tryResolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST);

/** Initialization metadata from Claude Code; optional fields vary with the installed CLI. */
export interface ClaudeRuntimeModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
}

function runtimeCapabilities(
  info: ClaudeRuntimeModelInfo,
  known: ClaudeCatalogModel | undefined,
  hasContextSuffix: boolean,
): ModelCapabilities {
  const descriptors: Array<ProviderOptionDescriptor> = [
    ...(known?.model.capabilities?.optionDescriptors ?? []),
  ].filter(
    (descriptor) =>
      !(descriptor.id === "contextWindow" && hasContextSuffix) &&
      !(
        descriptor.id === "effort" &&
        (info.supportsEffort === false || info.supportedEffortLevels !== undefined)
      ) &&
      !(descriptor.id === "fastMode" && info.supportsFastMode !== undefined),
  );
  const levels = [
    ...new Set(info.supportedEffortLevels?.map((level) => level.trim()).filter(Boolean)),
  ];
  if (info.supportsEffort !== false && levels.length > 0) {
    const previous = known?.model.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
    );
    const extensions =
      previous?.type === "select"
        ? previous.options.filter((option) => {
            if (levels.includes(option.id)) return false;
            const mapped = known?.runtime.effortMap?.[option.id];
            return (
              previous.promptInjectedValues?.includes(option.id) ||
              (typeof mapped === "string" && levels.includes(mapped))
            );
          })
        : [];
    const defaultLevel = levels.includes("high") ? "high" : levels[0];
    descriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        ...levels.map((level) => ({
          id: level,
          label: level === "xhigh" ? "Extra High" : level.charAt(0).toUpperCase() + level.slice(1),
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        ...extensions.map((option) => ({ ...option, isDefault: false })),
      ],
      ...(previous?.type === "select" && previous.promptInjectedValues
        ? {
            promptInjectedValues: previous.promptInjectedValues.filter((id) =>
              extensions.some((option) => option.id === id),
            ),
          }
        : {}),
    });
  }
  if (info.supportsFastMode === true) {
    descriptors.push({ id: "fastMode", label: "Fast Mode", type: "boolean" });
  }
  return { optionDescriptors: descriptors };
}

/** Runtime availability and capabilities win; the manifest supplies legacy models and extras. */
export function mergeClaudeRuntimeModelCatalog(
  catalog: ClaudeModelCatalog,
  runtimeModels?: ReadonlyArray<ClaudeRuntimeModelInfo> | null,
): ClaudeModelCatalog {
  const discovered = new Map<string, ClaudeCatalogModel>();
  const supplemented = new Set<string>();
  const runtimeAliases = new Map<string, string>();
  for (const info of runtimeModels ?? []) {
    const alias = info.value.trim();
    const slug = info.resolvedModel?.trim() || alias;
    if (!slug || !alias) continue;
    runtimeAliases.set(alias.toLowerCase(), slug);
    const suffix = /\[([^\]]+)\]$/.exec(slug);
    const baseSlug = suffix ? slug.slice(0, suffix.index) : slug;
    const aliasBase = alias.replace(/\[[^\]]+\]$/, "");
    if (aliasBase !== alias) runtimeAliases.set(aliasBase.toLowerCase(), slug);
    // An unresolved moving alias must never inherit an older model's canonical ID.
    const known =
      catalog.models.find((entry) => entry.model.slug === slug) ??
      catalog.models.find((entry) => entry.model.slug === baseSlug) ??
      (info.resolvedModel?.trim()
        ? catalog.models.find((entry) =>
            entry.model.aliases?.some((candidate) => candidate === slug || candidate === baseSlug),
          )
        : undefined);
    if (known) supplemented.add(known.model.slug);
    const existing = discovered.get(slug);
    const aliases = [
      ...new Set([
        ...(existing?.model.aliases ?? []),
        ...(known?.model.aliases ?? []),
        ...(known && known.model.slug !== slug ? [known.model.slug] : []),
        ...(baseSlug !== slug ? [baseSlug] : []),
        ...(alias !== slug ? [alias] : []),
        ...(aliasBase !== alias ? [aliasBase] : []),
      ]),
    ];
    const contextSize = suffix ? /^(\d+(?:\.\d+)?)([km])$/i.exec(suffix[1]!) : null;
    const fixedTokens = contextSize
      ? Number(contextSize[1]) * (contextSize[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000)
      : undefined;
    const previousRuntime = existing?.runtime ?? known?.runtime ?? {};
    const runtime = {
      ...previousRuntime,
      ...(previousRuntime.effortMap && info.supportedEffortLevels
        ? {
            effortMap: Object.fromEntries(
              Object.entries(previousRuntime.effortMap).filter(
                ([level]) => !info.supportedEffortLevels?.includes(level),
              ),
            ),
          }
        : {}),
    };
    discovered.set(slug, {
      model: {
        ...known?.model,
        slug,
        name:
          alias === "default" && existing ? existing.model.name : info.displayName.trim() || slug,
        aliases,
        isCustom: false,
        ...(alias === "default" || existing?.model.isDefault ? { isDefault: true } : {}),
        capabilities: runtimeCapabilities(info, existing ?? known, suffix !== null),
      },
      runtime: suffix
        ? {
            ...(runtime.effortMap ? { effortMap: runtime.effortMap } : {}),
            ...(fixedTokens ? { fixedContextWindowTokens: fixedTokens } : {}),
          }
        : runtime,
      // The running CLI has already confirmed availability, regardless of an old version gate.
      compatibility: {},
    });
  }
  if (discovered.size === 0) return catalog;
  const claimedAliases = new Set(
    [...discovered.values()]
      .flatMap((entry) => [entry.model.slug, ...(entry.model.aliases ?? [])])
      .map((alias) => alias.toLowerCase()),
  );
  return {
    models: [
      ...[...discovered.values()].map((entry) => ({
        ...entry,
        model: {
          ...entry.model,
          ...(runtimeAliases.has("default")
            ? { isDefault: runtimeAliases.get("default") === entry.model.slug }
            : {}),
          aliases: (entry.model.aliases ?? []).filter((alias) => {
            const owner = runtimeAliases.get(alias.toLowerCase());
            return owner === undefined || owner === entry.model.slug;
          }),
        },
      })),
      ...catalog.models
        .filter((entry) => !supplemented.has(entry.model.slug))
        .map((entry) => ({
          ...entry,
          model: {
            ...entry.model,
            ...(runtimeAliases.has("default") ? { isDefault: false } : {}),
            ...(entry.model.aliases
              ? {
                  aliases: entry.model.aliases.filter(
                    (alias) => !claimedAliases.has(alias.toLowerCase()),
                  ),
                }
              : {}),
          },
        })),
    ],
  };
}

/** Keeps custom model aliases opaque while preserving canonical built-in models and capabilities. */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<string>,
): ClaudeModelCatalog {
  const customAliases = new Set(
    customModels.flatMap((model) => {
      const slug = normalizeCustomModelSlug(model);
      return slug ? [slug.toLowerCase()] : [];
    }),
  );
  if (customAliases.size === 0) return catalog;

  return {
    models: catalog.models.map((entry) => {
      if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
        return entry;
      }
      return {
        ...entry,
        model: {
          ...entry.model,
          aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
        },
      };
    }),
  };
}

export function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  return catalog.models
    .filter((entry) => isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

export function isClaudeCatalogUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeCatalogContextWindow(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    selections: modelSelection.options,
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const contextWindow = resolveClaudeCatalogContextWindow(catalog, modelSelection);
  return contextWindow ? entry.runtime.contextWindowTokens?.[contextWindow] : undefined;
}
