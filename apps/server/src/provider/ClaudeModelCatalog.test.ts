import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@lecturn/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  mergeClaudeRuntimeModelCatalog,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

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
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
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

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("discovers future runtime models, deduplicates aliases and dispatches their exact IDs", () => {
    const catalog = mergeClaudeRuntimeModelCatalog(catalogFromManifest(manifest()), [
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
    const catalog = mergeClaudeRuntimeModelCatalog(catalogFromManifest(manifest()), [
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
    const original = catalogFromManifest(manifest());
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
    const catalog = mergeClaudeRuntimeModelCatalog(catalogFromManifest(manifest()), [
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
    const base = catalogFromManifest(manifest());
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
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
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
    const catalog = catalogFromManifest(input);
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

  it("preserves only SDK effort levels for uncatalogued models", () => {
    const catalog = catalogFromManifest(manifest());
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      assert.strictEqual(resolveClaudeCatalogEffort(catalog, "custom", ` ${effort} `), effort);
    }
    for (const effort of [undefined, null, "", "  ", "brutal", "extreme", "HIGH", "ultrathink"]) {
      assert.isUndefined(resolveClaudeCatalogEffort(catalog, "custom", effort));
    }
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"));
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "max"), "max");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "max", "synthetic"), "max");

    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});
