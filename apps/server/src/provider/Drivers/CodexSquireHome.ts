/**
 * Lecturn: the CODEX_HOME a Squire home or probe runs in (A5.9, D48, OQ24).
 *
 * Codex always loads `CODEX_HOME/AGENTS.md` into a thread's prompt, and no
 * thread config suppresses it (S0a2), so a marked thread runs in its own
 * home, one per provider instance under Lecturn's state directory. That home
 * holds only what a thread needs from the instance's home, linked from an
 * allowlist: the login and the thread store. The user's AGENTS.md, skills,
 * memories, plugins, rules, hooks, and config.toml stay behind, and so does
 * any entry a later Codex adds until it is listed here.
 */
import type { CodexSettings, ProviderInstanceId } from "@lecturn/contracts";
import { expandHomePath } from "@lecturn/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";

/**
 * Created in the source home if missing and always linked, so Codex never
 * starts a private copy that a later link would have to replace. Shared so a
 * probe can natively fork the user's thread, and so the instance keeps one
 * thread index and one set of writer locks across both homes.
 */
const LINKED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "thread-writer-locks",
  "rollout-migrations",
] as const;

/**
 * Codex 0.165.0's thread index and history, linked even before the source has
 * them: SQLite and Codex's appends create a missing target through the link,
 * so a Squire that starts first on a fresh home still writes the shared copy.
 */
const ALWAYS_LINKED_FILES = ["session_index.jsonl", "state_5.sqlite", "thread_history_1.sqlite"];

/**
 * Linked when the source home has them. The SQLite names carry Codex's schema
 * version, hence the pattern; SQLite resolves a linked database's path, so its
 * `-wal` and `-shm` files stay beside the source.
 */
const LINKED_FILE =
  /^(?:auth\.json|session_index\.jsonl|(?:state|thread_history)_\d+\.sqlite|\.sqlite-maintenance\.lock|\.app-server-state-reconciled[\w.-]*)$/u;

/**
 * Why auth.json is a link to the source home's file, not a copy: ChatGPT
 * refresh tokens rotate on use. A copy that refreshed would leave the source
 * holding a spent refresh token and log the user's own Codex out; a copy that
 * did not would go stale once the source refreshed, and writing it back could
 * overwrite a newer token. Codex rewrites auth.json in place (open and
 * truncate, which follows the link; checked on 0.165.0 with `codex login`), so
 * the user's CLI, Lecturn's ordinary threads, and the Squire read and refresh
 * one file, as they did when the Squire ran in the source home. The file store
 * is pinned because a keyring entry is keyed by the CODEX_HOME path: a keyring
 * write here would split the login in two.
 */
export const CODEX_SQUIRE_HOME_LAUNCH_ARGS = `-c 'cli_auth_credentials_store="file"'`;

const LAUNCH_ARGS_ENV = "LECTURN_CODEX_LAUNCH_ARGS";

export class CodexSquireHomeError extends Schema.TaggedError<CodexSquireHomeError>()(
  "CodexSquireHomeError",
  {
    squireHomePath: Schema.String,
    sourceHomePath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not prepare the Squire Codex home '${this.squireHomePath}' from '${this.sourceHomePath}': ${this.detail}`;
  }
}

/**
 * The source home holds no auth.json, so the Squire home has no login: a
 * keyring login is keyed by the source's CODEX_HOME path and does not carry
 * over, and the Squire home is pinned to the file store.
 */
export class CodexSquireLoginError extends Schema.TaggedError<CodexSquireLoginError>()(
  "CodexSquireLoginError",
  { sourceHomePath: Schema.String },
) {
  override get message(): string {
    return `A Squire can use only a Codex sign-in saved as a file, and ${this.sourceHomePath} has none (a sign-in kept in the system keyring stays there). Run \`codex login -c 'cli_auth_credentials_store="file"'\`, then try again.`;
  }
}

/** Codex reads these from the environment, which the Squire home keeps. */
const API_KEY_ENV = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;

/** A Squire thread on an ordinary session, or the reverse: their CODEX_HOMEs differ. */
export class CodexSquireSessionMismatchError extends Schema.TaggedError<CodexSquireSessionMismatchError>()(
  "CodexSquireSessionMismatchError",
  { squireThread: Schema.Boolean, squireSession: Schema.Boolean },
) {
  override get message(): string {
    return this.squireThread
      ? "A Squire thread cannot run on an ordinary Codex session, which loads the user's CODEX_HOME."
      : "An ordinary thread cannot run on a Squire Codex session, which runs without the user's CODEX_HOME.";
  }
}

export interface CodexLaunch {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}

/** The home an instance's ordinary threads run in: as Codex resolves it when Lecturn sets none. */
export const codexSourceHomePath = (
  path: Path.Path,
  launch: CodexLaunch,
  homeDirectory: string,
): string => {
  const configured = launch.settings.homePath.trim() || launch.environment.CODEX_HOME?.trim();
  return path.resolve(
    configured ? expandHomePath(configured, homeDirectory) : path.join(homeDirectory, ".codex"),
  );
};

export const codexSquireHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
): string => path.join(stateDir, "providers", "codex", instanceId, "squire-home");

type EntryState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Link"; readonly target: string }
  | { readonly _tag: "Real"; readonly directory: boolean };

export const materializeCodexSquireHome = Effect.fn("materializeCodexSquireHome")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly sourceHomePath: string;
    readonly squireHomePath: string;
  }) {
    const { fileSystem, path, sourceHomePath, squireHomePath } = input;
    const fail = (detail: string) => (cause: unknown) =>
      new CodexSquireHomeError({ squireHomePath, sourceHomePath, detail, cause });
    if (path.resolve(sourceHomePath) === path.resolve(squireHomePath)) {
      return yield* new CodexSquireHomeError({
        squireHomePath,
        sourceHomePath,
        detail: "the Squire home must differ from the instance's home.",
      });
    }

    const entryState = (entryPath: string) =>
      fileSystem.readLink(entryPath).pipe(
        Effect.map((target): EntryState => ({ _tag: "Link", target })),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed<EntryState>({ _tag: "Missing" })
              : fileSystem.stat(entryPath).pipe(
                  Effect.map((info): EntryState => ({
                    _tag: "Real",
                    directory: info.type === "Directory",
                  })),
                ),
        }),
        Effect.mapError(fail(`could not read '${entryPath}'.`)),
      );
    const remove = (entryPath: string) =>
      fileSystem
        .remove(entryPath, { force: true })
        .pipe(Effect.mapError(fail(`could not remove '${entryPath}'.`)));

    yield* Effect.forEach(
      [squireHomePath, ...LINKED_DIRECTORIES.map((name) => path.join(sourceHomePath, name))],
      (directory) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError(fail(`could not create '${directory}'.`))),
      { discard: true },
    );
    const sourceEntries = yield* fileSystem
      .readDirectory(sourceHomePath)
      .pipe(Effect.mapError(fail("could not list the instance's home.")));
    const linked = new Set<string>([
      ...LINKED_DIRECTORIES,
      ...ALWAYS_LINKED_FILES,
      ...sourceEntries.filter((name) => LINKED_FILE.test(name)),
    ]);

    // A link nothing wants any more goes: auth.json after the user logs out of
    // the source, or a link left by an older allowlist.
    const localEntries = yield* fileSystem
      .readDirectory(squireHomePath)
      .pipe(Effect.mapError(fail("could not list the Squire home.")));
    yield* Effect.forEach(
      localEntries.filter((name) => !linked.has(name)),
      (name) =>
        entryState(path.join(squireHomePath, name)).pipe(
          Effect.flatMap((state) =>
            state._tag === "Link" ? remove(path.join(squireHomePath, name)) : Effect.void,
          ),
        ),
      { discard: true },
    );

    yield* Effect.forEach(
      linked,
      (name) =>
        Effect.gen(function* () {
          const target = path.join(sourceHomePath, name);
          const link = path.join(squireHomePath, name);
          const state = yield* entryState(link);
          if (state._tag === "Link" && path.resolve(squireHomePath, state.target) === target)
            return;
          if (state._tag === "Real" && state.directory) {
            return yield* new CodexSquireHomeError({
              squireHomePath,
              sourceHomePath,
              detail: `'${link}' is a directory where a link to the instance's home belongs.`,
            });
          }
          // A file Codex wrote here before the source had one (a database a
          // newer Codex created first, a lock, a marker): the source's wins.
          if (state._tag !== "Missing") {
            yield* remove(link);
            if (name.endsWith(".sqlite")) {
              yield* remove(`${link}-wal`);
              yield* remove(`${link}-shm`);
            }
          }
          yield* fileSystem
            .symlink(target, link)
            .pipe(Effect.mapError(fail(`could not link '${link}' to '${target}'.`)));
        }),
      { discard: true },
    );
  },
);

// One lock per home path, shared by the adapter's sessions and the
// instance's Squire summaries, which prepare the same home.
const homeLocks = new Map<string, Semaphore.Semaphore>();
const homeLock = (squireHomePath: string) => {
  let lock = homeLocks.get(squireHomePath);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    homeLocks.set(squireHomePath, lock);
  }
  return lock;
};

/**
 * Prepares an instance's Squire home on each Squire session open, so links
 * follow the source home (a login, a logout, a new database), and returns the
 * launch for it. Opens are serialized: two Squire sessions share the home.
 */
export const makeCodexSquireHome = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly homeDirectory: string;
}) =>
  Effect.sync(() => {
    const squireHomePath = codexSquireHomePath(input.path, input.stateDir, input.instanceId);
    const lock = homeLock(squireHomePath);
    // Managed Codex signs in through the environment, never auth.json.
    const checkLogin = (launch: CodexLaunch) => {
      const sourceHomePath = codexSourceHomePath(input.path, launch, input.homeDirectory);
      if (
        launch.settings.setupMode === "managed" ||
        API_KEY_ENV.some((name) => launch.environment[name]?.trim())
      ) {
        return Effect.void;
      }
      return input.fileSystem.exists(input.path.join(sourceHomePath, "auth.json")).pipe(
        Effect.mapError(
          (cause) =>
            new CodexSquireHomeError({
              squireHomePath,
              sourceHomePath,
              detail: "could not look for the instance's login.",
              cause,
            }),
        ),
        Effect.flatMap((found) =>
          found ? Effect.void : Effect.fail(new CodexSquireLoginError({ sourceHomePath })),
        ),
      );
    };
    return {
      squireHomePath,
      /** Why a Squire cannot run on this launch, or null; read by the Squire provider picker. */
      readiness: (launch: CodexLaunch) =>
        checkLogin(launch).pipe(
          Effect.as(null),
          Effect.catchTags({
            CodexSquireLoginError: (error) => Effect.succeed(error.message),
            // An unreadable home surfaces on open, with its cause.
            CodexSquireHomeError: () => Effect.succeed(null),
          }),
        ),
      prepare: (launch: CodexLaunch) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* checkLogin(launch);
            yield* materializeCodexSquireHome({
              fileSystem: input.fileSystem,
              path: input.path,
              sourceHomePath: codexSourceHomePath(input.path, launch, input.homeDirectory),
              squireHomePath,
            });
            // The env override would replace the settings' args, the pinned
            // store with them, so it is folded in here instead.
            const {
              [LAUNCH_ARGS_ENV]: _launchArgs,
              CODEX_HOME: _home,
              ...environment
            } = launch.environment;
            const launchArgs = resolveCodexLaunchArgs(
              launch.settings.launchArgs,
              launch.environment,
            );
            return {
              settings: {
                ...launch.settings,
                homePath: squireHomePath,
                launchArgs: `${launchArgs} ${CODEX_SQUIRE_HOME_LAUNCH_ARGS}`.trim(),
              },
              environment,
            } satisfies CodexLaunch;
          }),
        ),
    };
  });
