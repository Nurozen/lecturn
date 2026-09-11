import type {
  StaveCreateSagaOperation,
  StaveCreateSpaceOperation,
  StaveMemoryProvider,
  StaveOperationError,
  StaveRegisterRepoOperation,
  StaveRemovePartialSpaceOperation,
  StaveRepoRow,
  StaveSagaListRow,
  StaveSpaceListRow,
} from "@lecturn/contracts";
import { isValidStaveSpaceId } from "@lecturn/shared/stave";

/**
 * Pure state and rules of the "New Stave space" wizard. The dialog and its
 * step components only render what these helpers say and feed edits back
 * through `updateWizardState`; every gate, option list and operation payload
 * is computed here so it can be tested without React.
 */

export type StaveWizardStep = "identity" | "repos" | "memory" | "saga" | "review" | "progress";

export const STAVE_WIZARD_STEP_LABELS: Record<StaveWizardStep, string> = {
  identity: "Identity",
  repos: "Repos",
  memory: "Memory",
  saga: "Saga",
  review: "Review",
  progress: "Progress",
};

/** Kind chips offered by the wizard; Stave reserves `review` and `saga`. */
export const STAVE_SPACE_KIND_CHIPS = ["ticket", "spike", "audit", "custom"] as const;
export type StaveSpaceKindChip = (typeof STAVE_SPACE_KIND_CHIPS)[number];

export const RESERVED_STAVE_SPACE_KINDS: ReadonlyArray<string> = ["review", "saga"];

export type StaveWizardRepoMode = "none" | "edit" | "reference";

export interface StaveWizardRepoRow {
  readonly repo: string;
  readonly mode: StaveWizardRepoMode;
  /** Edit base: a git ref or `space:<id>`; empty means the repo's default branch. */
  readonly base: string;
  /** Reference pin; empty means the repo's default branch. */
  readonly ref: string;
}

export interface StaveRegisterRepoForm {
  readonly name: string;
  readonly url: string;
  readonly adopt: boolean;
}

export const EMPTY_REGISTER_REPO_FORM: StaveRegisterRepoForm = { name: "", url: "", adopt: false };

export interface StaveSpaceWizardState {
  readonly step: StaveWizardStep;
  readonly spaceId: string;
  readonly title: string;
  readonly kindChip: StaveSpaceKindChip;
  /** The free-text kind used when `kindChip` is `custom`. */
  readonly customKind: string;
  readonly specText: string;
  /** Absolute path on the server, validated server-side. */
  readonly specPath: string;
  /** `space create` with no repos at all. */
  readonly emptySpace: boolean;
  readonly repos: ReadonlyArray<StaveWizardRepoRow>;
  readonly common: boolean;
  readonly includeWeak: boolean;
  readonly noLearn: boolean;
  readonly memory: ReadonlyArray<string>;
  readonly sagaId: string | null;
  readonly after: ReadonlyArray<string>;
}

/** What the wizard reads from the environment to validate and offer choices. */
export interface StaveWizardContext {
  readonly repos: ReadonlyArray<StaveRepoRow>;
  /** `stave.listSpaces { includeArchived: true }`. */
  readonly spaces: ReadonlyArray<StaveSpaceListRow>;
  readonly sagas: ReadonlyArray<StaveSagaListRow>;
  /** Some `stave.memoryProviders` row reports `available`; gates the memory step. */
  readonly memoryAvailable: boolean;
}

export const EMPTY_WIZARD_CONTEXT: StaveWizardContext = {
  repos: [],
  spaces: [],
  sagas: [],
  memoryAvailable: false,
};

/** Whether any memory provider can back `--memory`; false while the providers query is pending. */
export function memoryAvailableFrom(providers: ReadonlyArray<StaveMemoryProvider> | null): boolean {
  return providers !== null && providers.some((provider) => provider.available);
}

export function createInitialWizardState(
  context: StaveWizardContext = EMPTY_WIZARD_CONTEXT,
  sagaRoot?: string,
): StaveSpaceWizardState {
  const state: StaveSpaceWizardState = {
    step: "identity",
    spaceId: "",
    title: "",
    kindChip: "ticket",
    customKind: "",
    specText: "",
    specPath: "",
    emptySpace: false,
    repos: syncRepoRows([], context.repos),
    common: false,
    includeWeak: false,
    noLearn: false,
    memory: [],
    sagaId: null,
    after: [],
  };
  return preselectSaga(state, context.sagas, sagaRoot);
}

export function updateWizardState(
  state: StaveSpaceWizardState,
  patch: Partial<StaveSpaceWizardState>,
): StaveSpaceWizardState {
  return { ...state, ...patch };
}

// ── Identity ──────────────────────────────────────────────────

export type StaveSpaceIdProblem = "empty" | "invalid" | "exists";

export interface StaveSpaceIdValidation {
  readonly ok: boolean;
  readonly problem?: StaveSpaceIdProblem;
  readonly message?: string;
  /** Non-blocking: archived spaces that share the id. */
  readonly warning?: string;
}

const ARCHIVE_TIMESTAMP_SUFFIX = /-\d{14}$/;

function archivedRowMatches(row: StaveSpaceListRow, id: string): boolean {
  if (row.logicalId === id) return true;
  const basename = row.archiveBasename ?? row.id;
  return basename === id || basename.replace(ARCHIVE_TIMESTAMP_SUFFIX, "") === id;
}

/**
 * Charset and uniqueness against every row `space list --archived` returns.
 * A live space with the id (directory or logical) blocks; archived matches
 * only warn, since Stave timestamps archive entries precisely so an id can
 * be reused after archiving (a later `restore` may then be ambiguous).
 */
export function validateSpaceId(
  raw: string,
  spaces: ReadonlyArray<StaveSpaceListRow>,
): StaveSpaceIdValidation {
  const id = raw.trim();
  if (id.length === 0) {
    return { ok: false, problem: "empty", message: "Enter a space id." };
  }
  if (!isValidStaveSpaceId(id)) {
    return {
      ok: false,
      problem: "invalid",
      message: "Use letters, digits, '.', '_' or '-', starting with a letter or digit.",
    };
  }
  const live = spaces.find((row) => !row.archived && (row.id === id || row.logicalId === id));
  if (live) {
    return {
      ok: false,
      problem: "exists",
      message: `A space '${live.id}' already exists at ${live.path}.`,
    };
  }
  const archived = spaces.filter((row) => row.archived && archivedRowMatches(row, id));
  if (archived.length > 0) {
    const names = archived.map((row) => row.archiveBasename ?? row.id).join(", ");
    return {
      ok: true,
      warning: `An archived space shares this id (${names}); restoring it later may be ambiguous.`,
    };
  }
  return { ok: true };
}

export interface StaveSpaceKindValidation {
  readonly ok: boolean;
  readonly message?: string;
}

/** The `--kind` value: the chip, or the custom text (never a reserved kind). */
export function resolveSpaceKind(state: StaveSpaceWizardState): string {
  return state.kindChip === "custom" ? state.customKind.trim() : state.kindChip;
}

export function validateSpaceKind(state: StaveSpaceWizardState): StaveSpaceKindValidation {
  const kind = resolveSpaceKind(state);
  if (state.kindChip !== "custom") return { ok: true };
  if (kind.length === 0) {
    return { ok: false, message: "Enter a custom kind." };
  }
  if (RESERVED_STAVE_SPACE_KINDS.includes(kind.toLowerCase())) {
    return { ok: false, message: `'${kind}' is reserved by Stave.` };
  }
  if (!isValidStaveSpaceId(kind)) {
    return { ok: false, message: "Kinds use the same charset as ids." };
  }
  return { ok: true };
}

// ── Repos ─────────────────────────────────────────────────────

/** Table rows for the registry: existing selections keep their mode, new repos start at `none`. */
export function syncRepoRows(
  rows: ReadonlyArray<StaveWizardRepoRow>,
  registry: ReadonlyArray<StaveRepoRow>,
): ReadonlyArray<StaveWizardRepoRow> {
  const byName = new Map(rows.map((row) => [row.repo, row] as const));
  return registry.map(
    (entry) => byName.get(entry.name) ?? { repo: entry.name, mode: "none", base: "", ref: "" },
  );
}

export function setRepoMode(
  state: StaveSpaceWizardState,
  repo: string,
  mode: StaveWizardRepoMode,
): StaveSpaceWizardState {
  return updateWizardState(state, {
    repos: state.repos.map((row) => (row.repo === repo ? { ...row, mode } : row)),
    // Picking a repo is the opposite of asking for an empty space.
    ...(mode !== "none" ? { emptySpace: false } : {}),
  });
}

export function setRepoBase(
  state: StaveSpaceWizardState,
  repo: string,
  base: string,
): StaveSpaceWizardState {
  return updateWizardState(state, {
    repos: state.repos.map((row) => (row.repo === repo ? { ...row, base } : row)),
  });
}

export function setRepoRef(
  state: StaveSpaceWizardState,
  repo: string,
  ref: string,
): StaveSpaceWizardState {
  return updateWizardState(state, {
    repos: state.repos.map((row) => (row.repo === repo ? { ...row, ref } : row)),
  });
}

export function selectedRepoRows(state: StaveSpaceWizardState): ReadonlyArray<StaveWizardRepoRow> {
  return state.repos.filter((row) => row.mode !== "none");
}

export interface StaveBaseOption {
  readonly value: string;
  readonly label: string;
}

/**
 * `space:<id>` picker entries for stacking an edit worktree of `repo` on a
 * live space that edits the same repo (that is the branch Stave resolves).
 */
export function spaceBaseOptions(
  spaces: ReadonlyArray<StaveSpaceListRow>,
  repo: string,
): ReadonlyArray<StaveBaseOption> {
  return spaces
    .filter(
      (row) =>
        !row.archived &&
        row.error === undefined &&
        row.repos.some((entry) => entry.name === repo && entry.mode === "edit"),
    )
    .map((row) => {
      const id = row.logicalId ?? row.id;
      return { value: `space:${id}`, label: `space:${id}` };
    });
}

export function validateRegisterRepoForm(
  form: StaveRegisterRepoForm,
  registry: ReadonlyArray<StaveRepoRow>,
): { readonly ok: boolean; readonly message?: string } {
  const name = form.name.trim();
  const url = form.url.trim();
  if (name.length === 0) return { ok: false, message: "Enter a repo name." };
  if (!isValidStaveSpaceId(name)) {
    return { ok: false, message: "Repo names use letters, digits, '.', '_' or '-'." };
  }
  if (registry.some((entry) => entry.name === name)) {
    return { ok: false, message: `'${name}' is already registered.` };
  }
  if (url.length === 0) return { ok: false, message: "Enter a clone URL or path." };
  return { ok: true };
}

export function buildRegisterRepoOperation(
  form: StaveRegisterRepoForm,
): StaveRegisterRepoOperation {
  return { kind: "registerRepo", name: form.name.trim(), url: form.url.trim(), adopt: form.adopt };
}

// ── Memory ────────────────────────────────────────────────────

export interface StaveMemorySuggestion {
  readonly value: string;
  readonly label: string;
}

export const FRESH_MEMORY_SPEC = ".";

/** `.` (a fresh task store) followed by every den the listed spaces attach, as `provider:id`. */
export function memorySuggestions(
  spaces: ReadonlyArray<StaveSpaceListRow>,
): ReadonlyArray<StaveMemorySuggestion> {
  const seen = new Set<string>();
  const dens: Array<StaveMemorySuggestion> = [];
  for (const row of spaces) {
    for (const memory of row.memories) {
      const value = `${memory.provider}:${memory.id}`;
      if (seen.has(value)) continue;
      seen.add(value);
      dens.push({ value, label: `${value} (${memory.name} in ${row.logicalId ?? row.id})` });
    }
  }
  return [{ value: FRESH_MEMORY_SPEC, label: ". (fresh task store)" }, ...dens];
}

/** Adds `spec` to the list or removes it when already present; blank specs are ignored. */
export function toggleMemoryEntry(
  memory: ReadonlyArray<string>,
  spec: string,
): ReadonlyArray<string> {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return memory;
  return memory.includes(trimmed)
    ? memory.filter((entry) => entry !== trimmed)
    : [...memory, trimmed];
}

export function toggleMemorySpec(
  state: StaveSpaceWizardState,
  spec: string,
): StaveSpaceWizardState {
  const memory = toggleMemoryEntry(state.memory, spec);
  return memory === state.memory ? state : updateWizardState(state, { memory });
}

// ── Saga ──────────────────────────────────────────────────────

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? value.trim() : trimmed;
}

/** The saga row whose space root is `root` (the bus request from a saga's project section). */
export function findSagaByRoot(
  sagas: ReadonlyArray<StaveSagaListRow>,
  root: string,
): StaveSagaListRow | undefined {
  const wanted = normalizePath(root);
  return sagas.find((row) => normalizePath(row.path) === wanted);
}

export function sagaIdOf(row: StaveSagaListRow): string {
  return row.logicalId ?? row.id;
}

/** Applies the launch request's saga once the saga list is known; a no-op when unmatched. */
export function preselectSaga(
  state: StaveSpaceWizardState,
  sagas: ReadonlyArray<StaveSagaListRow>,
  root: string | undefined,
): StaveSpaceWizardState {
  if (root === undefined || state.sagaId !== null) return state;
  const row = findSagaByRoot(sagas, root);
  return row === undefined ? state : updateWizardState(state, { sagaId: sagaIdOf(row), after: [] });
}

export function setSaga(
  state: StaveSpaceWizardState,
  sagaId: string | null,
): StaveSpaceWizardState {
  return sagaId === state.sagaId ? state : updateWizardState(state, { sagaId, after: [] });
}

export function sagaMemberOptions(
  sagas: ReadonlyArray<StaveSagaListRow>,
  sagaId: string | null,
): ReadonlyArray<string> {
  if (sagaId === null) return [];
  const row = sagas.find((candidate) => sagaIdOf(candidate) === sagaId);
  return row?.members ?? [];
}

export function toggleAfterMember(
  state: StaveSpaceWizardState,
  member: string,
): StaveSpaceWizardState {
  return updateWizardState(state, {
    after: state.after.includes(member)
      ? state.after.filter((entry) => entry !== member)
      : [...state.after, member],
  });
}

// ── Steps ─────────────────────────────────────────────────────

export function wizardSteps(context: StaveWizardContext): ReadonlyArray<StaveWizardStep> {
  return context.memoryAvailable
    ? ["identity", "repos", "memory", "saga", "review", "progress"]
    : ["identity", "repos", "saga", "review", "progress"];
}

export function nextWizardStep(
  step: StaveWizardStep,
  context: StaveWizardContext,
): StaveWizardStep | null {
  const steps = wizardSteps(context);
  const index = steps.indexOf(step);
  return index === -1 ? null : (steps[index + 1] ?? null);
}

export function previousWizardStep(
  step: StaveWizardStep,
  context: StaveWizardContext,
): StaveWizardStep | null {
  const steps = wizardSteps(context);
  const index = steps.indexOf(step);
  return index <= 0 ? null : (steps[index - 1] ?? null);
}

export interface StaveStepGate {
  readonly ok: boolean;
  readonly message?: string;
}

/** Whether "Next" (and Enter) may leave `state.step`. */
export function canAdvance(
  state: StaveSpaceWizardState,
  context: StaveWizardContext,
): StaveStepGate {
  switch (state.step) {
    case "identity": {
      const id = validateSpaceId(state.spaceId, context.spaces);
      if (!id.ok)
        return { ok: false, ...(id.message === undefined ? {} : { message: id.message }) };
      const kind = validateSpaceKind(state);
      if (!kind.ok) {
        return { ok: false, ...(kind.message === undefined ? {} : { message: kind.message }) };
      }
      if (state.specText.trim().length > 0 && state.specPath.trim().length > 0) {
        return { ok: false, message: "Paste a spec or give a path, not both." };
      }
      return { ok: true };
    }
    case "repos": {
      if (state.emptySpace) return { ok: true };
      if (selectedRepoRows(state).length === 0) {
        return {
          ok: false,
          message: "Pick at least one repo to edit or reference, or choose an empty space.",
        };
      }
      const badBase = state.repos.find(
        (row) =>
          row.mode === "edit" &&
          row.base.trim().startsWith("space:") &&
          !isValidStaveSpaceId(row.base.trim().slice("space:".length)),
      );
      if (badBase) {
        return { ok: false, message: `'${badBase.base}' is not a valid space reference.` };
      }
      return { ok: true };
    }
    case "memory":
      return { ok: true };
    case "saga":
      if (state.after.length > 0 && state.sagaId === null) {
        return { ok: false, message: "Pick a saga before choosing members to land after." };
      }
      return { ok: true };
    case "review":
      return { ok: true };
    case "progress":
      return { ok: false };
  }
}

// ── Operations ────────────────────────────────────────────────

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function buildCreateSpaceOperation(state: StaveSpaceWizardState): StaveCreateSpaceOperation {
  const spaceId = state.spaceId.trim();
  const title = optionalText(state.title);
  const specText = state.specText.trim().length === 0 ? undefined : state.specText;
  const specPath = optionalText(state.specPath);
  const rows = state.emptySpace ? [] : selectedRepoRows(state);
  return {
    kind: "createSpace",
    spaceId,
    ...(title === undefined ? {} : { title }),
    spaceKind: resolveSpaceKind(state),
    ...(specText === undefined ? {} : { specText }),
    ...(specPath === undefined ? {} : { specPath }),
    edits: rows
      .filter((row) => row.mode === "edit")
      .map((row) => {
        const base = optionalText(row.base);
        return { repo: row.repo, ...(base === undefined ? {} : { base }) };
      }),
    references: rows
      .filter((row) => row.mode === "reference")
      .map((row) => {
        const ref = optionalText(row.ref);
        return { repo: row.repo, ...(ref === undefined ? {} : { ref }) };
      }),
    memory: state.memory
      .map((spec) => spec.trim())
      .filter((spec) => spec.length > 0)
      .map((spec) => ({ spec })),
    ...(state.sagaId === null ? {} : { saga: state.sagaId }),
    after: state.sagaId === null ? [] : [...state.after],
    common: state.common,
    includeWeak: state.common && state.includeWeak,
    noLearn: state.noLearn,
  };
}

/** The `stave space create` line the server will build, for the review step. */
export function describeCreateSpaceCommand(operation: StaveCreateSpaceOperation): string {
  const parts = ["stave", "space", "create"];
  const push = (flag: string, value?: string) => {
    parts.push(flag);
    if (value !== undefined) parts.push(shellQuote(value));
  };
  if (operation.spaceKind !== undefined) push("--kind", operation.spaceKind);
  // The placeholder stands in for a server-written file, so it is not shell-quoted.
  if (operation.specText !== undefined) parts.push("--spec", "<pasted spec>");
  else if (operation.specPath !== undefined) push("--spec", operation.specPath);
  for (const edit of operation.edits) {
    push("--edit", edit.base === undefined ? edit.repo : `${edit.repo}:${edit.base}`);
  }
  for (const reference of operation.references) {
    push(
      "--reference",
      reference.ref === undefined ? reference.repo : `${reference.repo}:${reference.ref}`,
    );
  }
  for (const memory of operation.memory) push("--memory", memory.spec);
  if (operation.saga !== undefined) push("--saga", operation.saga);
  for (const member of operation.after) push("--after", member);
  if (operation.common) push("--common");
  if (operation.includeWeak) push("--include-weak");
  if (operation.noLearn) push("--no-learn");
  parts.push(shellQuote(operation.spaceId));
  return parts.join(" ");
}

/** Every `stave` line the review step lists for a create: repos are already registered, so only the create itself. */
export function reviewCommandLines(operation: StaveCreateSpaceOperation): ReadonlyArray<string> {
  return [describeCreateSpaceCommand(operation)];
}

export function describeRegisterRepoCommand(operation: StaveRegisterRepoOperation): string {
  const parts = ["stave", "repos", "add"];
  if (operation.adopt) parts.push("--adopt");
  parts.push(shellQuote(operation.name), shellQuote(operation.url));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._:@/=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Saga variant ──────────────────────────────────────────────

export interface StaveSagaWizardState {
  readonly sagaId: string;
  readonly title: string;
  readonly specText: string;
  readonly references: ReadonlyArray<StaveWizardRepoRow>;
  readonly memory: ReadonlyArray<string>;
}

export function createInitialSagaWizardState(
  registry: ReadonlyArray<StaveRepoRow> = [],
): StaveSagaWizardState {
  return {
    sagaId: "",
    title: "",
    specText: "",
    references: syncRepoRows([], registry),
    memory: [],
  };
}

export function validateSagaWizard(
  state: StaveSagaWizardState,
  spaces: ReadonlyArray<StaveSpaceListRow>,
): StaveStepGate {
  const id = validateSpaceId(state.sagaId, spaces);
  if (id.ok) return { ok: true };
  return { ok: false, ...(id.message === undefined ? {} : { message: id.message }) };
}

export function buildCreateSagaOperation(state: StaveSagaWizardState): StaveCreateSagaOperation {
  const title = optionalText(state.title);
  const specText = state.specText.trim().length === 0 ? undefined : state.specText;
  return {
    kind: "createSaga",
    sagaId: state.sagaId.trim(),
    ...(title === undefined ? {} : { title }),
    ...(specText === undefined ? {} : { specText }),
    references: state.references
      .filter((row) => row.mode === "reference")
      .map((row) => {
        const ref = optionalText(row.ref);
        return { repo: row.repo, ...(ref === undefined ? {} : { ref }) };
      }),
    memory: state.memory
      .map((spec) => spec.trim())
      .filter((spec) => spec.length > 0)
      .map((spec) => ({ spec })),
  };
}

/** `createSaga` lands in Phase 5; until then the server answers `invalid_arguments`. */
export function isOperationNotImplemented(error: StaveOperationError): boolean {
  return (
    error.code === "invalid_arguments" &&
    /not (yet )?(implemented|supported)|no such operation|unknown operation/i.test(error.message)
  );
}

// ── Failure recovery ──────────────────────────────────────────

export interface StavePartialSpace {
  readonly spaceId: string;
  readonly spacePath: string;
  /** Absent when the server reported the space but not its manifest stamp. */
  readonly manifestCreatedAt: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The space a failed `createSpace` left behind, from the server's
 * `details.partialSpace` (set once `space create` returned) or the flatter
 * `details.spacePath`/`details.manifestCreatedAt` shape; `null` when the
 * failure happened before any manifest was written.
 */
export function partialSpaceFromError(
  error: StaveOperationError | undefined,
  fallbackSpaceId: string,
): StavePartialSpace | null {
  const details = error?.details;
  if (!details) return null;
  const nested = details.partialSpace;
  const source =
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : details;
  const spacePath = readString(source.spacePath);
  if (spacePath === null) return null;
  return {
    spaceId: readString(source.spaceId) ?? fallbackSpaceId,
    spacePath,
    manifestCreatedAt: readString(source.manifestCreatedAt) ?? readString(source.createdAt),
  };
}

/**
 * The explicit recovery for a failed create: `space destroy` bound to the
 * manifest stamp this operation produced, so a recreated space with the same
 * id is never touched. `null` when the stamp is unknown (the button stays
 * disabled with a hint instead).
 */
export function buildRemovePartialSpaceOperation(
  partial: StavePartialSpace,
): StaveRemovePartialSpaceOperation | null {
  if (partial.manifestCreatedAt === null || !isValidStaveSpaceId(partial.spaceId)) return null;
  return {
    kind: "removePartialSpace",
    spaceId: partial.spaceId,
    expectedManifestCreatedAt: partial.manifestCreatedAt,
  };
}
