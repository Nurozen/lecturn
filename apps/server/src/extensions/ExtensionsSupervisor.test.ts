// @effect-diagnostics nodeBuiltinImport:off -- real synthetic executable boundary tests.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { ExtensionsSupervisor } from "./ExtensionsSupervisor.ts";
import { resolveExtensionsBinary } from "./ExtensionsBinary.ts";

const roots: string[] = [];
const supervisors: ExtensionsSupervisor[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.close();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function fixture(mode = "normal") {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-extension-test-"));
  roots.push(root);
  const path = NodePath.join(root, "helper");
  const content = `#!${process.execPath}
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let captures = 0;
let statuses = 0;
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.operation === 'extensions.describe') {
    process.stdout.write(JSON.stringify({ protocolVersion: 1, id: req.id, operation: req.operation, status: 'success', result: {
      protocolVersion: 1, buildVersion: 'test', minimumHostVersion: '0.0.0', features: ['contextual-slack'], platforms: ['darwin-arm64'], formats: [],
      limits: { maxLineBytes: 1048576, maxCandidates: 24, maxConcurrentOperations: 4, maxProgressNotificationsPerSecond: 2 }
    }})+'\\n'); return;
  }
  if ('${mode}' === 'crash') process.exit(2);
  if ('${mode}' === 'oversized') { process.stdout.write('x'.repeat(1048577)); return; }
  if ('${mode}' === 'invalid') { process.stdout.write('not json\\n'); return; }
  if ('${mode}' === 'hang' && req.operation !== 'operation.cancel') return;
  if (req.operation === 'operation.cancel') { process.stdout.write(JSON.stringify({ protocolVersion: 1, id: req.id, operation: req.operation, status: 'success', result: { ...req.payload, state: 'canceled' } })+'\\n'); return; }
  if (req.operation === 'contextual.capture.status') {
    statuses++;
    if ('${mode}' === 'stale-export' || ('${mode}' === 'unlink-during-read' && statuses === 2)) {
      require('node:fs').unlinkSync(require('node:path').join(process.argv[process.argv.indexOf('--exports-dir') + 1], 'opaque-id'));
    }
    process.stdout.write(JSON.stringify({ protocolVersion: 1, id: req.id, operation: req.operation, status: 'success', result: {
      state: 'paused', reason: 'requested', generation: 0, sourceGeneration: 1,
      purgeGeneration: '${mode}' === 'purge-during-read' && statuses === 2 ? 1 : 0,
      receiptId: 'synthetic-status', observedAt: '2026-01-01T00:00:00.000Z', capturedRecords: 1, coverage: 'partial'
    }})+'\\n'); return;
  }
  captures++;
  process.stdout.write(JSON.stringify({ protocolVersion: 1, id: req.id, operation: req.operation, status: 'success', result: {
    sources: [], nextCursor: null, sourceGeneration: captures,
    policy: { allowedSourceIds: [], allowDirectMessages: false, allowGroupDirectMessages: false, unknownConversationPolicy: 'exclude', draftsPolicy: 'exclude', revision: 0 }
  }})+'\\n');
});
`;
  await NodeFSP.writeFile(path, content, { mode: 0o700 });
  const options = {
    platform: "darwin" as const,
    architecture: "arm64",
    bundledRoot: NodePath.join(root, "missing"),
    reviewBinary: { path, sha256: NodeCrypto.createHash("sha256").update(content).digest("hex") },
    homeDir: NodePath.join(root, "home"),
    exportsDir: NodePath.join(root, "exports"),
    environmentId: "test-environment",
    hostName: "Test host",
  };
  const supervisor = new ExtensionsSupervisor(options);
  supervisors.push(supervisor);
  return { root, path, options, supervisor };
}

describe("Extensions supervisor", () => {
  it("negotiates once and correlates concurrent requests on the same process", async () => {
    const { supervisor } = await fixture();
    const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
    expect(a).toEqual(b);
    const results = await Promise.all([
      supervisor.request("contextual.sources.list", { limit: 10 }),
      supervisor.request("contextual.sources.list", { limit: 10 }),
    ]);
    expect(results.map((r) => r.sourceGeneration).sort()).toEqual([1, 2]);
  });
  it.each(["invalid", "oversized", "crash"])(
    "rejects %s output and does not replay the failed operation",
    async (mode) => {
      const { supervisor } = await fixture(mode);
      await expect(supervisor.request("contextual.sources.list", { limit: 10 })).rejects.toThrow(
        "not retried",
      );
      await expect(supervisor.start()).rejects.toThrow("recovering");
    },
  );
  it("cancels an outstanding operation without poisoning the negotiated session", async () => {
    const { supervisor } = await fixture("hang");
    await supervisor.start();
    const abort = new AbortController();
    const result = supervisor.request("contextual.sources.list", { limit: 10 }, abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow("canceled");
    expect(await supervisor.start()).not.toBeNull();
  });
  it("rejects changed binaries, writable executables and symlinks before launch", async () => {
    const { path, options, root } = await fixture();
    await expect(
      resolveExtensionsBinary({ ...options, reviewBinary: { path, sha256: "0".repeat(64) } }),
    ).rejects.toThrow("digest");
    await NodeFSP.chmod(path, 0o777);
    await expect(resolveExtensionsBinary(options)).rejects.toThrow("trusted");
    await NodeFSP.chmod(path, 0o700);
    const link = NodePath.join(root, "link");
    await NodeFSP.symlink(path, link);
    await expect(
      resolveExtensionsBinary({
        ...options,
        reviewBinary: { ...options.reviewBinary, path: link },
      }),
    ).rejects.toThrow("trusted");
  });
  it("keeps a missing helper a capability state and constrains export access", async () => {
    const { options, supervisor } = await fixture();
    expect(
      await resolveExtensionsBinary({
        bundledRoot: options.bundledRoot,
        platform: options.platform,
        architecture: options.architecture,
      }),
    ).toBeNull();
    await supervisor.start();
    await expect(supervisor.readExport("../secret")).rejects.toThrow("Invalid");
    const exported = NodePath.join(options.exportsDir, "opaque-id");
    await NodeFSP.writeFile(exported, "synthetic", { mode: 0o600 });
    expect((await supervisor.readExport("opaque-id")).toString()).toBe("synthetic");
    await NodeFSP.symlink(exported, NodePath.join(options.exportsDir, "link"));
    await expect(supervisor.readExport("link")).rejects.toThrow("unavailable");
  });
  it.each(["purge-during-read", "unlink-during-read", "stale-export"])(
    "rejects exports invalidated by %s even if bytes were readable",
    async (mode) => {
      const { options, supervisor } = await fixture(mode);
      // The download starts a previously stopped helper before trusting the file.
      await NodeFSP.mkdir(options.exportsDir, { mode: 0o700 });
      await NodeFSP.writeFile(
        NodePath.join(options.exportsDir, "opaque-id"),
        "deleted synthetic text",
        { mode: 0o600 },
      );
      await expect(supervisor.readExport("opaque-id")).rejects.toThrow(
        mode === "purge-during-read" ? "changed during access" : "ENOENT",
      );
    },
  );
  it("refuses persisted exports when no helper can verify purge state", async () => {
    const { options } = await fixture();
    const { reviewBinary: _reviewBinary, ...withoutHelper } = options;
    const supervisor = new ExtensionsSupervisor(withoutHelper);
    supervisors.push(supervisor);
    await NodeFSP.mkdir(options.exportsDir, { mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(options.exportsDir, "opaque-id"),
      "deleted synthetic text",
      { mode: 0o600 },
    );
    await expect(supervisor.readExport("opaque-id")).rejects.toThrow("helper");
  });
});
