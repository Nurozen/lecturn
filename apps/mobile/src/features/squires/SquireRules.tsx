import { useAtomValue } from "@effect/atom-react";
import { squireRuleText } from "@lecturn/client-runtime/state/squire";
import {
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type Squire,
  type SquireRule,
} from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";

/** The way out of "Always allow this": each saved rule with Remove. Never shown for the Lead. */
export function SquireRules(props: {
  readonly environmentId: EnvironmentId;
  readonly squire: Pick<Squire, "id" | "name">;
}) {
  const { environmentId, squire } = props;
  const rules = useEnvironmentQuery(
    squireEnvironment.rules({ environmentId, input: { squireId: squire.id } }),
  );
  // Nothing to remove until the first rule is saved; the offer itself explains rules.
  if (rules.data === null ? rules.error === null : rules.data.rules.length === 0) return null;
  return (
    <View className="gap-2" accessibilityLabel="Rules">
      <Text
        accessibilityRole="header"
        className="px-1 font-lecturn-bold text-2xs uppercase tracking-[1.1px] text-foreground-muted"
      >
        Rules
      </Text>
      {rules.data === null ? (
        <Text className="px-1 font-sans text-sm text-foreground-muted">
          Rules could not be loaded.
        </Text>
      ) : (
        rules.data.rules.map((rule) => (
          <SquireRuleRow
            key={rule.id}
            environmentId={environmentId}
            squireName={squire.name}
            rule={rule}
          />
        ))
      )}
    </View>
  );
}

function SquireRuleRow(props: {
  readonly environmentId: EnvironmentId;
  readonly squireName: string;
  readonly rule: SquireRule;
}) {
  const { environmentId, rule } = props;
  const shell = useQuietThreadShell(
    rule.targetKind === "thread" ? { environmentId, threadId: ThreadId.make(rule.targetId) } : null,
  );
  const project = useProject(
    rule.targetKind === "project"
      ? { environmentId, projectId: ProjectId.make(rule.targetId) }
      : null,
  );
  const canRemove = useAtomValue(squireEnvironment.ruleRemove.permissionAtom(environmentId));
  const removeRule = useAtomCommand(squireEnvironment.ruleRemove);
  const [removing, setRemoving] = useState(false);
  const targetName = shell?.title ?? project?.title ?? rule.targetId;
  const text = squireRuleText(rule, { squireName: props.squireName, targetName });
  const remove = async () => {
    setRemoving(true);
    await removeRule({ environmentId, input: { requestId: uuidv4(), ruleId: rule.id } });
    setRemoving(false);
  };
  return (
    <GlassCard radius={20} className="gap-2 px-4 py-3">
      <Text
        className={
          rule.status === "disabled"
            ? "font-sans text-sm text-foreground-muted line-through"
            : "font-sans text-sm text-foreground"
        }
      >
        {text}
      </Text>
      <Text className="font-sans text-xs text-foreground-muted">
        {rule.effect === "allow" ? "Always allow" : "Ask first"}
        {rule.status === "disabled" ? " · Disabled: target left this Squire's scope" : ""}
      </Text>
      {canRemove ? (
        <View className="flex-row">
          <RequestActionButton
            label="Remove"
            tone="secondary"
            disabled={removing}
            onPress={() => void remove()}
          />
        </View>
      ) : null}
    </GlassCard>
  );
}
