import { expect, it } from "vite-plus/test";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import { gatewayHttpResponse, mutableGatewayBindingResponse } from "./ManagedGatewayBinding.ts";

it("allows response middleware headers without mutating the origin response", async () => {
  // @effect-diagnostics-next-line globalFetch:off -- native immutable headers reproduce the platform adapter failure.
  const upstream = await globalThis.fetch("data:text/plain,origin-stream");
  expect(() => upstream.headers.set("x-trace-id", "trace")).toThrow();
  const wrapped = HttpServerResponse.setHeader(
    gatewayHttpResponse(upstream),
    "x-trace-id",
    "trace",
  );
  const result = HttpServerResponse.toWeb(wrapped);
  expect(result.headers.get("x-trace-id")).toBe("trace");
  expect(upstream.headers.get("x-trace-id")).toBeNull();
  expect(await result.text()).toBe("origin-stream");
});

it("normalizes immutable raw responses returned by a namespace binding before tracing", async () => {
  // @effect-diagnostics-next-line globalFetch:off -- native immutable headers reproduce the platform adapter failure.
  const upstream = await globalThis.fetch("data:text/plain,binding-stream");
  const bindingResponse = HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: 200 }),
    HttpBody.raw(upstream),
  );
  const wrapped = HttpServerResponse.setHeader(
    mutableGatewayBindingResponse(bindingResponse),
    "x-trace-id",
    "trace",
  );
  const result = HttpServerResponse.toWeb(wrapped);
  expect(result.headers.get("x-trace-id")).toBe("trace");
  expect(upstream.headers.get("x-trace-id")).toBeNull();
  expect(await result.text()).toBe("binding-stream");
});
