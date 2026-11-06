import { useMemo } from "react";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { allowsThreadRouteControl, type ThreadRouteControls } from "./threadRouteControls";

export type NativeHeaderItem = Record<string, unknown>;

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
    /** iOS thread actions menu (decisions, fork) appended after the git items. */
    readonly threadActionsHeaderItem: NativeHeaderItem | null;
    /** Android in-flow fork action, appended after the git controls action. */
    readonly forkHeaderAction: AppBarAction | null;
    /** Lecturn: the thread route's controls allowlist; absent keeps every header control. */
    readonly controls?: ThreadRouteControls;
    /** Lecturn: Android's Squire Track and Stop tracking menu; iOS has them in the thread menu. */
    readonly squireTrackingMenu?: AppBarMenu | null;
  },
) {
  const allows = (control: Parameters<typeof allowsThreadRouteControl>[1]) =>
    allowsThreadRouteControl(props.controls, control);
  // The native iOS group (and its compact fallback) also carries terminal, files, and scripts.
  const gitHeaderShown = allows("git");
  const filesShown = allows("files");
  const terminalShown = allows("terminal");
  const mergeBackShown = allows("merge-back");
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  const { threadActionsHeaderItem } = props;
  const baseRightItems = native.options.unstable_headerRightItems as
    | (() => ReadonlyArray<NativeHeaderItem>)
    | undefined;
  const nativeOptions =
    baseRightItems === undefined
      ? native.options
      : !gitHeaderShown
        ? {
            ...native.options,
            unstable_headerRightItems: () =>
              threadActionsHeaderItem === null ? [] : [threadActionsHeaderItem],
          }
        : threadActionsHeaderItem !== null
          ? {
              ...native.options,
              unstable_headerRightItems: () => [...baseRightItems(), threadActionsHeaderItem],
            }
          : native.options;
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd && filesShown) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal && terminalShown) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    if (gitHeaderShown) {
      actions.push({
        accessibilityLabel: "Open git controls",
        icon: "point.topleft.down.curvedto.point.bottomright.up",
        onPress: props.onOpenGitInspector,
      });
    }
    if (onMergeBack && mergeBackShown) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: PullRequestGlyph.merged,
        onPress: onMergeBack,
      });
    }
    if (props.forkHeaderAction) actions.push(props.forkHeaderAction);
    return actions;
  }, [
    filesShown,
    terminalShown,
    mergeBackShown,
    gitHeaderShown,
    props.forkHeaderAction,
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
  ]);

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={nativeOptions}
        optionsVersion={[native.optionsVersion, threadActionsHeaderItem, gitHeaderShown]}
        menus={props.squireTrackingMenu ? [props.squireTrackingMenu] : undefined}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd && filesShown ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={layout.usesSplitView ? undefined : goBack}
        actions={androidHeaderActions}
        hideBottomBorder
      />
      {gitHeaderShown ? native.fallback : null}
    </>
  );
}
