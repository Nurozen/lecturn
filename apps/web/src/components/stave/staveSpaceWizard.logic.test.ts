import { describe, expect, it } from "vite-plus/test";
import type {
  StaveMemoryProvider,
  StaveOperationError,
  StaveRepoRow,
  StaveSagaListRow,
  StaveSpaceListRow,
} from "@lecturn/contracts";

import {
  buildCreateSagaOperation,
  buildCreateSpaceOperation,
  buildRegisterRepoOperation,
  buildRemovePartialSpaceOperation,
  canAdvance,
  createInitialSagaWizardState,
  createInitialWizardState,
  describeCreateSpaceCommand,
  describeRegisterRepoCommand,
  EMPTY_WIZARD_CONTEXT,
  findSagaByRoot,
  isOperationNotImplemented,
  memoryAvailableFrom,
  memorySuggestions,
  nextWizardStep,
  partialSpaceFromError,
  preselectSaga,
  previousWizardStep,
  resolveSpaceKind,
  reviewCommandLines,
  sagaMemberOptions,
  selectedRepoRows,
  setRepoBase,
  setRepoMode,
  setRepoRef,
  setSaga,
  spaceBaseOptions,
  syncRepoRows,
  toggleAfterMember,
  toggleMemorySpec,
  validateRegisterRepoForm,
  validateSagaWizard,
  validateSpaceId,
  validateSpaceKind,
  wizardSteps,
  type StaveSpaceWizardState,
  type StaveWizardContext,
  type StaveWizardRepoMode,
  type StaveWizardRepoRow,
} from "./staveSpaceWizard.logic";

// ── Fixtures ──────────────────────────────────────────────────

function repoRow(name: string): StaveRepoRow {
  return {
    name,
    url: `git@example.com:acme/${name}.git`,
    bareRepoPath: `/stave/repos/${name}.git`,
    tetherCount: 0,
  };
}

function liveSpace(
  overrides: Partial<StaveSpaceListRow> & { readonly id: string },
): StaveSpaceListRow {
  return {
    path: `/work/${overrides.id}`,
    isSaga: false,
    repos: [],
    archived: false,
    logicalId: overrides.id,
    manifestVersion: 2,
    memories: [],
    ...overrides,
  };
}

function archivedSpace(options: {
  readonly archiveBasename: string;
  readonly logicalId?: string | null;
}): StaveSpaceListRow {
  return {
    id: options.archiveBasename,
    path: `/work/.archive/${options.archiveBasename}`,
    isSaga: false,
    repos: [],
    archived: true,
    logicalId: options.logicalId ?? null,
    archiveBasename: options.archiveBasename,
    manifestVersion: 2,
    memories: [],
  };
}

function sagaRow(id: string, overrides: Partial<StaveSagaListRow> = {}): StaveSagaListRow {
  return {
    id,
    isSaga: true,
    members: [],
    path: `/work/${id}`,
    logicalId: id,
    ...overrides,
  };
}

function provider(available: boolean): StaveMemoryProvider {
  return { name: "marmot", default: true, available, capabilities: [] };
}

function wizardRepo(
  repo: string,
  mode: StaveWizardRepoMode,
  extra: { readonly base?: string; readonly ref?: string } = {},
): StaveWizardRepoRow {
  return { repo, mode, base: extra.base ?? "", ref: extra.ref ?? "" };
}

function wizardState(patch: Partial<StaveSpaceWizardState> = {}): StaveSpaceWizardState {
  return { ...createInitialWizardState(), ...patch };
}

function contextWith(patch: Partial<StaveWizardContext> = {}): StaveWizardContext {
  return { ...EMPTY_WIZARD_CONTEXT, ...patch };
}

describe("wizard initialization with cached data", () => {
  const cached = contextWith({
    repos: [repoRow("web"), repoRow("api")],
    sagas: [sagaRow("epic-dir", { logicalId: "epic" })],
  });

  it("reopens with the same repo choices as a first open that loaded asynchronously", () => {
    const initial = createInitialWizardState();
    const loaded = { ...initial, repos: syncRepoRows(initial.repos, cached.repos) };
    const selected = setRepoBase(setRepoMode(loaded, "web", "edit"), "web", "feature");

    const reopened = createInitialWizardState(cached);
    expect(reopened.repos).toEqual([wizardRepo("web", "none"), wizardRepo("api", "none")]);
    expect(reopened).toEqual(loaded);
    expect(selected.repos[0]).toEqual(wizardRepo("web", "edit", { base: "feature" }));
    expect(canAdvance({ ...reopened, step: "repos" }, cached).ok).toBe(false);
    expect(canAdvance({ ...setRepoMode(reopened, "web", "edit"), step: "repos" }, cached).ok).toBe(
      true,
    );
  });

  it("preselects the requested saga whether its list is cached or arrives later", () => {
    const root = "/work/epic-dir";
    const loaded = preselectSaga(
      createInitialWizardState(EMPTY_WIZARD_CONTEXT, root),
      cached.sagas,
      root,
    );
    const reopened = createInitialWizardState(cached, root);
    expect(reopened.sagaId).toBe("epic");
    expect(reopened.sagaId).toBe(loaded.sagaId);
    expect(createInitialWizardState(cached).sagaId).toBeNull();
    expect(createInitialWizardState(cached, "/work/missing").sagaId).toBeNull();
  });

  it("keeps edits when the registry refreshes after a cached open", () => {
    const selected = setRepoBase(
      setRepoMode(createInitialWizardState(cached), "web", "edit"),
      "web",
      "space:base",
    );
    const refreshed = syncRepoRows(selected.repos, [...cached.repos, repoRow("docs")]);
    expect(refreshed).toEqual([
      wizardRepo("web", "edit", { base: "space:base" }),
      wizardRepo("api", "none"),
      wizardRepo("docs", "none"),
    ]);
  });

  it("reopens saga creation with all cached references and no previous selections", () => {
    const initial = createInitialSagaWizardState();
    const loaded = { ...initial, references: syncRepoRows(initial.references, cached.repos) };
    const selected = {
      ...loaded,
      references: [wizardRepo("web", "reference", { ref: "v1" }), wizardRepo("api", "none")],
    };
    const reopened = createInitialSagaWizardState(cached.repos);
    expect(reopened.references).toEqual([wizardRepo("web", "none"), wizardRepo("api", "none")]);
    expect(reopened).toEqual(loaded);
    expect(buildCreateSagaOperation({ ...selected, sagaId: "epic" }).references).toEqual([
      { repo: "web", ref: "v1" },
    ]);
    expect(buildCreateSagaOperation({ ...reopened, sagaId: "epic" }).references).toEqual([]);
    expect(syncRepoRows(selected.references, [...cached.repos, repoRow("docs")])).toEqual([
      ...selected.references,
      wizardRepo("docs", "none"),
    ]);
  });
});

// ── Identity ──────────────────────────────────────────────────

describe("validateSpaceId", () => {
  it("rejects empty and whitespace-only ids", () => {
    expect(validateSpaceId("", [])).toMatchObject({ ok: false, problem: "empty" });
    expect(validateSpaceId("   ", [])).toMatchObject({ ok: false, problem: "empty" });
  });

  it("rejects ids outside Stave's charset", () => {
    expect(validateSpaceId("-bad", [])).toMatchObject({ ok: false, problem: "invalid" });
    expect(validateSpaceId("a b", [])).toMatchObject({ ok: false, problem: "invalid" });
    expect(validateSpaceId("a/b", [])).toMatchObject({ ok: false, problem: "invalid" });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateSpaceId("  feature-1  ", [])).toEqual({ ok: true });
    expect(validateSpaceId("  taken  ", [liveSpace({ id: "taken" })])).toMatchObject({
      problem: "exists",
    });
  });

  it("blocks a live space by directory id and by logical id", () => {
    const spaces = [liveSpace({ id: "dir-name", logicalId: "logical-name" })];
    const byId = validateSpaceId("dir-name", spaces);
    expect(byId).toMatchObject({ ok: false, problem: "exists" });
    expect(byId.message).toContain("/work/dir-name");
    expect(validateSpaceId("logical-name", spaces)).toMatchObject({
      ok: false,
      problem: "exists",
    });
  });

  it("still blocks on a live row whose manifest failed to read", () => {
    const spaces = [liveSpace({ id: "broken", logicalId: null, error: "manifest: parse error" })];
    expect(validateSpaceId("broken", spaces)).toMatchObject({ ok: false, problem: "exists" });
  });

  it("only warns when an archived row shares the id", () => {
    const viaLogicalId = validateSpaceId("ticket-9", [
      archivedSpace({ archiveBasename: "ticket-9-20260101120000", logicalId: "ticket-9" }),
    ]);
    expect(viaLogicalId.ok).toBe(true);
    expect(viaLogicalId.warning).toContain("ticket-9-20260101120000");

    const viaExactBasename = validateSpaceId("legacy", [
      archivedSpace({ archiveBasename: "legacy" }),
    ]);
    expect(viaExactBasename.ok).toBe(true);
    expect(viaExactBasename.warning).toContain("legacy");

    const viaTimestampSuffix = validateSpaceId("spike", [
      archivedSpace({ archiveBasename: "spike-20260907101500" }),
    ]);
    expect(viaTimestampSuffix.ok).toBe(true);
    expect(viaTimestampSuffix.warning).toContain("spike-20260907101500");
  });

  it("does not warn for archived rows that merely share a prefix", () => {
    expect(validateSpaceId("spike", [archivedSpace({ archiveBasename: "spike-2026" })])).toEqual({
      ok: true,
    });
    expect(
      validateSpaceId("spike", [archivedSpace({ archiveBasename: "spike-extra-20260907101500" })]),
    ).toEqual({ ok: true });
  });

  it("lists every archived match in the warning", () => {
    const result = validateSpaceId("dup", [
      archivedSpace({ archiveBasename: "dup-20260101000000" }),
      archivedSpace({ archiveBasename: "dup-20260202000000" }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("dup-20260101000000, dup-20260202000000");
  });

  it("prefers the live block over an archived warning", () => {
    const spaces = [
      archivedSpace({ archiveBasename: "x-20260101000000", logicalId: "x" }),
      liveSpace({ id: "x" }),
    ];
    expect(validateSpaceId("x", spaces)).toMatchObject({ ok: false, problem: "exists" });
  });
});

describe("validateSpaceKind / resolveSpaceKind", () => {
  it("accepts every chip as-is", () => {
    for (const kindChip of ["ticket", "spike", "audit"] as const) {
      const state = wizardState({ kindChip, customKind: "ignored" });
      expect(validateSpaceKind(state)).toEqual({ ok: true });
      expect(resolveSpaceKind(state)).toBe(kindChip);
    }
  });

  it("uses the trimmed custom text when the custom chip is selected", () => {
    expect(resolveSpaceKind(wizardState({ kindChip: "custom", customKind: "  hotfix " }))).toBe(
      "hotfix",
    );
  });

  it("requires a custom kind", () => {
    expect(validateSpaceKind(wizardState({ kindChip: "custom", customKind: "  " }))).toEqual({
      ok: false,
      message: "Enter a custom kind.",
    });
  });

  it("refuses reserved kinds case-insensitively", () => {
    expect(validateSpaceKind(wizardState({ kindChip: "custom", customKind: "review" })).ok).toBe(
      false,
    );
    const saga = validateSpaceKind(wizardState({ kindChip: "custom", customKind: "Saga" }));
    expect(saga.ok).toBe(false);
    expect(saga.message).toContain("reserved");
  });

  it("refuses custom kinds outside the id charset", () => {
    expect(validateSpaceKind(wizardState({ kindChip: "custom", customKind: "-x" })).ok).toBe(false);
    expect(validateSpaceKind(wizardState({ kindChip: "custom", customKind: "a b" })).ok).toBe(
      false,
    );
  });

  it("accepts a well-formed custom kind", () => {
    expect(validateSpaceKind(wizardState({ kindChip: "custom", customKind: "hotfix" }))).toEqual({
      ok: true,
    });
  });
});

// ── Repos ─────────────────────────────────────────────────────

describe("repo rows", () => {
  it("syncRepoRows keeps existing modes, adds new registry entries, drops unregistered", () => {
    const existing = [wizardRepo("api", "edit", { base: "main" }), wizardRepo("gone", "reference")];
    const synced = syncRepoRows(existing, [repoRow("web"), repoRow("api")]);
    expect(synced).toEqual([
      { repo: "web", mode: "none", base: "", ref: "" },
      { repo: "api", mode: "edit", base: "main", ref: "" },
    ]);
  });

  it("setRepoMode changes one row and clears emptySpace when a repo is picked", () => {
    const state = wizardState({
      emptySpace: true,
      repos: [wizardRepo("web", "none"), wizardRepo("api", "none")],
    });
    const picked = setRepoMode(state, "api", "edit");
    expect(picked.emptySpace).toBe(false);
    expect(picked.repos).toEqual([wizardRepo("web", "none"), wizardRepo("api", "edit")]);

    const cleared = setRepoMode({ ...picked, emptySpace: true }, "api", "none");
    expect(cleared.emptySpace).toBe(true);
    expect(cleared.repos[1]?.mode).toBe("none");
  });

  it("setRepoBase and setRepoRef only touch the named row", () => {
    const state = wizardState({
      repos: [wizardRepo("web", "edit"), wizardRepo("api", "reference")],
    });
    const based = setRepoBase(state, "web", "space:foo");
    expect(based.repos).toEqual([
      wizardRepo("web", "edit", { base: "space:foo" }),
      wizardRepo("api", "reference"),
    ]);
    const pinned = setRepoRef(based, "api", "v1.2.0");
    expect(pinned.repos[1]).toEqual(wizardRepo("api", "reference", { ref: "v1.2.0" }));
    expect(pinned.repos[0]).toEqual(based.repos[0]);
  });

  it("selectedRepoRows excludes rows left at none", () => {
    const state = wizardState({
      repos: [wizardRepo("a", "none"), wizardRepo("b", "edit"), wizardRepo("c", "reference")],
    });
    expect(selectedRepoRows(state).map((row) => row.repo)).toEqual(["b", "c"]);
  });
});

describe("spaceBaseOptions", () => {
  it("offers only live, error-free spaces that edit the repo", () => {
    const spaces = [
      liveSpace({ id: "edits-web", repos: [{ name: "web", mode: "edit" }] }),
      liveSpace({
        id: "dir-x",
        logicalId: "logical-x",
        repos: [{ name: "web", mode: "edit" }],
      }),
      liveSpace({ id: "refs-web", repos: [{ name: "web", mode: "reference" }] }),
      liveSpace({ id: "other-repo", repos: [{ name: "api", mode: "edit" }] }),
      liveSpace({ id: "broken", repos: [{ name: "web", mode: "edit" }], error: "bad manifest" }),
      { ...liveSpace({ id: "old", repos: [{ name: "web", mode: "edit" }] }), archived: true },
      liveSpace({ id: "no-logical", logicalId: null, repos: [{ name: "web", mode: "edit" }] }),
    ];
    expect(spaceBaseOptions(spaces, "web")).toEqual([
      { value: "space:edits-web", label: "space:edits-web" },
      { value: "space:logical-x", label: "space:logical-x" },
      { value: "space:no-logical", label: "space:no-logical" },
    ]);
    expect(spaceBaseOptions(spaces, "missing")).toEqual([]);
  });
});

describe("register repo form", () => {
  const registry = [repoRow("web")];

  it("validates name, charset, uniqueness and url in that order", () => {
    expect(validateRegisterRepoForm({ name: " ", url: "x", adopt: false }, registry).ok).toBe(
      false,
    );
    expect(
      validateRegisterRepoForm({ name: "bad name", url: "x", adopt: false }, registry).ok,
    ).toBe(false);
    const duplicate = validateRegisterRepoForm({ name: " web ", url: "x", adopt: false }, registry);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.message).toContain("'web'");
    expect(validateRegisterRepoForm({ name: "api", url: "  ", adopt: false }, registry)).toEqual({
      ok: false,
      message: "Enter a clone URL or path.",
    });
    expect(
      validateRegisterRepoForm({ name: "api", url: "git@x:y.git", adopt: true }, registry),
    ).toEqual({ ok: true });
  });

  it("buildRegisterRepoOperation trims name and url and carries adopt", () => {
    expect(
      buildRegisterRepoOperation({ name: " api ", url: " /srv/api.git ", adopt: true }),
    ).toEqual({ kind: "registerRepo", name: "api", url: "/srv/api.git", adopt: true });
  });
});

// ── Memory ────────────────────────────────────────────────────

describe("memory", () => {
  it("memorySuggestions lists a fresh store first and dedups dens across spaces", () => {
    const spaces = [
      liveSpace({
        id: "one",
        memories: [{ name: "default", provider: "marmot", id: "den-a", owned: true }],
      }),
      liveSpace({
        id: "two-dir",
        logicalId: "two",
        memories: [
          { name: "shared", provider: "marmot", id: "den-a", owned: false },
          { name: "notes", provider: "marmot", id: "den-b", owned: true },
        ],
      }),
    ];
    expect(memorySuggestions(spaces)).toEqual([
      { value: ".", label: ". (fresh task store)" },
      { value: "marmot:den-a", label: "marmot:den-a (default in one)" },
      { value: "marmot:den-b", label: "marmot:den-b (notes in two)" },
    ]);
    expect(memorySuggestions([])).toEqual([{ value: ".", label: ". (fresh task store)" }]);
  });

  it("toggleMemorySpec adds, removes and ignores blank specs", () => {
    const state = wizardState();
    const added = toggleMemorySpec(state, " marmot:den-a ");
    expect(added.memory).toEqual(["marmot:den-a"]);
    const both = toggleMemorySpec(added, ".");
    expect(both.memory).toEqual(["marmot:den-a", "."]);
    expect(toggleMemorySpec(both, "marmot:den-a").memory).toEqual(["."]);
    expect(toggleMemorySpec(both, "   ")).toBe(both);
  });

  it("memoryAvailableFrom is false while pending or when no provider is available", () => {
    expect(memoryAvailableFrom(null)).toBe(false);
    expect(memoryAvailableFrom([])).toBe(false);
    expect(memoryAvailableFrom([provider(false)])).toBe(false);
    expect(memoryAvailableFrom([provider(false), provider(true)])).toBe(true);
  });
});

// ── Saga ──────────────────────────────────────────────────────

describe("saga", () => {
  const sagas = [
    sagaRow("epic", { members: ["a", "b"] }),
    sagaRow("epic-dir", { logicalId: "epic-logical", members: ["c"] }),
  ];

  it("findSagaByRoot ignores trailing slashes on either side", () => {
    expect(findSagaByRoot(sagas, "/work/epic/")?.id).toBe("epic");
    expect(findSagaByRoot(sagas, " /work/epic ")?.id).toBe("epic");
    expect(findSagaByRoot([sagaRow("s", { path: "/work/s/" })], "/work/s")?.id).toBe("s");
    expect(findSagaByRoot(sagas, "/work/nope")).toBeUndefined();
  });

  it("preselectSaga applies the launch root once and prefers the logical id", () => {
    const state = wizardState({ after: ["stale"] });
    const selected = preselectSaga(state, sagas, "/work/epic-dir");
    expect(selected.sagaId).toBe("epic-logical");
    expect(selected.after).toEqual([]);

    const already = { ...state, sagaId: "epic" };
    expect(preselectSaga(already, sagas, "/work/epic-dir")).toBe(already);
    expect(preselectSaga(state, sagas, undefined)).toBe(state);
    expect(preselectSaga(state, sagas, "/work/unknown")).toBe(state);
  });

  it("setSaga resets the after list on change and is a no-op otherwise", () => {
    const state = wizardState({ sagaId: "epic", after: ["a"] });
    expect(setSaga(state, "epic")).toBe(state);
    const changed = setSaga(state, "epic-logical");
    expect(changed).toMatchObject({ sagaId: "epic-logical", after: [] });
    expect(setSaga(changed, null)).toMatchObject({ sagaId: null, after: [] });
  });

  it("sagaMemberOptions resolves members by logical id", () => {
    expect(sagaMemberOptions(sagas, null)).toEqual([]);
    expect(sagaMemberOptions(sagas, "epic")).toEqual(["a", "b"]);
    expect(sagaMemberOptions(sagas, "epic-logical")).toEqual(["c"]);
    expect(sagaMemberOptions(sagas, "epic-dir")).toEqual([]);
    expect(sagaMemberOptions(sagas, "missing")).toEqual([]);
  });

  it("toggleAfterMember adds and removes members", () => {
    const state = wizardState({ sagaId: "epic" });
    const one = toggleAfterMember(state, "a");
    expect(one.after).toEqual(["a"]);
    expect(toggleAfterMember(one, "b").after).toEqual(["a", "b"]);
    expect(toggleAfterMember(one, "a").after).toEqual([]);
  });
});

// ── Steps ─────────────────────────────────────────────────────

describe("wizard steps", () => {
  const withMemory = contextWith({ memoryAvailable: true });
  const withoutMemory = contextWith({ memoryAvailable: false });

  it("omits the memory step when no provider is available", () => {
    expect(wizardSteps(withMemory)).toEqual([
      "identity",
      "repos",
      "memory",
      "saga",
      "review",
      "progress",
    ]);
    expect(wizardSteps(withoutMemory)).toEqual(["identity", "repos", "saga", "review", "progress"]);
  });

  it("nextWizardStep follows the active step list", () => {
    expect(nextWizardStep("repos", withMemory)).toBe("memory");
    expect(nextWizardStep("repos", withoutMemory)).toBe("saga");
    expect(nextWizardStep("memory", withoutMemory)).toBeNull();
    expect(nextWizardStep("progress", withMemory)).toBeNull();
  });

  it("previousWizardStep follows the active step list", () => {
    expect(previousWizardStep("saga", withMemory)).toBe("memory");
    expect(previousWizardStep("saga", withoutMemory)).toBe("repos");
    expect(previousWizardStep("identity", withMemory)).toBeNull();
    expect(previousWizardStep("memory", withoutMemory)).toBeNull();
  });
});

describe("canAdvance", () => {
  it("identity: refuses an invalid id, a bad custom kind, or both spec inputs", () => {
    const context = contextWith({ spaces: [liveSpace({ id: "taken" })] });
    expect(canAdvance(wizardState({ step: "identity", spaceId: "taken" }), context).ok).toBe(false);
    expect(canAdvance(wizardState({ step: "identity", spaceId: "" }), context)).toMatchObject({
      ok: false,
      message: "Enter a space id.",
    });
    expect(
      canAdvance(
        wizardState({ step: "identity", spaceId: "ok", kindChip: "custom", customKind: "" }),
        context,
      ).ok,
    ).toBe(false);
    expect(
      canAdvance(
        wizardState({
          step: "identity",
          spaceId: "ok",
          specText: "# spec",
          specPath: "/tmp/spec.md",
        }),
        context,
      ),
    ).toEqual({ ok: false, message: "Paste a spec or give a path, not both." });
    expect(
      canAdvance(wizardState({ step: "identity", spaceId: "ok", specText: "# spec" }), context),
    ).toEqual({ ok: true });
  });

  it("repos: needs a selection unless the space is empty", () => {
    const context = contextWith();
    const none = wizardState({ step: "repos", repos: [wizardRepo("web", "none")] });
    expect(canAdvance(none, context).ok).toBe(false);
    expect(canAdvance({ ...none, emptySpace: true }, context)).toEqual({ ok: true });
    expect(
      canAdvance(wizardState({ step: "repos", repos: [wizardRepo("web", "reference")] }), context),
    ).toEqual({ ok: true });
  });

  it("repos: checks the charset of space: bases on edited repos", () => {
    const context = contextWith();
    const bad = wizardState({
      step: "repos",
      repos: [wizardRepo("web", "edit", { base: "space:-bad" })],
    });
    expect(canAdvance(bad, context)).toEqual({
      ok: false,
      message: "'space:-bad' is not a valid space reference.",
    });
    const good = wizardState({
      step: "repos",
      repos: [wizardRepo("web", "edit", { base: " space:foo " })],
    });
    expect(canAdvance(good, context)).toEqual({ ok: true });
    const plainRef = wizardState({
      step: "repos",
      repos: [wizardRepo("web", "edit", { base: "release/2026" })],
    });
    expect(canAdvance(plainRef, context)).toEqual({ ok: true });
  });

  it("saga: refuses after members without a saga", () => {
    const context = contextWith();
    expect(canAdvance(wizardState({ step: "saga", after: ["a"] }), context).ok).toBe(false);
    expect(
      canAdvance(wizardState({ step: "saga", sagaId: "epic", after: ["a"] }), context),
    ).toEqual({ ok: true });
    expect(canAdvance(wizardState({ step: "saga" }), context)).toEqual({ ok: true });
  });

  it("memory and review always pass; progress never does", () => {
    const context = contextWith();
    expect(canAdvance(wizardState({ step: "memory" }), context)).toEqual({ ok: true });
    expect(canAdvance(wizardState({ step: "review" }), context)).toEqual({ ok: true });
    expect(canAdvance(wizardState({ step: "progress" }), context)).toEqual({ ok: false });
  });
});

// ── Operations ────────────────────────────────────────────────

describe("buildCreateSpaceOperation", () => {
  it("builds the full payload", () => {
    const state = wizardState({
      spaceId: " ticket-42 ",
      title: " Fix login ",
      kindChip: "custom",
      customKind: " hotfix ",
      specPath: " /tmp/spec.md ",
      repos: [
        wizardRepo("web", "edit", { base: " space:foo " }),
        wizardRepo("api", "edit"),
        wizardRepo("docs", "reference", { ref: " v1.0 " }),
        wizardRepo("infra", "reference"),
        wizardRepo("skip", "none", { base: "x", ref: "y" }),
      ],
      memory: [" . ", "", "marmot:den-a", "  "],
      sagaId: "epic",
      after: ["a", "b"],
      common: true,
      includeWeak: true,
      noLearn: true,
    });
    expect(buildCreateSpaceOperation(state)).toEqual({
      kind: "createSpace",
      spaceId: "ticket-42",
      title: "Fix login",
      spaceKind: "hotfix",
      specPath: "/tmp/spec.md",
      edits: [{ repo: "web", base: "space:foo" }, { repo: "api" }],
      references: [{ repo: "docs", ref: "v1.0" }, { repo: "infra" }],
      memory: [{ spec: "." }, { spec: "marmot:den-a" }],
      saga: "epic",
      after: ["a", "b"],
      common: true,
      includeWeak: true,
      noLearn: true,
    });
  });

  it("omits empty title and spec, keeps pasted spec text verbatim", () => {
    const minimal = buildCreateSpaceOperation(wizardState({ spaceId: "s", title: "  " }));
    expect(minimal).not.toHaveProperty("title");
    expect(minimal).not.toHaveProperty("specText");
    expect(minimal).not.toHaveProperty("specPath");
    expect(minimal).not.toHaveProperty("saga");
    expect(minimal.spaceKind).toBe("ticket");

    const pasted = buildCreateSpaceOperation(
      wizardState({ spaceId: "s", specText: "# Title\n\n " }),
    );
    expect(pasted.specText).toBe("# Title\n\n ");
    expect(
      buildCreateSpaceOperation(wizardState({ spaceId: "s", specText: "  \n" })),
    ).not.toHaveProperty("specText");
  });

  it("forces includeWeak off without common and drops after without a saga", () => {
    const operation = buildCreateSpaceOperation(
      wizardState({ spaceId: "s", common: false, includeWeak: true, sagaId: null, after: ["a"] }),
    );
    expect(operation.includeWeak).toBe(false);
    expect(operation.after).toEqual([]);
    expect(operation).not.toHaveProperty("saga");
  });

  it("emits no repos for an empty space even when rows are selected", () => {
    const operation = buildCreateSpaceOperation(
      wizardState({
        spaceId: "s",
        emptySpace: true,
        repos: [wizardRepo("web", "edit"), wizardRepo("docs", "reference")],
      }),
    );
    expect(operation.edits).toEqual([]);
    expect(operation.references).toEqual([]);
  });
});

describe("command descriptions", () => {
  it("describeCreateSpaceCommand orders flags and masks pasted specs", () => {
    const operation = buildCreateSpaceOperation(
      wizardState({
        spaceId: "ticket-42",
        kindChip: "spike",
        specText: "# spec",
        repos: [
          wizardRepo("web", "edit", { base: "space:foo" }),
          wizardRepo("api", "edit"),
          wizardRepo("docs", "reference", { ref: "v1.0" }),
          wizardRepo("infra", "reference"),
        ],
        memory: [".", "marmot:den-a"],
        sagaId: "epic",
        after: ["a", "b"],
        common: true,
        includeWeak: true,
        noLearn: true,
      }),
    );
    expect(describeCreateSpaceCommand(operation)).toBe(
      "stave space create --kind spike --spec <pasted spec> --edit web:space:foo --edit api " +
        "--reference docs:v1.0 --reference infra --memory . --memory marmot:den-a " +
        "--saga epic --after a --after b --common --include-weak --no-learn ticket-42",
    );
  });

  it("describeCreateSpaceCommand shell-quotes values with spaces and shows spec paths", () => {
    const operation = buildCreateSpaceOperation(
      wizardState({ spaceId: "s", specPath: "/tmp/my spec.md" }),
    );
    expect(describeCreateSpaceCommand(operation)).toBe(
      "stave space create --kind ticket --spec '/tmp/my spec.md' s",
    );
    expect(reviewCommandLines(operation)).toEqual([describeCreateSpaceCommand(operation)]);
  });

  it("describeCreateSpaceCommand escapes single quotes inside quoted values", () => {
    const operation = buildCreateSpaceOperation(
      wizardState({ spaceId: "s", specPath: "/tmp/it's here.md" }),
    );
    expect(describeCreateSpaceCommand(operation)).toBe(
      "stave space create --kind ticket --spec '/tmp/it'\\''s here.md' s",
    );
  });

  it("describeRegisterRepoCommand places --adopt before the positionals", () => {
    expect(
      describeRegisterRepoCommand({
        kind: "registerRepo",
        name: "api",
        url: "/srv/api.git",
        adopt: true,
      }),
    ).toBe("stave repos add --adopt api /srv/api.git");
    expect(
      describeRegisterRepoCommand({
        kind: "registerRepo",
        name: "api",
        url: "/srv/my repos/api.git",
        adopt: false,
      }),
    ).toBe("stave repos add api '/srv/my repos/api.git'");
  });
});

// ── Saga variant ──────────────────────────────────────────────

describe("saga wizard", () => {
  it("validateSagaWizard reuses the space id rules", () => {
    const spaces = [liveSpace({ id: "epic" })];
    expect(validateSagaWizard({ ...createInitialSagaWizardState(), sagaId: "" }, spaces)).toEqual({
      ok: false,
      message: "Enter a space id.",
    });
    expect(
      validateSagaWizard({ ...createInitialSagaWizardState(), sagaId: "epic" }, spaces).ok,
    ).toBe(false);
    expect(
      validateSagaWizard({ ...createInitialSagaWizardState(), sagaId: "epic-2" }, spaces),
    ).toEqual({ ok: true });
  });

  it("buildCreateSagaOperation keeps only reference rows and trims optional text", () => {
    expect(
      buildCreateSagaOperation({
        sagaId: " epic ",
        title: " Big thing ",
        specText: "# saga",
        references: [
          wizardRepo("docs", "reference", { ref: " v2 " }),
          wizardRepo("web", "edit", { base: "main" }),
          wizardRepo("api", "reference"),
          wizardRepo("none", "none"),
        ],
        memory: [" . ", " "],
      }),
    ).toEqual({
      kind: "createSaga",
      sagaId: "epic",
      title: "Big thing",
      specText: "# saga",
      references: [{ repo: "docs", ref: "v2" }, { repo: "api" }],
      memory: [{ spec: "." }],
    });
    const bare = buildCreateSagaOperation(createInitialSagaWizardState());
    expect(bare).toEqual({ kind: "createSaga", sagaId: "", references: [], memory: [] });
  });
});

describe("isOperationNotImplemented", () => {
  const error = (patch: Partial<StaveOperationError>): StaveOperationError => ({
    code: "invalid_arguments",
    message: "Operation 'createSaga' is not implemented yet.",
    details: null,
    ...patch,
  });

  it("recognises the server's placeholder refusal", () => {
    expect(isOperationNotImplemented(error({}))).toBe(true);
    expect(isOperationNotImplemented(error({ message: "unknown operation createSaga" }))).toBe(
      true,
    );
  });

  it("ignores other codes and messages", () => {
    expect(isOperationNotImplemented(error({ code: "clone_failed" }))).toBe(false);
    expect(isOperationNotImplemented(error({ message: "Expected sagaId" }))).toBe(false);
  });
});

// ── Failure recovery ──────────────────────────────────────────

describe("partialSpaceFromError", () => {
  const failed = (details: StaveOperationError["details"]): StaveOperationError => ({
    code: "clone_failed",
    message: "space create failed",
    details,
  });

  it("reads the nested partialSpace shape", () => {
    expect(
      partialSpaceFromError(
        failed({
          partialSpace: {
            spaceId: "ticket-1",
            spacePath: "/work/ticket-1",
            manifestCreatedAt: "2026-09-07T10:00:00.123456789Z",
          },
        }),
        "fallback",
      ),
    ).toEqual({
      spaceId: "ticket-1",
      spacePath: "/work/ticket-1",
      manifestCreatedAt: "2026-09-07T10:00:00.123456789Z",
    });
  });

  it("reads the flat shape and falls back to createdAt", () => {
    expect(
      partialSpaceFromError(
        failed({ spacePath: "/work/ticket-1", manifestCreatedAt: "2026-09-07T10:00:00Z" }),
        "ticket-1",
      ),
    ).toEqual({
      spaceId: "ticket-1",
      spacePath: "/work/ticket-1",
      manifestCreatedAt: "2026-09-07T10:00:00Z",
    });
    expect(
      partialSpaceFromError(
        failed({ spaceId: "x", spacePath: "/work/x", createdAt: "2026-09-07T10:00:00Z" }),
        "fallback",
      ),
    ).toEqual({ spaceId: "x", spacePath: "/work/x", manifestCreatedAt: "2026-09-07T10:00:00Z" });
  });

  it("uses the fallback id and a null stamp when the server omits them", () => {
    expect(partialSpaceFromError(failed({ spacePath: "/work/y" }), "y")).toEqual({
      spaceId: "y",
      spacePath: "/work/y",
      manifestCreatedAt: null,
    });
  });

  it("returns null without details or a space path", () => {
    expect(partialSpaceFromError(undefined, "x")).toBeNull();
    expect(partialSpaceFromError(failed(null), "x")).toBeNull();
    expect(partialSpaceFromError(failed({ reason: "clone failed" }), "x")).toBeNull();
    expect(partialSpaceFromError(failed({ partialSpace: null, spacePath: "" }), "x")).toBeNull();
  });
});

describe("buildRemovePartialSpaceOperation", () => {
  it("binds the destroy to the manifest stamp", () => {
    expect(
      buildRemovePartialSpaceOperation({
        spaceId: "ticket-1",
        spacePath: "/work/ticket-1",
        manifestCreatedAt: "2026-09-07T10:00:00Z",
      }),
    ).toEqual({
      kind: "removePartialSpace",
      spaceId: "ticket-1",
      expectedManifestCreatedAt: "2026-09-07T10:00:00Z",
    });
  });

  it("returns null when the stamp is unknown or the id is unusable", () => {
    expect(
      buildRemovePartialSpaceOperation({
        spaceId: "ticket-1",
        spacePath: "/work/ticket-1",
        manifestCreatedAt: null,
      }),
    ).toBeNull();
    expect(
      buildRemovePartialSpaceOperation({
        spaceId: "-bad",
        spacePath: "/work/-bad",
        manifestCreatedAt: "2026-09-07T10:00:00Z",
      }),
    ).toBeNull();
  });
});
