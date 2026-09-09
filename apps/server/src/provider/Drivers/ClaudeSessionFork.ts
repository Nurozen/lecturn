// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { forkSession, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

class ClaudeSessionNotFound extends Error {}

const Uuid = Schema.String.check(Schema.isUUID());
const isUuid = Schema.is(Uuid);
const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const isEntry = Schema.is(Schema.Struct({ type: Schema.String }));
const isForkSource = Schema.is(Schema.Struct({ sessionId: Uuid, messageUuid: Uuid }));

/** Materialize history before query starts: Claude emits init only after a prompt. */
export async function forkClaudeSession(input: {
  readonly sourceSessionId: string;
  readonly upToMessageId?: string;
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{ sessionId: string }> {
  if (!isUuid(input.sourceSessionId)) throw new Error("Invalid Claude source session ID.");
  const configDir = input.environment.CLAUDE_CONFIG_DIR?.trim();
  const projectsDir = NodePath.join(
    configDir
      ? NodePath.resolve(input.cwd ?? process.cwd(), configDir)
      : NodePath.join(input.environment.HOME || NodeOS.homedir(), ".claude"),
    "projects",
  );
  const directories = (await NodeFSP.readdir(projectsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => NodePath.join(projectsDir, entry.name));
  const sessions = new Map<string, { directory: string; entries: SessionStoreEntry[] }>();
  async function loadSession(sessionId: string) {
    const cached = sessions.get(sessionId);
    if (cached) return cached;
    if (!isUuid(sessionId)) throw new Error("Invalid Claude session ID.");
    for (const directory of directories) {
      let transcript: string;
      try {
        transcript = await NodeFSP.readFile(NodePath.join(directory, `${sessionId}.jsonl`), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const entries: SessionStoreEntry[] = [];
      for (const line of transcript.split("\n")) {
        if (!line.trim()) continue;
        const entry = decodeEntry(line);
        if (isEntry(entry)) entries.push(entry);
      }
      const session = { directory, entries };
      sessions.set(sessionId, session);
      return session;
    }
    throw new ClaudeSessionNotFound(
      `Claude session ${sessionId} was not found in this provider's config directory.`,
    );
  }
  const source = await loadSession(input.sourceSessionId);
  let anchor = input.upToMessageId;
  // The SDK remaps UUIDs. Projection rows inherited by a fork retain their
  // original anchors, so follow the SDK's provenance when forking again.
  if (anchor && !source.entries.some((entry) => entry.uuid === anchor)) {
    const originalAnchor = anchor;
    const direct = source.entries.find(
      (entry) => isForkSource(entry.forkedFrom) && entry.forkedFrom.messageUuid === originalAnchor,
    );
    if (direct?.uuid) anchor = direct.uuid;
    for (const entry of anchor !== originalAnchor ? [] : source.entries) {
      let provenance = entry.forkedFrom;
      const visited = new Set<string>();
      while (isForkSource(provenance) && visited.size < 64) {
        const key = `${provenance.sessionId}:${provenance.messageUuid}`;
        if (visited.has(key)) break;
        visited.add(key);
        if (provenance.messageUuid === originalAnchor) {
          anchor = entry.uuid;
          break;
        }
        let ancestor;
        try {
          ancestor = await loadSession(provenance.sessionId);
        } catch (error) {
          if (error instanceof ClaudeSessionNotFound) break;
          throw error;
        }
        const messageUuid = provenance.messageUuid;
        provenance = ancestor.entries.find(
          (candidate) => candidate.uuid === messageUuid,
        )?.forkedFrom;
      }
      if (anchor !== originalAnchor) break;
    }
    if (!anchor || anchor === originalAnchor)
      throw new Error("Claude fork message was not found in the source session.");
  }
  return forkSession(input.sourceSessionId, {
    ...(input.cwd ? { dir: input.cwd } : {}),
    ...(anchor ? { upToMessageId: anchor } : {}),
    // The SDK's local filesystem helper reads process.env. A per-call store
    // preserves provider home isolation without mutating global environment.
    sessionStore: {
      load: async (key) => (key.sessionId === input.sourceSessionId ? source.entries : null),
      append: async (key, entries) => {
        if (!isUuid(key.sessionId) || key.sessionId === input.sourceSessionId) {
          throw new Error("Claude fork must write a distinct child session.");
        }
        await NodeFSP.writeFile(
          NodePath.join(source.directory, `${key.sessionId}.jsonl`),
          entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
          { flag: "wx", mode: 0o600 },
        );
      },
    },
  });
}
