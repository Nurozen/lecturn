/**
 * The first error lines of a CI-failure card's failing GitHub Actions jobs, fetched after
 * the card exists and stored on its evidence. It follows committed `card.created` rows rather
 * than the tools, so raising a card never waits on GitHub. The excerpt lives only on the card
 * (`squire.item.get`); relay, push, and notch payloads carry rows, never evidence.
 */
import { detectSourceControlProviderFromGitRemoteUrl } from "@lecturn/shared/git";
import { visibleThreadPullRequests } from "@lecturn/shared/threadPullRequests";
import {
  type SquireCardId,
  SquireEvidence,
  type SquireCiLog,
  type SquireId,
  SquireTurnSummary,
  type ThreadId,
  SourceControlProviderKind,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import type { ProviderCiFailure } from "@lecturn/source-control-core/server/PullRequestProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { FIXTURE_PULL_REQUEST_HOST } from "../orchestration-v2/PullRequestSyncReactor.ts";
import { PullRequestProviderRegistry } from "../pullRequest/PullRequestProviderRegistry.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { pullRequestEvidence } from "./SquireCardDetail.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";

export const SQUIRE_CI_MAX_JOBS = 2;
export const SQUIRE_CI_MAX_LOG_BYTES = 1024 * 1024;
const MAX_LINES = 5;
const LINE_MAX_CHARS = 300;
/** Rows older than this at startup predate any card still worth an excerpt. */
const STARTUP_WINDOW = Duration.hours(24);
const PAGE = 100;
const RETRY_AFTER_FAILURE = Duration.seconds(30);

// ── Pure excerpting ───────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- ANSI escapes are control characters.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
const REDACTED = "[redacted]";
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `$1 ${REDACTED}`],
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1$2${REDACTED}`,
  ],
];
/** GitHub's workflow markers that never carry a cause. */
const MARKER = /^##\[(?:group|endgroup|debug|warning|notice|command|section)\]/;
const ERROR_MARKER = /^##\[error\]\s*/;
const EXIT_CODE = /^Process completed with exit code \d+\.?$/;
const ERROR_WORDS =
  /\b(?:errors?|failed|failures?|fail|exception|panic(?:ked)?|fatal|traceback|assert(?:ion)?(?:error)?)\b|[✖✗×]/i;

const stripAnsi = (text: string) => text.replace(ANSI, "");

/** Token shapes and generic `key=value` secrets, then each known secret value verbatim. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const bound = (line: string) =>
  line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line;

const cleanLines = (text: string, secrets: ReadonlyArray<string>) =>
  stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => redactSecrets(line.replace(LOG_TIMESTAMP, ""), secrets).trim())
    .filter((line) => line.length > 0);

/** The log's error lines in log order: GitHub's `##[error]` lines and lines that name a failure. */
export function logErrorLines(text: string, secrets: ReadonlyArray<string> = []) {
  return cleanLines(text, secrets).flatMap((line) => {
    if (MARKER.test(line)) return [];
    if (ERROR_MARKER.test(line)) {
      const message = line.replace(ERROR_MARKER, "").trim();
      return message.length === 0 || EXIT_CODE.test(message) ? [] : [bound(message)];
    }
    return ERROR_WORDS.test(line) ? [bound(line)] : [];
  });
}

export interface SquireCiExcerptResult {
  readonly errorLines: ReadonlyArray<string>;
  readonly ciLog: SquireCiLog;
}

/** Annotations first, the log otherwise; at most five lines, the first job's first. */
export function squireCiExcerpt(
  failure: ProviderCiFailure,
  headSha: string,
  secrets: ReadonlyArray<string> = [],
): SquireCiExcerptResult {
  const jobs = failure.jobs.slice(0, SQUIRE_CI_MAX_JOBS);
  const perJob = jobs.map((job) =>
    job.annotations.length > 0
      ? {
          source: "annotations" as const,
          lines: job.annotations.flatMap((annotation) =>
            cleanLines(annotation, secrets).map(bound),
          ),
        }
      : job.log !== null
        ? { source: "log" as const, lines: logErrorLines(job.log.text, secrets) }
        : { source: null, lines: [] },
  );
  // A second job keeps room for two of its lines.
  const secondNeeds = Math.min(2, perJob[1]?.lines.length ?? 0);
  const first = perJob[0]?.lines.slice(0, MAX_LINES - secondNeeds) ?? [];
  const second = perJob[1]?.lines.slice(0, MAX_LINES - first.length) ?? [];
  const sources = new Set(perJob.flatMap((job) => (job.source === null ? [] : [job.source])));
  const ciLog: SquireCiLog = {
    status: sources.has("annotations") ? "annotations" : sources.has("log") ? "log" : "unavailable",
    headSha,
    jobs: jobs.map((job) => ({ name: job.name, url: job.url })),
    truncated: jobs.some((job) => job.log?.truncated === true),
  };
  return { errorLines: [...first, ...second], ciLog };
}

/** A check failure that could not be read at all. */
const unavailableCiLog = (headSha: string): SquireCiLog => ({
  status: "unavailable",
  headSha,
  jobs: [],
  truncated: false,
});

// ── Source ────────────────────────────────────────────────────

export class SquireCiReadError extends Schema.TaggedError<SquireCiReadError>()(
  "SquireCiReadError",
  { cause: Schema.Defect() },
) {}

export interface SquireCiReadInput {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly headRevision: string;
}

export class SquireCiSource extends Context.Service<
  SquireCiSource,
  {
    /** None when the forge has no excerpt read (only GitHub has one). */
    readonly read: (
      input: SquireCiReadInput,
    ) => Effect.Effect<Option.Option<ProviderCiFailure>, SquireCiReadError>;
  }
>()("lecturn/squire/SquireCiExcerpt/SquireCiSource") {}

/** GitHub's provider read; with no registry in context (isolated harnesses) nothing is read. */
export const layerSourceFromRegistry = Layer.effect(
  SquireCiSource,
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(PullRequestProviderRegistry);
    const read = Option.flatMapNullishOr(
      registry,
      (value) => value.get(SourceControlProviderKind.make("github"))?.readCiFailure,
    );
    return SquireCiSource.of({
      read: (input) =>
        Option.match(read, {
          onNone: () => Effect.succeedNone,
          onSome: (readCiFailure) =>
            readCiFailure({
              ...input,
              maxJobs: SQUIRE_CI_MAX_JOBS,
              maxLogBytes: SQUIRE_CI_MAX_LOG_BYTES,
            }).pipe(
              Effect.map(Option.some),
              Effect.mapError((cause) => new SquireCiReadError({ cause })),
            ),
        }),
    });
  }),
);

// ── The fiber ─────────────────────────────────────────────────

const decodeEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvidence));
const decodePayload = Schema.decodeUnknownOption(SquireEventPayloadJson);
const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(SquireTurnSummary));
const EVENT_STATUSES = ["deferred", "pending", "batched", "delivered", "dropped"] as const;
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(SquireEvidence));
const EXCERPT_KINDS: ReadonlySet<string> = new Set(["steer", "proposal"]);
const LIVE_STATUSES: ReadonlySet<string> = new Set(["held", "open", "accepting", "executing"]);
const ALL_STATUSES = [
  "held",
  "open",
  "accepting",
  "executing",
  "resolved",
  "executed",
  "dismissed",
  "outdated",
] as const;

/** The thread's linked open PR whose checks fail on a known head, if any. */
const failingPullRequestOf = (
  links: ReadonlyArray<ThreadPullRequestLink>,
): Option.Option<ThreadPullRequestLink & { readonly headSha: string }> =>
  Option.fromNullishOr(
    visibleThreadPullRequests(links).flatMap((link) =>
      link.snapshot?.state === "open" &&
      link.snapshot.checksState === "failing" &&
      link.snapshot.headSha !== undefined
        ? [{ ...link, headSha: link.snapshot.headSha }]
        : [],
    )[0],
  );

export type SquireCiExcerptError = PersistenceSqlError | ProjectionStore.ProjectionStoreV2Error;

export class SquireCiExcerpt extends Context.Service<
  SquireCiExcerpt,
  {
    /** Excerpts every CI-failure card raised since the last pass. */
    readonly runPending: Effect.Effect<void, SquireCiExcerptError>;
    /** Excerpts one card now; a no-op unless it is a live CI-failure card lacking this head's excerpt. */
    readonly excerptCard: (cardId: SquireCardId) => Effect.Effect<void, SquireCiExcerptError>;
    /** `runPending` on every repository change; never returns. Forked at startup. */
    readonly start: Effect.Effect<never>;
  }
>()("lecturn/squire/SquireCiExcerpt") {}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const source = yield* SquireCiSource;
  // In memory: a restart re-reads the startup window, and a card that already holds its
  // head's excerpt is skipped, so a re-read costs no request.
  const cursors = new Map<SquireId, number>();
  const startedAt = DateTime.formatIso(
    DateTime.subtract(yield* DateTime.now, { milliseconds: Duration.toMillis(STARTUP_WINDOW) }),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** Merges over whatever the card holds now, since the read may have taken a while. */
  const storeExcerpt = (
    cardId: SquireCardId,
    excerpt: SquireCiExcerptResult,
    extra: Pick<SquireEvidence, "pullRequest" | "diffStats" | "headBranch">,
  ) =>
    Effect.gen(function* () {
      const latest = Option.getOrNull(yield* repository.getCard(cardId));
      if (latest === null) return;
      const current = Option.getOrElse(
        decodeEvidence(latest.evidence_json),
        (): SquireEvidence => ({}),
      );
      const { errorLines: _previous, ...rest } = current;
      const evidence: SquireEvidence = {
        ...rest,
        ...(excerpt.errorLines.length === 0 ? {} : { errorLines: excerpt.errorLines }),
        ciLog: excerpt.ciLog,
        ...(extra.pullRequest === undefined ? {} : { pullRequest: extra.pullRequest }),
        ...(extra.diffStats === undefined ? {} : { diffStats: extra.diffStats }),
        ...(extra.headBranch === undefined ? {} : { headBranch: extra.headBranch }),
      };
      yield* repository.updateCard({
        id: cardId,
        fromStatuses: ALL_STATUSES,
        patch: { evidence_json: encodeEvidence(evidence) },
        updatedAt: yield* nowIso,
      });
    });

  /**
   * A fixture PR is never read. Its scenario's error lines, branch, and diff stats ride on
   * the injected event's payload, newest event for this head first; the check counts come from
   * the run summary the fixture stored, as a real read's would come from GitHub.
   */
  const fixtureExcerpt = (threadId: ThreadId, headSha: string) =>
    Effect.gen(function* () {
      const rows = yield* repository.listEvents({
        statuses: EVENT_STATUSES,
        threadId,
        kinds: ["pull-request-changed"],
      });
      const payload = rows
        .toReversed()
        .flatMap((row) => Option.toArray(decodePayload(row.payload_json ?? "")))
        .find(
          (candidate) =>
            candidate.pullRequest?.headSha === headSha &&
            (candidate.evidence?.errorLines?.length ?? 0) > 0,
        );
      const errorLines = payload?.evidence?.errorLines;
      if (payload === undefined || errorLines === undefined) return Option.none();
      const summaries =
        payload.runId === null
          ? []
          : yield* repository.listRunSummaries({ thread_id: threadId, run_id: payload.runId });
      const pullRequest = summaries
        .flatMap((row) => Option.toArray(decodeSummary(row.summary_json)))
        .map((summary) => summary.pullRequest)
        .find((candidate) => candidate?.headSha === headSha);
      return Option.some({
        excerpt: {
          errorLines: errorLines.slice(0, MAX_LINES),
          ciLog: { status: "log", headSha, jobs: [], truncated: false },
        } satisfies SquireCiExcerptResult,
        extra: {
          ...(pullRequest == null ? {} : { pullRequest }),
          ...(payload.evidence?.diffStats === undefined
            ? {}
            : { diffStats: payload.evidence.diffStats }),
          ...(payload.evidence?.headBranch === undefined
            ? {}
            : { headBranch: payload.evidence.headBranch }),
        },
      });
    });

  const excerptCard: SquireCiExcerpt["Service"]["excerptCard"] = Effect.fn(
    "SquireCiExcerpt.excerptCard",
  )(function* (cardId) {
    const card = Option.getOrNull(yield* repository.getCard(cardId));
    if (card === null || card.target_thread_id === null) return;
    if (!EXCERPT_KINDS.has(card.kind) || !LIVE_STATUSES.has(card.status)) return;
    const shell = yield* projections.getThreadShell(card.target_thread_id);
    if (shell === null) return;
    const link = Option.getOrNull(failingPullRequestOf(shell.pullRequests ?? []));
    if (link === null) return;
    const stored = Option.getOrElse(decodeEvidence(card.evidence_json), (): SquireEvidence => ({}));
    if (stored.ciLog?.headSha === link.headSha) return;
    if (link.host === FIXTURE_PULL_REQUEST_HOST) {
      const fixture = yield* fixtureExcerpt(card.target_thread_id, link.headSha);
      if (Option.isSome(fixture)) {
        yield* storeExcerpt(cardId, fixture.value.excerpt, fixture.value.extra);
      }
      return;
    }
    if (detectSourceControlProviderFromGitRemoteUrl(link.url)?.kind !== "github") return;
    const read = yield* source
      .read({
        cwd: shell.worktreePath ?? "",
        host: link.host,
        repository: link.repository,
        number: link.number,
        headRevision: link.headSha,
      })
      .pipe(
        Effect.tapError((cause) => Effect.logWarning("Squire CI excerpt read failed", { cause })),
        Effect.option,
      );
    if (Option.isSome(read) && Option.isNone(read.value)) return;
    const failure = Option.flatten(read);
    const excerpt = Option.match(failure, {
      onNone: () => ({ errorLines: [], ciLog: unavailableCiLog(link.headSha) }),
      onSome: (value) => squireCiExcerpt(value, link.headSha),
    });
    const pullRequest = pullRequestEvidence(link, Option.getOrUndefined(failure)?.checks);
    yield* storeExcerpt(cardId, excerpt, pullRequest === undefined ? {} : { pullRequest });
  });

  const runPending: SquireCiExcerpt["Service"]["runPending"] = Effect.gen(function* () {
    for (const squire of yield* repository.listSquires) {
      let afterId = cursors.get(squire.id) ?? 0;
      while (true) {
        const rows = yield* repository.listActionLog({
          squireId: squire.id,
          kinds: ["card.created"],
          afterId,
          limit: PAGE,
        });
        for (const row of rows) {
          afterId = row.id;
          if (row.card_id === null || row.created_at < startedAt) continue;
          yield* excerptCard(row.card_id);
        }
        cursors.set(squire.id, afterId);
        if (rows.length < PAGE) break;
      }
    }
  });

  const start: SquireCiExcerpt["Service"]["start"] = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* repository.subscribeChanges;
      const step = runPending.pipe(
        Effect.andThen(Stream.runHead(changes)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire CI excerpt pass failed", { cause }).pipe(
            Effect.andThen(Effect.sleep(RETRY_AFTER_FAILURE)),
          ),
        ),
      );
      return yield* Effect.forever(step);
    }),
  );

  return SquireCiExcerpt.of({ runPending, excerptCard, start });
});

export const layer = Layer.effect(SquireCiExcerpt, make);
