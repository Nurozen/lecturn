import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { appReferenceLabelsFromRecords } from "@lecturn/shared/appReferences";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { AppRefChip } from "./AppRefChip";
import { AppRefChipStrip } from "./AppRefChipStrip";
import { appRefLabelsForSend, foldAppRefChips, useAppRefChipStore } from "./appRefChipStore";
import { __resetAppRefLabelsForTests } from "./appRefLabels";
import { AppReferencesContext } from "./AppReferencesContext";

const THREAD = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const TARGET = "env-1:thread-1";
const presentation = {
  projectRef: scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1")),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppRefChipStore.setState({ chipsByTarget: {} });
  __resetAppRefLabelsForTests();
  vi.unstubAllGlobals();
});

const renderStrip = (embedded = true) =>
  act(async () =>
    root.render(
      embedded ? (
        <EmbedPresentationContext value={presentation}>
          <AppRefChipStrip targetKey={TARGET} />
        </EmbedPresentationContext>
      ) : (
        <AppRefChipStrip targetKey={TARGET} />
      ),
    ),
  );
const insert = (ref: string, label = ref) =>
  act(async () => useAppRefChipStore.getState().add(TARGET, { ref, label }));
const chipLabels = () =>
  [...container.querySelectorAll("[data-app-ref]")].map((chip) => chip.textContent);

describe("AppRefChipStrip", () => {
  it("shows inserted mentions once each, and × removes one", async () => {
    await renderStrip();
    expect(container.querySelector('[data-testid="app-ref-chip-strip"]')).toBeNull();

    await insert("rw:c/fins");
    await insert("rw:c/nose");
    await insert("rw:c/fins");
    expect(chipLabels()).toEqual(["rw:c/nose", "rw:c/fins"]);

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove rw:c/nose"]');
    await act(async () => remove?.click());
    expect(chipLabels()).toEqual(["rw:c/fins"]);
  });

  it("is not part of full Lecturn's composer", async () => {
    await renderStrip(false);
    await insert("rw:c/fins");
    expect(container.querySelector("[data-app-ref]")).toBeNull();
  });

  it("sends the chips with the prompt, then clears them and gives the editor its text back", async () => {
    await renderStrip();
    await insert("rw:c/fins");
    const promptRef = { current: "Check the fins." };
    const sent: string[] = [];

    await act(async () => {
      const settle = foldAppRefChips(TARGET, promptRef);
      sent.push(promptRef.current);
      settle(true);
    });
    expect(sent).toEqual(["rw:c/fins\n\nCheck the fins."]);
    expect(promptRef.current).toBe("Check the fins.");
    expect(chipLabels()).toEqual([]);
  });

  it("keeps the chips when the send does not go out, and leaves a prompt the send consumed", async () => {
    await renderStrip();
    await insert("rw:c/fins");
    const promptRef = { current: "Hi" };

    await act(async () => foldAppRefChips(TARGET, promptRef)(false));
    expect(promptRef.current).toBe("Hi");
    expect(chipLabels()).toEqual(["rw:c/fins"]);

    await act(async () => {
      const settle = foldAppRefChips(TARGET, promptRef);
      promptRef.current = "";
      settle(true);
    });
    expect(promptRef.current).toBe("");
    expect(chipLabels()).toEqual([]);
  });

  it("leaves an answer to a pending question alone", () => {
    useAppRefChipStore.getState().add(TARGET, { ref: "rw:c/fins", label: "rw:c/fins" });
    const promptRef = { current: "yes" };
    const sent: string[] = [];
    const settle = foldAppRefChips(null, promptRef);
    sent.push(promptRef.current);
    settle(true);
    expect(sent).toEqual(["yes"]);
    expect(useAppRefChipStore.getState().chipsByTarget[TARGET]).toHaveLength(1);
  });

  it("stores the labels of the chips a sent message names, and its bubble shows them", async () => {
    await renderStrip();
    await insert("rw:c/fins", "Fins");
    await insert("rw:c/nose", "rw:c/nose");
    await insert("rw:c/tail", "Tail");
    const promptRef = { current: "Check these." };
    const context = await act(async () => {
      const settle = foldAppRefChips(TARGET, promptRef);
      // A chip whose reference the sent text does not name stores nothing.
      const sent = promptRef.current.replace(" rw:c/tail", "");
      const built = buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        appRefs: appRefLabelsForSend(THREAD, sent),
      });
      settle(true);
      return built;
    });
    expect(appReferenceLabelsFromRecords(context?.records ?? [])).toEqual([
      { ref: "rw:c/fins", label: "Fins" },
    ]);

    // Full Lecturn has no host to ask, so the label comes only from what the message stored.
    await act(async () =>
      root.render(
        <AppReferencesContext
          value={{ refPrefixes: ["rw:"], iconUrl: null, activate: null, labelScope: TARGET }}
        >
          <AppRefChip reference="rw:c/fins" />
          <AppRefChip reference="rw:c/nose" />
        </AppReferencesContext>,
      ),
    );
    expect(chipLabels()).toEqual(["Fins", "rw:c/nose"]);
  });
});
