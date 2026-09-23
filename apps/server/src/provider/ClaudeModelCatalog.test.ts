import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@lecturn/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  mergeClaudeRuntimeModelCatalog,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [{ id: "large", label: "Large", isDefault: true }],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

describe("Claude model catalog", () => {
  it("discovers future runtime models, deduplicates aliases and dispatches their exact IDs", () => {
    const catalog = mergeClaudeRuntimeModelCatalog(resolveClaudeModelCatalog(manifest()), [
      {
        value: "default",
        resolvedModel: "claude-synthetic-future[1m]",
        displayName: "Default",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "future"],
        supportsFastMode: true,
      },
      {
        value: "synthetic[1m]",
        resolvedModel: "claude-synthetic-future[1m]",
        displayName: "Synthetic Future",
        description: "",
      },
    ]);
    assert.deepStrictEqual(
      catalog.models.map((entry) => entry.model.slug),
      ["claude-synthetic-future[1m]", "claude-synthetic-next"],
    );
    assert.strictEqual(catalog.models[0]?.model.name, "Synthetic Future");
    assert.isTrue(catalog.models[0]?.model.isDefault);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-future[1m]");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-future"),
      "claude-synthetic-future[1m]",
    );
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection),
      "claude-synthetic-future[1m]",
    );
    assert.strictEqual(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    const caps = getClaudeCatalogModelCapabilities(catalog, "synthetic");
    const effort = caps.optionDescriptors?.find((option) => option.id === "effort");
    assert.deepStrictEqual(
      effort?.type === "select" ? effort.options.map((option) => option.id) : [],
      ["low", "high", "future"],
    );
    assert.isTrue(caps.optionDescriptors?.some((option) => option.id === "fastMode"));
    assert.strictEqual(
      resolveClaudeModelSlug(scopeClaudeModelCatalog(catalog, ["synthetic"]), "synthetic"),
      "synthetic",
    );
  });

  it("uses explicit runtime capability removals and availability over stale manifest data", () => {
    const catalog = mergeClaudeRuntimeModelCatalog(resolveClaudeModelCatalog(manifest()), [
      {
        value: "synthetic",
        resolvedModel: "claude-synthetic-next",
        displayName: "Updated Runtime Name",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsFastMode: false,
      },
    ]);
    const models = resolveClaudeModelsForVersion(catalog, "1.0.0");
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0]?.name, "Updated Runtime Name");
    assert.deepStrictEqual(
      models[0]?.capabilities?.optionDescriptors?.map((option) => option.id),
      ["contextWindow"],
    );
    assert.isUndefined(formatClaudeVersionUpgradeMessage(catalog, "1.0.0"));
  });

  it("keeps absent capability metadata and legacy supplements, but never pins unresolved aliases", () => {
    const original = resolveClaudeModelCatalog(manifest());
    assert.strictEqual(mergeClaudeRuntimeModelCatalog(original, []), original);
    assert.strictEqual(mergeClaudeRuntimeModelCatalog(original), original);
    assert.strictEqual(mergeClaudeRuntimeModelCatalog(original, null), original);
    const matched = mergeClaudeRuntimeModelCatalog(original, [
      {
        value: "claude-synthetic-next",
        displayName: "Known",
        description: "",
        supportsEffort: true,
      },
    ]);
    assert.deepStrictEqual(
      matched.models[0]?.model.capabilities,
      original.models[0]?.model.capabilities,
    );
    const unresolved = mergeClaudeRuntimeModelCatalog(original, [
      {
        value: "synthetic",
        displayName: "Moving Alias",
        description: "",
      },
    ]);
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(unresolved, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "synthetic",
    );
    assert.strictEqual(unresolved.models.length, 2);
  });

  it("preserves resolved suffixes without applying an old manifest suffix again", () => {
    const catalog = mergeClaudeRuntimeModelCatalog(resolveClaudeModelCatalog(manifest()), [
      {
        value: "synthetic",
        resolvedModel: "claude-synthetic-next[large]",
        displayName: "Known Large",
        description: "",
      },
    ]);
    assert.strictEqual(catalog.models.length, 1);
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-synthetic-next",
        options: [{ id: "contextWindow", value: "large" }],
      }),
      "claude-synthetic-next[large]",
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
    );
  });

  it("lets native efforts and the runtime default override old manifest mappings", () => {
    const base = resolveClaudeModelCatalog(manifest());
    const catalog = mergeClaudeRuntimeModelCatalog(
      {
        models: base.models.map((entry) => ({
          ...entry,
          model: { ...entry.model, isDefault: true },
        })),
      },
      [
        {
          value: "default",
          resolvedModel: "claude-synthetic-future",
          displayName: "Future",
          description: "",
        },
        {
          value: "synthetic",
          resolvedModel: "claude-synthetic-next",
          displayName: "Known",
          description: "",
          supportedEffortLevels: ["extreme"],
        },
      ],
    );
    assert.deepStrictEqual(
      catalog.models.filter((entry) => entry.model.isDefault).map((entry) => entry.model.slug),
      ["claude-synthetic-future"],
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "extreme");
  });

  it("matches resolved dated IDs to manifest aliases without duplicating models or losing options", () => {
    const known = {
      models: [
        {
          model: {
            slug: "claude-synthetic-thinking",
            name: "Synthetic Thinking",
            aliases: ["moving", "claude-synthetic-thinking-20990101"],
            isCustom: false,
            capabilities: {
              optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" as const }],
            },
          },
          runtime: { fixedContextWindowTokens: 200_000 },
          compatibility: {},
        },
      ],
    };
    const catalog = mergeClaudeRuntimeModelCatalog(known, [
      {
        value: "moving",
        resolvedModel: "claude-synthetic-thinking-20990101",
        displayName: "Runtime Thinking",
        description: "",
        supportsEffort: false,
      },
    ]);
    assert.strictEqual(catalog.models.length, 1);
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(catalog, "moving"),
      known.models[0]?.model.capabilities,
    );
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-synthetic-thinking",
    };
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection),
      "claude-synthetic-thinking-20990101",
    );
    assert.strictEqual(resolveClaudeCatalogContextWindowTokens(catalog, selection), 200_000);
    const unresolved = mergeClaudeRuntimeModelCatalog(known, [
      { value: "moving", displayName: "Moving", description: "" },
    ]);
    assert.strictEqual(resolveClaudeModelSlug(unresolved, "moving"), "moving");
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(unresolved, "moving").optionDescriptors,
      [],
    );
  });
  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = resolveClaudeModelCatalog(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });
});
