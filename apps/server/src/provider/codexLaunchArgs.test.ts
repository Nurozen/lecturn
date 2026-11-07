import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("preserves attached short config and profile arguments", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs('-cfeatures.example=true -pwork -cfoo="bar"'), [
      "-cfeatures.example=true",
      "-pwork",
      "-cfoo=bar",
    ]);
  });

  it("preserves selected profiles while dropping server transport and analytics flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        "--listen off --profile work -p other --profile=third -p=fourth --analytics-default-enabled",
      ),
      ["--profile", "work", "-p", "other", "--profile=third", "-p=fourth"],
    );
  });

  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
