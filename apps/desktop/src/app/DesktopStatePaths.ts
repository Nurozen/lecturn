import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(lecturnHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(lecturnHome)) {
    return Option.none();
  }
  const trimmed = lecturnHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly lecturnHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.lecturnHome), () =>
    input.joinPath(input.homeDirectory, ".lecturn"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly lecturnHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.lecturnHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
