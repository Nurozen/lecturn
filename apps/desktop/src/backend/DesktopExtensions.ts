import type { DesktopBackendBootstrap } from "@lecturn/contracts";
import { Effect, FileSystem, Option, Schema } from "effect";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

const ReviewManifest = Schema.Struct({
  binary: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  fixtureRoot: Schema.optionalKey(Schema.String),
});
const decodeReviewManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewManifest));
/** Only trusted packaged resources select executables. Renderer settings and PATH never do. */
export const resolveExtensionsBootstrap = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  if (!environment.isPackaged || environment.platform !== "darwin") return undefined;
  const bundledRoot = environment.path.join(environment.resourcesPath, "extensions");
  if (!(yield* fs.exists(bundledRoot).pipe(Effect.orElseSucceed(() => false)))) return undefined;
  const base: NonNullable<DesktopBackendBootstrap["extensions"]> = { bundledRoot };
  if (!environment.appVersion.includes("-pr.")) return base;
  // An explicit local review artifact pins its own unsigned helper. Official builds never read this.
  const review = yield* fs.readFileString(environment.path.join(bundledRoot, "review.json")).pipe(
    Effect.filterOrFail(
      (text) => text.length <= 4096,
      () => new InvalidReviewManifest(),
    ),
    Effect.flatMap(decodeReviewManifest),
    Effect.option,
  );
  if (Option.isNone(review)) return base;
  return {
    ...base,
    reviewBinary: {
      path: environment.path.join(bundledRoot, review.value.binary),
      sha256: review.value.sha256,
      ...(review.value.fixtureRoot ? { fixtureRoot: review.value.fixtureRoot } : {}),
    },
  };
});
class InvalidReviewManifest extends Schema.TaggedErrorClass<InvalidReviewManifest>()(
  "InvalidReviewManifest",
  {},
) {}
