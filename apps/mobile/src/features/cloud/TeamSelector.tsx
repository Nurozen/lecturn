import * as SecureStore from "expo-secure-store";
import { useAuth } from "@clerk/expo";
import {
  createTeamsClient,
  selectTeam,
  selectedTeam,
  subscribeTeamSelection,
} from "@lecturn/client-runtime/relay";
import type { RelayTeamOrganization } from "@lecturn/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

/** Native companion: account selection and access status, without purchase links. */
export function TeamSelector() {
  const { userId, isSignedIn, getToken } = useAuth();
  const selected = useSyncExternalStore(
    subscribeTeamSelection,
    () => selectedTeam(userId),
    () => null,
  );
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
        const saved = SecureStore.getItem(`lecturn.team.${userId}`);
        if (saved) selectTeam(userId, saved);
      } catch {
        /* Session-only selection when storage is unavailable. */
      }
    }
    if (isSignedIn && userId)
      void createTeamsClient({
        relayUrl: resolveCloudPublicConfig().relay.url ?? "",
        getToken: () => getToken(resolveRelayClerkTokenOptions()),
      })
        .list()
        .then(
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
  }, [getToken, isSignedIn, userId]);
  if (!isSignedIn || !userId) return null;
  const organizations = result?.userId === userId ? result.organizations : [];
  const organization = organizations.find((org) => org.organizationId === selected);
  return (
    <View className="gap-2 px-2 py-2">
      <Text className="text-sm font-medium text-foreground">Connect account</Text>
      {[
        { id: null, name: "Personal" },
        ...organizations.map((org) => ({ id: org.organizationId, name: org.name })),
      ].map((option) => (
        <Pressable
          key={option.id ?? "personal"}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === option.id }}
          className="min-h-11 justify-center rounded-lg border border-border px-3 py-2"
          onPress={() => {
            selectTeam(userId, option.id);
            void (
              option.id
                ? SecureStore.setItemAsync(`lecturn.team.${userId}`, option.id)
                : SecureStore.deleteItemAsync(`lecturn.team.${userId}`)
            ).catch(() => {});
          }}
        >
          <Text className="text-sm text-foreground">
            {selected === option.id ? "✓ " : ""}
            {option.name}
          </Text>
        </Pressable>
      ))}
      <Text className="text-sm text-foreground-muted">
        {error
          ? "Could not check team access. Reopen Settings to try again."
          : organization
            ? organization.hasAccess
              ? `Connect provided by ${organization.name}.`
              : "Company Connect access is not active. Contact your administrator."
            : "Using your personal Connect account."}
      </Text>
      {organization && (
        <Text className="text-sm text-foreground-muted">
          {organization.policy.allowedProviders
            ? `Managed by ${organization.name}: ${organization.policy.allowedProviders.join(", ")}.`
            : `Managed by ${organization.name}: all providers allowed.`}{" "}
          Agent activity {organization.policy.publishAgentActivity ? "allowed" : "disabled"}. Your
          environments remain private.
        </Text>
      )}
    </View>
  );
}
