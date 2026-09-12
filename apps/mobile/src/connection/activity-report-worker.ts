import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const REPORT_TIMEOUT = "5 seconds";

/** Keep lifecycle reports current even if a suspended socket never acknowledges one. */
export function runMobileActivityReports<R>(
  requests: Stream.Stream<void>,
  report: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> {
  return requests.pipe(
    Stream.debounce("250 millis"),
    Stream.switchMap(() =>
      Stream.fromEffect(report.pipe(Effect.timeout(REPORT_TIMEOUT), Effect.ignore)),
    ),
    Stream.runDrain,
  );
}
