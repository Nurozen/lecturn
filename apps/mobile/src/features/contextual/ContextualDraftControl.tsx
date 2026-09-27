import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@lecturn/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { contextualEnvironment } from "../../state/contextual";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { useComposerDraft, updateComposerDraftSettings } from "../../state/use-composer-drafts";

export function ContextualDraftControl({
  environmentId,
  projectId,
  draftKey,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftKey: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.contextual === true;
  const settings = useEnvironmentQuery(
    supported
      ? contextualEnvironment.projectSettings({ environmentId, input: { projectId } })
      : null,
  );
  const draft = useComposerDraft(draftKey);
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const canOperate = access.data?.scopes?.includes(AuthOrchestrationOperateScope) === true;
  if (!supported) return null;
  return (
    <View className="min-h-11 flex-row items-center gap-2">
      <ThemedSwitch
        accessibilityLabel="Contextual for new thread"
        value={draft.contextual?.enabled ?? settings.data?.defaultEnabled ?? false}
        disabled={!canOperate || (!settings.data && !draft.contextual)}
        onValueChange={(enabled) =>
          updateComposerDraftSettings(draftKey, {
            contextual: {
              enabled,
              sourceIds: draft.contextual?.sourceIds ?? settings.data?.sourceIds ?? [],
            },
          })
        }
      />
      <Text className="text-foreground">Contextual</Text>
    </View>
  );
}
