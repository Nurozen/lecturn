// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * Embed cookie isolation (A17a, decision 19). The guest's session first gets
 * a real Lecturn session cookie for the sidecar origin through a normal
 * pairing in a second window of the same partition; then the embed loads.
 * The guest's CDP network events give each request's kind and the Cookie
 * header the browser actually sent; the sidecar's auth spans give the
 * subject each request authenticated as. Asserted:
 * - every protected fetch/XHR carries no Cookie and is the embed subject;
 * - every WebSocket upgrade authenticates by ticket as the embed subject;
 * - a probe fetch with the embed bearer and `credentials: "include"` (so the
 *   cookie is sent) still authenticates as the embed subject (D14).
 * The public document and static assets are logged but not asserted.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { embedHostDir } from "../scripts/electronLauncher.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { type HostGlobals, launchEmbedHost, removeDirs } from "./harness.ts";
import type { E2eContext } from "./run.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(NodePath.join(embedHostDir, "package.json"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ObservedRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly type: string;
  readonly at: number;
  cookie?: string | null;
  authorization?: boolean;
}

interface TraceSpan {
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly attributes: Record<string, unknown>;
  readonly exit: { readonly _tag: string };
}

const kindOf = (request: ObservedRequest) => {
  if (request.type === "WebSocket") return "websocket-upgrade";
  if (request.type === "Document") return "document";
  if (request.type === "Fetch" || request.type === "XHR") return "fetch/xhr";
  return "static";
};

export default async function embedCookies({ log, artifactsDir, keep }: E2eContext): Promise<void> {
  const run = await launchEmbedHost();
  const lines: Array<string> = [];
  const record = (line: string) => {
    lines.push(line);
    log(line);
  };
  try {
    const { host, dirs } = run;
    const embedSubject = `embed:dev.example.embedhost:${host.projectId}`;
    record(`sidecar ${host.origin}; expected embed subject ${embedSubject}`);

    // A normal one-time pairing link for the sidecar, as `lecturn pair` mints it.
    const { stdout } = await execFile(
      process.execPath,
      [require.resolve("lecturn/dist/bin.mjs"), "pair", "--base-dir", dirs.sidecarDir],
      { env: { ...process.env, LECTURN_HOME: dirs.lecturnHome }, timeout: 60_000 },
    );
    const pairingUrl = /Pairing URL:\s*(\S+)/u.exec(stdout)?.[1];
    NodeAssert.ok(pairingUrl, `pair printed no URL:\n${stdout}`);

    // Pair in a second window of the guest's own session, so the cookie lands
    // in the jar the embed's requests use.
    const cookies = await run.app.evaluate(async (electron, url) => {
      const embed = (
        globalThis as unknown as { embedHost: { embed: { webContents: Electron.WebContents } } }
      ).embedHost.embed;
      const session = embed.webContents.session;
      const pairWindow = new electron.BrowserWindow({ show: false, webPreferences: { session } });
      await pairWindow.loadURL(url);
      const origin = new URL(url).origin;
      const deadline = Date.now() + 30_000;
      let jar = await session.cookies.get({ url: origin });
      while (jar.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        jar = await session.cookies.get({ url: origin });
      }
      pairWindow.destroy();
      return jar.map((cookie) => ({ name: cookie.name, httpOnly: cookie.httpOnly }));
    }, pairingUrl);
    record(`guest session cookies after pairing: ${JSON.stringify(cookies)}`);
    NodeAssert.ok(cookies.length > 0, "pairing set a Lecturn session cookie in the guest session");

    const target = await run.app.evaluate(() =>
      (globalThis as HostGlobals).embedHost!.embedTarget(),
    );
    const threadId = await createEmbedThread({
      origin: host.origin,
      embedToken: target.token,
      projectId: host.projectId,
      title: "Cookies",
    });

    const guest = await run.guestPage(`/embed/`);
    const cdp = await run.app.context().newCDPSession(guest);
    const requests = new Map<string, ObservedRequest>();
    cdp.on("Network.requestWillBeSent", (event) => {
      if (requests.has(event.requestId)) return;
      requests.set(event.requestId, {
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        type: event.type ?? "Other",
        at: Date.now(),
      });
    });
    cdp.on("Network.webSocketCreated", (event) => {
      requests.set(event.requestId, {
        requestId: event.requestId,
        url: event.url,
        method: "GET",
        type: "WebSocket",
        at: Date.now(),
      });
    });
    const extraInfo = new Map<string, Record<string, string>>();
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
      extraInfo.set(event.requestId, event.headers as Record<string, string>);
    });
    const handshakes = new Map<string, Record<string, string>>();
    cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
      handshakes.set(event.requestId, event.request.headers as Record<string, string>);
    });
    await cdp.send("Network.enable", {});

    // The pairing window's own requests (as the user, with the cookie) may still be landing;
    // everything after this mark is the embed's.
    await sleep(2_000);
    const loadStartedAt = Date.now();
    // A full reload of the guest, now with the cookie in its jar.
    await run.app.evaluate(
      (_electron, id) => (globalThis as HostGlobals).embedHost!.openThread(id),
      threadId,
    );
    await guest
      .locator('[data-testid="composer-editor"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    await sleep(3_000);

    const probe = await guest.evaluate(
      async ({ origin, token }) => {
        const response = await fetch(new URL("/api/auth/session", origin), {
          headers: { authorization: `Bearer ${token}` },
          credentials: "include",
        });
        return { status: response.status, body: await response.json() };
      },
      { origin: host.origin, token: target.token },
    );
    record(`probe /api/auth/session (bearer + credentials:'include'): ${JSON.stringify(probe)}`);
    await sleep(1_000);

    for (const request of requests.values()) {
      const headers = handshakes.get(request.requestId) ?? extraInfo.get(request.requestId) ?? {};
      const lower = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      request.cookie = lower["cookie"] ?? null;
      request.authorization = lower["authorization"] !== undefined;
    }
    await cdp.detach().catch(() => undefined);
    await run.close();

    // Spans are flushed by the time the sidecar stops.
    const trace = (
      await NodeFSP.readFile(
        NodePath.join(dirs.sidecarDir, "userdata", "logs", "server.trace.ndjson"),
        "utf8",
      )
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as TraceSpan)
      .filter(
        (span) =>
          (span.name === "EnvironmentAuth.authenticateHttpRequest" ||
            span.name === "EnvironmentAuth.authenticateWebSocketUpgrade" ||
            span.name === "EnvironmentAuth.getSessionState") &&
          Number(BigInt(span.startTimeUnixNano) / 1_000_000n) >= loadStartedAt,
      )
      .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1));

    record("--- client requests (guest CDP) ---");
    const failures: Array<string> = [];
    const ordered = [...requests.values()].sort((a, b) => a.at - b.at);
    const statics = ordered.filter((request) => kindOf(request) === "static");
    record(
      `static: ${statics.length} requests, ${statics.filter((request) => request.cookie !== null).length} with a Cookie (${statics
        .filter((request) => request.cookie !== null)
        .map((request) => new URL(request.url).pathname)
        .join(", ")}); public, excluded from the assertion`,
    );
    for (const request of ordered) {
      const url = new URL(request.url);
      const kind = kindOf(request);
      if (kind === "static") continue;
      record(
        `${kind.padEnd(17)} ${request.method.padEnd(5)} ${url.pathname} cookie=${request.cookie === null ? "none" : "PRESENT"} bearer=${request.authorization ? "yes" : "no"}${url.searchParams.has("wsTicket") ? " wsTicket=yes" : ""}`,
      );
      const isProbe = url.pathname === "/api/auth/session" && request.cookie !== null;
      if (
        kind === "fetch/xhr" &&
        url.origin === host.origin &&
        !isProbe &&
        request.cookie !== null
      ) {
        failures.push(`fetch ${url.pathname} carried a Cookie header`);
      }
      if (kind === "websocket-upgrade" && !url.searchParams.has("wsTicket")) {
        failures.push(`WebSocket ${url.pathname} had no ticket`);
      }
    }

    record("--- server auth spans (sidecar trace) ---");
    for (const span of trace) {
      const a = span.attributes;
      record(
        `${span.name.replace("EnvironmentAuth.", "").padEnd(28)} ${String(a["url.path"] ?? "?").padEnd(28)} ${span.exit._tag.padEnd(7)} subject=${String(a["auth.subject"] ?? "-")} cookie=${a["http.request.cookie_present"] === true ? "PRESENT" : "none"}${a["auth.websocket_ticket"] === true ? " via=ticket" : ""}`,
      );
      if (span.exit._tag !== "Success") {
        failures.push(`${span.name} ${String(a["url.path"])} failed`);
        continue;
      }
      if (a["auth.subject"] !== embedSubject) {
        failures.push(
          `${span.name} ${String(a["url.path"])} authenticated as ${String(a["auth.subject"])}`,
        );
      }
      if (
        span.name === "EnvironmentAuth.authenticateWebSocketUpgrade" &&
        a["auth.websocket_ticket"] !== true
      ) {
        failures.push(`WebSocket upgrade not authenticated by ticket`);
      }
      if (
        span.name === "EnvironmentAuth.authenticateHttpRequest" &&
        a["http.request.cookie_present"] === true
      ) {
        failures.push(
          `protected request ${String(a["url.path"])} reached the server with a cookie`,
        );
      }
    }
    const probeSpans = trace.filter(
      (span) =>
        span.name === "EnvironmentAuth.getSessionState" &&
        span.attributes["http.request.cookie_present"] === true,
    );
    record(
      `probe spans (session state with cookie): ${probeSpans.map((span) => String(span.attributes["auth.subject"])).join(", ") || "none"}`,
    );
    if (probeSpans.length === 0) failures.push("the probe reached the server without the cookie");
    for (const span of probeSpans) {
      if (span.attributes["auth.subject"] !== embedSubject)
        failures.push("the probe acted as the user");
    }
    const upgrades = trace.filter(
      (span) => span.name === "EnvironmentAuth.authenticateWebSocketUpgrade",
    );
    const protectedFetches = trace.filter(
      (span) => span.name !== "EnvironmentAuth.authenticateWebSocketUpgrade",
    );
    record(
      `summary: ${protectedFetches.length} authenticated fetch/XHR (probe included), ${upgrades.length} WS upgrades, ${probeSpans.length} probe`,
    );
    if (upgrades.length === 0) failures.push("no WebSocket upgrade was observed");
    if (protectedFetches.length === 0) failures.push("no protected fetch was observed");
    record(failures.length === 0 ? "ASSERTIONS PASS" : `ASSERTIONS FAIL: ${failures.join("; ")}`);
    NodeAssert.deepEqual(failures, []);
  } catch (error) {
    log(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    if (artifactsDir !== undefined) {
      await NodeFSP.writeFile(
        NodePath.join(artifactsDir, "embed-cookies.log"),
        `${lines.join("\n")}\n`,
      );
    }
    await run.close();
    if (keep) log(`kept ${run.dirs.root}`);
    else await removeDirs(run.dirs);
  }
}
