import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import { openAppUrl, parseAppOpenUrl } from "./apps.ts";

const TEMPLATE = "rocketwright://open?workspace={workspaceRoot}&thread={threadId}";

describe("parseAppOpenUrl", () => {
  it("opens a URL in the scheme the app registered", () => {
    assert.deepStrictEqual(
      parseAppOpenUrl({
        url: "rocketwright://open?workspace=%2Fwork%2Fhopper&thread=t-1",
        openUrlTemplate: TEMPLATE,
      }),
      Option.some("rocketwright://open?workspace=%2Fwork%2Fhopper&thread=t-1"),
    );
    assert.isTrue(
      Option.isSome(
        parseAppOpenUrl({
          url: "http://127.0.0.1:4100/open?workspace=%2Fw",
          openUrlTemplate: "http://127.0.0.1:4100/open?workspace={workspaceRoot}",
        }),
      ),
    );
  });

  it("refuses a URL outside the template's scheme", () => {
    for (const url of [
      "file:///Applications/Calculator.app",
      "otherapp://open",
      "javascript:alert(1)",
      "not a url",
    ]) {
      assert.isTrue(Option.isNone(parseAppOpenUrl({ url, openUrlTemplate: TEMPLATE })), url);
    }
  });

  it("refuses schemes no app owns even when the template names them", () => {
    for (const [url, openUrlTemplate] of [
      ["file:///etc/passwd", "file:///{workspaceRoot}"],
      ["smb://host/share", "smb://host/{workspaceRoot}"],
      ["search-ms:query=x", "search-ms:query={ref}"],
      ["lecturn://threads/env/thread", "lecturn://threads/{threadId}"],
      ["{workspaceRoot}", "{workspaceRoot}"],
    ] as const) {
      assert.isTrue(Option.isNone(parseAppOpenUrl({ url, openUrlTemplate })), url);
    }
  });

  it("refuses credentials smuggled into the authority", () => {
    assert.isTrue(
      Option.isNone(
        parseAppOpenUrl({ url: "rocketwright://user:secret@open", openUrlTemplate: TEMPLATE }),
      ),
    );
  });
});

describe("openAppUrl", () => {
  const shellOpening = (opened: string[]) =>
    ElectronShell.ElectronShell.of({
      openExternal: () => Effect.succeed(false),
      openAppUrl: (url) => Effect.sync(() => (opened.push(url), true)),
      openSystemSettings: () => Effect.succeed(false),
      copyText: () => Effect.void,
    });

  it.effect("hands a matching URL to the shell", () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const result = yield* openAppUrl
        .handler({ url: "rocketwright://open?workspace=%2Fw", openUrlTemplate: TEMPLATE })
        .pipe(Effect.provideService(ElectronShell.ElectronShell, shellOpening(opened)));
      assert.isTrue(result);
      assert.deepStrictEqual(opened, ["rocketwright://open?workspace=%2Fw"]);
    }),
  );

  it.effect("never reaches the shell with a refused URL", () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const result = yield* openAppUrl
        .handler({ url: "file:///Applications/Calculator.app", openUrlTemplate: TEMPLATE })
        .pipe(Effect.provideService(ElectronShell.ElectronShell, shellOpening(opened)));
      assert.isFalse(result);
      assert.deepStrictEqual(opened, []);
    }),
  );

  it.effect("rejects a payload without the template", () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const exit = yield* openAppUrl
        .handler("rocketwright://open")
        .pipe(
          Effect.provideService(ElectronShell.ElectronShell, shellOpening(opened)),
          Effect.exit,
        );
      assert.isTrue(exit._tag === "Failure");
      assert.deepStrictEqual(opened, []);
    }),
  );
});
