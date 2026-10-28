// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Tests the Promise API against fake servers and real temp dirs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import type {
  ConnectedAppThreadSummary,
  ConnectedAppThreadsStreamEvent,
} from "@lecturn/contracts/apps";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ConnectionEvent, ConnectionModeEvent } from "../target.ts";
import type { AttachLedger } from "./copyLedger.ts";
import {
  type ConnectDeps,
  connect,
  createConnection,
  exchangeSeedToken,
  issueWebSocketTicket,
  type LecturnConnection,
  USER_SERVER_WATCH_INTERVAL_MS,
} from "./connect.ts";
import {
  credentialFilePath,
  type CredentialStore,
  type KeyringEntry,
  makeCredentialStore,
  type StoredCredential,
} from "./credentials.ts";
import { isProcessAlive } from "./discovery.ts";
import type { PairingPoll } from "./pairing.ts";
import { CredentialRejectedError, openServerSession, type ServerSession } from "./serverSession.ts";

function recordingFetch(response: Response) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return response;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("exchangeSeedToken", () => {
  it("spends the seed as an environment-bootstrap token without asking for a scope", async () => {
    const { fetch, requests } = recordingFetch(
      Response.json({
        access_token: "app-session",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "apps:host",
      }),
    );

    const result = await exchangeSeedToken({
      origin: "http://127.0.0.1:41001",
      seedToken: "seed",
      clientLabel: "Example",
      fetch,
    });

    expect(result).toEqual({ accessToken: "app-session", expiresInSeconds: 2_592_000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:41001/oauth/token");
    const body = new URLSearchParams(String(requests[0]!.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "seed",
      subject_token_type: "urn:lecturn:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Example",
      client_device_type: "desktop",
    });
    expect(requests[0]!.init?.credentials).toBe("omit");
  });

  it("surfaces a refused seed with the server's answer", async () => {
    const { fetch } = recordingFetch(Response.json({ error: "invalid_grant" }, { status: 401 }));
    await expect(
      exchangeSeedToken({
        origin: "http://127.0.0.1:41001",
        seedToken: "x",
        clientLabel: "E",
        fetch,
      }),
    ).rejects.toThrow(/refused the sidecar seed: 401 .*invalid_grant/);
  });
});

describe("issueWebSocketTicket", () => {
  it("reads the ticket from the server's JSON answer", async () => {
    const { fetch, requests } = recordingFetch(
      Response.json({ ticket: "ws-ticket", expiresAt: "2026-10-25T11:36:24.457Z" }),
    );

    await expect(
      issueWebSocketTicket("http://127.0.0.1:41001", "app-session", fetch),
    ).resolves.toBe("ws-ticket");
    expect(requests[0]!.url).toBe("http://127.0.0.1:41001/api/auth/websocket-ticket");
    expect(requests[0]!.init?.credentials).toBe("omit");
  });

  it("tells a refused credential apart from a server that is not ready", async () => {
    const revoked = recordingFetch(Response.json({ error: "revoked" }, { status: 401 }));
    await expect(
      issueWebSocketTicket("http://127.0.0.1:41001", "old", revoked.fetch),
    ).rejects.toBeInstanceOf(CredentialRejectedError);
    const starting = recordingFetch(new Response("", { status: 503 }));
    const error = await issueWebSocketTicket("http://127.0.0.1:41001", "ok", starting.fetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).not.toBeInstanceOf(CredentialRejectedError);
  });
});

/** A ticket endpoint and a `/ws` that completes the handshake for a ticketed upgrade only. */
async function ticketedSocketServer() {
  const state = { refuse: false };
  const sockets: Array<NodeStream.Duplex> = [];
  let onConnected = () => {};
  const connected = new Promise<void>((resolve) => (onConnected = resolve));
  let onTicketlessUpgrade = () => {};
  const ticketlessUpgrade = new Promise<void>((resolve) => (onTicketlessUpgrade = resolve));
  const server = NodeHttp.createServer((_request, response) => {
    if (state.refuse) {
      response.writeHead(401).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ticket: "ticket", expiresAt: new Date(T0 + 60_000).toISOString() }));
  });
  server.on("upgrade", (request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    // A closing session resets its socket.
    socket.on("error", () => undefined);
    if (!new URL(request.url ?? "/", "http://127.0.0.1").searchParams.has("wsTicket")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      onTicketlessUpgrade();
      return;
    }
    const accept = NodeCrypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
    onConnected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    connected,
    ticketlessUpgrade,
    dropSockets: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("openServerSession", () => {
  it("reports a bearer the server refuses when the socket reconnects", async () => {
    const server = await ticketedSocketServer();
    const session = await openServerSession({
      origin: server.origin,
      environmentId: "env-user",
      accessToken: "bearer",
      verify: true,
    });
    try {
      await server.connected;
      expect(session.credentialRejected).toBe(false);

      // Revoking the app closes its socket, and its bearer gets no ticket from then on.
      server.state.refuse = true;
      server.dropSockets();
      await server.ticketlessUpgrade;
      expect(session.credentialRejected).toBe(true);
    } finally {
      await session.close();
      await server.close();
    }
  });
});

type Thread = {
  -readonly [K in keyof ConnectedAppThreadSummary]: ConnectedAppThreadSummary[K];
} & { lecturnTurns: boolean };

interface FakeBundle {
  readonly sourceEnvironmentId: string;
  readonly projects: ReadonlyArray<{
    readonly workspaceRoot: string;
    readonly title: string;
    readonly threads: ReadonlyArray<{
      readonly sourceThreadId: string;
      readonly title: string;
      readonly historyRevision: number;
    }>;
  }>;
}

const T0 = Date.parse("2026-10-25T10:00:00.000Z");

/**
 * One Lecturn server's app-visible state, with the copy rules of
 * ThreadCopyService: an up-to-date copy is skipped, a newer source
 * replaces a history-only copy in place, and metadata never moves history.
 */
class FakeServer {
  readonly projects = new Map<string, { readonly projectId: string; readonly title: string }>();
  readonly threads = new Map<string, Thread>();
  lease: { url: string; bearer: string } | null = null;
  /** Keyed `project:<id>` or `thread:<id>`, as the server's in-memory store. */
  readonly hostContext = new Map<string, string>();
  exports = 0;
  readonly imported: Array<string> = [];
  readonly sessions: Array<{ closed: boolean; rejected: boolean }> = [];
  private readonly subscribers = new Set<{
    readonly projectId: string;
    readonly listener: (event: ConnectedAppThreadsStreamEvent) => void;
  }>();

  readonly environmentId: string;
  readonly origin: string;

  constructor(environmentId: string, origin: string) {
    this.environmentId = environmentId;
    this.origin = origin;
  }

  projectId(root: string) {
    return this.projects.get(root)?.projectId;
  }

  ensure(root: string, title: string) {
    let project = this.projects.get(root);
    if (project === undefined) {
      project = { projectId: `${this.environmentId}-project-${this.projects.size + 1}`, title };
      this.projects.set(root, project);
    }
    return project.projectId;
  }

  addThread(root: string, threadId: string, fields: Partial<Thread> = {}) {
    const projectId = this.ensure(root, root);
    this.threads.set(threadId, {
      threadId,
      projectId,
      workspaceRoot: root,
      title: threadId,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      historyRevision: 1,
      state: "idle",
      appData: null,
      subtitle: null,
      lecturnTurns: false,
      ...fields,
    } as Thread);
  }

  thread(threadId: string) {
    return this.threads.get(threadId)!;
  }

  /** Metadata writes: `updatedAt` moves, history does not. */
  touch(threadId: string, change: Partial<Thread>) {
    const thread = this.thread(threadId);
    Object.assign(thread, change, {
      updatedAt: new Date(Date.parse(thread.updatedAt) + 1).toISOString(),
    });
  }

  copiesOf(sourceThreadId: string) {
    return [...this.threads.values()].filter(
      (thread) => thread.copiedFrom?.sourceThreadId === sourceThreadId,
    );
  }

  summaries(projectId: string): Array<ConnectedAppThreadSummary> {
    return [...this.threads.values()]
      .filter((thread) => thread.projectId === projectId)
      .map(({ lecturnTurns: _lecturnTurns, ...summary }) => structuredClone(summary));
  }

  open(): ServerSession {
    const handle = { closed: false, rejected: false };
    this.sessions.push(handle);
    const live = () => {
      if (handle.closed) throw new Error(`session to ${this.environmentId} is closed`);
    };
    return {
      origin: this.origin,
      environmentId: this.environmentId,
      get credentialRejected() {
        return handle.rejected;
      },
      ensureWorkspace: async (root, title) => {
        live();
        return { projectId: this.ensure(root, title) };
      },
      mintEmbedToken: async (projectId, threadId) => ({
        url: `${this.origin}/embed/${this.environmentId}/${projectId}${threadId ? `/${threadId}` : ""}`,
        token: `token-${this.environmentId}`,
        expiresAt: new Date(T0 + 900_000).toISOString(),
      }),
      setLiveLease: async (input) => {
        live();
        this.lease = { url: input.url, bearer: input.bearer };
        return { expiresAt: new Date(T0 + 60_000).toISOString() };
      },
      clearLiveLease: async () => {
        live();
        this.lease = null;
        return {};
      },
      listThreads: async (projectId) => {
        live();
        return this.summaries(projectId);
      },
      subscribeThreads: (projectId, listener) => {
        const subscriber = { projectId, listener };
        this.subscribers.add(subscriber);
        listener({ type: "snapshot", threads: this.summaries(projectId) });
        return () => {
          this.subscribers.delete(subscriber);
        };
      },
      setThreadAppData: async (threadId, appData, subtitle) => {
        live();
        this.touch(threadId, { appData, ...(subtitle === undefined ? {} : { subtitle }) });
      },
      updateHostContext: async (target, text) => {
        live();
        const key =
          "threadId" in target ? `thread:${target.threadId}` : `project:${target.projectId}`;
        if (text.length === 0) this.hostContext.delete(key);
        else this.hostContext.set(key, text);
      },
      exportThreads: async (projectIds) => {
        live();
        this.exports += 1;
        const bundle: FakeBundle = {
          sourceEnvironmentId: this.environmentId,
          projects: [...this.projects]
            .filter(([, project]) => projectIds.includes(project.projectId))
            .map(([workspaceRoot, project]) => ({
              workspaceRoot,
              title: project.title,
              threads: this.summaries(project.projectId).map((thread) => ({
                sourceThreadId: thread.threadId,
                title: thread.title,
                historyRevision: thread.historyRevision,
              })),
            })),
        };
        return bundle;
      },
      importThreads: async (raw) => {
        live();
        const bundle = raw as FakeBundle;
        let imported = 0;
        let skipped = 0;
        for (const project of bundle.projects) {
          this.ensure(project.workspaceRoot, project.title);
          for (const source of project.threads) {
            const copies = this.copiesOf(source.sourceThreadId);
            const latest = copies.toSorted(
              (a, b) => b.copiedFrom!.sourceHistoryRevision - a.copiedFrom!.sourceHistoryRevision,
            )[0];
            const copiedFrom = {
              appId: "dev.example.app",
              sourceEnvironmentId: bundle.sourceEnvironmentId,
              sourceThreadId: source.sourceThreadId,
              copiedAt: new Date(T0).toISOString(),
              sourceHistoryRevision: source.historyRevision,
            } as NonNullable<Thread["copiedFrom"]>;
            if (
              latest !== undefined &&
              latest.copiedFrom!.sourceHistoryRevision >= source.historyRevision
            ) {
              skipped += 1;
              continue;
            }
            imported += 1;
            this.imported.push(source.sourceThreadId);
            if (latest !== undefined && !latest.lecturnTurns) {
              latest.copiedFrom = copiedFrom;
              latest.historyRevision = source.historyRevision;
              continue;
            }
            const id =
              latest === undefined
                ? `copy:${bundle.sourceEnvironmentId}:${source.sourceThreadId}`
                : `copy:${bundle.sourceEnvironmentId}:${source.sourceThreadId}:${source.historyRevision}`;
            this.addThread(project.workspaceRoot, id, {
              title: source.title,
              historyRevision: source.historyRevision,
              copiedFrom,
            });
          }
        }
        return { imported, skipped };
      },
      markThreadsCopied: async (entries) => {
        live();
        for (const entry of entries) {
          this.touch(entry.threadId, {
            continuedIn: entry.continuedIn as NonNullable<Thread["continuedIn"]>,
          });
        }
      },
      close: async () => {
        handle.closed = true;
        for (const subscriber of this.subscribers) this.subscribers.delete(subscriber);
      },
    };
  }

  /** The server refuses the bearer its open sessions hold, as when it reconnects them. */
  rejectSessions() {
    for (const session of this.sessions) session.rejected = true;
  }

  emitTo(projectId: string) {
    for (const subscriber of this.subscribers) {
      if (subscriber.projectId === projectId) {
        subscriber.listener({ type: "snapshot", threads: this.summaries(projectId) });
      }
    }
  }
}

/** The watch loop's timer, run by hand: `beat` runs one tick and returns once the loop waits again. */
function manualClock() {
  const waiters: Array<() => void> = [];
  const parkers: Array<() => void> = [];
  const intervals: Array<number> = [];
  const nextPark = () => new Promise<void>((resolve) => parkers.push(resolve));
  return {
    intervals,
    nextPark,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        intervals.push(ms);
        waiters.push(resolve);
        for (const park of parkers.splice(0)) park();
      }),
    beat: async () => {
      if (waiters.length === 0) await nextPark();
      const parked = nextPark();
      for (const resolve of waiters.splice(0)) resolve();
      await parked;
    },
  };
}

function memoryCredentials(): CredentialStore & { readonly all: Map<string, StoredCredential> } {
  const all = new Map<string, StoredCredential>();
  return {
    all,
    get: async (environmentId) => all.get(environmentId) ?? null,
    set: async (environmentId, credential) => {
      all.set(environmentId, credential);
    },
    delete: async (environmentId) => {
      all.delete(environmentId);
    },
  };
}

const USER_TOKEN = "user-bearer";

/** A sidecar, a user server that can come and go, and the pairing endpoint between them. */
function world() {
  const sidecar = new FakeServer("env-sidecar", "http://127.0.0.1:41001");
  const userServer = new FakeServer("env-user", "http://127.0.0.1:3773");
  const state = {
    userRunning: false,
    sidecarRunning: false,
    sidecarStarts: 0,
    sidecarStops: 0,
    sidecarStateOnDisk: false,
    pairingRequests: 0,
    poll: { state: "pairing-requested" } as PairingPoll,
    ledger: { version: 1, workspaces: {}, pendingCopy: false } as AttachLedger,
    now: T0,
  };
  const credentials = memoryCredentials();
  const clock = manualClock();
  const grant = () => {
    state.poll = {
      state: "granted",
      credential: {
        token: USER_TOKEN,
        expiresAt: new Date(T0 + 30 * 86_400_000).toISOString(),
        environmentId: "env-user",
      },
    } as PairingPoll;
  };
  const deps: ConnectDeps = {
    discover: async () =>
      state.userRunning
        ? { origin: userServer.origin, environmentId: userServer.environmentId }
        : null,
    openSidecar: async () => {
      state.sidecarStarts += 1;
      state.sidecarRunning = true;
      state.sidecarStateOnDisk = true;
      return {
        session: sidecar.open(),
        stop: async () => {
          state.sidecarStops += 1;
          state.sidecarRunning = false;
        },
      };
    },
    hasSidecarState: async () => state.sidecarStateOnDisk,
    knownSidecarEnvironmentId: async () => (state.sidecarStateOnDisk ? "env-sidecar" : null),
    openUserServer: async (_server, token) => {
      if (!state.userRunning) throw new Error("connection refused");
      if (token !== USER_TOKEN) throw new CredentialRejectedError("revoked");
      return userServer.open();
    },
    createPairingRequest: async () => {
      state.pairingRequests += 1;
      return {
        requestId: `request-${state.pairingRequests}`,
        pollSecret: "poll-secret",
        expiresAt: new Date(T0 + 600_000).toISOString(),
      } as never;
    },
    pollPairingRequest: async () => {
      const answer = state.poll;
      // The credential comes once.
      if (answer.state === "granted") state.poll = { state: "granted" } as PairingPoll;
      return answer;
    },
    credentials,
    readLedger: async () => state.ledger,
    writeLedger: async (next) => {
      state.ledger = next;
    },
    wait: clock.wait,
    now: () => state.now,
  };
  return { sidecar, userServer, state, credentials, clock, deps, grant };
}

const connections: Array<LecturnConnection> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

async function open(w: ReturnType<typeof world>) {
  const connection = await createConnection(w.deps);
  connections.push(connection);
  const events: Array<ConnectionEvent> = [];
  connection.status.subscribe((event) => events.push(event));
  const modes = () => events.filter((event): event is ConnectionModeEvent => event.type === "mode");
  return { connection, events, modes };
}

const LIVE = { url: "http://127.0.0.1:45000/mcp", bearer: "live-bearer" };

describe("connect", () => {
  it("watches for a user server that starts later, at 5 s or less, and asks it to pair", async () => {
    const w = world();
    const { connection, events } = await open(w);
    expect(connection.mode).toBe("sidecar");
    expect(connection.status.current.pairing).toBe("none");

    await w.clock.beat();
    expect(w.state.pairingRequests).toBe(0);

    w.state.userRunning = true;
    await w.clock.beat();
    expect(w.state.pairingRequests).toBe(1);
    expect(connection.status.current).toEqual({
      type: "status",
      mode: "sidecar",
      pairing: "pending",
      app: null,
    });
    expect(events.at(-1)).toEqual(connection.status.current);
    expect(USER_SERVER_WATCH_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(w.clock.intervals.every((ms) => ms <= 5_000)).toBe(true);
  });

  it("switches live on grant: maps, leases, subscriptions, and the sidecar drains its running turn", async () => {
    const w = world();
    w.state.userRunning = true;
    const { connection, modes } = await open(w);
    expect(connection.mode).toBe("sidecar");
    expect(connection.status.current.pairing).toBe("pending");
    expect(connection.environmentId).toBe("env-sidecar");

    const { projectId: sidecarProject } = await connection.ensureWorkspace("/ws/a", "Workspace A");
    w.sidecar.addThread("/ws/a", "s-idle", { historyRevision: 3 });
    w.sidecar.addThread("/ws/a", "s-running", { historyRevision: 5, state: "running" });
    await connection.setLiveTools(LIVE);
    const rail: Array<ConnectedAppThreadsStreamEvent> = [];
    connection.subscribeThreads(sidecarProject, (event) => rail.push(event));

    w.grant();
    await w.clock.beat();

    expect(connection.mode).toBe("user-server");
    expect(connection.environmentId).toBe("env-user");
    expect(w.credentials.all.get("env-user")?.token).toBe(USER_TOKEN);
    const userProject = w.userServer.projectId("/ws/a")!;
    expect(modes()).toEqual([
      {
        type: "mode",
        mode: "user-server",
        environmentId: "env-user",
        projectIdsByWorkspaceRoot: { "/ws/a": userProject },
        threadIdMap: {
          "s-idle": "copy:env-sidecar:s-idle",
          "s-running": "copy:env-sidecar:s-running",
        },
      },
    ]);
    expect(connection.status.current.pairing).toBe("none");
    expect(connection.workspaceRootOf(sidecarProject)).toBe("/ws/a");
    expect(connection.workspaceRootOf(userProject)).toBe("/ws/a");
    // Both sidecar threads record where they continue, which makes them read-only there.
    expect(w.sidecar.thread("s-idle").continuedIn).toMatchObject({
      environmentId: "env-user",
      threadId: "copy:env-sidecar:s-idle",
    });
    // The lease is on the user server, and the sidecar keeps its own while its turn runs.
    expect(w.userServer.lease).toEqual(LIVE);
    expect(w.sidecar.lease).toEqual(LIVE);
    // The rail's subscription moved to the user server, in its ids.
    const last = rail.at(-1);
    expect(last?.type === "snapshot" && last.threads.map((thread) => thread.threadId)).toEqual([
      "copy:env-sidecar:s-idle",
      "copy:env-sidecar:s-running",
    ]);
    // An embed token for the old project still comes from the server that owns it.
    expect((await connection.embedTarget(sidecarProject)).url).toContain("/embed/env-sidecar/");
    expect((await connection.embedTarget(userProject)).url).toContain("/embed/env-user/");

    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(0);
    expect(w.sidecar.lease).toEqual(LIVE);

    // The turn in flight at copy time ends on the sidecar.
    w.sidecar.touch("s-running", { state: "idle", historyRevision: 7 });
    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(1);
    expect(w.sidecar.lease).toBeNull();
    expect(w.userServer.lease).toEqual(LIVE);
    // History newer than its copy is left for the next attach.
    expect(w.state.ledger.pendingCopy).toBe(true);
  });

  it("does not stop the sidecar while a turn there waits on an approval", async () => {
    const w = world();
    w.state.userRunning = true;
    const { connection } = await open(w);
    await connection.ensureWorkspace("/ws/a", "A");
    w.sidecar.addThread("/ws/a", "s-1", { state: "awaiting-approval" });
    w.grant();
    await w.clock.beat();
    await w.clock.beat();
    await w.clock.beat();
    expect(connection.mode).toBe("user-server");
    expect(w.state.sidecarStops).toBe(0);
    w.sidecar.touch("s-1", { state: "idle" });
    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(1);
    expect(w.state.ledger.pendingCopy).toBe(false);
  });

  it("re-copies a thread whose turn ended after the copy exactly once; the attach after copies nothing", async () => {
    const w = world();
    w.state.userRunning = true;
    const first = await open(w);
    await first.connection.ensureWorkspace("/ws/a", "A");
    w.sidecar.addThread("/ws/a", "s-1", { historyRevision: 5, state: "running" });
    w.grant();
    await w.clock.beat();
    w.sidecar.touch("s-1", { state: "idle", historyRevision: 9 });
    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(1);
    expect(w.userServer.imported).toEqual(["s-1"]);
    await first.connection.close();

    // The next run starts the sidecar only because it holds history the user server lacks.
    const second = await open(w);
    expect(second.connection.mode).toBe("user-server");
    expect(w.state.sidecarStarts).toBe(2);
    expect(w.userServer.imported).toEqual(["s-1", "s-1"]);
    expect(w.userServer.copiesOf("s-1")).toHaveLength(1);
    expect(w.userServer.thread("copy:env-sidecar:s-1").copiedFrom?.sourceHistoryRevision).toBe(9);
    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(2);
    expect(w.state.ledger.pendingCopy).toBe(false);
    await second.connection.close();

    const exports = w.sidecar.exports;
    const third = await open(w);
    expect(third.connection.mode).toBe("user-server");
    expect(w.state.sidecarStarts).toBe(2);
    expect(w.sidecar.exports).toBe(exports);
    expect(w.userServer.imported).toEqual(["s-1", "s-1"]);
  });

  it("falls back to the sidecar when the user server goes away, and back again without a re-copy", async () => {
    const w = world();
    w.state.userRunning = true;
    const { connection, modes } = await open(w);
    const { projectId: sidecarProject } = await connection.ensureWorkspace("/ws/a", "A");
    w.sidecar.addThread("/ws/a", "s-1", { historyRevision: 4 });
    await connection.setLiveTools(LIVE);
    w.grant();
    await w.clock.beat();
    await w.clock.beat();
    expect(w.state.sidecarStops).toBe(1);
    expect(w.state.ledger.pendingCopy).toBe(false);
    const exports = w.sidecar.exports;

    w.state.userRunning = false;
    await w.clock.beat();
    // One missed probe is not enough.
    expect(connection.mode).toBe("user-server");
    await w.clock.beat();
    expect(connection.mode).toBe("sidecar");
    expect(w.state.sidecarStarts).toBe(2);
    expect(modes().at(-1)).toEqual({
      type: "mode",
      mode: "sidecar",
      environmentId: "env-sidecar",
      projectIdsByWorkspaceRoot: { "/ws/a": sidecarProject },
      threadIdMap: { "copy:env-sidecar:s-1": "s-1" },
    });
    expect(w.sidecar.lease).toEqual(LIVE);
    // The copied thread is the one the embed shows read-only here.
    expect(w.sidecar.thread("s-1").continuedIn?.threadId).toBe("copy:env-sidecar:s-1");
    expect(w.state.ledger.pendingCopy).toBe(true);

    // Subtitle and continuedIn writes move updatedAt only.
    await connection.setThreadAppData("s-1", '{"doc":1}', "Fins");
    expect(w.sidecar.thread("s-1").updatedAt).not.toBe(w.sidecar.thread("s-1").createdAt);

    w.state.userRunning = true;
    await w.clock.beat();
    expect(connection.mode).toBe("user-server");
    expect(w.sidecar.exports).toBe(exports);
    expect(w.userServer.imported).toEqual(["s-1"]);
    expect(modes().at(-1)?.threadIdMap).toEqual({ "s-1": "copy:env-sidecar:s-1" });
    expect(w.userServer.lease).toEqual(LIVE);
  });

  it("carries host context to the new server on a switch, before the mode event, and back on fallback", async () => {
    const w = world();
    w.state.userRunning = true;
    const { connection, events } = await open(w);
    const { projectId: sidecarProject } = await connection.ensureWorkspace("/ws/a", "A");
    w.sidecar.addThread("/ws/a", "s-1", { historyRevision: 2 });
    await connection.updateHostContext({ projectId: sidecarProject }, "page: assembly");
    await connection.updateHostContext({ threadId: "s-1" }, "selected: fin-1");
    const { projectId: sidecarB } = await connection.ensureWorkspace("/ws/b", "B");
    await connection.updateHostContext({ projectId: sidecarB }, "page: sim");
    await expect(
      connection.updateHostContext({ projectId: sidecarB }, "x".repeat(4 * 1024 + 1)),
    ).rejects.toThrow(/4096 UTF-8 bytes/);
    // Empty text is the way back out; a cleared entry is not carried.
    await connection.updateHostContext({ projectId: sidecarB }, "");
    expect(Object.fromEntries(w.sidecar.hostContext)).toEqual({
      [`project:${sidecarProject}`]: "page: assembly",
      "thread:s-1": "selected: fin-1",
    });

    let atModeEvent: Record<string, string> | undefined;
    connection.status.subscribe((event) => {
      if (event.type === "mode") atModeEvent = Object.fromEntries(w.userServer.hostContext);
    });
    w.grant();
    await w.clock.beat();
    expect(connection.mode).toBe("user-server");
    const userProject = w.userServer.projectId("/ws/a")!;
    const carried = {
      [`project:${userProject}`]: "page: assembly",
      "thread:copy:env-sidecar:s-1": "selected: fin-1",
    };
    expect(Object.fromEntries(w.userServer.hostContext)).toEqual(carried);
    expect(atModeEvent).toEqual(carried);
    expect(events.some((event) => event.type === "mode")).toBe(true);

    // A host still holding the sidecar's project id reaches the server new turns start on.
    await connection.updateHostContext({ projectId: sidecarProject }, "page: fins");
    expect(w.userServer.hostContext.get(`project:${userProject}`)).toBe("page: fins");
    // A thread made on the user server has no sidecar counterpart to carry to.
    w.userServer.addThread("/ws/a", "u-1");
    await connection.updateHostContext({ threadId: "u-1" }, "selected: nose");

    await w.clock.beat();
    w.state.userRunning = false;
    w.sidecar.hostContext.clear();
    await w.clock.beat();
    await w.clock.beat();
    expect(connection.mode).toBe("sidecar");
    expect(Object.fromEntries(w.sidecar.hostContext)).toEqual({
      [`project:${sidecarProject}`]: "page: fins",
      "thread:s-1": "selected: fin-1",
    });
  });

  it("stays on the sidecar after a deny until the app asks again", async () => {
    const w = world();
    w.state.userRunning = true;
    const { connection } = await open(w);
    expect(w.state.pairingRequests).toBe(1);

    w.state.poll = { state: "denied" } as PairingPoll;
    await w.clock.beat();
    expect(connection.status.current.pairing).toBe("denied");
    await w.clock.beat();
    await w.clock.beat();
    expect(w.state.pairingRequests).toBe(1);
    expect(connection.mode).toBe("sidecar");

    w.state.poll = { state: "pairing-requested" } as PairingPoll;
    const parked = w.clock.nextPark();
    await connection.requestPairingAgain();
    await parked;
    expect(w.state.pairingRequests).toBe(2);
    expect(connection.status.current.pairing).toBe("pending");
  });

  it("attaches straight to a granted user server without starting a sidecar it does not need", async () => {
    const w = world();
    w.state.userRunning = true;
    await w.credentials.set("env-user", {
      token: USER_TOKEN,
      expiresAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const { connection } = await open(w);
    expect(connection.mode).toBe("user-server");
    expect(w.state.sidecarStarts).toBe(0);
    expect(w.state.pairingRequests).toBe(0);
    const { projectId } = await connection.ensureWorkspace("/ws/a", "A");
    expect(projectId).toBe(w.userServer.projectId("/ws/a"));
  });

  it("falls back when the user revokes the connected app, and asks again only when the app does", async () => {
    const w = world();
    w.state.userRunning = true;
    await w.credentials.set("env-user", {
      token: USER_TOKEN,
      expiresAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const { connection, events, modes } = await open(w);
    expect(connection.mode).toBe("user-server");

    w.userServer.rejectSessions();
    await w.clock.beat();
    expect(connection.mode).toBe("sidecar");
    expect(modes().at(-1)?.environmentId).toBe("env-sidecar");
    expect(events.at(-1)).toEqual({
      type: "status",
      mode: "sidecar",
      pairing: "denied",
      app: null,
    });
    expect(w.credentials.all.has("env-user")).toBe(false);
    expect(w.userServer.sessions.every((session) => session.closed)).toBe(true);
    await w.clock.beat();
    expect(w.state.pairingRequests).toBe(0);

    const parked = w.clock.nextPark();
    await connection.requestPairingAgain();
    await parked;
    expect(w.state.pairingRequests).toBe(1);
    expect(connection.status.current.pairing).toBe("pending");
  });

  it("asks to pair again when the connected app's credential expires", async () => {
    const w = world();
    w.state.userRunning = true;
    await w.credentials.set("env-user", {
      token: USER_TOKEN,
      expiresAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const { connection } = await open(w);
    expect(connection.mode).toBe("user-server");

    w.state.now = T0 + 86_400_000;
    w.userServer.rejectSessions();
    await w.clock.beat();
    expect(connection.mode).toBe("sidecar");
    expect(w.credentials.all.has("env-user")).toBe(false);
    await w.clock.beat();
    expect(w.state.pairingRequests).toBe(1);
    expect(connection.status.current.pairing).toBe("pending");
  });

  it("drops a credential the user server refuses and asks to pair again", async () => {
    const w = world();
    w.state.userRunning = true;
    await w.credentials.set("env-user", {
      token: "revoked-bearer",
      expiresAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const { connection } = await open(w);
    expect(connection.mode).toBe("sidecar");
    expect(w.credentials.all.has("env-user")).toBe(false);
    expect(w.state.pairingRequests).toBe(1);
    expect(connection.status.current.pairing).toBe("pending");
  });
});

const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** A sidecar start that never gets ready; an abort ends it as a killed process would, a moment later. */
function neverReadySidecar() {
  const start = { calls: 0, exited: false };
  const openSidecar: ConnectDeps["openSidecar"] = (signal) => {
    start.calls += 1;
    return new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          setTimeout(() => {
            start.exited = true;
            reject(signal.reason);
          }, 10),
        { once: true },
      );
    });
  };
  return { start, openSidecar };
}

// Reads the envelope like the server, records its pid, and never gets ready.
const STARTING_SERVER = String.raw`
import * as fs from "node:fs";
fs.createReadStream(null, { fd: 3 }).on("data", () => {}).on("end", () => {
  fs.writeFileSync("sidecar.pid", String(process.pid));
});
setInterval(() => {}, 1_000);
`;

describe("connect lifetime", () => {
  it("rejects an aborted connect only after the sidecar it was starting has exited", async () => {
    const w = world();
    const { start, openSidecar } = neverReadySidecar();
    const controller = new AbortController();
    const connecting = createConnection({ ...w.deps, openSidecar }, { signal: controller.signal });
    await until(() => start.calls === 1);

    const reason = new Error("host quit");
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(start.exited).toBe(true);
  });

  it("closes a ready connection when the host's signal aborts", async () => {
    const w = world();
    const controller = new AbortController();
    const connection = await createConnection(w.deps, { signal: controller.signal });
    expect(connection.mode).toBe("sidecar");

    controller.abort();

    await until(() => w.state.sidecarStops === 1);
    expect(w.state.sidecarRunning).toBe(false);
  });

  it("stops a fallback sidecar that is still starting at close, and waits for it", async () => {
    const w = world();
    w.state.userRunning = true;
    await w.credentials.set("env-user", {
      token: USER_TOKEN,
      expiresAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const { start, openSidecar } = neverReadySidecar();
    const connection = await createConnection({ ...w.deps, openSidecar });
    expect(connection.mode).toBe("user-server");

    w.state.userRunning = false;
    await w.clock.beat();
    // The second miss starts the sidecar, which never parks the loop again.
    void w.clock.beat();
    await until(() => start.calls === 1);

    await connection.close();
    expect(start.exited).toBe(true);
  });

  it("close() before ready stops the real sidecar process it was starting", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-embed-connect-"));
    try {
      const serverEntry = NodePath.join(root, "starting-server.mjs");
      await NodeFSP.writeFile(serverEntry, STARTING_SERVER);
      const baseDir = NodePath.join(root, "sidecar-home");
      const pidPath = NodePath.join(baseDir, "sidecar.pid");

      const pending = connect({
        registration: {
          appId: "dev.example.app",
          name: "Example",
          iconDataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          toolPrefix: "ex",
          refPrefixes: ["ex:"],
          liveTools: false,
          gatedTools: [],
        },
        lecturnHome: NodePath.join(root, "lecturn-home"),
        sidecar: { serverEntry, baseDir, nodePath: process.execPath },
        readyTimeoutMs: 20_000,
      });
      await until(() => NodeFS.existsSync(pidPath));
      const pid = Number(await NodeFSP.readFile(pidPath, "utf8"));
      expect(isProcessAlive(pid)).toBe(true);

      await pending.close();

      expect(isProcessAlive(pid)).toBe(false);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe("credential store", () => {
  const dirs: Array<string> = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true })));
  });
  const tempDir = async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-embed-cred-"));
    dirs.push(dir);
    return dir;
  };
  const credential = { token: "bearer", expiresAt: "2026-11-24T00:00:00.000Z" };

  it("without a keyring, keeps credentials per environment in a 0600 file in baseDir", async () => {
    const baseDir = await tempDir();
    const store = makeCredentialStore({ appId: "dev.example.app", baseDir, keyring: null });
    await store.set("env-a", credential);
    await store.set("env-b", { ...credential, token: "other" });
    expect(await store.get("env-a")).toEqual(credential);
    expect((await store.get("env-b"))?.token).toBe("other");
    const stat = await NodeFSP.stat(credentialFilePath(baseDir));
    expect(stat.mode & 0o777).toBe(0o600);
    await store.delete("env-a");
    expect(await store.get("env-a")).toBeNull();
    expect((await store.get("env-b"))?.token).toBe("other");
  });

  it("uses the keyring when it is present, and the file when it fails", async () => {
    const baseDir = await tempDir();
    const secrets = new Map<string, string>();
    let failing = false;
    const keyring = (service: string, account: string): KeyringEntry => ({
      getPassword: async () => {
        if (failing) throw new Error("no secret service");
        return secrets.get(`${service}/${account}`);
      },
      setPassword: async (password) => {
        if (failing) throw new Error("no secret service");
        secrets.set(`${service}/${account}`, password);
      },
      deleteCredential: async () => secrets.delete(`${service}/${account}`),
    });
    const store = makeCredentialStore({ appId: "dev.example.app", baseDir, keyring });
    await store.set("env-a", credential);
    expect([...secrets.keys()]).toEqual(["lecturn-embed:dev.example.app/env-a"]);
    await expect(NodeFSP.stat(credentialFilePath(baseDir))).rejects.toThrow();
    expect(await store.get("env-a")).toEqual(credential);

    failing = true;
    await store.set("env-b", credential);
    expect(await store.get("env-b")).toEqual(credential);
    expect((await NodeFSP.stat(credentialFilePath(baseDir))).mode & 0o777).toBe(0o600);
  });
});
