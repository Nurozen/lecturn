import { accountTintColor } from "@lecturn/shared/accountTint";
import { useAtomValue } from "@effect/atom-react";

import { accountMarkByEnvironmentIdAtom } from "../../cloud/connectAccounts";
import { connectMultiAccount } from "../../cloud/publicConfig";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Names the Connect account that owns an environment. Renders nothing unless
 * two or more accounts are known and the environment is a relay environment
 * with an owner, so a single-account client looks as it always did.
 */
export function AccountMark(props: {
  readonly environmentId: string;
  readonly className?: string;
}) {
  return connectMultiAccount ? <KnownAccountMark {...props} /> : null;
}

function KnownAccountMark({
  environmentId,
  className,
}: {
  readonly environmentId: string;
  readonly className?: string;
}) {
  const mark = useAtomValue(accountMarkByEnvironmentIdAtom).get(environmentId);
  if (mark === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            style={{ borderInlineStart: `3px solid ${accountTintColor(mark.preset)}` }}
            role="img"
            aria-label={`Account ${mark.email}`}
            className={cn(
              "max-w-16 shrink-0 truncate rounded-sm bg-muted/60 px-1 text-[0.625rem] text-muted-foreground leading-4",
              className,
            )}
          />
        }
      >
        {mark.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{mark.email}</TooltipPopup>
    </Tooltip>
  );
}
