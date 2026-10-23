import type { EnvironmentId, ServerProvider } from "@lecturn/contracts";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, RotateCwIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  providerDetectionHint,
  providerDetectionLabel,
  shouldShowProviderDetection,
} from "./providerDetection";
import { GoldThreadSpinner } from "./ui/gold-thread-spinner";
import { Button } from "./ui/button";

export function ProviderDetectionRecovery({
  environmentId,
  provider,
  details,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  details?: string;
}) {
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const pending = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const ready =
    provider.discovery?.status === "ready" && provider.auth.status !== "unauthenticated";
  const detecting = provider.discovery?.status === "detecting" || (retrying && !ready);
  const retry = async () => {
    if (pending.current) return;
    pending.current = true;
    setRetrying(true);
    setRetryError(false);
    const attempt = async () => {
      const result = await refresh({ environmentId, input: { instanceId: provider.instanceId } });
      setRetryError(result._tag === "Failure");
    };
    return await attempt()
      .catch((_error: unknown) => {
        setRetryError(true);
      })
      .finally(() => {
        pending.current = false;
        setRetrying(false);
      });
  };
  return (
    <div className="flex items-start gap-3" role={detecting || ready ? "status" : "alert"}>
      {ready ? (
        <CheckCircle2Icon className="size-10 shrink-0 text-muted-foreground" />
      ) : detecting ? (
        <GoldThreadSpinner className="size-10" />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void retry()}
          aria-label="Retry provider detection"
          className="relative size-10 shrink-0"
        >
          <GoldThreadSpinner variant="idle" className="size-10" />
          <RotateCwIcon className="absolute size-4 text-muted-foreground" />
        </Button>
      )}
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="font-medium">
          {retrying && !ready ? "Retrying provider detection…" : providerDetectionLabel(provider)}
        </p>
        {ready ? (
          <p className="text-muted-foreground">
            The earlier attempt failed. Try sending your message again.
          </p>
        ) : !detecting ? (
          <>
            <p className="text-muted-foreground">{providerDetectionHint(provider)}</p>
            <div className="flex gap-3">
              <Button variant="link" size="xs-flush" onClick={() => void retry()}>
                Retry
              </Button>
              <Link
                className="self-center text-primary underline underline-offset-4"
                to="/settings/providers"
                search={{ environmentId, instanceId: provider.instanceId }}
              >
                Provider settings
              </Link>
            </div>
          </>
        ) : null}
        {retryError && !ready ? (
          <p className="text-warning">
            Detection could not be retried. Check the environment connection, then try again.
          </p>
        ) : null}
        {details ? (
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Show details</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">
              {details}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Lives above routes so settings and navigation remain available during discovery. */
export function ProviderDetectionProgress() {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // A retry or reconnect is still the same unresolved problem. Re-arm only
  // after recovery or disabling the provider.
  if (dismissed.size > 0) {
    const resolved = new Set(
      environments.flatMap((environment) =>
        (providersByEnvironment.get(environment.environmentId) ?? [])
          .filter((provider) => !provider.enabled || provider.discovery?.status === "ready")
          .map((provider) => JSON.stringify([environment.environmentId, provider.instanceId])),
      ),
    );
    const remaining = new Set([...dismissed].filter((key) => !resolved.has(key)));
    if (remaining.size !== dismissed.size) setDismissed(remaining);
  }
  const rows = environments.flatMap((environment) =>
    (providersByEnvironment.get(environment.environmentId) ?? [])
      .filter((provider) =>
        shouldShowProviderDetection(provider, environment.connection.phase === "connected"),
      )
      .map((provider) => ({
        environment,
        provider,
        key: JSON.stringify([environment.environmentId, provider.instanceId]),
      })),
  );
  // Every implicit executable shares one shell probe. Show that operation once.
  const shellEnvironments = new Set<EnvironmentId>();
  const visibleRows = rows
    .filter(({ environment, provider }) => {
      if (provider.discovery?.status !== "detecting" || provider.discovery.phase !== "shell")
        return true;
      if (shellEnvironments.has(environment.environmentId)) return false;
      shellEnvironments.add(environment.environmentId);
      return true;
    })
    .filter(({ key }) => !dismissed.has(key));
  if (visibleRows.length === 0) return null;
  return (
    <aside
      aria-label="Provider detection"
      className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+0.5rem)] right-4 z-40 flex max-h-[min(35dvh,28rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto sm:top-auto sm:bottom-4 sm:max-h-[min(50vh,28rem)]"
    >
      {visibleRows.map(({ environment, provider, key }) => (
        <div
          key={key}
          className="pointer-events-auto relative rounded-xl border border-border bg-popover/95 p-3 pr-10 shadow-lg"
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss provider notification"
            className="absolute top-1 right-1 size-9"
            onClick={() => setDismissed((previous) => new Set([...previous, key]))}
          >
            <XIcon className="size-4" />
          </Button>
          {environments.length > 1 ? (
            <p className="mb-1 text-xs text-muted-foreground">{environment.label}</p>
          ) : null}
          <ProviderDetectionRecovery
            environmentId={environment.environmentId}
            provider={provider}
          />
        </div>
      ))}
    </aside>
  );
}
