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

import { randomUUID } from "../../../lib/utils";
import { useProject, useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";

/** P8.1 rules in the setup sheet (plan 10b.6). Never rendered for the Lead. */
export function SquireRulesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly squire: Pick<Squire, "id" | "name" | "role">;
}) {
  const { environmentId, squire } = props;
  const rules = useEnvironmentQuery(
    squire.role === "lead"
      ? null
      : squireEnvironment.rules({ environmentId, input: { squireId: squire.id } }),
  );
  if (squire.role === "lead") return null;
  if (rules.data === null) {
    return rules.error !== null ? (
      <p className="text-xs text-muted-foreground">Rules could not be loaded.</p>
    ) : (
      <Spinner />
    );
  }
  if (rules.data.rules.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No rules yet. After you accept or undo an item, {squire.name} offers to always allow or
        always ask first for that kind of action.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {rules.data.rules.map((rule) => (
        <SquireRuleRow
          key={rule.id}
          environmentId={environmentId}
          squireName={squire.name}
          rule={rule}
        />
      ))}
    </ul>
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
  const disabled = rule.status === "disabled";
  const usage =
    rule.matchCount === 0
      ? "Never used"
      : `Used ${rule.matchCount === 1 ? "once" : `${rule.matchCount} times`}${
          rule.lastMatchedAt === null ? "" : `, last ${formatRelativeTimeLabel(rule.lastMatchedAt)}`
        }`;
  const remove = async () => {
    setRemoving(true);
    await removeRule({ environmentId, input: { requestId: randomUUID(), ruleId: rule.id } });
    setRemoving(false);
  };
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <p className={disabled ? "text-sm text-muted-foreground line-through" : "text-sm"}>
          {text}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant={rule.effect === "allow" ? "success" : "info"}>
            {rule.effect === "allow" ? "Always allow" : "Ask first"}
          </Badge>
          {disabled ? (
            <Badge variant="warning">Disabled: target left this Squire's scope</Badge>
          ) : null}
          <span>{usage}</span>
        </div>
      </div>
      <Button
        size="xs"
        variant="ghost-destructive"
        disabled={!canRemove || removing}
        onClick={() => void remove()}
      >
        Remove
      </Button>
    </li>
  );
}
