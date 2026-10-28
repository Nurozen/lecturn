import { fetchRemoteEnvironmentDescriptor } from "@lecturn/client-runtime/environment";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import { __resetEmbedAuthForTests, setEmbedToken } from "./embedAuth";

const ORIGIN = "http://127.0.0.1:3773";

function installWindow(href: string) {
  const location = new URL(href);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history: { state: null, replaceState: () => undefined },
    },
  });
}

function mockFetch(body: unknown = {}) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json(body)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    request(index = 0) {
      const call = fetchMock.mock.calls[index];
      if (call === undefined) throw new Error(`No fetch call ${index}`);
      return new Request(call[0], call[1]);
    },
  };
}

const DESCRIPTOR = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

describe("embed HTTP layer", { concurrent: false }, () => {
  afterEach(() => {
    __resetEmbedAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("sends the embed bearer without cookies for the registration bootstrap", () => {
    installWindow(`${ORIGIN}/embed/environment-1/project-1#embedToken=embed-token`);
    const fetched = mockFetch(DESCRIPTOR);

    return Effect.gen(function* () {
      yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: ORIGIN });

      const request = fetched.request();
      expect(request.url).toBe(`${ORIGIN}/.well-known/lecturn/environment`);
      expect(request.credentials).toBe("omit");
      expect(request.headers.get("authorization")).toBe("Bearer embed-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  // lib/runtime.ts provides only the primary client to its runtime, so a RequestInit provided
  // beside it in the layer never reaches the request.
  it.effect(
    "omits cookies from the runtime client, which never sees the layer's RequestInit",
    () => {
      installWindow(`${ORIGIN}/embed/environment-1/project-1#embedToken=embed-token`);
      const fetched = mockFetch({ authenticated: true, auth: {} });

      return Effect.gen(function* () {
        const client = yield* PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient;
        yield* Effect.exit(client.auth.session({ headers: {} }));

        const request = fetched.request();
        expect(new URL(request.url).pathname).toBe("/api/auth/session");
        expect(request.credentials).toBe("omit");
        expect(request.headers.get("authorization")).toBe("Bearer embed-token");
      }).pipe(
        Effect.provide(
          PrimaryEnvironmentHttpClient.layer.pipe(
            Layer.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()),
          ),
        ),
      );
    },
  );

  it.effect("sends a refreshed token on the next request, as tracing exports do", () => {
    installWindow(`${ORIGIN}/embed/environment-1/project-1#embedToken=first`);
    const fetched = mockFetch();

    return Effect.gen(function* () {
      yield* HttpClient.post(`${ORIGIN}/api/observability/v1/traces`);
      setEmbedToken("second");
      yield* HttpClient.post(`${ORIGIN}/api/observability/v1/traces`);

      expect(fetched.request(0).headers.get("authorization")).toBe("Bearer first");
      expect(fetched.request(1).headers.get("authorization")).toBe("Bearer second");
      expect(fetched.request(1).credentials).toBe("omit");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("keeps cookie credentials for a same-origin page outside /embed", () => {
    installWindow(`${ORIGIN}/environment-1/thread-1#embedToken=ignored`);
    const fetched = mockFetch();

    return Effect.gen(function* () {
      yield* HttpClient.get(`${ORIGIN}/api/auth/session`);

      const request = fetched.request();
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });
});
