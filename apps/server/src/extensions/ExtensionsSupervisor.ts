// @effect-diagnostics nodeBuiltinImport:off -- bounded native NDJSON subprocess boundary; owned by an Effect scope.
// @effect-diagnostics globalDate:off -- protocol wall-clock deadlines cross the native process boundary.
// @effect-diagnostics globalTimers:off -- callback transport deadlines are canceled with each pending request.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  EXTENSIONS_HELPER_MAX_LINE_BYTES,
  ExtensionsHelperRequest,
  ExtensionsHelperResponse,
  type ExtensionsHelperSuccess,
  type ExtensionsHelperDescribeResult,
} from "@lecturn/contracts";
import { Schema } from "effect";
import { compareSemverVersions, parseSemver } from "@lecturn/shared/semver";
import packageJson from "../../package.json" with { type: "json" };
import { resolveExtensionsBinary, type ExtensionsBinaryOptions } from "./ExtensionsBinary.ts";

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ExtensionsHelperResponse), {
  onExcessProperty: "error",
});
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ExtensionsHelperRequest));
type Operation = ExtensionsHelperRequest["operation"];
type RequestOf<O extends Operation> = Extract<ExtensionsHelperRequest, { operation: O }>;
export type ExtensionsPayloads = {
  [O in Operation]: Extract<ExtensionsHelperRequest, { operation: O }>["payload"];
};
export type ExtensionsResults = {
  [O in Operation]: Extract<ExtensionsHelperSuccess, { operation: O }>["result"];
};
type Pending = {
  operation: Operation;
  resolve: (value: ExtensionsHelperSuccess["result"]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

export interface ExtensionsSupervisorOptions extends ExtensionsBinaryOptions {
  readonly homeDir: string;
  readonly exportsDir: string;
  readonly environmentId: string;
  readonly hostName: string;
  readonly fixtureRoot?: string;
}

/** One instance belongs to one host service layer. Never retries a failed mutation. */
export class ExtensionsSupervisor {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ExtensionsHelperDescribeResult | null> | null = null;
  private described: ExtensionsHelperDescribeResult | null = null;
  private pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failures = 0;
  private nextStartAt = 0;
  private readonly options: ExtensionsSupervisorOptions;
  constructor(options: ExtensionsSupervisorOptions) {
    this.options = options;
  }

  async start(): Promise<ExtensionsHelperDescribeResult | null> {
    if (this.closed) throw new Error("Extensions helper is closed.");
    if (this.described && this.child) return this.described;
    if (this.starting) return this.starting;
    if (Date.now() < this.nextStartAt)
      throw new Error("Extensions helper is recovering. Try again shortly.");
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async launch(): Promise<ExtensionsHelperDescribeResult | null> {
    const binary = await resolveExtensionsBinary(this.options);
    if (this.closed) throw new Error("Extensions helper is closed.");
    if (!binary) return null;
    for (const directory of [this.options.homeDir, this.options.exportsDir]) {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await NodeFSP.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error("Extensions storage must be private to this host account.");
    }
    const args = [
      "--home-dir",
      this.options.homeDir,
      "--exports-dir",
      this.options.exportsDir,
      "--environment-id",
      this.options.environmentId,
      "--host-name",
      this.options.hostName,
    ];
    if (this.options.fixtureRoot) {
      if (binary.source !== "review")
        throw new Error("Synthetic source roots require a review bootstrap.");
      args.push("--fixture-root", this.options.fixtureRoot);
    }
    // Credentials and provider configuration never cross into the archive process.
    if (this.closed) throw new Error("Extensions helper is closed.");
    const child = NodeChildProcess.spawn(binary.path, args, {
      stdio: "pipe",
      env: {
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
      },
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.receive(chunk);
    });
    // Drain without persisting potentially sensitive diagnostics. Capability/status carries safe errors.
    child.stderr.on("data", () => {});
    child.on("error", () => this.failed(child));
    child.on("exit", () => this.failed(child));
    try {
      const described = await this.send("extensions.describe", {}, 10000);
      if (
        !parseSemver(described.minimumHostVersion) ||
        compareSemverVersions(packageJson.version, described.minimumHostVersion) < 0
      )
        throw new Error("Extensions helper requires a newer Lecturn host.");
      if (
        !described.platforms.includes(
          `${this.options.platform}-${this.options.architecture}` as (typeof described.platforms)[number],
        )
      )
        throw new Error("Extensions helper does not support this host.");
      this.described = described;
      return described;
    } catch (error) {
      child.kill("SIGTERM");
      this.failed(child);
      throw error;
    }
  }

  private failed(child: NodeChildProcess.ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    this.described = null;
    this.failures = Math.min(this.failures + 1, 8);
    this.nextStartAt = Date.now() + Math.min(30000, 250 * 2 ** this.failures);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.abort?.();
      entry.reject(new Error("Extensions helper stopped; the operation was not retried."));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }

  private invalid(): void {
    const child = this.child;
    if (child) {
      child.kill("SIGTERM");
      this.failed(child);
    }
  }

  private receive(chunk: Buffer): void {
    // Process each bounded line, including chunks containing several valid responses.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - offset > EXTENSIONS_HELPER_MAX_LINE_BYTES)
        return this.invalid();
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      try {
        const response = decodeResponse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        const entry = this.pending.get(response.id);
        if (!entry) continue; // A canceled request may still finish in the helper.
        if (entry.operation !== response.operation) return this.invalid();
        if (response.status === "progress") continue;
        this.pending.delete(response.id);
        clearTimeout(entry.timer);
        entry.abort?.();
        if (response.status === "error")
          entry.reject(new Error(`Extensions operation failed (${response.error.code}).`));
        else {
          this.failures = 0;
          entry.resolve(response.result);
        }
      } catch {
        return this.invalid();
      }
    }
  }

  private send<O extends Operation>(
    operation: O,
    payload: ExtensionsPayloads[O],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExtensionsResults[O]> {
    if (!this.child || this.closed)
      return Promise.reject(new Error("Extensions helper unavailable."));
    if (this.pending.size >= (this.described?.limits.maxConcurrentOperations ?? 1))
      return Promise.reject(new Error("Extensions helper is busy."));
    if (signal?.aborted) return Promise.reject(new Error("Extensions operation canceled."));
    const id = NodeCrypto.randomUUID();
    const request = {
      protocolVersion: 1,
      id,
      operation,
      payload,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    } as RequestOf<O>;
    const line = encodeRequest(request) + "\n";
    if (Buffer.byteLength(line) - 1 > EXTENSIONS_HELPER_MAX_LINE_BYTES)
      return Promise.reject(new Error("Extensions request is too large."));
    return new Promise<ExtensionsHelperSuccess["result"]>((resolve, reject) => {
      const cancel = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.abort?.();
        reject(new Error("Extensions operation canceled or timed out."));
        if (operation !== "operation.cancel" && this.child)
          void this.send("operation.cancel", { requestId: id, jobId: null }, 1000).catch(() => {});
      };
      const timer = setTimeout(cancel, timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        operation,
        resolve,
        reject,
        timer,
        abort: () => signal?.removeEventListener("abort", cancel),
      });
      this.child!.stdin.write(line, (error) => {
        if (error) this.invalid();
      });
    }) as Promise<ExtensionsResults[O]>;
  }

  async request<O extends Operation>(
    operation: O,
    payload: ExtensionsPayloads[O],
    signal?: AbortSignal,
  ): Promise<ExtensionsResults[O]> {
    if (!(await this.start()))
      throw new Error(
        "Slack collection requires the Contextual helper. Saved Decisions remain available.",
      );
    return this.send(operation, payload, 30000, signal);
  }

  async readExport(artifactId: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9_-]{1,240}(?:\.jsonl)?$/.test(artifactId))
      throw new Error("Invalid export artifact.");
    // A successful status reconciles files against durable purge receipts,
    // including a previous helper exit between the archive commit and unlink.
    const before = await this.request("contextual.capture.status", {});
    const path = NodePath.join(this.options.exportsDir, artifactId);
    const stat = await NodeFSP.lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 256 * 1024 * 1024 ||
      NodePath.dirname(await NodeFSP.realpath(path)) !==
        (await NodeFSP.realpath(this.options.exportsDir))
    )
      throw new Error("Export artifact unavailable.");
    const file = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size !== stat.size
      )
        throw new Error("Export artifact changed during access.");
      const body = await file.readFile();
      const after = await this.request("contextual.capture.status", {});
      const linked = await NodeFSP.lstat(path);
      if (
        after.purgeGeneration !== before.purgeGeneration ||
        !linked.isFile() ||
        linked.isSymbolicLink() ||
        linked.ino !== opened.ino ||
        linked.dev !== opened.dev ||
        linked.size !== opened.size
      )
        throw new Error("Export artifact changed during access.");
      return body;
    } finally {
      await file.close();
    }
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
      this.failed(child);
    }
  }
}
