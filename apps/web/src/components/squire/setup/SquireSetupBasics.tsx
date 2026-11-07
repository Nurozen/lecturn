import type { ModelSelection, ProjectId, ServerProvider } from "@lecturn/contracts";

import { Input } from "../../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import type { SquireProviderOption, SquireSetupDraft } from "./squireSetup.logic";
import { SetupRow, SetupSection } from "./SquireSetupLayout";

export interface SetupFieldsProps {
  readonly draft: SquireSetupDraft;
  readonly update: (patch: Partial<SquireSetupDraft>) => void;
  readonly disabled: boolean;
}

export function SquireIdentitySection(
  props: SetupFieldsProps & {
    /** Null once created: the home project is fixed after create. */
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }> | null;
    readonly homeProjectTitle: string | null;
  },
) {
  const { draft, update, disabled, projects } = props;
  return (
    <SetupSection title="Name and home">
      <Input
        aria-label="Name"
        placeholder="Name this Squire"
        maxLength={80}
        value={draft.name}
        disabled={disabled}
        onChange={(event) => update({ name: event.target.value })}
      />
      <SetupRow label="Home project" description="Its own thread lives here.">
        {projects === null ? (
          <span className="text-sm text-muted-foreground">{props.homeProjectTitle ?? "-"}</span>
        ) : (
          <Select
            value={draft.homeProjectId ?? ""}
            disabled={disabled || projects.length === 0}
            onValueChange={(value) => {
              if (value) update({ homeProjectId: value as ProjectId });
            }}
          >
            <SelectTrigger aria-label="Home project" size="sm" className="w-48">
              <SelectValue>
                {projects.find((project) => project.id === draft.homeProjectId)?.title ??
                  "No project"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </SetupRow>
    </SetupSection>
  );
}

const SAME_AS_SQUIRE = "same";
const PROVIDER_DEFAULT = "default";
const modelKey = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

function modelOf(providers: ReadonlyArray<ServerProvider>, key: string): ModelSelection | null {
  for (const provider of providers) {
    const model = provider.models.find(
      (candidate) => modelKey({ instanceId: provider.instanceId, model: candidate.slug }) === key,
    );
    if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}

function modelLabel(providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return model?.name ?? selection.model;
}

export function SquireProviderSection(
  props: SetupFieldsProps & {
    readonly options: ReadonlyArray<SquireProviderOption>;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly noSupportedProvider: boolean;
  },
) {
  const { draft, update, disabled, options, providers } = props;
  const selected = options.find((option) => option.instanceId === draft.providerInstanceId);
  const provider = providers.find((candidate) => candidate.instanceId === draft.providerInstanceId);
  const summaryProviders = providers.filter((candidate) => candidate.models.length > 0);
  return (
    <SetupSection
      title="Provider"
      description={
        props.noSupportedProvider
          ? "No supported provider. A Squire needs a provider that can isolate its tools."
          : undefined
      }
    >
      <SetupRow label="Runs on">
        <Select
          value={draft.providerInstanceId ?? ""}
          disabled={disabled || options.length === 0}
          onValueChange={(value) => {
            const option = options.find((candidate) => candidate.instanceId === value);
            if (option === undefined || option.supported === false) return;
            update({ providerInstanceId: option.instanceId, modelSelection: null });
          }}
        >
          <SelectTrigger aria-label="Provider" size="sm" className="w-48">
            <SelectValue>{selected?.label ?? "Choose a provider"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {options.map((option) => (
              <SelectItem
                key={option.instanceId}
                value={option.instanceId}
                disabled={option.supported === false}
              >
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  {option.supported === false ? (
                    <span className="text-xs text-muted-foreground">
                      {option.reason ?? "Cannot run a Squire"}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SetupRow>
      {provider === undefined || provider.models.length === 0 ? null : (
        <SetupRow label="Model">
          <Select
            value={
              draft.modelSelection === null ? PROVIDER_DEFAULT : modelKey(draft.modelSelection)
            }
            disabled={disabled}
            onValueChange={(value) => {
              if (value === PROVIDER_DEFAULT) return;
              const model = typeof value === "string" ? modelOf([provider], value) : null;
              if (model !== null) update({ modelSelection: model });
            }}
          >
            <SelectTrigger aria-label="Model" size="sm" className="w-48">
              <SelectValue>
                {draft.modelSelection === null
                  ? "Provider default"
                  : modelLabel(providers, draft.modelSelection)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {draft.modelSelection === null ? (
                <SelectItem value={PROVIDER_DEFAULT}>Provider default</SelectItem>
              ) : null}
              {provider.models.map((model) => (
                <SelectItem
                  key={model.slug}
                  value={modelKey({ instanceId: provider.instanceId, model: model.slug })}
                >
                  {model.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SetupRow>
      )}
      <SetupRow label="Summaries paid by" description="The model that writes turn summaries.">
        <Select
          value={
            draft.summaryModelSelection === null
              ? SAME_AS_SQUIRE
              : modelKey(draft.summaryModelSelection)
          }
          disabled={disabled}
          onValueChange={(value) => {
            if (value === SAME_AS_SQUIRE) update({ summaryModelSelection: null });
            else if (typeof value === "string") {
              const model = modelOf(summaryProviders, value);
              if (model !== null) update({ summaryModelSelection: model });
            }
          }}
        >
          <SelectTrigger aria-label="Summary model" size="sm" className="w-48">
            <SelectValue>
              {draft.summaryModelSelection === null
                ? "Same as Squire"
                : modelLabel(providers, draft.summaryModelSelection)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={SAME_AS_SQUIRE}>Same as Squire</SelectItem>
            {summaryProviders.map((candidate) => (
              <SelectGroup key={candidate.instanceId}>
                <SelectGroupLabel>
                  {options.find((option) => option.instanceId === candidate.instanceId)?.label ??
                    candidate.instanceId}
                </SelectGroupLabel>
                {candidate.models.map((model) => (
                  <SelectItem
                    key={model.slug}
                    value={modelKey({ instanceId: candidate.instanceId, model: model.slug })}
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectPopup>
        </Select>
      </SetupRow>
    </SetupSection>
  );
}

export function SquireBriefSection(props: SetupFieldsProps) {
  const { draft, update, disabled } = props;
  return (
    <SetupSection title="Brief" description="What it watches for and how it should help.">
      <Textarea
        aria-label="Brief"
        rows={5}
        maxLength={4000}
        placeholder="What should it watch for, and when should it speak up?"
        value={draft.brief}
        disabled={disabled}
        onChange={(event) => update({ brief: event.target.value })}
      />
    </SetupSection>
  );
}
