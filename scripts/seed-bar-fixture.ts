#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - Host-side fixture tooling drives a server subprocess with Node process, timer and fetch APIs.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Relative imports keep this file runnable unchanged in a checkout of the
// baseline commit, whose scripts package does not depend on the contracts.
import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
} from "../packages/contracts/src/index.ts";
import * as EventSink from "../apps/server/src/orchestration-v2/EventSink.ts";
import * as EventStore from "../apps/server/src/orchestration-v2/EventStore.ts";
import { planProjectCommand } from "../apps/server/src/orchestration-v2/ProjectCommands.ts";
import * as ProjectionMaintenance from "../apps/server/src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../apps/server/src/orchestration-v2/ProjectionStore.ts";
import {
  BAR_APP_SETTINGS,
  type BarAppManifest,
  barAppServerEnv,
  stageBarAppFixture,
} from "./bar/app-fixture.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverBin = (serverRoot: string) => NodePath.join(serverRoot, "apps/server/src/bin.ts");
const SERVER_READY_LINE = "Lecturn server is ready.";
const DEFAULT_SERVER_START_TIMEOUT_MS = 90_000;
/** Raises the start timeout for slow hosts (cold caches, CI) without a flag on every script. */
export const BAR_SERVER_START_TIMEOUT_ENV = "BAR_SERVER_START_TIMEOUT_MS";

/** The `--start-timeout` flag wins over the env variable; both are milliseconds. */
export function barServerStartTimeoutMs(
  flag: string | number | undefined,
  env: Readonly<Record<string, string | undefined>> = NodeProcess.env,
): number {
  const [source, raw] =
    flag !== undefined
      ? ["--start-timeout", String(flag)]
      : [BAR_SERVER_START_TIMEOUT_ENV, env[BAR_SERVER_START_TIMEOUT_ENV]];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SERVER_START_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${source} must be a positive whole number of milliseconds, got '${raw}'.`);
  }
  return value;
}
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Captures freeze the browser clock here so relative ages render the same on every run. */
export const BAR_FIXTURE_NOW = "2026-10-20T12:00:00.000Z";

const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

export interface BarFixtureTool {
  readonly name: string;
  readonly title: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: string;
}

export interface BarFixtureTurn {
  readonly at: string;
  readonly user: string;
  readonly tools: ReadonlyArray<BarFixtureTool>;
  readonly assistant: string;
}

export interface BarFixtureThread {
  readonly key: string;
  readonly title: string;
  readonly state: "pinned" | "active" | "settled";
  readonly turns: ReadonlyArray<BarFixtureTurn>;
}

export interface BarFixtureProject {
  readonly key: string;
  readonly title: string;
  readonly createdAt: string;
  readonly threads: ReadonlyArray<BarFixtureThread>;
}

const simpleTurn = (at: string, user: string, assistant: string): BarFixtureTurn => ({
  at,
  user,
  tools: [],
  assistant,
});

// Shaped after the approved mockups: two workspaces, each with pinned, active
// and settled threads, and a pinned thread whose turn runs two tools.
export const BAR_FIXTURE: ReadonlyArray<BarFixtureProject> = [
  {
    key: "hopper-38mm",
    title: "hopper-38mm",
    createdAt: "2026-10-12T09:00:00.000Z",
    threads: [
      {
        key: "baseline-flight",
        title: "Baseline flight",
        state: "pinned",
        turns: [
          {
            at: "2026-10-20T11:48:00.000Z",
            user: "Simulate the baseline and check the design.",
            tools: [
              {
                name: "rw_simulate",
                title: "rw_simulate baseline",
                input: { config: "baseline" },
                output: "Apogee 305.23 m, max velocity 78.4 m/s, time to apogee 7.8 s.",
              },
              {
                name: "rw_design_check",
                title: "rw_design_check",
                input: {},
                output: "All design checks passed.",
              },
            ],
            assistant: "The saved baseline reaches 305.23 m. The design check passed.",
          },
        ],
      },
      {
        key: "fin-clearance",
        title: "Fin clearance",
        state: "active",
        turns: [
          simpleTurn(
            "2026-10-20T11:37:00.000Z",
            "Check the fin clearance against the motor casing.",
            "Fin clearance is 1.2 mm, above the 0.5 mm minimum.",
          ),
        ],
      },
      {
        key: "motor-selection",
        title: "Motor selection",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-17T15:10:00.000Z",
            "Compare the F and G motor classes for this airframe.",
            "The G class gives the target apogee with margin.",
          ),
        ],
      },
      {
        key: "nose-cone-shape",
        title: "Nose cone shape",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-16T10:20:00.000Z",
            "Which nose cone shape has the lowest drag here?",
            "The ogive shape has the lowest drag at these speeds.",
          ),
        ],
      },
      {
        key: "recovery-sizing",
        title: "Recovery sizing",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-15T14:05:00.000Z",
            "Size the parachute for a 5 m/s descent.",
            "A 60 cm parachute gives a 4.8 m/s descent.",
          ),
        ],
      },
    ],
  },
  {
    key: "liquid-demo",
    title: "liquid-demo",
    createdAt: "2026-10-13T09:00:00.000Z",
    threads: [
      {
        key: "feed-system",
        title: "Feed system",
        state: "pinned",
        turns: [
          simpleTurn(
            "2026-10-20T10:58:00.000Z",
            "Review the feed system pressure budget.",
            "The feed system holds 2.1 MPa at the injector.",
          ),
        ],
      },
      {
        key: "valve-sizing",
        title: "Valve sizing",
        state: "active",
        turns: [
          simpleTurn(
            "2026-10-20T10:30:00.000Z",
            "Size the main oxidizer valve.",
            "A 6 mm orifice valve meets the flow target.",
          ),
        ],
      },
      {
        key: "injector-pattern",
        title: "Injector pattern",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-18T09:15:00.000Z",
            "Compare doublet and showerhead injector patterns.",
            "The doublet pattern mixes better at this scale.",
          ),
        ],
      },
      {
        key: "tank-pressure",
        title: "Tank pressure",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-17T11:40:00.000Z",
            "What tank pressure does the regulator need?",
            "The regulator needs 3 MPa upstream.",
          ),
        ],
      },
      {
        key: "igniter-test",
        title: "Igniter test",
        state: "settled",
        turns: [
          simpleTurn(
            "2026-10-16T16:25:00.000Z",
            "Plan the igniter test sequence.",
            "The sequence arms, purges, then fires after a 3 s count.",
          ),
        ],
      },
    ],
  },
];

export const barProjectId = (project: BarFixtureProject) => ProjectId.make(`bar-${project.key}`);
export const barThreadId = (thread: BarFixtureThread) => ThreadId.make(`bar-${thread.key}`);

const at = (iso: string) => DateTime.makeUnsafe(iso);
const plus = (iso: string, seconds: number) => DateTime.add(at(iso), { seconds });

/** The time a seeded thread was last active, which is its shell `updatedAt`. */
export function barThreadUpdatedAt(thread: BarFixtureThread): string {
  const last = thread.turns.at(-1);
  if (last === undefined) throw new Error(`Bar fixture thread '${thread.key}' has no turns.`);
  return DateTime.formatIso(plus(last.at, 120));
}

export function barThreadCreatedAt(thread: BarFixtureThread): string {
  const first = thread.turns[0];
  if (first === undefined) throw new Error(`Bar fixture thread '${thread.key}' has no turns.`);
  return first.at;
}

export function barWorkspaceRoot(baseDir: string, project: BarFixtureProject): string {
  return NodePath.join(baseDir, "workspaces", project.key);
}

/**
 * Pins every fixture workspace to "not a Git repository", as CP0 drew it
 * (Initialize Git, no ref picker): Git stops looking for a repository at the
 * workspace, so a base dir inside a checkout cannot lend them its repo.
 */
export function barGitEnv(baseDir: string): Readonly<Record<string, string>> {
  const real = NodeFS.realpathSync(baseDir);
  return {
    GIT_CEILING_DIRECTORIES: [
      NodePath.join(real, "workspaces"),
      NodePath.join(real, "app-workspaces"),
    ].join(NodePath.delimiter),
  };
}

/** Each fixture workspace that Git, under the server's environment, sees inside a repository. */
export async function barGitStateProblems(
  baseDir: string,
  fixture: ReadonlyArray<BarFixtureProject> = BAR_FIXTURE,
): Promise<ReadonlyArray<string>> {
  const env = { ...NodeProcess.env, ...barGitEnv(baseDir) };
  const problems: Array<string> = [];
  for (const project of fixture) {
    const root = barWorkspaceRoot(baseDir, project);
    const inside = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: root, env }).then(
      ({ stdout }) => stdout.trim(),
      () => null,
    );
    if (inside !== null) problems.push(`${project.key} is inside the Git repository ${inside}`);
  }
  return problems;
}

export function buildBarProjectCommit(project: BarFixtureProject, workspaceRoot: string) {
  const projectId = barProjectId(project);
  const commandId = CommandId.make(`bar:project:${project.key}`);
  const acceptedAt = at(project.createdAt);
  const planned = planProjectCommand({
    command: {
      type: "project.create",
      commandId,
      projectId,
      title: project.title,
      workspaceRoot,
    },
    state: { project: undefined, workspaceOwner: undefined },
    eventId: EventId.make(`bar:project:${project.key}`),
    now: acceptedAt,
  });
  if (Result.isFailure(planned)) {
    throw new Error(
      `Bar fixture project '${project.key}' was rejected: ${planned.failure.message}`,
    );
  }
  return { commandId, projectId, acceptedAt, event: planned.success };
}

export function buildBarThreadEvents(
  project: BarFixtureProject,
  thread: BarFixtureThread,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = barThreadId(thread);
  const createdAt = at(barThreadCreatedAt(thread));
  const updatedAt = at(barThreadUpdatedAt(thread));
  const providerInstanceId = MODEL_SELECTION.instanceId;
  let eventIndex = 0;
  const nextEventId = () => EventId.make(`bar:${thread.key}:${eventIndex++}`);

  const created: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: barProjectId(project),
    title: thread.title,
    providerInstanceId,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: updatedAt,
    deletedAt: null,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: nextEventId(),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: created,
    },
  ];

  for (const [turnIndex, turn] of thread.turns.entries()) {
    const runId = RunId.make(`bar-run-${thread.key}-${turnIndex + 1}`);
    const userMessageId = MessageId.make(`bar-message-${thread.key}-${turnIndex + 1}-user`);
    const startedAt = at(turn.at);
    const completedAt = plus(turn.at, 120);
    events.push({
      id: nextEventId(),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: startedAt,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: userMessageId,
        threadId,
        runId,
        nodeId: null,
        role: "user",
        text: turn.user,
        attachments: [],
        streaming: false,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
    events.push({
      id: nextEventId(),
      type: "run.created",
      threadId,
      runId,
      providerInstanceId,
      occurredAt: startedAt,
      payload: {
        id: runId,
        threadId,
        ordinal: turnIndex + 1,
        providerInstanceId,
        modelSelection: MODEL_SELECTION,
        providerThreadId: null,
        userMessageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        queuePosition: null,
        requestedAt: startedAt,
        startedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    for (const [toolIndex, tool] of turn.tools.entries()) {
      const toolStartedAt = plus(turn.at, 20 + toolIndex * 30);
      const toolCompletedAt = plus(turn.at, 40 + toolIndex * 30);
      events.push({
        id: nextEventId(),
        type: "turn-item.updated",
        threadId,
        runId,
        providerInstanceId,
        occurredAt: toolCompletedAt,
        payload: {
          id: TurnItemId.make(`bar-tool-${thread.key}-${turnIndex + 1}-${toolIndex + 1}`),
          type: "dynamic_tool",
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: toolIndex + 1,
          status: "completed",
          title: tool.title,
          toolName: tool.name,
          input: tool.input,
          output: { content: [{ type: "text", text: tool.output }] },
          startedAt: toolStartedAt,
          completedAt: toolCompletedAt,
          updatedAt: toolCompletedAt,
        },
      });
    }
    events.push({
      id: nextEventId(),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: completedAt,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make(`bar-message-${thread.key}-${turnIndex + 1}-assistant`),
        threadId,
        runId,
        nodeId: null,
        role: "assistant",
        text: turn.assistant,
        attachments: [],
        streaming: false,
        createdAt: completedAt,
        updatedAt: completedAt,
      },
    });
  }

  // Active threads carry the explicit "active" override so the server's
  // age-based auto-settlement cannot move them while the fixture is served.
  const finalThread: OrchestrationV2AppThread =
    thread.state === "pinned"
      ? { ...created, pinnedAt: updatedAt, pinOrderKey: `a${thread.key}`, updatedAt }
      : thread.state === "settled"
        ? { ...created, settledOverride: "settled", settledAt: updatedAt, updatedAt }
        : { ...created, settledOverride: "active", unsettledAt: updatedAt, updatedAt };
  events.push({
    id: nextEventId(),
    type:
      thread.state === "pinned"
        ? "thread.pinned"
        : thread.state === "settled"
          ? "thread.settled"
          : "thread.unsettled",
    threadId,
    providerInstanceId,
    occurredAt: updatedAt,
    payload: finalThread,
  });
  return events;
}

export function barDatabasePath(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", "statev2.sqlite");
}

/**
 * Layers over the server's own stores against a database the server has
 * already migrated. Nothing else may hold the database while they run.
 */
export function barStoreLayer(baseDir: string) {
  const layerDatabase = NodeSqliteClient.layer({ filename: barDatabasePath(baseDir) });
  const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(layerDatabase),
  );
  return Layer.mergeAll(
    layerStores,
    EventSink.layer.pipe(Layer.provide(layerStores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(layerStores)),
  );
}

export class BarFixtureSeedError extends Schema.TaggedError<BarFixtureSeedError>()(
  "BarFixtureSeedError",
  { message: Schema.String },
) {}

export const seedBarFixtureOffline = Effect.fn("seedBarFixtureOffline")(function* (
  baseDir: string,
  fixture: ReadonlyArray<BarFixtureProject> = BAR_FIXTURE,
) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA foreign_keys = ON`;
  for (const project of fixture) {
    const commit = buildBarProjectCommit(project, barWorkspaceRoot(baseDir, project));
    const { committed } = yield* sink.commitProjectCommand({
      commandId: commit.commandId,
      projectId: commit.projectId,
      commandType: "project.create",
      acceptedAt: commit.acceptedAt,
      event: commit.event,
    });
    if (!committed) {
      return yield* new BarFixtureSeedError({
        message: `Bar fixture project '${project.key}' already exists in ${baseDir}.`,
      });
    }
  }
  const threadEvents = fixture.flatMap((project) =>
    project.threads.flatMap((thread) => buildBarThreadEvents(project, thread)),
  );
  yield* eventStore.append({ events: threadEvents });
  const verification = yield* maintenance.rebuild;
  if (!verification.valid) {
    return yield* new BarFixtureSeedError({
      message: `Projection rebuild left an invalid projection: missing ${verification.missingThreadIds.join(", ") || "none"}, unreadable ${verification.unreadableThreadIds.join(", ") || "none"}, sequence ${verification.projectionSequence}/${verification.expectedSequence}.`,
    });
  }
  return verification;
});

export function assertIsolatedBaseDir(baseDir: string, sharedHome?: string): void {
  // Resolve through the nearest existing ancestor so a not-yet-created
  // directory under a symlinked home still compares equal.
  const resolve = (value: string): string => {
    const absolute = NodePath.resolve(value);
    try {
      return NodeFS.realpathSync(absolute);
    } catch {
      const parent = NodePath.dirname(absolute);
      return parent === absolute
        ? absolute
        : NodePath.join(resolve(parent), NodePath.basename(absolute));
    }
  };
  const live = resolve(sharedHome ?? NodePath.join(NodeOS.homedir(), ".lecturn"));
  const target = resolve(baseDir);
  if (target === live || target.startsWith(`${live}${NodePath.sep}`)) {
    throw new Error("Refusing to seed the shared ~/.lecturn home. Use an isolated --base-dir.");
  }
}

async function reservePort(host: string): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port was reserved.");
  return address.port;
}

export interface BarServer {
  readonly origin: string;
  readonly port: number;
  readonly pairingUrl: string | null;
  readonly pid: number;
  readonly stop: () => Promise<void>;
}

export interface BarServerOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /** Checkout whose server runs, e.g. a baseline worktree; defaults to this one. */
  readonly serverRoot?: string | undefined;
  /** Added to the server's environment, e.g. to enable the scripted test provider. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Milliseconds to wait for the ready line; defaults to `barServerStartTimeoutMs`. */
  readonly startTimeoutMs?: number | undefined;
}

export async function startBarServer(
  input: BarServerOptions & { readonly baseDir: string },
): Promise<BarServer> {
  assertIsolatedBaseDir(input.baseDir);
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? (await reservePort(host));
  const serverRoot = input.serverRoot ?? REPO_ROOT;
  const startTimeoutMs = barServerStartTimeoutMs(input.startTimeoutMs);
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [
      serverBin(serverRoot),
      "serve",
      "--base-dir",
      input.baseDir,
      "--host",
      host,
      "--port",
      String(port),
      "--no-browser",
      "--log-level",
      "info",
    ],
    {
      cwd: serverRoot,
      env: { ...NodeProcess.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("The bar fixture server did not start.");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  const ready = new Promise<string | null>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Server did not report ready within ${startTimeoutMs}ms; raise it with --start-timeout <ms> or ${BAR_SERVER_START_TIMEOUT_ENV}.`,
          ),
        ),
      startTimeoutMs,
    );
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      const readyAt = output.indexOf(SERVER_READY_LINE);
      if (readyAt === -1) return;
      const pairing = /Pairing URL: (\S+)/u.exec(output.slice(readyAt));
      if (pairing === null && !output.slice(readyAt).includes("\n\n")) return;
      clearTimeout(timer);
      resolve(pairing?.[1] ?? null);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code} before it was ready:\n${output}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(forced);
  };
  try {
    const pairingUrl = await ready;
    return { origin: `http://${host}:${port}`, port, pairingUrl, pid, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A bearer token for checks against, or staging on, a running fixture server. */
export async function issueBarToken(
  baseDir: string,
  scopes: ReadonlyArray<string>,
  label: string,
  serverRoot: string = REPO_ROOT,
): Promise<string> {
  assertIsolatedBaseDir(baseDir);
  const { stdout } = await execFile(
    NodeProcess.execPath,
    [
      serverBin(serverRoot),
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--token-only",
      ...scopes.flatMap((scope) => ["--scope", scope]),
      "--label",
      label,
    ],
    { cwd: serverRoot, env: { ...NodeProcess.env, NO_COLOR: "1" } },
  );
  const token = stdout.trim().split(/\s+/u).at(-1);
  if (!token) throw new Error("The session issue command printed no token.");
  return token;
}

export const issueBarReadToken = (baseDir: string, serverRoot: string = REPO_ROOT) =>
  issueBarToken(baseDir, ["orchestration:read"], "bar-fixture-check", serverRoot);

export async function fetchBarShellSnapshot(
  origin: string,
  token: string,
): Promise<OrchestrationV2ShellSnapshot> {
  const response = await fetch(`${origin}/api/orchestration/shell`, {
    headers: {
      authorization: `Bearer ${token}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    },
  });
  if (!response.ok) {
    throw new Error(`Shell snapshot failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as OrchestrationV2ShellSnapshot;
}

export interface BarExpectedShell {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
}

export function expectedBarShell(
  fixture: ReadonlyArray<BarFixtureProject> = BAR_FIXTURE,
): BarExpectedShell {
  return {
    projects: fixture.map((project) => ({ id: barProjectId(project), title: project.title })),
    threads: fixture.flatMap((project) =>
      project.threads.map((thread) => ({
        id: barThreadId(thread),
        projectId: barProjectId(project),
        title: thread.title,
        createdAt: barThreadCreatedAt(thread),
        updatedAt: barThreadUpdatedAt(thread),
      })),
    ),
  };
}

const sameInstant = (left: unknown, right: string) =>
  typeof left === "string" && Date.parse(left) === Date.parse(right);

/** Every way the running server's shell disagrees with the seeded fixture. */
export function shellVisibilityProblems(
  snapshot: Pick<OrchestrationV2ShellSnapshot, "projects" | "threads">,
  expected: BarExpectedShell,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const projects = new Map(snapshot.projects.map((project) => [String(project.id), project]));
  for (const project of expected.projects) {
    const actual = projects.get(project.id);
    if (actual === undefined) problems.push(`project ${project.id} is missing`);
    else if (actual.title !== project.title) problems.push(`project ${project.id} title differs`);
  }
  const threads = new Map(snapshot.threads.map((thread) => [String(thread.id), thread]));
  for (const thread of expected.threads) {
    const actual = threads.get(thread.id);
    if (actual === undefined) {
      problems.push(`thread ${thread.id} is missing`);
      continue;
    }
    if (String(actual.projectId) !== thread.projectId) {
      problems.push(`thread ${thread.id} is in the wrong project`);
    }
    if (actual.title !== thread.title) problems.push(`thread ${thread.id} title differs`);
    if (!sameInstant(actual.createdAt, thread.createdAt)) {
      problems.push(`thread ${thread.id} createdAt ${String(actual.createdAt)}`);
    }
    if (!sameInstant(actual.updatedAt, thread.updatedAt)) {
      problems.push(`thread ${thread.id} updatedAt ${String(actual.updatedAt)}`);
    }
  }
  return problems;
}

export interface SeedBarFixtureResult {
  readonly baseDir: string;
  readonly server: BarServer | null;
  /** Present with `app`: the staged connected-app states the after-captures read. */
  readonly app: BarAppManifest | null;
}

/**
 * Seeds a fresh base directory: one server start runs the migrations, the
 * fixture is written offline through the server's own event sink and
 * projection rebuild, and a final start proves the server serves it.
 */
export async function seedBarFixture(
  input: BarServerOptions & {
    readonly baseDir: string;
    readonly restart?: boolean;
    readonly fixture?: ReadonlyArray<BarFixtureProject>;
    /** Also pair Embed Host, import its history and stage its live states (A38). */
    readonly app?: boolean;
  },
): Promise<SeedBarFixtureResult> {
  const baseDir = NodePath.resolve(input.baseDir);
  assertIsolatedBaseDir(baseDir);
  if (NodeFS.existsSync(barDatabasePath(baseDir))) {
    throw new Error(`${barDatabasePath(baseDir)} already exists; seed a fresh base directory.`);
  }
  const fixture = input.fixture ?? BAR_FIXTURE;
  await NodeFSP.mkdir(baseDir, { recursive: true });
  for (const project of fixture) {
    await NodeFSP.mkdir(barWorkspaceRoot(baseDir, project), { recursive: true });
  }
  const gitProblems = await barGitStateProblems(baseDir, fixture);
  if (gitProblems.length > 0) {
    throw new Error(
      `The fixture workspaces must not be Git repositories:\n- ${gitProblems.join("\n- ")}`,
    );
  }
  const app = input.app === true;
  if (app && input.restart === false) {
    throw new Error("The app fixture stages live turns, so it needs the server left running.");
  }
  const env = { ...barGitEnv(baseDir), ...(app ? barAppServerEnv(baseDir) : {}) };
  if (app) {
    await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(baseDir, "userdata", "settings.json"),
      `${JSON.stringify(BAR_APP_SETTINGS, null, 2)}\n`,
    );
  }
  const migrating = await startBarServer({
    baseDir,
    host: input.host,
    serverRoot: input.serverRoot,
    env,
    startTimeoutMs: input.startTimeoutMs,
  });
  await migrating.stop();
  await Effect.runPromise(
    seedBarFixtureOffline(baseDir, fixture).pipe(Effect.provide(barStoreLayer(baseDir))),
  );
  if (input.restart === false) return { baseDir, server: null, app: null };
  const server = await startBarServer({ ...input, baseDir, env });
  if (!app) return { baseDir, server, app: null };
  try {
    const hopper = fixture.find((project) => project.key === "hopper-38mm");
    if (hopper === undefined) {
      throw new Error("The app fixture stages its approval in hopper-38mm.");
    }
    const manifest = await stageBarAppFixture({
      baseDir,
      origin: server.origin,
      projectsApprovalProjectId: barProjectId(hopper),
      issueToken: (scopes, label) => issueBarToken(baseDir, scopes, label, input.serverRoot),
      fetchShell: async () =>
        fetchBarShellSnapshot(server.origin, await issueBarReadToken(baseDir, input.serverRoot)),
    });
    return { baseDir, server, app: manifest };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

function parseCliArgs(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      "base-dir": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "server-root": { type: "string" },
      "no-start": { type: "boolean", default: false },
      "start-timeout": { type: "string" },
      app: { type: "boolean", default: false },
    },
  });
  const baseDir = values["base-dir"];
  if (baseDir === undefined) {
    throw new Error(
      `Usage: node scripts/seed-bar-fixture.ts --base-dir <fresh dir> [--app] [--server-root <checkout>] [--host 127.0.0.1] [--port <n>] [--no-start] [--start-timeout <ms>]\n--start-timeout (or ${BAR_SERVER_START_TIMEOUT_ENV}) is how long each server start may take to report ready; default ${DEFAULT_SERVER_START_TIMEOUT_MS}.`,
    );
  }
  return {
    baseDir,
    host: values.host,
    port: values.port === undefined ? undefined : Number(values.port),
    serverRoot:
      values["server-root"] === undefined ? undefined : NodePath.resolve(values["server-root"]),
    restart: !values["no-start"],
    app: values.app,
    startTimeoutMs: barServerStartTimeoutMs(values["start-timeout"]),
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(NodeProcess.argv.slice(2));
  const { server, app } = await seedBarFixture(options);
  NodeProcess.stdout.write(`Seeded the bar fixture into ${NodePath.resolve(options.baseDir)}.\n`);
  if (server === null) return;
  NodeProcess.stdout.write(
    `Server ${server.origin} (pid ${server.pid})\nPairing URL: ${server.pairingUrl ?? "(not printed)"}\nCapture clock: ${BAR_FIXTURE_NOW}\n`,
  );
  if (app !== null) {
    NodeProcess.stdout.write(
      `App fixture: ${app.appName} staged at ${app.stagedAt} (app scenes use this clock).\nThe pending approval expires at ${app.approvalExpiresAt}; capture before then:\n  node scripts/bar/capture-web.ts --after --pairing-url <url> --base-dir ${NodePath.resolve(options.baseDir)} --out <dir> --checklist desktop\n`,
    );
  }
  NodeProcess.stdout.write("Press Ctrl-C to stop.\n");
  const shutdown = () => void server.stop().then(() => NodeProcess.exit(0));
  // The `node:process` namespace has no EventEmitter methods; only the process object does.
  globalThis.process.once("SIGINT", shutdown);
  globalThis.process.once("SIGTERM", shutdown);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}
