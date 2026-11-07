import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { vi } from "vite-plus/test";

import * as ElectronDialog from "./ElectronDialog.ts";

const { showSaveDialogMock } = vi.hoisted(() => ({
  showSaveDialogMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showSaveDialog: showSaveDialogMock,
  },
}));

it.effect.each([false, true])("native save respects user choice (canceled=%s)", (canceled) =>
  Effect.gen(function* () {
    const owner = { id: 7 } as BrowserWindow;
    showSaveDialogMock.mockReset();
    showSaveDialogMock.mockResolvedValue({ canceled, filePath: "/chosen/decision.md" });
    const dialog = yield* ElectronDialog.ElectronDialog;
    const result = yield* dialog.saveFile({
      owner: Option.some(owner),
      defaultPath: "decisions.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    assert.deepEqual(result, canceled ? Option.none() : Option.some("/chosen/decision.md"));
    assert.deepEqual(showSaveDialogMock.mock.calls, [
      [
        owner,
        {
          title: "Export decisions",
          buttonLabel: "Save",
          defaultPath: "decisions.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        },
      ],
    ]);
  }).pipe(Effect.provide(ElectronDialog.layer)),
);
it.effect("native save failure is sanitized", () =>
  Effect.gen(function* () {
    showSaveDialogMock.mockRejectedValue(new Error("private sentinel"));
    const dialog = yield* ElectronDialog.ElectronDialog;
    const error = yield* Effect.flip(
      dialog.saveFile({ owner: Option.none(), defaultPath: "decisions.json", filters: [] }),
    );
    assert.strictEqual(error.message, "Could not open the Save dialog.");
    assert.isFalse("cause" in error);
  }).pipe(Effect.provide(ElectronDialog.layer)),
);
