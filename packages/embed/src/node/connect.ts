// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Promise API for hosts that run no Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AppRegistration,
  type AppEmbedTarget,
  type ConnectedAppThreadSummary,
  type ConnectedAppThreadsStreamEvent,
} from "@lecturn/contracts/apps";
import * as Schema from "effect/Schema";

import type {
  ConnectionEvent,
  ConnectionMode,
  ConnectionModeEvent,
  ConnectionPairing,
  ConnectionStatus,
  ConnectionStatusEvent,
  EmbedConnectionSource,
} from "../target.ts";
import {
  hasRunningTurn,
  latestCopies,
  readAttachLedger,
  threadsToCopy,
  writeAttachLedger,
  type AttachLedger,
} from "./copyLedger.ts";
import {
  type CredentialStore,
  isCredentialUsable,
  loadKeyring,
  makeCredentialStore,
} from "./credentials.ts";
import { discoverServer } from "./discovery.ts";
import { type LiveLeaseHeartbeat, type LiveTools, makeLiveLeaseHeartbeat } from "./liveLease.ts";
import {
  createPairingRequest,
  type PairingPoll,
  type PairingRequest,
  pollPairingRequest,
} from "./pairing.ts";
import {
  CredentialRejectedError,
  exchangeSeedToken,
  openServerSession,
  type ServerSession,
} from "./serverSession.ts";
import { type SidecarOptions, startSidecar } from "./sidecar.ts";

export { exchangeSeedToken, issueWebSocketTicket } from "./serverSession.ts";

export interface ConnectOptions {
  readonly registration: typeof AppRegistration.Encoded;
  /** The user's Lecturn home; defaults to `LECTURN_HOME`, then `~/.lecturn`. Tests pass a temp dir. */
  readonly lecturnHome?: string;
  readonly sidecar: SidecarOptions;
  readonly readyTimeoutMs?: number;
}

export interface LecturnConnection extends EmbedConnectionSource {
  /** Changes on a live switch; a `mode` event announces each one. */
  readonly mode: ConnectionMode;
  readonly environmentId: string;
  readonly origin: string;
  readonly status: ConnectionStatus;
  ensureWorkspace(workspaceRoot: string, title: string): Promise<{ readonly projectId: string }>;
  embedTarget(projectId: string, threadId?: string): Promise<AppEmbedTarget>;
  refreshEmbedToken(projectId: string): Promise<AppEmbedTarget>;
  workspaceRootOf(projectId: string): string | null;
  /**
   * Publishes the app's live MCP endpoint and keeps its lease alive while the
   * app runs (heartbeat every 20 s, lease 60 s). Calling it again moves the
   * lease to the new endpoint.
   */
  setLiveTools(tools: LiveTools): Promise<void>;
  /** Live tools then answer that the app is closed. */
  clearLiveTools(): Promise<void>;
  /** The project's threads as the app's rail shows them, `appData` and subtitle included. */
  listThreads(projectId: string): Promise<ReadonlyArray<ConnectedAppThreadSummary>>;
  /**
   * A snapshot, then an upsert or removal per change. Survives reconnects and
   * server switches (each starts with a fresh snapshot, in the new server's
   * ids) until the returned function is called or the connection closes.
   */
  subscribeThreads(
    projectId: string,
    listener: (event: ConnectedAppThreadsStreamEvent) => void,
  ): () => void;
  /**
   * Only the owning app writes `appData`. An omitted `subtitle` keeps the current one and null
   * clears it; neither write counts as thread history, so it never causes a re-copy.
   */
  setThreadAppData(
    threadId: string,
    appData: string | null,
    subtitle?: string | null,
  ): Promise<void>;
  /** After the user denied pairing, asks the user server again. */
  requestPairingAgain(): Promise<void>;
  /** Clears the live leases, and stops the sidecar only when this connection started it. */
  close(): Promise<void>;
}

export interface UserServer {
  readonly origin: string;
  readonly environmentId: string;
}

export interface SidecarRuntime {
  readonly session: ServerSession;
  /** Stops the process when this connection started it; an attached sidecar is left running. */
  stop(): Promise<void>;
}

/** Everything `connect` touches outside itself; tests stand in fake servers here. */
export interface ConnectDeps {
  discover(): Promise<UserServer | null>;
  openSidecar(): Promise<SidecarRuntime>;
  hasSidecarState(): Promise<boolean>;
  /** The sidecar's environment from an earlier run, to find its copies without starting it. */
  knownSidecarEnvironmentId(): Promise<string | null>;
  openUserServer(server: UserServer, token: string): Promise<ServerSession>;
  createPairingRequest(server: UserServer): Promise<PairingRequest>;
  pollPairingRequest(server: UserServer, request: PairingRequest): Promise<PairingPoll>;
  readonly credentials: CredentialStore;
  readLedger(): Promise<AttachLedger>;
  writeLedger(ledger: AttachLedger): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/** D36 asks for 5 s or less: a user server that starts later is found within one beat. */
export const USER_SERVER_WATCH_INTERVAL_MS = 2_000;
// A switch that failed for a reason other than the credential (an import
// error, a server still starting) is not retried on every beat.
const ATTACH_RETRY_MS = 30_000;
// One missed probe can be a busy server; two in a row is a server that is gone.
const USER_SERVER_MISSES_BEFORE_FALLBACK = 2;
const MARK_COPIED_BATCH = 1_000;
const CLOSE_TIMEOUT_MS = 2_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const withTimeout = <A>(promise: Promise<A>, ms: number) =>
  Promise.race([promise.then(() => undefined), delay(ms)]).catch(() => undefined);

const invert = (map: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));

interface ThreadSubscription {
  projectId: string;
  session: ServerSession;
  stop: () => void;
  readonly listener: (event: ConnectedAppThreadsStreamEvent) => void;
}

/**
 * The attach state machine (D33, D36): sidecar while pairing is pending or
 * denied, a live switch to the user server on grant, and back to the sidecar
 * when the user server goes away. Exported for the fake-server tests.
 */
export async function createConnection(
  deps: ConnectDeps,
  options: { readonly watchIntervalMs?: number } = {},
): Promise<LecturnConnection> {
  const watchIntervalMs = Math.min(options.watchIntervalMs ?? USER_SERVER_WATCH_INTERVAL_MS, 5_000);

  let ledger = await deps.readLedger();
  let ledgerWrite: Promise<void> = Promise.resolve();
  const updateLedger = (change: (current: AttachLedger) => AttachLedger) => {
    const next = change(ledger);
    if (JSON.stringify(next) === JSON.stringify(ledger)) return ledgerWrite;
    ledger = next;
    ledgerWrite = ledgerWrite.then(() => deps.writeLedger(next)).catch(() => undefined);
    return ledgerWrite;
  };

  let sidecar: SidecarRuntime | null = null;
  let user: { readonly server: UserServer; readonly session: ServerSession } | null = null;
  let active: ServerSession | null = null;
  let mode: ConnectionMode = "sidecar";
  let pairing: ConnectionPairing = "none";
  let pairingRequest: { readonly server: UserServer; readonly request: PairingRequest } | null =
    null;
  // After a switch the sidecar stays up, lease included, until no turn runs on it (D33).
  let draining = false;
  let userMisses = 0;
  let attachRetryAt = 0;
  // Sidecar thread id to its current user-server copy, from the last attach.
  let threadCopies: Record<string, string> = {};
  let liveTools: LiveTools | null = null;
  let closed = false;
  const leases = new Map<ServerSession, LiveLeaseHeartbeat>();
  // Project ids are unique across servers, so one map serves both.
  const projects = new Map<string, { readonly root: string; readonly environmentId: string }>();
  const listeners = new Set<(event: ConnectionEvent) => void>();
  const subscriptions = new Set<ThreadSubscription>();

  const requireActive = () => {
    if (active === null) throw new Error("The Lecturn connection is not attached to a server.");
    return active;
  };
  const recordProject = (session: ServerSession, root: string, projectId: string) => {
    projects.set(projectId, { root, environmentId: session.environmentId });
  };
  const projectIdsOn = (environmentId: string) => {
    const ids: Record<string, string> = {};
    for (const [projectId, project] of projects) {
      if (project.environmentId === environmentId) ids[project.root] = projectId;
    }
    return ids;
  };
  const sessionFor = (projectId: string) => {
    const environmentId = projects.get(projectId)?.environmentId;
    for (const session of [user?.session, sidecar?.session]) {
      if (session !== undefined && session.environmentId === environmentId) return session;
    }
    return requireActive();
  };
  const ensureAll = async (session: ServerSession) => {
    for (const [root, title] of Object.entries(ledger.workspaces)) {
      const { projectId } = await session.ensureWorkspace(root, title);
      recordProject(session, root, projectId);
    }
    return projectIdsOn(session.environmentId);
  };

  const leaseFor = (session: ServerSession) => {
    let lease = leases.get(session);
    if (lease === undefined) {
      lease = makeLiveLeaseHeartbeat({
        setLease: (input) => session.setLiveLease(input),
        clearLease: () => session.clearLiveLease(),
      });
      leases.set(session, lease);
    }
    return lease;
  };
  const dropLease = async (session: ServerSession, clear: boolean) => {
    const lease = leases.get(session);
    if (lease === undefined) return;
    leases.delete(session);
    if (clear) await withTimeout(lease.clear(), CLOSE_TIMEOUT_MS);
    lease.stop();
  };

  const statusEvent = (): ConnectionStatusEvent => ({ type: "status", mode, pairing, app: null });
  let lastStatus = statusEvent();
  const emit = (event: ConnectionEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A host's listener must not stop the switch it is being told about.
      }
    }
  };
  const emitStatus = () => {
    const next = statusEvent();
    if (next.mode === lastStatus.mode && next.pairing === lastStatus.pairing) return;
    lastStatus = next;
    emit(next);
  };
  const emitMode = (session: ServerSession, threadIdMap: Record<string, string>) => {
    const event: ConnectionModeEvent = {
      type: "mode",
      mode,
      environmentId: session.environmentId,
      projectIdsByWorkspaceRoot: projectIdsOn(session.environmentId),
      threadIdMap,
    };
    emit(event);
    emitStatus();
  };

  const moveSubscriptions = (target: ServerSession) => {
    for (const subscription of subscriptions) {
      if (subscription.session === target) continue;
      const root = projects.get(subscription.projectId)?.root;
      const projectId = root === undefined ? undefined : projectIdsOn(target.environmentId)[root];
      if (projectId === undefined) continue;
      subscription.stop();
      subscription.session = target;
      subscription.projectId = projectId;
      subscription.stop = target.subscribeThreads(projectId, subscription.listener);
    }
  };

  /** Sidecar thread id to its user-server copy, for every workspace the helper knows. */
  const copyMap = (
    sidecarEnvironmentId: string,
    userThreadsByRoot: ReadonlyMap<string, ReadonlyArray<ConnectedAppThreadSummary>>,
  ) => {
    const map: Record<string, string> = {};
    for (const threads of userThreadsByRoot.values()) {
      for (const [source, copy] of latestCopies(threads, sidecarEnvironmentId)) {
        map[source] = copy.threadId;
      }
    }
    return map;
  };
  const listByRoot = async (session: ServerSession, roots: ReadonlyArray<string>) => {
    const ids = projectIdsOn(session.environmentId);
    const lists = new Map<string, ReadonlyArray<ConnectedAppThreadSummary>>();
    for (const root of roots) {
      const projectId = ids[root];
      if (projectId !== undefined) lists.set(root, await session.listThreads(projectId));
    }
    return lists;
  };

  /**
   * Copies what the user server lacks: new sidecar threads and threads whose
   * history moved past their copy. Nothing is exported when nothing is due.
   */
  const copyThreads = async (side: ServerSession, userSession: ServerSession) => {
    await ensureAll(side);
    const roots = Object.keys(ledger.workspaces);
    const sideThreads = await listByRoot(side, roots);
    let userThreads = await listByRoot(userSession, roots);
    const due = new Set<string>();
    for (const [root, threads] of sideThreads) {
      const copies = latestCopies(userThreads.get(root) ?? [], side.environmentId);
      if (threadsToCopy(threads, copies).length > 0) due.add(root);
    }
    if (due.size > 0) {
      const sideIds = projectIdsOn(side.environmentId);
      const bundle = await side.exportThreads([...due].map((root) => sideIds[root]!));
      await userSession.importThreads(bundle);
      userThreads = await listByRoot(userSession, roots);
    }
    const map = copyMap(side.environmentId, userThreads);
    // Also re-marks a thread whose earlier mark was lost, so fallback still shows it read-only.
    const copiedAt = new Date(deps.now()).toISOString();
    const marks = [...sideThreads.values()].flat().flatMap((thread) => {
      const copy = map[thread.threadId];
      if (copy === undefined) return [];
      const marked = thread.continuedIn;
      if (marked?.environmentId === userSession.environmentId && marked.threadId === copy) {
        return [];
      }
      return [
        {
          threadId: thread.threadId,
          continuedIn: { environmentId: userSession.environmentId, threadId: copy, copiedAt },
        },
      ];
    });
    for (let start = 0; start < marks.length; start += MARK_COPIED_BATCH) {
      await side.markThreadsCopied(marks.slice(start, start + MARK_COPIED_BATCH));
    }
    return map;
  };

  const attach = async (server: UserServer, token: string) => {
    const session = await deps.openUserServer(server, token);
    let map: Record<string, string>;
    try {
      await ensureAll(session);
      if (sidecar !== null) {
        map = await copyThreads(sidecar.session, session);
      } else {
        const sidecarEnvironmentId = await deps.knownSidecarEnvironmentId();
        map =
          sidecarEnvironmentId === null
            ? {}
            : copyMap(
                sidecarEnvironmentId,
                await listByRoot(session, Object.keys(ledger.workspaces)),
              );
      }
      if (liveTools !== null) await leaseFor(session).set(liveTools);
      if (closed) throw new Error("The Lecturn connection closed during the switch.");
    } catch (error) {
      await dropLease(session, false);
      await session.close().catch(() => undefined);
      throw error;
    }
    user = { server, session };
    active = session;
    mode = "user-server";
    userMisses = 0;
    pairing = "none";
    pairingRequest = null;
    threadCopies = map;
    draining = sidecar !== null;
    moveSubscriptions(session);
    emitMode(session, map);
  };

  const enterSidecar = async () => {
    sidecar ??= await deps.openSidecar();
    const session = sidecar.session;
    draining = false;
    await ensureAll(session);
    if (liveTools !== null) await leaseFor(session).set(liveTools);
    active = session;
    mode = "sidecar";
    await updateLedger((current) => ({ ...current, pendingCopy: true }));
    return session;
  };

  const fallback = async () => {
    const gone = user;
    if (gone !== null) {
      user = null;
      await dropLease(gone.session, false);
      void gone.session.close().catch(() => undefined);
    }
    const session = await enterSidecar();
    moveSubscriptions(session);
    // Copies made on the user server map back to the sidecar threads they came from.
    emitMode(session, invert(threadCopies));
  };

  /** Stops the sidecar once no turn runs on it; until then a turn in flight finishes there. */
  const drain = async () => {
    const side = sidecar;
    const current = user;
    if (!draining || side === null || current === null) return;
    const roots = Object.keys(ledger.workspaces);
    const sideThreads = await listByRoot(side.session, roots);
    if ([...sideThreads.values()].some(hasRunningTurn)) return;
    let settled = false;
    try {
      const userThreads = await listByRoot(current.session, roots);
      settled = [...sideThreads].every(
        ([root, threads]) =>
          threadsToCopy(
            threads,
            latestCopies(userThreads.get(root) ?? [], side.session.environmentId),
          ).length === 0,
      );
    } catch {
      // Unknown counts as unsettled: the next connect starts the sidecar to check.
    }
    // A turn that ended after the copy leaves history for the next attach to pick up.
    if (settled) await updateLedger((ledgerNow) => ({ ...ledgerNow, pendingCopy: false }));
    draining = false;
    sidecar = null;
    await dropLease(side.session, true);
    await side.session.close().catch(() => undefined);
    await side.stop().catch(() => undefined);
  };

  const requestPairing = async (server: UserServer) => {
    const request = await deps.createPairingRequest(server);
    pairingRequest = { server, request };
    pairing = "pending";
    emitStatus();
  };

  const reach = async (server: UserServer) => {
    const credential = await deps.credentials.get(server.environmentId);
    if (credential !== null && isCredentialUsable(credential, deps.now())) {
      try {
        await attach(server, credential.token);
        return;
      } catch (error) {
        if (!(error instanceof CredentialRejectedError)) {
          attachRetryAt = deps.now() + ATTACH_RETRY_MS;
          return;
        }
      }
    }
    if (credential !== null) await deps.credentials.delete(server.environmentId);
    await requestPairing(server);
  };

  const pollPairing = async (pending: NonNullable<typeof pairingRequest>) => {
    let poll: PairingPoll;
    try {
      poll = await deps.pollPairingRequest(pending.server, pending.request);
    } catch {
      const found = await deps.discover().catch(() => null);
      if (found?.environmentId !== pending.server.environmentId) {
        pairingRequest = null;
        pairing = "none";
        emitStatus();
      }
      return;
    }
    switch (poll.state) {
      case "pairing-requested":
        return;
      case "expired":
        pairingRequest = null;
        await requestPairing(pending.server).catch(() => {
          pairing = "none";
          emitStatus();
        });
        return;
      case "denied":
      case "revoked":
        pairingRequest = null;
        pairing = "denied";
        emitStatus();
        return;
      case "granted": {
        pairingRequest = null;
        const credential = poll.credential;
        if (credential === undefined) {
          // Another poll took the one-time credential; asking again is the only way back.
          pairing = "none";
          emitStatus();
          return;
        }
        await deps.credentials.set(credential.environmentId, {
          token: credential.token,
          expiresAt: credential.expiresAt,
        });
        try {
          await attach(pending.server, credential.token);
        } catch {
          attachRetryAt = deps.now() + ATTACH_RETRY_MS;
          pairing = "none";
          emitStatus();
        }
        return;
      }
    }
  };

  const tick = async () => {
    if (mode === "user-server") {
      const found = await deps.discover().catch(() => null);
      if (user === null) return fallback();
      if (found?.environmentId !== user.server.environmentId) {
        userMisses += 1;
        if (userMisses >= USER_SERVER_MISSES_BEFORE_FALLBACK) await fallback();
        return;
      }
      userMisses = 0;
      return drain();
    }
    if (pairingRequest !== null) return pollPairing(pairingRequest);
    if (pairing === "denied" || deps.now() < attachRetryAt) return;
    const found = await deps.discover();
    if (found === null || found.environmentId === sidecar?.session.environmentId) return;
    await reach(found);
  };

  // Initial attach: a granted user server is used at once, copying first when
  // the sidecar may hold history it lacks (R7.4); otherwise the sidecar serves
  // while pairing waits on the user.
  const found = await deps.discover().catch(() => null);
  if (found !== null) {
    const credential = await deps.credentials.get(found.environmentId);
    let ask = credential === null;
    if (credential !== null && isCredentialUsable(credential, deps.now())) {
      if (ledger.pendingCopy && (await deps.hasSidecarState())) {
        sidecar = await deps.openSidecar().catch(() => null);
      }
      try {
        await attach(found, credential.token);
      } catch (error) {
        if (error instanceof CredentialRejectedError) {
          await deps.credentials.delete(found.environmentId);
          ask = true;
        } else {
          attachRetryAt = deps.now() + ATTACH_RETRY_MS;
        }
      }
    } else if (credential !== null) {
      await deps.credentials.delete(found.environmentId);
      ask = true;
    }
    if (ask) await requestPairing(found).catch(() => undefined);
  }
  // `mode` is set inside `attach`, which the compiler's narrowing cannot see.
  if ((mode as ConnectionMode) !== "user-server") {
    try {
      await enterSidecar();
    } catch (error) {
      await sidecar?.stop().catch(() => undefined);
      throw error;
    }
  }
  lastStatus = statusEvent();

  let wake = () => {};
  let transition: Promise<void> = Promise.resolve();
  const loop = (async () => {
    // `close` sets `closed` from outside the loop, between beats.
    while (true) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        void deps.wait(watchIntervalMs).then(resolve);
      });
      if (closed) return;
      transition = tick().catch(() => undefined);
      await transition;
    }
  })();

  let closing: Promise<void> | undefined;
  const status: ConnectionStatus = {
    get current() {
      return statusEvent();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(statusEvent());
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    get mode() {
      return mode;
    },
    get environmentId() {
      return requireActive().environmentId;
    },
    get origin() {
      return requireActive().origin;
    },
    status,
    workspaceRootOf: (projectId) => projects.get(projectId)?.root ?? null,
    ensureWorkspace: async (workspaceRoot, title) => {
      await transition;
      const session = requireActive();
      const result = await session.ensureWorkspace(workspaceRoot, title);
      recordProject(session, workspaceRoot, result.projectId);
      if (ledger.workspaces[workspaceRoot] !== title) {
        await updateLedger((current) => ({
          ...current,
          workspaces: { ...current.workspaces, [workspaceRoot]: title },
        }));
      }
      return result;
    },
    embedTarget: (projectId, threadId) => sessionFor(projectId).mintEmbedToken(projectId, threadId),
    // Embed tokens are scoped to the project; the thread only shapes the url.
    refreshEmbedToken: (projectId) => sessionFor(projectId).mintEmbedToken(projectId),
    setLiveTools: async (tools) => {
      liveTools = tools;
      const session = requireActive();
      if (draining && sidecar !== null && sidecar.session !== session) {
        leaseFor(sidecar.session)
          .set(tools)
          .catch(() => undefined);
      }
      await leaseFor(session).set(tools);
    },
    clearLiveTools: async () => {
      liveTools = null;
      await Promise.all([...leases.values()].map((lease) => lease.clear()));
    },
    listThreads: (projectId) => sessionFor(projectId).listThreads(projectId),
    subscribeThreads: (projectId, listener) => {
      const session = sessionFor(projectId);
      const subscription: ThreadSubscription = {
        projectId,
        session,
        listener,
        stop: session.subscribeThreads(projectId, listener),
      };
      subscriptions.add(subscription);
      return () => {
        if (!subscriptions.delete(subscription)) return;
        subscription.stop();
      };
    },
    setThreadAppData: (threadId, appData, subtitle) =>
      requireActive().setThreadAppData(threadId, appData, subtitle),
    requestPairingAgain: async () => {
      if (pairing !== "denied") return;
      pairing = "none";
      attachRetryAt = 0;
      emitStatus();
      wake();
    },
    close: () => {
      closing ??= (async () => {
        closed = true;
        wake();
        await withTimeout(loop, CLOSE_TIMEOUT_MS);
        // Clearing first lets Lecturn show the app as closed now rather than
        // when the lease lapses; a server that is already gone must not hold up close.
        const held = [...leases.values()];
        leases.clear();
        await withTimeout(Promise.all(held.map((lease) => lease.clear())), CLOSE_TIMEOUT_MS);
        for (const lease of held) lease.stop();
        for (const subscription of subscriptions) subscription.stop();
        subscriptions.clear();
        listeners.clear();
        await Promise.all(
          [user?.session, sidecar?.session].map((session) =>
            session?.close().catch(() => undefined),
          ),
        );
        await sidecar?.stop().catch(() => undefined);
        await ledgerWrite;
      })();
      return closing;
    },
  };
}

/**
 * The app session, shared by every helper attached to this sidecar. Sharing
 * the session rather than the seed matters: re-exchanging the seed replaces
 * the subject's earlier `desktop-bootstrap` session, which would sign the
 * other process out.
 */
const StoredSession = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.String,
  accessToken: Schema.String,
});
type StoredSession = typeof StoredSession.Type;
const decodeStoredSession = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSession));

const sidecarSessionPath = (baseDir: string) => NodePath.join(baseDir, "embed-app-session.json");

async function readStoredSession(path: string): Promise<StoredSession | null> {
  try {
    const decoded = decodeStoredSession(await NodeFSP.readFile(path, "utf8"));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

async function writeStoredSession(path: string, session: StoredSession): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await NodeFSP.rename(temp, path);
}

async function openSidecar(input: {
  readonly registration: AppRegistration;
  readonly sidecar: SidecarOptions;
  readonly readyTimeoutMs: number;
}): Promise<SidecarRuntime> {
  const { registration, readyTimeoutMs } = input;
  const deadline = Date.now() + readyTimeoutMs;
  const handle = await startSidecar({ registration, sidecar: input.sidecar, readyTimeoutMs });
  const stop = () => (handle.kind === "spawned" ? handle.stop() : Promise.resolve());
  try {
    const sessionPath = sidecarSessionPath(input.sidecar.baseDir);
    let accessToken: string;
    if (handle.kind === "spawned") {
      ({ accessToken } = await exchangeSeedToken({
        origin: handle.origin,
        seedToken: handle.appSeedToken,
        clientLabel: registration.name,
      }));
      await writeStoredSession(sessionPath, {
        appId: registration.appId,
        environmentId: handle.environmentId,
        accessToken,
      });
    } else {
      accessToken = await attachedSession(
        handle.environmentId,
        registration.appId,
        sessionPath,
        deadline,
      );
    }
    const session = await openServerSession({
      origin: handle.origin,
      environmentId: handle.environmentId,
      accessToken,
    });
    return { session, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// The owner writes the session just after it starts serving, so an attacher
// that won the discovery race can arrive first.
async function attachedSession(
  environmentId: string,
  appId: string,
  sessionPath: string,
  deadline: number,
): Promise<string> {
  while (true) {
    const stored = await readStoredSession(sessionPath);
    if (stored !== null && stored.environmentId === environmentId) {
      if (stored.appId !== appId) {
        throw new Error(`The sidecar in this baseDir belongs to the app ${stored.appId}.`);
      }
      return stored.accessToken;
    }
    if (Date.now() >= deadline) {
      throw new Error("The running sidecar in this baseDir published no app session.");
    }
    await delay(100);
  }
}

const decodeRegistration = Schema.decodeSync(AppRegistration);

const defaultLecturnHome = () =>
  process.env["LECTURN_HOME"] ?? NodePath.join(NodeOS.homedir(), ".lecturn");

/**
 * Connects the app to Lecturn: the user's own server when it has granted the
 * app, else the app's sidecar while pairing waits, switching live when the
 * user grants it or the user server comes and goes.
 */
export async function connect(options: ConnectOptions): Promise<LecturnConnection> {
  const registration = decodeRegistration(options.registration);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const lecturnHome = options.lecturnHome ?? defaultLecturnHome();
  const { baseDir } = options.sidecar;
  // A sidecar whose baseDir is the Lecturn home would find itself as the user server.
  const sameHome = NodePath.resolve(lecturnHome) === NodePath.resolve(baseDir);
  const keyring = await loadKeyring();
  return createConnection({
    discover: async () => {
      if (sameHome) return null;
      const server = await discoverServer(lecturnHome);
      return server === null
        ? null
        : { origin: server.origin, environmentId: server.environmentId };
    },
    openSidecar: () => openSidecar({ registration, sidecar: options.sidecar, readyTimeoutMs }),
    hasSidecarState: () =>
      NodeFSP.stat(NodePath.join(baseDir, "userdata")).then(
        () => true,
        () => false,
      ),
    knownSidecarEnvironmentId: async () =>
      (await readStoredSession(sidecarSessionPath(baseDir)))?.environmentId ?? null,
    openUserServer: (server, token) =>
      openServerSession({
        origin: server.origin,
        environmentId: server.environmentId,
        accessToken: token,
        verify: true,
      }),
    createPairingRequest: (server) => createPairingRequest(server.origin, registration),
    pollPairingRequest: (server, request) => pollPairingRequest(server.origin, request),
    credentials: makeCredentialStore({ appId: registration.appId, baseDir, keyring }),
    readLedger: () => readAttachLedger(baseDir),
    writeLedger: (next) => writeAttachLedger(baseDir, next),
    wait: delay,
    now: () => Date.now(),
  });
}
