import * as React from "react";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { loadCompiledMobileModule } from "../../lib/reactCompilerModule.test-support";
import * as WorkspaceStackProjection from "../../native/workspace-stack-projection";
import * as WorkspacePresentationContext from "./workspace-presentation-context";

type StackViewProps = {
  readonly state: { readonly key: string; readonly routes: readonly { readonly key: string }[] };
};

const renderedStates: StackViewProps["state"][] = [];
function NativeStackView(props: StackViewProps) {
  renderedStates.push(props.state);
  return null;
}

const { exports } = loadCompiledMobileModule({
  file: "src/features/layout/createWorkspaceStackNavigator.android.tsx",
  modules: {
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
    "react/compiler-runtime": ReactCompilerRuntime,
    "@react-navigation/native": {},
    "@react-navigation/native-stack": { NativeStackView },
    "../../components/ui/RoutedFormSheetContext": {
      RoutedFormSheetContext: React.createContext(false),
    },
    "../../native/workspace-stack-projection": WorkspaceStackProjection,
    "./workspace-presentation-context": WorkspacePresentationContext,
  },
  expose: ["WorkspaceStackView"],
});
const WorkspaceStackView = exports.WorkspaceStackView as React.ComponentType<
  Record<string, unknown>
>;

function renderRootStack(stateKey: string) {
  const home = { key: `Home-${stateKey}`, name: "Home" };
  const descriptor = { options: {}, render: () => null };
  renderedStates.length = 0;
  renderToStaticMarkup(
    <WorkspacePresentationContext.WorkspaceColumnsRendererContext value={() => <></>}>
      <WorkspaceStackView
        state={{ key: stateKey, index: 0, routes: [home], preloadedRoutes: [] }}
        descriptors={{ [home.key]: descriptor }}
        describe={() => descriptor}
      />
    </WorkspacePresentationContext.WorkspaceColumnsRendererContext>,
  );
  return renderedStates[0]!;
}

describe("Android workspace stack", () => {
  it("keeps the workspace screen when a keyless reset replaces the root state key", () => {
    const before = renderRootStack("stack-before");
    const after = renderRootStack("stack-after");
    expect(after.routes[0]!.key).toBe(before.routes[0]!.key);
  });
});
