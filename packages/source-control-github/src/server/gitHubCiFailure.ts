/**
 * Lecturn (Squire CI excerpt): the failing GitHub Actions jobs of a head revision with their error
 * sources, annotations first and the job log only when a job has none. A background read: it
 * spends no reserved quota, asks the user nothing, and makes at most `1 + 3 * maxJobs` requests.
 */
import type {
  ProviderCiFailure,
  ProviderCiFailureJob,
} from "@lecturn/source-control-core/server/PullRequestProvider";
import * as SourceControlRateLimit from "@lecturn/source-control-core/server/SourceControlRateLimit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import type * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

export class GitHubCiFailureDecodeError extends Schema.TaggedError<GitHubCiFailureDecodeError>()(
  "GitHubCiFailureDecodeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `GitHub answered ${this.operation} with something that is not a check listing.`;
  }
}

export interface GitHubCiFailureInput {
  readonly host: string;
  readonly repository: string;
  readonly headRevision: string;
  readonly maxJobs: number;
  readonly maxLogBytes: number;
}

const CheckRuns = Schema.fromJsonString(
  Schema.Struct({
    check_runs: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        name: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
        html_url: Schema.optional(Schema.NullOr(Schema.String)),
        app: Schema.optional(
          Schema.NullOr(Schema.Struct({ slug: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  }),
);
const decodeCheckRuns = Schema.decodeUnknownEffect(CheckRuns);
const decodeAnnotations = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        annotation_level: Schema.optional(Schema.NullOr(Schema.String)),
        message: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
);

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const PASSED = new Set(["success", "neutral", "skipped"]);
/** Every failed Actions step adds this one, so it names no cause. */
const EXIT_CODE_ANNOTATION = /^Process completed with exit code \d+\.?$/;
const LOG_TIMEOUT = Duration.seconds(30);
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

function repositoryPath(repository: string): string {
  const parts = repository.trim().split("/").filter(Boolean);
  return `${encodeURIComponent(parts.at(-2) ?? "")}/${encodeURIComponent(parts.at(-1) ?? "")}`;
}

/** Reads at most `maxBytes`, then stops the transfer instead of draining the rest. */
const readBounded = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) => {
  let seen = 0;
  return stream.pipe(
    Stream.takeUntil((chunk) => {
      seen += chunk.byteLength;
      return seen > maxBytes;
    }),
    Stream.runFold(
      (): Array<Uint8Array> => [],
      (chunks, chunk) => {
        chunks.push(chunk);
        return chunks;
      },
    ),
    Effect.map((chunks) => {
      const bytes = Buffer.concat(chunks);
      const truncated = bytes.byteLength > maxBytes;
      return {
        text: new TextDecoder().decode(truncated ? bytes.subarray(0, maxBytes) : bytes),
        truncated,
      };
    }),
  );
};

export const readGitHubCiFailure = Effect.fn("GitHubCiFailure.read")(
  function* (input: GitHubCiFailureInput) {
    const api = yield* GitHubRest.GitHubRest;
    const httpClient = yield* HttpClient.HttpClient;
    const repo = repositoryPath(input.repository);
    const sha = encodeURIComponent(input.headRevision);
    const rest = (operation: string, path: string, extra?: Partial<GitHubRest.GitHubRestInput>) =>
      api.rest({ host: input.host, operation, path, allowReserve: false, ...extra });

    const listing = yield* rest(
      "listCiCheckRuns",
      `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    );
    const { check_runs: runs } = yield* decodeCheckRuns(listing.body).pipe(
      Effect.mapError(
        (cause) => new GitHubCiFailureDecodeError({ operation: "listCiCheckRuns", cause }),
      ),
    );
    const failing = runs.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion));
    const checks = {
      passed: runs.filter((run) => run.conclusion !== null && PASSED.has(run.conclusion)).length,
      failed: failing.length,
      failingJobs: failing.map((run) => run.name),
    };
    const actionsJobs = failing
      .filter((run) => run.app?.slug === "github-actions")
      .slice(0, Math.max(0, input.maxJobs));

    // The token this host's requests carry; a log that echoes it must not carry it further.
    const token = yield* api.credential(input.host).pipe(
      Effect.map(({ token }) => Redacted.value(token)),
      Effect.orElseSucceed(() => null),
    );
    const withoutToken = (text: string) =>
      token !== null && token.length > 0 ? text.split(token).join("[redacted]") : text;

    const annotationsOf = (id: number) =>
      rest("listCiAnnotations", `repos/${repo}/check-runs/${id}/annotations?per_page=50`).pipe(
        Effect.map((response) =>
          Option.getOrElse(decodeAnnotations(response.body), () => []).flatMap((annotation) => {
            const message = annotation.message?.trim();
            return annotation.annotation_level === "failure" &&
              message &&
              !EXIT_CODE_ANNOTATION.test(message)
              ? [withoutToken(message)]
              : [];
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

    /** GitHub answers with a redirect to a presigned URL, which is fetched without the token. */
    const logOf = (id: number) =>
      Effect.gen(function* () {
        const answer = yield* rest("readCiJobLog", `repos/${repo}/actions/jobs/${id}/logs`, {
          manualRedirect: true,
          accept: "application/vnd.github+json",
          maxResponseBytes: input.maxLogBytes,
        });
        if (answer.status >= 200 && answer.status < 300) {
          return { text: withoutToken(answer.body), truncated: answer.truncated };
        }
        const location = answer.headers.location;
        if (!location) return null;
        const target = new URL(location, `https://${input.host}/`);
        if (target.protocol !== "https:") return null;
        const response = yield* httpClient.execute(HttpClientRequest.get(target.toString())).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.timeout(LOG_TIMEOUT),
        );
        if (response.status < 200 || response.status >= 300) return null;
        const read = yield* readBounded(response.stream, input.maxLogBytes).pipe(
          Effect.timeout(LOG_TIMEOUT),
        );
        return { text: withoutToken(read.text), truncated: read.truncated };
      }).pipe(Effect.orElseSucceed(() => null));

    const jobs = yield* Effect.forEach(actionsJobs, (run) =>
      Effect.gen(function* () {
        const annotations = yield* annotationsOf(run.id);
        const log = annotations.length > 0 ? null : yield* logOf(run.id);
        const job: ProviderCiFailureJob = {
          name: run.name,
          url: run.html_url ?? null,
          annotations,
          log,
          logUnavailable: annotations.length === 0 && log === null,
        };
        return job;
      }),
    );
    const result: ProviderCiFailure = { checks, jobs };
    return result;
  },
  Effect.provideService(SourceControlRateLimit.Interactive, false),
);

export type GitHubCiFailureError = GitHubRequestPolicy.GitHubApiError | GitHubCiFailureDecodeError;
