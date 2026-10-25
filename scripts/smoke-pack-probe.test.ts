import { assert, it } from "@effect/vitest";

import { satisfiesEnginesRange } from "./smoke-pack-probe.ts";

const SERVER_ENGINES = "^22.16 || ^23.11 || >=24.10";

it("checks a runtime's Node version against the server engines range", () => {
  for (const version of ["22.16.0", "22.20.1", "23.11.0", "24.10.0", "24.21.0", "26.0.0"]) {
    assert.isTrue(satisfiesEnginesRange(version, SERVER_ENGINES), version);
  }
  for (const version of ["22.15.9", "23.10.0", "24.9.3", "20.19.0"]) {
    assert.isFalse(satisfiesEnginesRange(version, SERVER_ENGINES), version);
  }
});
