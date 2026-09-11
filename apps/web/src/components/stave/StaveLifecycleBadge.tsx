import type { StaveProjectNotice } from "@lecturn/contracts";
import { Badge } from "../ui/badge";
import { lifecycleNoticeLabel } from "./staveLifecycle.logic";

export function StaveLifecycleBadge({
  notices,
}: {
  notices: readonly (StaveProjectNotice | null | undefined)[];
}) {
  const labels = [...new Set(notices.map(lifecycleNoticeLabel).filter((value) => value !== null))];
  if (labels.length === 0) return null;
  return (
    <Badge
      variant="warning"
      title={notices
        .map((notice) => notice?.message)
        .filter(Boolean)
        .join("\n")}
    >
      {labels.join(" · ")}
    </Badge>
  );
}
