// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";
import { forkClaudeSession } from "./ClaudeSessionFork.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-claude-fork-"));
  const directory = NodePath.join(root, "projects", "-synthetic-workspace");
  await NodeFSP.mkdir(directory, { recursive: true });
  const sessionId = NodeCrypto.randomUUID();
  const ids = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID(), NodeCrypto.randomUUID()] as const;
  const entries = ids.map((uuid, index) => ({
    type: index === 1 ? "assistant" : "user",
    uuid,
    sessionId,
    parentUuid: ids[index - 1] ?? null,
    cwd: "/synthetic/workspace",
    timestamp: "2026-09-09T00:00:00.000Z",
    message: { role: index === 1 ? "assistant" : "user", content: `Message ${index}` },
  }));
  const sourcePath = NodePath.join(directory, `${sessionId}.jsonl`);
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await NodeFSP.writeFile(sourcePath, contents);
  return {
    root,
    directory,
    sessionId,
    ids,
    sourcePath,
    contents,
    environment: { CLAUDE_CONFIG_DIR: root },
  };
}

async function readEntries(directory: string, sessionId: string) {
  return (await NodeFSP.readFile(NodePath.join(directory, `${sessionId}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("forkClaudeSession with the installed SDK", () => {
  it("persists an independent child through the inclusive anchor and preserves the parent", async () => {
    const f = await fixture();
    try {
      const child = await forkClaudeSession({
        sourceSessionId: f.sessionId,
        upToMessageId: f.ids[1],
        environment: f.environment,
      });
      expect(child.sessionId).not.toBe(f.sessionId);
      const entries = await readEntries(f.directory, child.sessionId);
      const messages = entries.filter(
        (entry) => entry.type === "user" || entry.type === "assistant",
      );
      expect(messages.map((entry) => entry.message.content)).toEqual(["Message 0", "Message 1"]);
      expect(messages.every((entry) => entry.sessionId === child.sessionId)).toBe(true);
      expect(messages[0].parentUuid).toBe(null);
      expect(messages[1].parentUuid).toBe(messages[0].uuid);
      expect(messages[1].uuid).not.toBe(f.ids[1]);
      expect(messages[1].forkedFrom).toEqual({ sessionId: f.sessionId, messageUuid: f.ids[1] });
      expect(await NodeFSP.readFile(f.sourcePath, "utf8")).toBe(f.contents);
      expect(
        (await NodeFSP.stat(NodePath.join(f.directory, `${child.sessionId}.jsonl`))).mode & 0o777,
      ).toBe(0o600);
      // Forking a persisted child through an inherited projection anchor works
      // across multiple generations without a CLI or first user prompt.
      const grandchild = await forkClaudeSession({
        sourceSessionId: child.sessionId,
        upToMessageId: f.ids[1],
        environment: f.environment,
      });
      const third = await forkClaudeSession({
        sourceSessionId: grandchild.sessionId,
        upToMessageId: f.ids[0],
        environment: f.environment,
      });
      expect(
        (await readEntries(f.directory, third.sessionId))
          .filter((entry) => entry.type === "user" || entry.type === "assistant")
          .map((entry) => entry.message.content),
      ).toEqual(["Message 0"]);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed for absent anchors without creating a child", async () => {
    const f = await fixture();
    try {
      await expect(
        forkClaudeSession({
          sourceSessionId: f.sessionId,
          upToMessageId: NodeCrypto.randomUUID(),
          environment: f.environment,
        }),
      ).rejects.toThrow("fork message was not found");
      expect(await NodeFSP.readdir(f.directory)).toEqual([`${f.sessionId}.jsonl`]);
      expect(await NodeFSP.readFile(f.sourcePath, "utf8")).toBe(f.contents);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });

  it("resolves a direct inherited anchor even after older ancestors are removed", async () => {
    const f = await fixture();
    try {
      const child = await forkClaudeSession({
        sourceSessionId: f.sessionId,
        environment: f.environment,
      });
      expect(
        (await readEntries(f.directory, child.sessionId)).filter(
          (entry) => entry.type === "user" || entry.type === "assistant",
        ),
      ).toHaveLength(3);
      await NodeFSP.unlink(f.sourcePath);
      const grandchild = await forkClaudeSession({
        sourceSessionId: child.sessionId,
        upToMessageId: f.ids[1],
        environment: f.environment,
      });
      expect(
        (await readEntries(f.directory, grandchild.sessionId)).filter(
          (entry) => entry.type === "user" || entry.type === "assistant",
        ),
      ).toHaveLength(2);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed for cyclic provenance without writing a child", async () => {
    const f = await fixture();
    try {
      const entries = await readEntries(f.directory, f.sessionId);
      for (const entry of entries)
        entry.forkedFrom = { sessionId: f.sessionId, messageUuid: entry.uuid };
      await NodeFSP.writeFile(
        f.sourcePath,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      await expect(
        forkClaudeSession({
          sourceSessionId: f.sessionId,
          upToMessageId: NodeCrypto.randomUUID(),
          environment: f.environment,
        }),
      ).rejects.toThrow("fork message was not found");
      expect(await NodeFSP.readdir(f.directory)).toEqual([`${f.sessionId}.jsonl`]);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });

  it("only searches the configured provider home", async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      await expect(
        forkClaudeSession({ sourceSessionId: f.sessionId, environment: other.environment }),
      ).rejects.toThrow("was not found in this provider");
      expect(await NodeFSP.readdir(other.directory)).toEqual([`${other.sessionId}.jsonl`]);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
      await NodeFSP.rm(other.root, { recursive: true, force: true });
    }
  });
});
