// @effect-diagnostics nodeBuiltinImport:off - Verify the deployment compiler's concrete filesystem target.
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import { config } from "../vercel";

// Use the routing compiler shipped with @vercel/config, not a hand-written
// approximation of Vercel's filesystem-check rewrite semantics.
const requireConfigDependency = NodeModule.createRequire(import.meta.resolve("@vercel/config/v1"));
const { getTransformedRoutes } = requireConfigDependency("@vercel/routing-utils") as {
  getTransformedRoutes(config: unknown): {
    error: unknown;
    routes: Array<{ src?: string; dest?: string; check?: boolean }>;
  };
};

describe("preview authentication deployment routing", () => {
  it("resolves Clerk requests to a concrete function before the SPA fallback", () => {
    const compiled = getTransformedRoutes(config);
    expect(compiled.error).toBeNull();
    for (const path of ["/__clerk/v1/environment", "/__clerk/v1/client/sign_ins"]) {
      const route = compiled.routes.find((item) => item.src && new RegExp(item.src).test(path));
      expect(route?.dest).toBeDefined();
      const destination = new URL(
        path.replace(new RegExp(route!.src!), route!.dest!),
        "https://preview.vercel.app",
      );
      expect(destination.pathname).toBe("/api/clerk-proxy");
      expect(destination.searchParams.get("__lecturn_clerk_path")).toBe(
        path.slice("/__clerk/".length),
      );
      // A catch-all API file is not a concrete filesystem target: check:true
      // skips it and the following SPA fallback returns HTML instead of JSON.
      expect(NodeFs.existsSync(new URL(`..${destination.pathname}.ts`, import.meta.url))).toBe(
        true,
      );
    }
  });
});
