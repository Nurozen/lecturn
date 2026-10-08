import type { ContextualSource, ContextualSourcePolicy } from "@lecturn/contracts";

export function updateSourceSelection(
  policy: ContextualSourcePolicy,
  source: ContextualSource,
  selected: boolean,
): ContextualSourcePolicy {
  if (selected && (source.conversationType === "unknown" || !source.available)) return policy;
  const ids = new Set(policy.allowedSourceIds);
  if (selected) ids.add(source.id);
  else ids.delete(source.id);
  if (ids.size > 256) return policy;
  return {
    ...policy,
    allowedSourceIds: [...ids],
    allowDirectMessages:
      policy.allowDirectMessages || (selected && source.conversationType === "dm"),
    allowGroupDirectMessages:
      policy.allowGroupDirectMessages || (selected && source.conversationType === "group-dm"),
    unknownConversationPolicy: "exclude",
    draftsPolicy: "exclude",
  };
}
