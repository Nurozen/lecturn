import { GlassCard } from "../../../components/GlassCard";
import { isStaveProject } from "@lecturn/client-runtime/state/projectGit";
import { sanitizeFeatureBranchName } from "@lecturn/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/ui/AndroidScreenHeader";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly repoKey?: string;
}>;

const SECTION_TITLE_CLASS_NAME =
  "android:text-foreground android:text-base android:font-lecturn-medium ios:text-foreground-secondary ios:text-2xs ios:font-lecturn-bold ios:tracking-[1px] ios:uppercase";

const INPUT_CLASS_NAME = "android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]";

/** Android uses flat Material cards; iOS keeps Lecturn's glass cards. */
function BranchSheetCard(props: { readonly children: ReactNode }) {
  if (Platform.OS === "android") {
    return <View className="gap-3 rounded-[20px] bg-card p-4">{props.children}</View>;
  }
  return <GlassCard className="gap-2 px-4 py-4">{props.children}</GlassCard>;
}

export function GitBranchesSheet(props: GitBranchesSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadGitCwd, selectedThreadWorktreePath, selectedThreadGitRepository } =
    useSelectedThreadWorktree(props.route.params.repoKey);
  const gitState = useSelectedThreadGitState(props.route.params.repoKey);
  const gitActions = useSelectedThreadGitActions(props.route.params.repoKey);
  const { canChangeThreadBranch } = gitActions;
  // Stave threads always run in the space root, so there is no worktree to
  // create or move to; the sheet only offers branch switching there.
  const worktreesSupported = !isStaveProject(selectedThreadProject);

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadGitCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadGitCwd },
        })
      : null,
  );

  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentWorktreePath = selectedThreadWorktreePath;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy =
    gitState.gitOperationLabel !== null ||
    selectedThreadGitRepository?.mode === "reference" ||
    selectedThreadGitCwd === null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState(
    currentBranchLabel === "Detached HEAD" ? "main" : currentBranchLabel,
  );
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title={worktreesSupported ? "Branches & worktrees" : "Branches"}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          {props.route.params.repoKey ? (
            <Text className="text-sm font-lecturn-bold android:px-4 android:pt-2">
              {selectedThreadGitRepository?.repoName ?? "Repository unavailable"}
            </Text>
          ) : null}
          <BranchSheetCard>
            <Text className={SECTION_TITLE_CLASS_NAME}>New branch</Text>
            <TextInput
              value={newBranchName}
              onChangeText={setNewBranchName}
              placeholder="feature/mobile-polish"
              accessibilityLabel="New branch name"
              className={INPUT_CLASS_NAME}
            />
            <SheetActionButton
              icon="plus"
              label="Create & checkout"
              tone="primary"
              disabled={!canChangeThreadBranch || busy || newBranchName.trim().length === 0}
              onPress={() => {
                const branch = sanitizeFeatureBranchName(newBranchName.trim());
                if (branch.length === 0) return;
                void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
                  if (result === null) return;
                  setNewBranchName("");
                  navigation.goBack();
                });
              }}
            />
          </BranchSheetCard>

          {worktreesSupported ? (
            <BranchSheetCard>
              <Text className={SECTION_TITLE_CLASS_NAME}>New worktree</Text>
              {Platform.OS === "android" ? (
                <Text className="text-foreground-secondary text-sm">Base branch</Text>
              ) : null}
              <TextInput
                value={worktreeBaseBranch}
                onChangeText={setWorktreeBaseBranch}
                placeholder="main"
                accessibilityLabel="Worktree base branch"
                className={INPUT_CLASS_NAME}
              />
              {Platform.OS === "android" ? (
                <Text className="text-foreground-secondary text-sm">New branch</Text>
              ) : null}
              <TextInput
                value={worktreeBranchName}
                onChangeText={setWorktreeBranchName}
                placeholder="feature/mobile-thread"
                accessibilityLabel="Worktree branch name"
                className={INPUT_CLASS_NAME}
              />
              <SheetActionButton
                icon="square.split.2x1"
                label="Create worktree"
                tone="primary"
                disabled={
                  !canChangeThreadBranch ||
                  busy ||
                  worktreeBaseBranch.trim().length === 0 ||
                  worktreeBranchName.trim().length === 0
                }
                onPress={() => {
                  const baseBranch = worktreeBaseBranch.trim();
                  const newBranch = worktreeBranchName.trim();
                  if (baseBranch.length === 0 || newBranch.length === 0) return;
                  void gitActions
                    .onCreateSelectedThreadWorktree({ baseBranch, newBranch })
                    .then((result) => {
                      if (result === null) return;
                      setWorktreeBranchName("");
                      navigation.goBack();
                    });
                }}
              />
            </BranchSheetCard>
          ) : null}

          <View className="gap-2">
            <Text className="text-foreground-secondary android:px-4 android:pb-1 android:pt-3 android:text-sm android:font-lecturn-medium ios:text-2xs ios:font-lecturn-bold ios:tracking-[1px] ios:uppercase">
              Existing branches
            </Text>
            {branchesLoading ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                Loading branches...
              </Text>
            ) : null}
            {!branchesLoading && availableBranches.length === 0 ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                No local branches found.
              </Text>
            ) : null}
            {availableBranches.map((branch) => {
              const disabled = disabledExistingBranches.has(branch.name);
              const subtitle = branch.worktreePath
                ? branch.worktreePath === currentWorktreePath
                  ? "Checked out in this thread"
                  : "Checked out in another worktree"
                : branch.isDefault
                  ? "Default branch"
                  : "Local branch";

              return (
                <Pressable
                  key={branch.name}
                  className={cn(
                    "gap-1 px-4 py-3 disabled:opacity-[0.45] android:rounded-[20px] android:active:bg-subtle ios:rounded-[18px] ios:border",
                    branch.current
                      ? "android:bg-secondary ios:border-subtle-strong"
                      : "android:bg-card ios:border-border",
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ selected: branch.current, disabled: busy || disabled }}
                  disabled={!canChangeThreadBranch || busy || disabled}
                  onPress={() => {
                    void gitActions.onCheckoutSelectedThreadBranch(branch.name).then((result) => {
                      if (result === null) return;
                      navigation.goBack();
                    });
                  }}
                >
                  {Platform.OS !== "android" ? (
                    <View className="absolute inset-0 rounded-[18px] bg-glass-surface" />
                  ) : null}
                  <Text className="text-foreground text-base android:font-lecturn-medium ios:font-lecturn-bold">
                    {branch.name}
                  </Text>
                  <Text className="text-foreground-secondary text-xs font-medium">{subtitle}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
