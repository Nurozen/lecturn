import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

const ROCKET = AppId.make("com.example.rocket");

vi.mock("react-native", () => ({
  View: "div",
  Pressable: (props: { accessibilityLabel?: string; children: ReactNode }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/entities", () => ({
  useProject: () => ({ appBinding: { appId: ROCKET, workspaceRoot: "/work/hopper" } }),
}));
vi.mock("../../state/apps", () => ({
  useAppEmbedContext: () => ({
    appId: ROCKET,
    name: "RocketWright",
    iconDataUrl: null,
    refPrefixes: ["rw:"],
    openUrlTemplate: "rocketwright://open?root={workspaceRoot}&thread={threadId}",
    embedOrigins: [],
    live: null,
    state: "granted",
  }),
}));

import { AppClosedBanner } from "./AppClosedBanner";

describe("AppClosedBanner", () => {
  it("names the app on its open button", () => {
    const markup = renderToStaticMarkup(
      <AppClosedBanner
        thread={makeThreadShellFixture({
          environmentId: EnvironmentId.make("mac"),
          projectId: ProjectId.make("hopper"),
          id: ThreadId.make("t-1"),
        })}
      />,
    );
    expect(markup).toContain("RocketWright closed: live tools unavailable");
    expect(markup).toMatch(
      /<button aria-label="Open in RocketWright"><span[^>]*>Open in RocketWright<\/span>/,
    );
  });
});
