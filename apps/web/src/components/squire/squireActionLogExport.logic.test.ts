import type { SquireId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireActionLogFileName,
  squireActionLogPath,
  squireActionLogUrl,
} from "./squireActionLogExport.logic";

const id = "squire-1" as SquireId;

describe("action log export", () => {
  it("builds the route on the environment's origin, dropping any base path, query, or hash", () => {
    expect(squireActionLogUrl("https://host.example:3773/", id)).toBe(
      "https://host.example:3773/api/squire/squire-1/action-log",
    );
    expect(squireActionLogUrl("https://relay.example/env/abc?x=1#y", id)).toBe(
      "https://relay.example/api/squire/squire-1/action-log",
    );
  });

  it("encodes the Squire id as one path segment", () => {
    expect(squireActionLogPath("a/b c" as SquireId)).toBe("/api/squire/a%2Fb%20c/action-log");
  });

  it("names the file after the Squire, falling back to its id", () => {
    expect(squireActionLogFileName({ id, name: "Release Captain!" })).toBe(
      "squire-release-captain-log.ndjson",
    );
    expect(squireActionLogFileName({ id, name: "???" })).toBe("squire-squire-1-log.ndjson");
  });
});
