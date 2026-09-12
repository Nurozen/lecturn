// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface LecturnPublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          LECTURN_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          LECTURN_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          LECTURN_RELAY_URL: config.relayUrl,
          VITE_LECTURN_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          LECTURN_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          LECTURN_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          LECTURN_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          LECTURN_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          LECTURN_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          LECTURN_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): LecturnPublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "LECTURN_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "LECTURN_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "LECTURN_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "LECTURN_RELAY_URL", "VITE_LECTURN_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "LECTURN_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "LECTURN_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "LECTURN_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "LECTURN_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "LECTURN_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "LECTURN_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

/** Hosted production must never silently ship the local, signed-out-only UI. */
export function assertHostedWebPublicConfig(env: Environment): void {
  // Ordinary production bundles also serve local/offline desktop and CLI installs.
  // Only the hosted deployment opts into this requirement.
  if (env.VERCEL_ENV !== "production") return;

  assertRequiredConnectConfig(env, "Hosted web build");
}

/** Store builds must include Connect even when local development uses direct pairing only. */
export function assertProductionMobilePublicConfig(env: Environment): void {
  if (env.EAS_BUILD !== "true" || env.APP_VARIANT !== "production") return;
  assertRequiredConnectConfig(env, "Production mobile build");
}

function assertRequiredConnectConfig(env: Environment, buildName: string): void {
  const config = resolvePublicConfig(env);
  const missing = [
    !config.clerkPublishableKey && "LECTURN_CLERK_PUBLISHABLE_KEY",
    !config.clerkJwtTemplate && "LECTURN_CLERK_JWT_TEMPLATE",
    !config.relayUrl && "LECTURN_RELAY_URL",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`${buildName} requires Connect configuration: ${missing.join(", ")}.`);
  }

  let relayUrl: URL;
  try {
    relayUrl = new URL(config.relayUrl ?? "");
  } catch {
    throw new Error(`${buildName} requires a valid HTTPS LECTURN_RELAY_URL.`);
  }
  if (relayUrl.protocol !== "https:" || relayUrl.username || relayUrl.password) {
    throw new Error(`${buildName} requires a valid HTTPS LECTURN_RELAY_URL.`);
  }
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
