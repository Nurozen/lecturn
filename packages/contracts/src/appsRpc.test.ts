import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  APPS_RPC_SCOPES,
  APPS_WS_METHODS,
  AppsMintEmbedTokenInput,
  AppsRpcs,
  AppsSetThreadAppDataInput,
  AppsUpdateHostContextInput,
} from "./appsRpc.ts";
import {
  AuthAppHostScope,
  AuthEnvironmentScope,
  AuthGrantScope,
  AuthStandardClientScopes,
  authScopeRequiredResponse,
} from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const methods = Object.values(APPS_WS_METHODS);
const isGrantScope = Schema.is(AuthGrantScope);

describe("apps RPC surface", () => {
  it("mounts every apps method on the WebSocket group with a declared scope", () => {
    expect(AppsRpcs.map((rpc) => rpc._tag).sort()).toEqual([...methods].sort());
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method), method).toBe(true);
      expect(Object.values(WS_METHODS)).toContain(method);
      expect(APPS_RPC_SCOPES[method], method).toBeDefined();
    }
  });

  it("guards the four Lecturn-client mutations with access:write on the client too", () => {
    const guarded = methods.filter((method) => Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method));
    expect(guarded.sort()).toEqual(
      [
        APPS_WS_METHODS.appsDecidePairing,
        APPS_WS_METHODS.appsDelete,
        APPS_WS_METHODS.appsRevoke,
        APPS_WS_METHODS.appsSetRuntimeCeiling,
      ].sort(),
    );
    for (const method of guarded) {
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([APPS_RPC_SCOPES[method]]);
      expect(APPS_RPC_SCOPES[method]).toBe("access:write");
    }
  });

  it("keeps app-credential methods out of client guards, since only app subjects hold apps:host", () => {
    const hostMethods = methods.filter((method) => APPS_RPC_SCOPES[method] === AuthAppHostScope);
    expect(hostMethods).toContain(APPS_WS_METHODS.appsEnsureWorkspace);
    expect(hostMethods).toContain(APPS_WS_METHODS.appsMarkThreadsCopied);
    for (const method of hostMethods) {
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method), method).toBe(false);
    }
  });

  it("never lets pairing or standard grants carry apps:host", () => {
    expect(AuthEnvironmentScope.literals).toContain(AuthAppHostScope);
    expect(AuthGrantScope.literals).not.toContain(AuthAppHostScope);
    expect(AuthStandardClientScopes).not.toContain(AuthAppHostScope);
    expect(isGrantScope(AuthAppHostScope)).toBe(false);
    expect(authScopeRequiredResponse(AuthAppHostScope)).toEqual({
      requiredScope: AuthAppHostScope,
      requiredPermission: AuthAppHostScope,
    });
  });
});

describe("apps RPC inputs", () => {
  it("caps embed tokens at 15 minutes", () => {
    const is = Schema.is(AppsMintEmbedTokenInput);
    expect(is({ projectId: "p", ttlSeconds: 900 })).toBe(true);
    expect(is({ projectId: "p", threadId: "t", ttlSeconds: 60 })).toBe(true);
    expect(is({ projectId: "p", ttlSeconds: 901 })).toBe(false);
    expect(is({ projectId: "p", ttlSeconds: 0 })).toBe(false);
  });

  it("caps host context at 4 KB of UTF-8 for thread and project targets", () => {
    const is = Schema.is(AppsUpdateHostContextInput);
    expect(is({ target: { threadId: "t" }, text: "x".repeat(4096) })).toBe(true);
    expect(is({ target: { projectId: "p" }, text: "" })).toBe(true);
    expect(is({ target: { threadId: "t" }, text: "é".repeat(2049) })).toBe(false);
    expect(is({ target: {}, text: "x" })).toBe(false);
  });

  it("distinguishes leaving the subtitle unchanged from clearing it", () => {
    const decode = Schema.decodeUnknownSync(AppsSetThreadAppDataInput);
    expect(decode({ threadId: "t", appData: null })).toEqual({ threadId: "t", appData: null });
    expect(decode({ threadId: "t", appData: "x", subtitle: null })).toEqual({
      threadId: "t",
      appData: "x",
      subtitle: null,
    });
    expect(() => decode({ threadId: "t", appData: null, subtitle: "x".repeat(81) })).toThrow();
  });
});
