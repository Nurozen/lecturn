// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertProductionMobilePublicConfig,
  assertHostedWebPublicConfig,
  loadRepoEnv,
  resolvePublicConfig,
} from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.LECTURN_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.LECTURN_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.LECTURN_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.LECTURN_RELAY_URL).toBeUndefined();
    expect(env.VITE_LECTURN_RELAY_URL).toBeUndefined();
    expect(env.LECTURN_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.LECTURN_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.LECTURN_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.LECTURN_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.LECTURN_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.LECTURN_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "LECTURN_CLERK_PUBLISHABLE_KEY=pk_root\nLECTURN_CLERK_JWT_TEMPLATE=template_root\nLECTURN_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nLECTURN_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "LECTURN_CLERK_PUBLISHABLE_KEY=pk_local\nLECTURN_CLERK_JWT_TEMPLATE=template_local\nLECTURN_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nLECTURN_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).LECTURN_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          LECTURN_CLERK_PUBLISHABLE_KEY: "pk_ci",
          LECTURN_CLERK_JWT_TEMPLATE: "template_ci",
          LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          LECTURN_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      LECTURN_CLERK_PUBLISHABLE_KEY: "pk_ci",
      LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      LECTURN_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      LECTURN_RELAY_URL: "https://ci.example.test",
      VITE_LECTURN_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_LECTURN_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          LECTURN_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          LECTURN_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          LECTURN_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      LECTURN_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      LECTURN_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      LECTURN_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          LECTURN_RELAY_URL: "https://relay.example.test",
          LECTURN_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          LECTURN_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          LECTURN_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      LECTURN_RELAY_URL: "https://relay.example.test",
      VITE_LECTURN_RELAY_URL: "https://relay.example.test",
      LECTURN_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      LECTURN_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      LECTURN_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("hosted web configuration", () => {
  const production = {
    VERCEL_ENV: "production",
    LECTURN_CLERK_PUBLISHABLE_KEY: "pk_live_example",
    LECTURN_CLERK_JWT_TEMPLATE: "production-template",
    LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
    LECTURN_RELAY_URL: "https://relay.example.test",
  };

  it.each(["LECTURN_CLERK_PUBLISHABLE_KEY", "LECTURN_CLERK_JWT_TEMPLATE", "LECTURN_RELAY_URL"])(
    "rejects a hosted deployment missing %s",
    (key) => {
      expect(() => assertHostedWebPublicConfig({ ...production, [key]: "  " })).toThrow(key);
    },
  );

  it("rejects the obsolete deployment configuration that hid login after rebranding", () => {
    expect(() =>
      assertHostedWebPublicConfig({
        VERCEL_ENV: "production",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_live_example",
        T3CODE_CLERK_JWT_TEMPLATE: "production-template",
        T3CODE_RELAY_URL: "https://relay.example.test",
      }),
    ).toThrow("Hosted web build requires Connect configuration");
  });

  it("allows canonical configuration projected into both web and mobile builds", () => {
    const env = loadRepoEnv({ baseEnv: production, repoRoot: makeTemporaryDirectory() });
    expect(() => assertHostedWebPublicConfig(env)).not.toThrow();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe(production.LECTURN_CLERK_PUBLISHABLE_KEY);
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBe(production.LECTURN_CLERK_JWT_TEMPLATE);
  });

  it("accepts supported Expo and Vite aliases without requiring duplicate canonical keys", () => {
    expect(() =>
      assertHostedWebPublicConfig({
        VERCEL_ENV: "production",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
        EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "production-template",
        VITE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
        VITE_LECTURN_RELAY_URL: "https://relay.example.test",
      }),
    ).not.toThrow();
  });

  it.each(["http://relay.example.test", "not-a-url", "https://user:secret@relay.example.test"])(
    "rejects an unusable hosted relay URL without exposing its value",
    (relayUrl) => {
      const build = () =>
        assertHostedWebPublicConfig({ ...production, LECTURN_RELAY_URL: relayUrl });
      expect(build).toThrow("valid HTTPS LECTURN_RELAY_URL");
      expect(build).not.toThrow(relayUrl);
    },
  );

  it("allows web-only deployments without the optional CLI OAuth client", () => {
    expect(() =>
      assertHostedWebPublicConfig({
        ...production,
        LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: undefined,
      }),
    ).not.toThrow();
  });

  it("preserves unconfigured offline builds even in production mode", () => {
    expect(() => assertHostedWebPublicConfig({ NODE_ENV: "production" })).not.toThrow();
    expect(() => assertHostedWebPublicConfig({ VERCEL_ENV: "development" })).not.toThrow();
  });
});

describe("production mobile configuration", () => {
  const eas = { EAS_BUILD: "true", APP_VARIANT: "production" };
  const expo = {
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
    EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "production-template",
    LECTURN_RELAY_URL: "https://relay.example.test",
  };

  it("blocks the deployed EAS configuration with an obsolete relay variable", () => {
    expect(() =>
      assertProductionMobilePublicConfig({
        ...eas,
        ...expo,
        LECTURN_RELAY_URL: undefined,
        T3CODE_RELAY_URL: "https://relay.example.test",
      }),
    ).toThrow("Production mobile build requires Connect configuration: LECTURN_RELAY_URL");
  });

  it.each([
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    "LECTURN_RELAY_URL",
  ])("rejects production EAS builds missing %s", (key) => {
    expect(() => assertProductionMobilePublicConfig({ ...eas, ...expo, [key]: "" })).toThrow();
  });

  it("accepts supported Expo authentication aliases without CLI OAuth configuration", () => {
    const env = loadRepoEnv({ baseEnv: { ...eas, ...expo }, repoRoot: makeTemporaryDirectory() });
    expect(() => assertProductionMobilePublicConfig(env)).not.toThrow();
    expect(env.LECTURN_RELAY_URL).toBe(expo.LECTURN_RELAY_URL);
  });

  it("accepts canonical authentication configuration for production EAS builds", () => {
    expect(() =>
      assertProductionMobilePublicConfig({
        ...eas,
        LECTURN_CLERK_PUBLISHABLE_KEY: expo.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
        LECTURN_CLERK_JWT_TEMPLATE: expo.EXPO_PUBLIC_CLERK_JWT_TEMPLATE,
        LECTURN_RELAY_URL: expo.LECTURN_RELAY_URL,
      }),
    ).not.toThrow();
  });

  it("rejects insecure relay configuration before building", () => {
    expect(() =>
      assertProductionMobilePublicConfig({
        ...eas,
        ...expo,
        LECTURN_RELAY_URL: "http://relay.example.test",
      }),
    ).toThrow("Production mobile build requires a valid HTTPS LECTURN_RELAY_URL");
  });

  it.each([
    { APP_VARIANT: "production" },
    { EAS_BUILD: "true", APP_VARIANT: "development" },
    { EAS_BUILD: "true", APP_VARIANT: "preview" },
  ])("preserves local configuration evaluation and direct-pairing development", (env) => {
    expect(() => assertProductionMobilePublicConfig(env)).not.toThrow();
  });
});
