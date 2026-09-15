// @effect-diagnostics globalTimers:off -- This native subprocess deadline aborts its owned child and clears on every completion path.
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShellAsync,
} from "@lecturn/shared/shell";

export const SHELL_DETECTION_TIMEOUT_MS = 15_000;
export type ShellEnvironmentResult = {
  readonly status: "ready" | "timed-out" | "error";
  readonly message?: string;
};
type Probe = typeof readEnvironmentFromLoginShellAsync;
const names = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

/** One bounded probe shared by every provider, including concurrent retries. */
export function createShellEnvironmentDetector(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probe: Probe = readEnvironmentFromLoginShellAsync,
) {
  let result: ShellEnvironmentResult | undefined;
  let running: Promise<ShellEnvironmentResult> | undefined;
  const detect = (options: { retry?: boolean } = {}): Promise<ShellEnvironmentResult> => {
    if (running) return running;
    if (result && !options.retry) return Promise.resolve(result);
    result = undefined;
    const controller = new AbortController();
    const work = async (): Promise<ShellEnvironmentResult> => {
      if (platform !== "darwin" && platform !== "linux") return { status: "ready" };
      for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
        try {
          const values = await probe(shell, names, controller.signal);
          if (controller.signal.aborted) break;
          if (!values.PATH?.trim()) continue;
          env.PATH = mergePathEntries(values.PATH, env.PATH, platform);
          for (const name of names) {
            if (
              name !== "PATH" &&
              !["LANG", "LC_ALL", "LC_CTYPE"].includes(name) &&
              !env[name] &&
              values[name]
            )
              env[name] = values[name];
          }
          // Locale variables are one precedence group: importing LC_ALL must not
          // override a locale explicitly inherited from the parent process.
          if (["LANG", "LC_ALL", "LC_CTYPE"].every((name) => !env[name]?.trim())) {
            for (const name of ["LANG", "LC_ALL", "LC_CTYPE"]) {
              if (values[name]) env[name] = values[name];
            }
            if (
              platform === "darwin" &&
              ["LANG", "LC_ALL", "LC_CTYPE"].every((name) => !env[name]?.trim())
            )
              env.LC_CTYPE = "en_US.UTF-8";
          }
          return { status: "ready" };
        } catch {
          if (controller.signal.aborted) break;
        }
      }
      return {
        status: "error",
        message:
          "Could not load the shell environment. Retry or configure the provider executable path.",
      };
    };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<ShellEnvironmentResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          status: "timed-out",
          message:
            "Loading the shell environment timed out after 15 seconds. Retry or configure the provider executable path.",
        });
      }, SHELL_DETECTION_TIMEOUT_MS);
    });
    running = Promise.race([deadline, work()]).then((next) => {
      clearTimeout(timer);
      result = next;
      running = undefined;
      return next;
    });
    return running;
  };
  return { detect, getStatus: () => result?.status ?? ("pending" as const) };
}

const detectors = new WeakMap<
  NodeJS.ProcessEnv,
  ReturnType<typeof createShellEnvironmentDetector>
>();

export function startShellEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  let detector = detectors.get(env);
  if (!detector) {
    detector = createShellEnvironmentDetector(env, platform);
    detectors.set(env, detector);
  }
  void detector.detect();
}

export function awaitShellEnvironment(
  options: { retry?: boolean } = {},
): Promise<ShellEnvironmentResult> {
  return detectors.get(process.env)?.detect(options) ?? Promise.resolve({ status: "ready" });
}

export function getShellEnvironmentStatus() {
  return detectors.get(process.env)?.getStatus() ?? "ready";
}
