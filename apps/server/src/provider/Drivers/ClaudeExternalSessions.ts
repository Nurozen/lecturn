// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  type ExternalSessionOrigin,
  ExternalSessionsListError,
  type ProviderInstanceId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readClaudeResumeState } from "../Layers/ClaudeAdapter.ts";
import type { ExternalSessionListing, ProviderInstance } from "../ProviderDriver.ts";

// The SDK returns newest first, so the cap only ever hides the oldest sessions.
const SDK_SESSION_CAP = 500;
// `entrypoint` is on the first user line but follows `message` there, so a
// first prompt larger than this prefix pushes it out of reach and the origin
// reads as "unknown". Transcripts run to many MB, so never read past the prefix.
const ORIGIN_PREFIX_BYTES = 16 * 1024;
const ORIGIN_READ_CONCURRENCY = 8;
const ENTRYPOINT_PATTERN = /"entrypoint"\s*:\s*"([^"]*)"/;

const ORIGIN_BY_ENTRYPOINT: Record<string, ExternalSessionOrigin> = {
  cli: "cli",
  "claude-desktop": "desktop",
};

function configDirOf(environment: NodeJS.ProcessEnv): string {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configDir
    ? NodePath.resolve(configDir)
    : NodePath.join(environment.HOME || NodeOS.homedir(), ".claude");
}

/**
 * The Claude config dir external sessions can be listed from, or `undefined`
 * when the instance runs against a different home than the server process.
 * The SDK's filesystem lister reads `process.env` and Lecturn never mutates
 * that, so only the process's own home is listable for now.
 */
export function claudeExternalSessionsConfigDir(
  instanceEnvironment: NodeJS.ProcessEnv,
  serverEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configDir = configDirOf(instanceEnvironment);
  return configDir === configDirOf(serverEnvironment) ? configDir : undefined;
}

/**
 * One readdir pass over `projects/*`: session id to transcript path. Origin is
 * best effort, so an unreadable directory just leaves its sessions unindexed.
 */
async function indexTranscripts(configDir: string): Promise<Map<string, string>> {
  const projectsDir = NodePath.join(configDir, "projects");
  const index = new Map<string, string>();
  const projects = await NodeFSP.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    const directory = NodePath.join(projectsDir, project.name);
    const files = await NodeFSP.readdir(directory).catch(() => []);
    for (const file of files) {
      if (file.endsWith(".jsonl")) index.set(file.slice(0, -6), NodePath.join(directory, file));
    }
  }
  return index;
}

async function readOrigin(transcriptPath: string | undefined): Promise<ExternalSessionOrigin> {
  if (transcriptPath === undefined) return "unknown";
  try {
    const handle = await NodeFSP.open(transcriptPath, "r");
    try {
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(ORIGIN_PREFIX_BYTES),
        0,
        ORIGIN_PREFIX_BYTES,
        0,
      );
      const entrypoint = ENTRYPOINT_PATTERN.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
      return (entrypoint && ORIGIN_BY_ENTRYPOINT[entrypoint]) || "unknown";
    } finally {
      await handle.close();
    }
  } catch {
    return "unknown";
  }
}

function matchesSearch(session: SDKSessionInfo, needle: string): boolean {
  return [
    session.customTitle,
    session.summary,
    session.firstPrompt,
    session.cwd,
    session.gitBranch,
  ].some((field) => field?.toLowerCase().includes(needle));
}

/**
 * Builds `ProviderInstance.listExternalSessions` for a Claude home: sessions
 * the Claude CLI or desktop app wrote there, minus the
 * programmatic ones Lecturn creates and any session Lecturn already resumes.
 * `listSessions` is injectable so tests never read a real home.
 */
export function makeClaudeExternalSessionsLister(options: {
  readonly instanceId: ProviderInstanceId;
  readonly configDir: string;
  readonly listSessions?: typeof listSessions;
}): NonNullable<ProviderInstance["listExternalSessions"]> {
  const sdkListSessions = options.listSessions ?? listSessions;
  return Effect.fn("listClaudeExternalSessions")(function* (input) {
    const unreadable = (cause: unknown) =>
      new ExternalSessionsListError({
        providerInstanceId: options.instanceId,
        reason: "unreadable",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        cause,
      });

    const listed = yield* Effect.tryPromise({
      try: () =>
        sdkListSessions({
          ...(input.cwd !== undefined ? { dir: input.cwd } : {}),
          limit: SDK_SESSION_CAP,
          includeProgrammatic: false,
          includeWorktrees: true,
        }),
      catch: unreadable,
    });

    const knownSessionIds = new Set(
      input.knownResumeCursors.flatMap((cursor) => readClaudeResumeState(cursor)?.resume ?? []),
    );
    const needle = input.searchTerm?.trim().toLowerCase();
    const matched = listed
      .filter(
        (session): session is SDKSessionInfo & { cwd: string } =>
          Boolean(session.cwd?.trim()) &&
          !knownSessionIds.has(session.sessionId) &&
          (!needle || matchesSearch(session, needle)),
      )
      .toSorted((left, right) => right.lastModified - left.lastModified);
    const page = matched.slice(0, input.limit);

    const transcripts =
      page.length === 0
        ? new Map<string, string>()
        : yield* Effect.promise(() => indexTranscripts(options.configDir));
    const sessions = yield* Effect.forEach(
      page,
      (session) =>
        Effect.promise(() => readOrigin(transcripts.get(session.sessionId))).pipe(
          Effect.map((origin): ExternalSessionListing => ({
            sessionId: session.sessionId,
            title: (session.customTitle || session.summary).trim(),
            ...(session.firstPrompt ? { firstPrompt: session.firstPrompt.trim() } : {}),
            cwd: session.cwd.trim(),
            ...(session.gitBranch?.trim() ? { gitBranch: session.gitBranch.trim() } : {}),
            ...(session.createdAt !== undefined
              ? { createdAt: DateTime.formatIso(DateTime.makeUnsafe(session.createdAt)) }
              : {}),
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(session.lastModified)),
            ...(session.fileSize !== undefined ? { sizeBytes: session.fileSize } : {}),
            origin,
          })),
        ),
      { concurrency: ORIGIN_READ_CONCURRENCY },
    );

    return {
      sessions,
      truncated: matched.length > input.limit || listed.length >= SDK_SESSION_CAP,
    };
  });
}
