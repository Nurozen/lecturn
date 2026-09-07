/**
 * StaveCli - the ONLY place Lecturn spawns `stave`.
 *
 * Every verb is a typed method (no argv passthrough): inputs are validated
 * with Stave's own name rule before they reach argv, `--json` is always
 * requested, and the exit status decides how stdout is read — a success
 * payload (exit 0) or the `{"error": {...}}` envelope (exit 1). Prose from a
 * legacy binary or a read verb's service error (which bypasses the envelope)
 * degrades to `non_json_output` with the stderr tail, never to a parse crash.
 *
 * Spawn discipline (deviation 7): the binary comes from `StaveBinary.resolve`,
 * stdin is `""` (closed immediately, so a prompt can never hang), `STAVE_CD_FD`
 * is unset so Stave never treats the server as its shell wrapper, `MARMOT_HOME`
 * is forwarded when the host has one, reads time out after 60s and mutations
 * after 15 minutes, and output is truncated rather than failed.
 *
 * URLs read back from JSON (Stave redacts secret-looking values) are never
 * turned into argv again; callers pass the original inputs.
 *
 * @module StaveCli
 */
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { isValidStaveSpaceId, type StaveVersionInfo } from "@t3tools/shared/stave";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { ProcessRunner, type ProcessRunError, type ProcessRunInput } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { parseStaveErrorEnvelope, StaveError } from "./StaveError.ts";
import {
  decodeStaveConfigShow,
  decodeStaveMemoryAttachResult,
  decodeStaveMemoryDetachResult,
  decodeStaveMemoryList,
  decodeStaveMemoryProviders,
  decodeStaveReposAddResult,
  decodeStaveReposList,
  decodeStaveSagaList,
  decodeStaveSagaMutationResult,
  decodeStaveSagaStatus,
  decodeStaveSagaSyncResult,
  decodeStaveSagaTeardownResult,
  decodeStaveSetupResult,
  decodeStaveSpaceArchiveResult,
  decodeStaveSpaceDestroyResult,
  decodeStaveSpaceList,
  decodeStaveSpaceMutationResult,
  decodeStaveSpaceStatus,
  decodeStaveSpaceSyncResult,
  decodeStaveVersion,
  isStaveDryRunPlan,
  type StaveConfigShow,
  type StaveDecoder,
  type StaveDryRunPlan,
  type StaveMemoryAttachResult,
  type StaveMemoryDetachResult,
  type StaveMemoryList,
  type StaveMemoryProviders,
  type StaveReposAddResult,
  type StaveReposList,
  type StaveSagaList,
  type StaveSagaMutationResult,
  type StaveSagaStatus,
  type StaveSagaSyncResult,
  type StaveSagaTeardownResult,
  type StaveSetupResult,
  type StaveSpaceArchiveResult,
  type StaveSpaceDestroyResult,
  type StaveSpaceList,
  type StaveSpaceMutationResult,
  type StaveSpaceStatus,
  type StaveSpaceSyncResult,
} from "./staveJson.ts";

// ── Verb table ────────────────────────────────────────────────

/** Reads are bounded by how long a status probe may block; mutations by a slow clone. */
export const STAVE_READ_TIMEOUT = Duration.seconds(60);
export const STAVE_MUTATION_TIMEOUT = Duration.minutes(15);
/** Kept at the ProcessRunner default; output is truncated, never fatal. */
export const STAVE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How much of stderr a `StaveError.stderrTail` keeps. */
export const STAVE_STDERR_TAIL_CHARS = 2_000;
/** Dropped from the child's env so Stave never writes a chdir handoff to the server's fd 3. */
export const STAVE_UNSET_ENV = ["STAVE_CD_FD"] as const;
/** Forwarded verbatim when the host has it, so memory providers see the same home. */
export const STAVE_PASSTHROUGH_ENV = ["MARMOT_HOME"] as const;

export type StaveVerb =
  | "version"
  | "config show"
  | "repos list"
  | "space list"
  | "space status"
  | "saga list"
  | "saga status"
  | "memory providers"
  | "memory list"
  | "setup"
  | "repos add"
  | "space init"
  | "space create"
  | "space add"
  | "space remove"
  | "space sync"
  | "space retarget"
  | "space archive"
  | "space restore"
  | "space destroy"
  | "saga create"
  | "saga add"
  | "saga remove"
  | "saga sync"
  | "saga archive"
  | "saga destroy"
  | "memory attach"
  | "memory detach";

export interface StaveVerbPolicy {
  /** Decides the timeout class. */
  readonly kind: "read" | "mutation";
  /**
   * `json`: pass `--json` and parse stdout (v0.4 supports it on every verb
   * below). `prose`: no `--json` flag exists; stdout is parsed as text.
   */
  readonly output: "json" | "prose";
}

/** Per-verb spawn policy; kept as a table so a legacy binary degrades predictably. */
export const STAVE_VERB_POLICY: Readonly<Record<StaveVerb, StaveVerbPolicy>> = {
  version: { kind: "read", output: "prose" },
  "config show": { kind: "read", output: "json" },
  "repos list": { kind: "read", output: "json" },
  "space list": { kind: "read", output: "json" },
  "space status": { kind: "read", output: "json" },
  "saga list": { kind: "read", output: "json" },
  "saga status": { kind: "read", output: "json" },
  "memory providers": { kind: "read", output: "json" },
  "memory list": { kind: "read", output: "json" },
  setup: { kind: "mutation", output: "json" },
  "repos add": { kind: "mutation", output: "json" },
  "space init": { kind: "mutation", output: "json" },
  "space create": { kind: "mutation", output: "json" },
  "space add": { kind: "mutation", output: "json" },
  "space remove": { kind: "mutation", output: "json" },
  "space sync": { kind: "mutation", output: "json" },
  "space retarget": { kind: "mutation", output: "json" },
  "space archive": { kind: "mutation", output: "json" },
  "space restore": { kind: "mutation", output: "json" },
  "space destroy": { kind: "mutation", output: "json" },
  "saga create": { kind: "mutation", output: "json" },
  "saga add": { kind: "mutation", output: "json" },
  "saga remove": { kind: "mutation", output: "json" },
  "saga sync": { kind: "mutation", output: "json" },
  "saga archive": { kind: "mutation", output: "json" },
  "saga destroy": { kind: "mutation", output: "json" },
  "memory attach": { kind: "mutation", output: "json" },
  "memory detach": { kind: "mutation", output: "json" },
};

// ── Typed inputs ──────────────────────────────────────────────

export type StaveRepoModeInput = "edit" | "reference";
export type StaveArchiveMemoryFate = "keep" | "contribute";
export type StaveDestroyMemoryFate = "keep" | "destroy" | "contribute";

/** Receives each stdout/stderr line as Stave emits it (progress for long mutations). */
export interface StaveStreamOptions {
  readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined;
}

export interface StaveSpaceListInput {
  readonly archived?: boolean | undefined;
}

export interface StaveMemoryListInput {
  /** One space's attachments; omitted lists every live space that has any. */
  readonly spaceId?: string | undefined;
}

export interface StaveSetupInput {
  /** Rewrite an existing config file (refused with `config_exists` otherwise). */
  readonly force?: boolean | undefined;
}

export interface StaveReposAddInput {
  readonly name: string;
  readonly url: string;
  /** Reuse a bare cache already at the derived path (refused with `cache_exists` otherwise). */
  readonly adopt?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceInitInput {
  readonly id: string;
  readonly kind?: string | undefined;
  /** Spec file or directory copied into the space. */
  readonly spec?: string | undefined;
}

export interface StaveSpaceCreateInput {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly spec?: string | undefined;
  /** `repo[:base]`; base may be `space:<id>` to stack on that space's branch. */
  readonly edits: ReadonlyArray<string>;
  /** `repo[:ref]`. */
  readonly references: ReadonlyArray<string>;
  /** `[provider:]<spec>`; `.` is a fresh task store. */
  readonly memory: ReadonlyArray<string>;
  /** Enrol the new space in this saga. */
  readonly saga?: string | undefined;
  /** Member ids the new space lands behind (requires `saga`). */
  readonly after: ReadonlyArray<string>;
  /** Also add reference worktrees for the edited repos' strong learned tethers. */
  readonly common?: boolean | undefined;
  readonly includeWeak?: boolean | undefined;
  readonly noLearn?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceAddInput {
  readonly id: string;
  readonly repo: string;
  readonly mode: StaveRepoModeInput;
  /** Base branch/ref for edit repos (or `space:<id>`), ref for reference repos. */
  readonly base?: string | undefined;
  /** Branch name for editable repos. */
  readonly branch?: string | undefined;
  readonly noFetch?: boolean | undefined;
  /** Defaults to true in Stave; false passes `--link-memory=false`. */
  readonly linkMemory?: boolean | undefined;
  readonly noLearn?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceRemoveInput {
  readonly id: string;
  readonly repo: string;
  /** Required by Stave (`repo_mode_ambiguous`) when the repo is present in both modes. */
  readonly mode?: StaveRepoModeInput | undefined;
  readonly force?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceSyncInput {
  readonly id: string;
  readonly referencesOnly?: boolean | undefined;
}

export interface StaveSpaceRetargetInput {
  readonly id: string;
  readonly repo: string;
  /** New base ref; may be `space:<id>`. */
  readonly base: string;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceArchiveInput {
  readonly id: string;
  readonly force?: boolean | undefined;
  readonly memory?: StaveArchiveMemoryFate | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceRestoreInput {
  readonly id: string;
  /** `.archive/` entry name, required when several `<id>-<timestamp>` archives exist. */
  readonly from?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSpaceDestroyInput {
  readonly id: string;
  readonly force?: boolean | undefined;
  readonly memory?: StaveDestroyMemoryFate | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaCreateInput {
  readonly id: string;
  readonly spec?: string | undefined;
  readonly references: ReadonlyArray<string>;
  readonly memory: ReadonlyArray<string>;
  readonly noLearn?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaAddInput {
  readonly sagaId: string;
  readonly spaceId: string;
  /** Member ids this space lands behind. */
  readonly after: ReadonlyArray<string>;
  /** Reset the member's after edges before applying `after`. */
  readonly clearAfter?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaRemoveInput {
  readonly sagaId: string;
  readonly spaceId: string;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaSyncInput {
  readonly id: string;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaArchiveInput {
  readonly id: string;
  readonly force?: boolean | undefined;
  readonly memory?: StaveArchiveMemoryFate | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveSagaDestroyInput {
  readonly id: string;
  readonly force?: boolean | undefined;
  readonly memory?: StaveDestroyMemoryFate | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface StaveMemoryAttachInput {
  readonly id: string;
  readonly provider?: string | undefined;
  /** Attach an existing durable store instead of creating a task store. */
  readonly use?: string | undefined;
  /** Attachment alias (Stave defaults to `default`). */
  readonly name?: string | undefined;
  readonly edit: ReadonlyArray<string>;
  readonly link: ReadonlyArray<string>;
  /** Provider-specific `k=v` options. */
  readonly opt: ReadonlyArray<string>;
  readonly dryRun?: boolean | undefined;
}

export interface StaveMemoryDetachInput {
  readonly id: string;
  readonly alias?: string | undefined;
  /** `keep` (Stave's default) or `destroy` an owned store. */
  readonly fate?: "keep" | "destroy" | undefined;
  /** Forward force to the provider's destroy (unpushed edits). */
  readonly force?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

/** A mutating verb's answer: the real result, or the plan when `dryRun` was set. */
export type StaveMutationOutcome<A> = A | StaveDryRunPlan;

// ── Service ───────────────────────────────────────────────────

export interface StaveCliShape {
  // Reads
  readonly version: Effect.Effect<StaveVersionInfo, StaveError>;
  readonly configShow: Effect.Effect<StaveConfigShow, StaveError>;
  readonly reposList: Effect.Effect<StaveReposList, StaveError>;
  readonly spaceList: (input?: StaveSpaceListInput) => Effect.Effect<StaveSpaceList, StaveError>;
  readonly spaceStatus: (id: string) => Effect.Effect<StaveSpaceStatus, StaveError>;
  readonly sagaList: Effect.Effect<StaveSagaList, StaveError>;
  readonly sagaStatus: (id: string) => Effect.Effect<StaveSagaStatus, StaveError>;
  readonly memoryProviders: Effect.Effect<StaveMemoryProviders, StaveError>;
  readonly memoryList: (input?: StaveMemoryListInput) => Effect.Effect<StaveMemoryList, StaveError>;

  // Mutations
  readonly setup: (
    input?: StaveSetupInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveSetupResult, StaveError>;
  readonly reposAdd: (
    input: StaveReposAddInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveReposAddResult>, StaveError>;
  readonly spaceInit: (
    input: StaveSpaceInitInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveSpaceMutationResult, StaveError>;
  readonly spaceCreate: (
    input: StaveSpaceCreateInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceMutationResult>, StaveError>;
  readonly spaceAdd: (
    input: StaveSpaceAddInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceMutationResult>, StaveError>;
  readonly spaceRemove: (
    input: StaveSpaceRemoveInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceMutationResult>, StaveError>;
  readonly spaceSync: (
    input: StaveSpaceSyncInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveSpaceSyncResult, StaveError>;
  readonly spaceRetarget: (
    input: StaveSpaceRetargetInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceMutationResult>, StaveError>;
  readonly spaceArchive: (
    input: StaveSpaceArchiveInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceArchiveResult>, StaveError>;
  readonly spaceRestore: (
    input: StaveSpaceRestoreInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceMutationResult>, StaveError>;
  readonly spaceDestroy: (
    input: StaveSpaceDestroyInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSpaceDestroyResult>, StaveError>;
  readonly sagaCreate: (
    input: StaveSagaCreateInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaMutationResult>, StaveError>;
  readonly sagaAdd: (
    input: StaveSagaAddInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaMutationResult>, StaveError>;
  readonly sagaRemove: (
    input: StaveSagaRemoveInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaMutationResult>, StaveError>;
  readonly sagaSync: (
    input: StaveSagaSyncInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaSyncResult>, StaveError>;
  readonly sagaArchive: (
    input: StaveSagaArchiveInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaTeardownResult>, StaveError>;
  readonly sagaDestroy: (
    input: StaveSagaDestroyInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveSagaTeardownResult>, StaveError>;
  readonly memoryAttach: (
    input: StaveMemoryAttachInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveMemoryAttachResult>, StaveError>;
  readonly memoryDetach: (
    input: StaveMemoryDetachInput,
    stream?: StaveStreamOptions,
  ) => Effect.Effect<StaveMutationOutcome<StaveMemoryDetachResult>, StaveError>;
}

export class StaveCli extends Context.Service<StaveCli, StaveCliShape>()("t3/stave/StaveCli") {}

// ── Argv construction (pure) ──────────────────────────────────

/**
 * The words after the global flags: the verb, `--json` when the policy says
 * so, then flags, then positionals. Flags come BEFORE positionals because
 * `space create` / `saga create` parse with interspersed flags off (agent
 * args may follow `--`).
 */
export interface StaveArgv {
  readonly verb: StaveVerb;
  readonly args: ReadonlyArray<string>;
}

/**
 * Builds the verb-specific argv for a typed input. Fails (with the message a
 * `StaveError{code:"invalid_arguments"}` will carry) when an id or repo name
 * breaks Stave's name rule, when a free-form value could be read as a flag,
 * or when a value is empty.
 */
export type StaveArgvBuilder<Input> = (
  input: Input,
) => Result.Result<ReadonlyArray<string>, string>;

/** Prefix shared by every call: `--config <path>` only when the setting is non-empty. */
export function staveGlobalArgs(configPath: string): ReadonlyArray<string> {
  const trimmed = configPath.trim();
  return trimmed.length === 0 ? [] : ["--config", trimmed];
}

type ValueCheck = (field: string, value: string) => Result.Result<string, string>;

/** Stave's name rule for space/saga ids, repo names, aliases and archive entries. */
const nameValue: ValueCheck = (field, value) =>
  isValidStaveSpaceId(value)
    ? Result.succeed(value)
    : Result.fail(`${field} ${JSON.stringify(value)} is not a valid Stave name`);

/**
 * Free-form values (urls, refs, paths, provider options) only need to be
 * non-empty and unable to masquerade as a flag or smuggle a line break.
 */
const freeValue: ValueCheck = (field, value) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Result.fail(`${field} must not be empty`);
  }
  if (trimmed.startsWith("-")) {
    return Result.fail(`${field} ${JSON.stringify(value)} must not start with "-"`);
  }
  if (/[\0\r\n]/.test(trimmed)) {
    return Result.fail(`${field} must not contain control characters`);
  }
  return Result.succeed(trimmed);
};

/** `repo[:base]` / `repo[:ref]`: the repo part follows the name rule, the rest is a free ref. */
const repoSpecValue: ValueCheck = (field, value) => {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return nameValue(field, value);
  }
  const repo = nameValue(field, value.slice(0, separator));
  if (Result.isFailure(repo)) {
    return repo;
  }
  const ref = freeValue(`${field} ref`, value.slice(separator + 1));
  return Result.isFailure(ref) ? ref : Result.succeed(`${repo.success}:${ref.success}`);
};

/**
 * Accumulates `--flag`, `--flag=<value>` and positional tokens in the order
 * Stave expects, remembering the first validation failure.
 */
class ArgvBuilder {
  readonly #verb: StaveVerb;
  readonly #flags: Array<string> = [];
  readonly #positionals: Array<string> = [];
  #failure: string | undefined;

  constructor(verb: StaveVerb) {
    this.#verb = verb;
  }

  /** A boolean `--name`, emitted only when `enabled`. */
  flag(name: string, enabled: boolean | undefined): this {
    if (enabled === true) {
      this.#flags.push(`--${name}`);
    }
    return this;
  }

  /** A pre-formed token such as `--link-memory=false`. */
  raw(token: string, enabled: boolean): this {
    if (enabled) {
      this.#flags.push(token);
    }
    return this;
  }

  /** `--name=<value>` when the value is given; validated with `check`. */
  value(name: string, value: string | undefined, check: ValueCheck = freeValue): this {
    if (value !== undefined) {
      const checked = check(`--${name}`, value);
      if (Result.isFailure(checked)) {
        this.#fail(checked.failure);
      } else {
        this.#flags.push(`--${name}=${checked.success}`);
      }
    }
    return this;
  }

  /** One `--name=<value>` per entry. */
  values(name: string, values: ReadonlyArray<string>, check: ValueCheck = freeValue): this {
    for (const value of values) {
      this.value(name, value, check);
    }
    return this;
  }

  /** A required trailing argument. */
  positional(field: string, value: string, check: ValueCheck = nameValue): this {
    const checked = check(field, value);
    if (Result.isFailure(checked)) {
      this.#fail(checked.failure);
    } else {
      this.#positionals.push(checked.success);
    }
    return this;
  }

  /** A trailing argument that Stave treats as optional. */
  optionalPositional(
    field: string,
    value: string | undefined,
    check: ValueCheck = nameValue,
  ): this {
    return value === undefined ? this : this.positional(field, value, check);
  }

  fail(message: string): this {
    this.#fail(message);
    return this;
  }

  build(): Result.Result<ReadonlyArray<string>, string> {
    if (this.#failure !== undefined) {
      return Result.fail(this.#failure);
    }
    const json = STAVE_VERB_POLICY[this.#verb].output === "json" ? ["--json"] : [];
    return Result.succeed([
      ...this.#verb.split(" "),
      ...json,
      ...this.#flags,
      ...this.#positionals,
    ]);
  }

  #fail(message: string): void {
    this.#failure ??= message;
  }
}

const argv = (verb: StaveVerb) => new ArgvBuilder(verb);

export const buildStaveArgv: {
  readonly version: StaveArgvBuilder<void>;
  readonly configShow: StaveArgvBuilder<void>;
  readonly reposList: StaveArgvBuilder<void>;
  readonly spaceList: StaveArgvBuilder<StaveSpaceListInput>;
  readonly spaceStatus: StaveArgvBuilder<string>;
  readonly sagaList: StaveArgvBuilder<void>;
  readonly sagaStatus: StaveArgvBuilder<string>;
  readonly memoryProviders: StaveArgvBuilder<void>;
  readonly memoryList: StaveArgvBuilder<StaveMemoryListInput>;
  readonly setup: StaveArgvBuilder<StaveSetupInput>;
  readonly reposAdd: StaveArgvBuilder<StaveReposAddInput>;
  readonly spaceInit: StaveArgvBuilder<StaveSpaceInitInput>;
  readonly spaceCreate: StaveArgvBuilder<StaveSpaceCreateInput>;
  readonly spaceAdd: StaveArgvBuilder<StaveSpaceAddInput>;
  readonly spaceRemove: StaveArgvBuilder<StaveSpaceRemoveInput>;
  readonly spaceSync: StaveArgvBuilder<StaveSpaceSyncInput>;
  readonly spaceRetarget: StaveArgvBuilder<StaveSpaceRetargetInput>;
  readonly spaceArchive: StaveArgvBuilder<StaveSpaceArchiveInput>;
  readonly spaceRestore: StaveArgvBuilder<StaveSpaceRestoreInput>;
  readonly spaceDestroy: StaveArgvBuilder<StaveSpaceDestroyInput>;
  readonly sagaCreate: StaveArgvBuilder<StaveSagaCreateInput>;
  readonly sagaAdd: StaveArgvBuilder<StaveSagaAddInput>;
  readonly sagaRemove: StaveArgvBuilder<StaveSagaRemoveInput>;
  readonly sagaSync: StaveArgvBuilder<StaveSagaSyncInput>;
  readonly sagaArchive: StaveArgvBuilder<StaveSagaArchiveInput>;
  readonly sagaDestroy: StaveArgvBuilder<StaveSagaDestroyInput>;
  readonly memoryAttach: StaveArgvBuilder<StaveMemoryAttachInput>;
  readonly memoryDetach: StaveArgvBuilder<StaveMemoryDetachInput>;
} = {
  version: () => argv("version").build(),
  configShow: () => argv("config show").build(),
  reposList: () => argv("repos list").build(),
  spaceList: (input) => argv("space list").flag("archived", input.archived).build(),
  spaceStatus: (id) => argv("space status").positional("space id", id).build(),
  sagaList: () => argv("saga list").build(),
  sagaStatus: (id) => argv("saga status").positional("saga id", id).build(),
  memoryProviders: () => argv("memory providers").build(),
  memoryList: (input) => argv("memory list").optionalPositional("space id", input.spaceId).build(),
  setup: (input) => argv("setup").flag("force", input.force).build(),
  reposAdd: (input) =>
    argv("repos add")
      .flag("adopt", input.adopt)
      .flag("dry-run", input.dryRun)
      .positional("repo name", input.name)
      .positional("url", input.url, freeValue)
      .build(),
  spaceInit: (input) =>
    argv("space init")
      .value("kind", input.kind)
      .value("spec", input.spec)
      .positional("space id", input.id)
      .build(),
  spaceCreate: (input) => {
    const builder = argv("space create")
      .value("kind", input.kind)
      .value("spec", input.spec)
      .values("edit", input.edits, repoSpecValue)
      .values("reference", input.references, repoSpecValue)
      .values("memory", input.memory)
      .value("saga", input.saga, nameValue)
      .values("after", input.after, nameValue)
      .flag("common", input.common)
      .flag("include-weak", input.includeWeak)
      .flag("no-learn", input.noLearn)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id);
    if (input.after.length > 0 && input.saga === undefined) {
      builder.fail("after requires saga");
    }
    return builder.build();
  },
  spaceAdd: (input) =>
    argv("space add")
      .flag(input.mode, true)
      .value("base", input.base)
      .value("branch", input.branch)
      .flag("no-fetch", input.noFetch)
      .raw("--link-memory=false", input.linkMemory === false)
      .flag("no-learn", input.noLearn)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .positional("repo name", input.repo)
      .build(),
  spaceRemove: (input) =>
    argv("space remove")
      .flag("edit", input.mode === "edit")
      .flag("reference", input.mode === "reference")
      .flag("force", input.force)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .positional("repo name", input.repo)
      .build(),
  spaceSync: (input) =>
    argv("space sync")
      .flag("references-only", input.referencesOnly)
      .positional("space id", input.id)
      .build(),
  spaceRetarget: (input) =>
    argv("space retarget")
      .value("repo", input.repo, nameValue)
      .value("base", input.base)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .build(),
  spaceArchive: (input) =>
    argv("space archive")
      .flag("force", input.force)
      .value("memory", input.memory)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .build(),
  spaceRestore: (input) =>
    argv("space restore")
      .value("from", input.from, nameValue)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .build(),
  spaceDestroy: (input) =>
    argv("space destroy")
      .flag("force", input.force)
      .value("memory", input.memory)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .build(),
  sagaCreate: (input) =>
    argv("saga create")
      .value("spec", input.spec)
      .values("reference", input.references, repoSpecValue)
      .values("memory", input.memory)
      .flag("no-learn", input.noLearn)
      .flag("dry-run", input.dryRun)
      .positional("saga id", input.id)
      .build(),
  sagaAdd: (input) =>
    argv("saga add")
      .values("after", input.after, nameValue)
      .flag("clear-after", input.clearAfter)
      .flag("dry-run", input.dryRun)
      .positional("saga id", input.sagaId)
      .positional("space id", input.spaceId)
      .build(),
  sagaRemove: (input) =>
    argv("saga remove")
      .flag("dry-run", input.dryRun)
      .positional("saga id", input.sagaId)
      .positional("space id", input.spaceId)
      .build(),
  sagaSync: (input) =>
    argv("saga sync").flag("dry-run", input.dryRun).positional("saga id", input.id).build(),
  sagaArchive: (input) =>
    argv("saga archive")
      .flag("force", input.force)
      .value("memory", input.memory)
      .flag("dry-run", input.dryRun)
      .positional("saga id", input.id)
      .build(),
  sagaDestroy: (input) =>
    argv("saga destroy")
      .flag("force", input.force)
      .value("memory", input.memory)
      .flag("dry-run", input.dryRun)
      .positional("saga id", input.id)
      .build(),
  memoryAttach: (input) =>
    argv("memory attach")
      .value("provider", input.provider)
      .value("use", input.use)
      .value("name", input.name)
      .values("edit", input.edit)
      .values("link", input.link)
      .values("opt", input.opt)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .build(),
  memoryDetach: (input) =>
    argv("memory detach")
      .flag("destroy", input.fate === "destroy")
      .flag("keep", input.fate === "keep")
      .flag("force", input.force)
      .flag("dry-run", input.dryRun)
      .positional("space id", input.id)
      .optionalPositional("memory alias", input.alias)
      .build(),
};

// ── Running a verb ────────────────────────────────────────────

/** One spawn: the verb (for policy + error context), its argv, and how to read stdout. */
export interface StaveRunSpec<A> {
  readonly verb: StaveVerb;
  /** Everything after the global `--config` prefix, `--json` included. */
  readonly args: ReadonlyArray<string>;
  readonly decode: StaveDecoder<A>;
  readonly stream?: StaveStreamOptions | undefined;
}

/** Verbs without `--dry-run` share a `WithDryRun` decoder; a plan answer is a contract breach. */
const withoutDryRun =
  <A>(decode: StaveDecoder<StaveMutationOutcome<A>>): StaveDecoder<A> =>
  (stdout) => {
    const decoded = decode(stdout);
    if (Result.isFailure(decoded)) {
      return Result.fail(decoded.failure);
    }
    const value = decoded.success;
    return isStaveDryRunPlan(value)
      ? Result.fail({ reason: "schema", detail: "unexpected dry-run plan" })
      : Result.succeed(value as A);
  };

const stderrTailOf = (stderr: string): string | null => {
  const trimmed = stderr.trim();
  return trimmed.length === 0 ? null : trimmed.slice(-STAVE_STDERR_TAIL_CHARS);
};

/** ENOENT from the spawner, whether wrapped as a PlatformError or a raw Node error. */
const isNotFoundCause = (cause: unknown): boolean => {
  if (Predicate.hasProperty(cause, "_tag") && cause._tag === "PlatformError") {
    const reason = Predicate.hasProperty(cause, "reason") ? cause.reason : undefined;
    return Predicate.hasProperty(reason, "_tag") && reason._tag === "NotFound";
  }
  return Predicate.hasProperty(cause, "code") && cause.code === "ENOENT";
};

export const make = Effect.fn("StaveCli.make")(function* () {
  const staveBinary = yield* StaveBinary;
  const processRunner = yield* ProcessRunner;
  const serverSettings = yield* ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;

  const passthroughEnv = (): NodeJS.ProcessEnv | undefined => {
    const env: NodeJS.ProcessEnv = {};
    let any = false;
    for (const name of STAVE_PASSTHROUGH_ENV) {
      const value = hostEnvironment[name];
      if (value !== undefined && value.length > 0) {
        env[name] = value;
        any = true;
      }
    }
    return any ? env : undefined;
  };

  const runVerb = <A>(spec: StaveRunSpec<A>): Effect.Effect<A, StaveError> => {
    const verb = spec.verb;
    const policy = STAVE_VERB_POLICY[verb];
    const hostError = (
      code: StaveError["code"],
      message: string,
      details: StaveError["details"] = null,
    ) => new StaveError({ code, message, details, exitCode: null, stderrTail: null, verb });

    const mapRunError = (error: ProcessRunError): StaveError => {
      switch (error._tag) {
        case "ProcessTimeoutError":
          return hostError("timeout", `stave ${verb} timed out after ${error.timeoutMs}ms`);
        case "ProcessSpawnError":
          return isNotFoundCause(error.cause)
            ? hostError("binary_missing", error.message, { path: error.command })
            : hostError("spawn_failed", error.message);
        default:
          return hostError("spawn_failed", error.message);
      }
    };

    return Effect.gen(function* () {
      const binary = yield* staveBinary.resolve.pipe(
        Effect.mapError((error) =>
          hostError(
            "binary_missing",
            error.message,
            error._tag === "StaveBinaryNotFound"
              ? { candidates: error.candidates }
              : { path: error.path },
          ),
        ),
      );
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((error) => hostError("unknown", error.message)),
      );
      const onLine = spec.stream?.onLine;
      const env = passthroughEnv();
      const input: ProcessRunInput = {
        command: binary.path,
        args: [...staveGlobalArgs(settings.stave.configPath), ...spec.args],
        stdin: "",
        unsetEnv: [...STAVE_UNSET_ENV],
        ...(env === undefined ? {} : { env }),
        timeout: policy.kind === "read" ? STAVE_READ_TIMEOUT : STAVE_MUTATION_TIMEOUT,
        maxOutputBytes: STAVE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        ...(onLine === undefined ? {} : { onStdoutLine: onLine, onStderrLine: onLine }),
      };
      const output = yield* processRunner.run(input).pipe(Effect.mapError(mapRunError));
      const stderrTail = stderrTailOf(output.stderr);

      if (output.code === 0) {
        const decoded = spec.decode(output.stdout);
        if (Result.isSuccess(decoded)) {
          return decoded.success;
        }
        const failure = decoded.failure;
        return yield* failure.reason === "not_json"
          ? new StaveError({
              code: "non_json_output",
              message: `stave ${verb} did not return JSON`,
              details: { stdoutHead: output.stdout.slice(0, 500), detail: failure.detail },
              exitCode: 0,
              stderrTail,
              verb,
            })
          : new StaveError({
              code: "unreadable",
              message: `stave ${verb} returned JSON that does not match its contract`,
              details: { detail: failure.detail },
              exitCode: 0,
              stderrTail,
              verb,
            });
      }

      const exitCode = output.code;
      const envelope = parseStaveErrorEnvelope(output.stdout);
      if (Option.isSome(envelope)) {
        const { code, rawCode, message, details } = envelope.value;
        return yield* new StaveError({
          code,
          message,
          details: rawCode === code ? details : { ...details, rawCode },
          exitCode,
          stderrTail,
          verb,
        });
      }
      return yield* new StaveError({
        code: "non_json_output",
        message:
          stderrTail ??
          `stave ${verb} exited with status ${exitCode === null ? "unknown" : exitCode}`,
        details: null,
        exitCode,
        stderrTail,
        verb,
      });
    }).pipe(
      Effect.withSpan(`StaveCli.${verb}`, {
        attributes: { "stave.verb": verb, "stave.args_count": spec.args.length },
      }),
    );
  };

  /** Pairs a builder with a decoder; a builder failure never spawns. */
  const method =
    <Input, A>(verb: StaveVerb, build: StaveArgvBuilder<Input>, decode: StaveDecoder<A>) =>
    (input: Input, stream?: StaveStreamOptions): Effect.Effect<A, StaveError> => {
      const built = build(input);
      if (Result.isFailure(built)) {
        return Effect.fail(
          new StaveError({
            code: "invalid_arguments",
            message: built.failure,
            details: null,
            exitCode: null,
            stderrTail: null,
            verb,
          }),
        );
      }
      return runVerb({ verb, args: built.success, decode, stream });
    };

  const spaceList = method("space list", buildStaveArgv.spaceList, decodeStaveSpaceList);
  const memoryList = method("memory list", buildStaveArgv.memoryList, decodeStaveMemoryList);
  const setup = method("setup", buildStaveArgv.setup, decodeStaveSetupResult);

  return StaveCli.of({
    version: method("version", buildStaveArgv.version, decodeStaveVersion)(undefined),
    configShow: method("config show", buildStaveArgv.configShow, decodeStaveConfigShow)(undefined),
    reposList: method("repos list", buildStaveArgv.reposList, decodeStaveReposList)(undefined),
    spaceList: (input = {}) => spaceList(input),
    spaceStatus: method("space status", buildStaveArgv.spaceStatus, decodeStaveSpaceStatus),
    sagaList: method("saga list", buildStaveArgv.sagaList, decodeStaveSagaList)(undefined),
    sagaStatus: method("saga status", buildStaveArgv.sagaStatus, decodeStaveSagaStatus),
    memoryProviders: method(
      "memory providers",
      buildStaveArgv.memoryProviders,
      decodeStaveMemoryProviders,
    )(undefined),
    memoryList: (input = {}) => memoryList(input),
    setup: (input = {}, stream) => setup(input, stream),
    reposAdd: method("repos add", buildStaveArgv.reposAdd, decodeStaveReposAddResult),
    spaceInit: method(
      "space init",
      buildStaveArgv.spaceInit,
      withoutDryRun(decodeStaveSpaceMutationResult),
    ),
    spaceCreate: method("space create", buildStaveArgv.spaceCreate, decodeStaveSpaceMutationResult),
    spaceAdd: method("space add", buildStaveArgv.spaceAdd, decodeStaveSpaceMutationResult),
    spaceRemove: method("space remove", buildStaveArgv.spaceRemove, decodeStaveSpaceMutationResult),
    spaceSync: method("space sync", buildStaveArgv.spaceSync, decodeStaveSpaceSyncResult),
    spaceRetarget: method(
      "space retarget",
      buildStaveArgv.spaceRetarget,
      decodeStaveSpaceMutationResult,
    ),
    spaceArchive: method(
      "space archive",
      buildStaveArgv.spaceArchive,
      decodeStaveSpaceArchiveResult,
    ),
    spaceRestore: method(
      "space restore",
      buildStaveArgv.spaceRestore,
      decodeStaveSpaceMutationResult,
    ),
    spaceDestroy: method(
      "space destroy",
      buildStaveArgv.spaceDestroy,
      decodeStaveSpaceDestroyResult,
    ),
    sagaCreate: method("saga create", buildStaveArgv.sagaCreate, decodeStaveSagaMutationResult),
    sagaAdd: method("saga add", buildStaveArgv.sagaAdd, decodeStaveSagaMutationResult),
    sagaRemove: method("saga remove", buildStaveArgv.sagaRemove, decodeStaveSagaMutationResult),
    sagaSync: method("saga sync", buildStaveArgv.sagaSync, decodeStaveSagaSyncResult),
    sagaArchive: method("saga archive", buildStaveArgv.sagaArchive, decodeStaveSagaTeardownResult),
    sagaDestroy: method("saga destroy", buildStaveArgv.sagaDestroy, decodeStaveSagaTeardownResult),
    memoryAttach: method(
      "memory attach",
      buildStaveArgv.memoryAttach,
      decodeStaveMemoryAttachResult,
    ),
    memoryDetach: method(
      "memory detach",
      buildStaveArgv.memoryDetach,
      decodeStaveMemoryDetachResult,
    ),
  });
});

export const layer = Layer.effect(StaveCli, make());
