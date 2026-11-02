import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import { squireDistinctCompanion, type EnvironmentId, type SquireId } from "@lecturn/contracts";
import { useState } from "react";

import { environmentProjects } from "../../../state/projects";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { squireCapableAtom, squireEnvironment } from "../../../state/squires";
import {
  squireProviderOptions,
  squireSetupDraftForCreate,
  squireSetupDraftFromProposal,
  squireSetupDraftFromSquire,
  squireSetupRecordReady,
} from "./squireSetup.logic";
import {
  SquireSetupForm,
  SquireSetupFrame,
  SquireSetupPending,
  type SquireSetupFormProps,
} from "./SquireSetupSheet";
import { useSquireSetupTarget, type SquireSetupTarget } from "./squireSetupStore";

const targetKey = (target: SquireSetupTarget) =>
  target.kind === "edit"
    ? `edit:${target.environmentId}:${target.squireId}`
    : target.kind === "proposal"
      ? `proposal:${target.environmentId}:${target.cardId}`
      : `create:${target.environmentId}`;

/** Mounted once in AppShell; every entry point opens it through `openSquireSetup`. */
export function SquireSetupHost() {
  const target = useSquireSetupTarget();
  if (target === null) return null;
  return <SquireSetupGate key={targetKey(target)} target={target} />;
}

function SquireSetupGate(props: { readonly target: SquireSetupTarget }) {
  const capable = useAtomValue(squireCapableAtom(props.target.environmentId));
  if (!capable) return null;
  return props.target.kind === "edit" ? (
    <SquireEditSetup target={props.target} squireId={props.target.squireId} />
  ) : (
    <SquireNewSetup target={props.target} />
  );
}

/** Providers, their Squire support, and the environment's projects, read only while open. */
function useSetupContext(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const support = useEnvironmentQuery(
    squireEnvironment.providerSupport({ environmentId, input: {} }),
  );
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId)).map(
    (project) => ({ id: project.id, title: project.title }),
  );
  const providers = (config?.providers ?? []).filter((provider) => provider.enabled);
  // A failed or absent support query offers every provider; the server still refuses one.
  const options = squireProviderOptions(
    providers.map((provider) => ({
      instanceId: provider.instanceId,
      label: resolveProviderInstanceDisplayName(provider),
    })),
    support.data?.instances ?? null,
  );
  return { providers, options, projects };
}

function SquireNewSetup(props: {
  readonly target: Extract<SquireSetupTarget, { kind: "create" | "proposal" }>;
}) {
  const { target } = props;
  const { environmentId } = target;
  const context = useSetupContext(environmentId);
  const state = useAtomValue(squireEnvironment.state(environmentId));
  const fallback = { homeProjectId: null, providerInstanceId: null };
  const initialDraft =
    target.kind === "proposal"
      ? squireSetupDraftFromProposal(target.proposal, fallback)
      : {
          ...squireSetupDraftForCreate(fallback),
          companion: squireDistinctCompanion(
            state?.squires.map((entry) => entry.squire.companion) ?? [],
          ),
        };
  const form: SquireSetupFormProps = {
    target,
    environmentId,
    role: "squire",
    squire: null,
    entry: null,
    initialDraft,
    ...context,
  };
  return (
    <SquireSetupFrame
      title={target.kind === "proposal" ? "Squire from Lead proposal" : "New Squire"}
    >
      <SquireSetupForm {...form} />
    </SquireSetupFrame>
  );
}

function SquireEditSetup(props: {
  readonly target: Extract<SquireSetupTarget, { kind: "edit" }>;
  readonly squireId: SquireId;
}) {
  const { target, squireId } = props;
  const { environmentId } = target;
  const context = useSetupContext(environmentId);
  const entry = useAtomValue(squireEnvironment.entry(environmentId, squireId));
  // The snapshot leaves the brief out, so the full record is read only while this is open.
  const detail = useEnvironmentQuery(
    squireEnvironment.detail({ environmentId, input: { squireId } }),
  );
  const squire = detail.data?.squire ?? null;
  const name = squire?.name ?? entry?.squire.name ?? null;
  const title = name === null ? "Squire settings" : `${name} settings`;
  const ready = squireSetupRecordReady({
    squire,
    snapshotRevision: entry?.squire.revision ?? null,
    refetching: detail.isPending,
  });
  // Latched: a concurrent edit that bumps the revision after the form opens must not unmount
  // it and drop the user's changes (the form pins its own base record).
  const [opened, setOpened] = useState(false);
  if (ready && !opened) setOpened(true);
  if (squire === null || !(ready || opened)) {
    return (
      <SquireSetupFrame title={title}>
        <SquireSetupPending
          error={detail.error === null ? null : "This Squire could not be loaded."}
        />
      </SquireSetupFrame>
    );
  }
  return (
    <SquireSetupFrame title={title}>
      <SquireSetupForm
        target={target}
        environmentId={environmentId}
        role={squire.role}
        squire={squire}
        entry={entry}
        initialDraft={squireSetupDraftFromSquire(squire)}
        {...context}
      />
    </SquireSetupFrame>
  );
}
