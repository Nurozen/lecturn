import { useAuth } from "@clerk/react";
import {
  createTeamsClient,
  selectTeam,
  selectedTeam,
  subscribeTeamSelection,
} from "@lecturn/client-runtime/relay";
import type { RelayTeamOrganization } from "@lecturn/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { readToken } from "../../cloud/accountTokens";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";

export function useTeamClient() {
  const { userId } = useAuth();
  return useMemo(
    () =>
      createTeamsClient({
        relayUrl: resolveCloudPublicConfig().relayUrl ?? "",
        getToken: () => (userId ? readToken(userId) : Promise.resolve(null)),
      }),
    [userId],
  );
}
export function useSelectedTeam() {
  const { userId } = useAuth();
  return useSyncExternalStore(
    subscribeTeamSelection,
    () => selectedTeam(userId),
    () => null,
  );
}
export function TeamSelector() {
  const { userId, isSignedIn } = useAuth();
  const client = useTeamClient();
  const selected = useSelectedTeam();
  const [result, setResult] = useState<{
    userId: string;
    organizations: readonly RelayTeamOrganization[];
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    setError(false);
    if (isSignedIn && userId) {
      try {
        const saved = localStorage.getItem(`lecturn.team.${userId}`);
        if (saved) selectTeam(userId, saved);
      } catch {
        /* Session-only selection when storage is blocked. */
      }
    }
    if (isSignedIn && userId)
      void client.list().then(
        (value) => {
          if (disposed) return;
          setResult({ userId, organizations: value.organizations });
          if (
            selectedTeam(userId) &&
            !value.organizations.some((org) => org.organizationId === selectedTeam(userId))
          )
            selectTeam(userId, null);
        },
        () => {
          if (!disposed) setError(true);
        },
      );
    return () => {
      disposed = true;
    };
  }, [client, isSignedIn, userId]);
  if (!isSignedIn || !userId) return null;
  const organizations = result?.userId === userId ? result.organizations : [];
  const organization = organizations.find((org) => org.organizationId === selected);
  return (
    <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <label className="block text-sm font-medium">
        Connect account
        <select
          className="mt-2 block w-full rounded-md border bg-background p-2 text-foreground"
          value={selected ?? ""}
          onChange={(event) => {
            const id = event.target.value || null;
            selectTeam(userId, id);
            try {
              if (id) localStorage.setItem(`lecturn.team.${userId}`, id);
              else localStorage.removeItem(`lecturn.team.${userId}`);
            } catch {
              /* Session-only selection. */
            }
          }}
        >
          <option value="">Personal</option>
          {organizations.map((org) => (
            <option key={org.organizationId} value={org.organizationId}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {error
          ? "Could not load teams. Reopen this page to try again."
          : organization
            ? `${organization.hasAccess ? "Company Connect access is active." : organization.hasSeat ? "Your seat is assigned; company billing is not active." : "Ask your administrator to assign a seat."} New links use ${organization.name}.`
            : "New links use your personal Connect access."}{" "}
        Existing environments keep their current account.
      </p>
    </div>
  );
}
