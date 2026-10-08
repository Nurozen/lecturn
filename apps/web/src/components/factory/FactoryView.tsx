import { useState, type FormEvent } from "react";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  FactoryIcon,
  FileSearchIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  PlusIcon,
  RadioIcon,
  ShieldCheckIcon,
  SquareIcon,
} from "lucide-react";
import { FACTORY_STAGES } from "@lecturn/client-runtime/providerFactory";

import { Button } from "../ui/button";
import type { FactoryOption, FactoryRun, FactoryViewProps } from "./FactoryView.types";
import "./factory.css";

function Choice({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<FactoryOption>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="factory-field" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          Select {label.toLowerCase()}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {options.find((option) => option.id === value)?.description ? (
        <small>{options.find((option) => option.id === value)?.description}</small>
      ) : null}
    </label>
  );
}

function AssemblyLine({ phase }: { phase: string | null }) {
  return (
    <section className="factory-assembly" aria-label="Factory workflow">
      <div className="factory-section-label">
        <span>The assembly line</span>
        <span>{phase ? "Agent-reported stage" : "One outcome. Six steps."}</span>
      </div>
      <ol className="factory-stages">
        {FACTORY_STAGES.map((stage, index) => (
          <li
            key={stage.id}
            data-active={phase === stage.id}
            aria-current={phase === stage.id ? "step" : undefined}
          >
            <div className="factory-stage-node">
              <span>{String(index + 1).padStart(2, "0")}</span>
            </div>
            <strong>{stage.label}</strong>
            <p>{stage.description}</p>
          </li>
        ))}
      </ol>
      {phase ? (
        <p className="factory-stage-note">
          Stage reported by the agent. Validation and review evidence appear below.
        </p>
      ) : null}
    </section>
  );
}

function LaunchForm(props: FactoryViewProps) {
  const { form, onFormChange } = props;
  const source = props.sources.find((item) => item.id === form.sourceId);
  const launchDisabled =
    props.launchPending || props.launchDisabledReason !== null || props.recovery !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!launchDisabled) props.onLaunch();
  };
  return (
    <form className="factory-launch" onSubmit={submit}>
      <div className="factory-launch-heading">
        <div>
          <span className="factory-eyebrow">Configure a run</span>
          <h2>What shipped upstream?</h2>
        </div>
        <span className="factory-edition">Integration update / 01</span>
      </div>
      <fieldset className="factory-sources" disabled={props.launchPending}>
        <legend>Release source</legend>
        <div className="factory-source-options">
          {props.sources.map((item) => (
            <label
              key={item.id}
              className="factory-source"
              data-selected={item.id === form.sourceId}
            >
              <input
                type="radio"
                name="factory-source"
                value={item.id}
                checked={item.id === form.sourceId}
                onChange={() => onFormChange({ sourceId: item.id })}
              />
              <span className="factory-source-mark" aria-hidden="true">
                {item.id === form.sourceId ? <CheckIcon /> : <FileSearchIcon />}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </label>
          ))}
        </div>
        {source ? (
          <a className="factory-source-link" href={source.url} target="_blank" rel="noreferrer">
            Official release notes <ArrowUpRightIcon aria-hidden="true" />
          </a>
        ) : null}
      </fieldset>
      <div className="factory-form-grid">
        <Choice
          id="factory-project"
          label="Project"
          value={form.projectId}
          options={props.projects}
          disabled={props.launchPending}
          onChange={(projectId) => onFormChange({ projectId })}
        />
        <label className="factory-field" htmlFor="factory-base-branch">
          <span>Base branch</span>
          <input
            id="factory-base-branch"
            value={form.baseBranch}
            placeholder="origin/main"
            disabled={props.launchPending}
            onChange={(event) => onFormChange({ baseBranch: event.target.value })}
          />
          <small>A new worktree keeps the update isolated.</small>
        </label>
        <Choice
          id="factory-executor"
          label="Execution provider"
          value={form.executorId}
          options={props.executors}
          disabled={props.launchPending}
          onChange={(executorId) => onFormChange({ executorId })}
        />
        <Choice
          id="factory-model"
          label="Model"
          value={form.modelId}
          options={props.models}
          disabled={props.launchPending}
          onChange={(modelId) => onFormChange({ modelId })}
        />
      </div>
      <label className="factory-field factory-direction" htmlFor="factory-constraints">
        <span>
          Direction <em>Optional</em>
        </span>
        <textarea
          id="factory-constraints"
          value={form.constraints}
          disabled={props.launchPending}
          rows={2}
          placeholder="Focus on stable releases. Preserve support for the current CLI version."
          onChange={(event) => onFormChange({ constraints: event.target.value })}
        />
      </label>
      <div className="factory-permission">
        <ShieldCheckIcon aria-hidden="true" />
        <label htmlFor="factory-permission">
          <strong>Execution permissions</strong>
          <span>
            {form.runtimeMode === "full-access"
              ? "Autonomous execution with full access. Existing provider controls still apply."
              : "The agent requests approval when required by the provider."}
          </span>
        </label>
        <select
          id="factory-permission"
          value={form.runtimeMode}
          disabled={props.launchPending}
          onChange={(event) =>
            onFormChange({
              runtimeMode:
                event.target.value === "full-access" ? "full-access" : "approval-required",
            })
          }
        >
          <option value="approval-required">Require approvals</option>
          <option value="full-access">Full access</option>
        </select>
      </div>
      {props.launchDisabledReason ? (
        <p className="factory-hint">{props.launchDisabledReason}</p>
      ) : null}
      <div className="factory-launch-footer">
        <p>
          One coherent update. A reviewable pull request.
          <br />
          <span>Launch authorizes worktree edits, commit, push, and PR creation.</span>
          <br />
          <span>Nothing merges or deploys automatically.</span>
        </p>
        <Button type="submit" size="xl" className="factory-launch-button" disabled={launchDisabled}>
          {props.launchPending ? "Starting the factory…" : "Launch factory"}
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

function Steering({
  run,
  pending,
  onSteer,
}: {
  run: FactoryRun;
  pending: boolean;
  onSteer: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="factory-steering"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && run.canSteer && !pending) {
          const submitted = text;
          void onSteer(text.trim()).then((acknowledged) => {
            if (acknowledged) setText((current) => (current === submitted ? "" : current));
          });
        }
      }}
    >
      <label htmlFor="factory-steer">
        <MessageSquareIcon aria-hidden="true" />
        <strong>Change the direction</strong>
      </label>
      <div>
        <textarea
          id="factory-steer"
          maxLength={8000}
          value={text}
          rows={2}
          placeholder="Preserve backward compatibility; defer experimental features."
          disabled={!run.canSteer || pending}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!run.canSteer || pending || !text.trim()}>
          {pending ? "Sending…" : "Send direction"}
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </div>
      <p>Direction goes to the managing conversation. Follow its response to see what changed.</p>
    </form>
  );
}

function ActiveRun(props: FactoryViewProps & { run: FactoryRun }) {
  const { run } = props;
  return (
    <section className="factory-active" aria-label="Selected factory run">
      <div className="factory-run-heading">
        <div>
          <span className="factory-eyebrow">
            {run.projectLabel} / {run.sourceLabel}
          </span>
          <h2>{run.title}</h2>
        </div>
        <span className="factory-status" data-tone={run.statusTone}>
          <span />
          {run.statusLabel}
        </span>
      </div>
      <p className="factory-run-description" aria-live="polite">
        {run.statusDescription}
      </p>
      {run.connectionLabel ? (
        <p className="factory-connection">
          <RadioIcon aria-hidden="true" />
          {run.connectionLabel}
        </p>
      ) : null}
      <div className="factory-run-actions">
        <Button variant="outline" onClick={props.onOpenConversation}>
          <MessageSquareIcon aria-hidden="true" />
          Open conversation
          <ArrowUpRightIcon aria-hidden="true" />
        </Button>
        {run.canInterrupt || props.interruptPending ? (
          <Button
            variant="ghost"
            disabled={props.interruptPending || !run.canInterrupt}
            onClick={props.onInterrupt}
          >
            <SquareIcon aria-hidden="true" />
            {props.interruptPending ? "Stopping…" : "Stop run"}
          </Button>
        ) : null}
      </div>
      <div className="factory-run-grid">
        <div className="factory-evidence">
          <div className="factory-section-label">
            <span>Evidence from the run</span>
            <span>Recent conversation</span>
          </div>
          {run.phaseDetail ? <p className="factory-phase-detail">{run.phaseDetail}</p> : null}
          {run.evidence.length ? (
            <ol>
              {run.evidence.map((item) => (
                <li key={item.id}>
                  <span className="factory-evidence-dot" />
                  <div>
                    <span className="factory-evidence-label">{item.label}</span>
                    <p>{item.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="factory-evidence-empty">
              <FileSearchIcon aria-hidden="true" />
              <h3>Waiting for the first evidence.</h3>
              <p>Research, decisions, and results appear as the agent reports them.</p>
            </div>
          )}
        </div>
        <aside className="factory-output" aria-label="Run output">
          <div className="factory-output-icon">
            <GitPullRequestIcon aria-hidden="true" />
          </div>
          <span className="factory-eyebrow">The deliverable</span>
          {run.pullRequest ? (
            <>
              <h3>
                A pull request
                <br />
                to review.
              </h3>
              <a
                className="factory-pr-link"
                href={run.pullRequest.url}
                target="_blank"
                rel="noreferrer"
              >
                {run.pullRequest.label}
                <ArrowUpRightIcon aria-hidden="true" />
              </a>
              <p>Inspect the changes and checks before merging.</p>
            </>
          ) : (
            <>
              <h3>
                Good work.
                <br />
                Then the proof.
              </h3>
              <span className="factory-no-pr">No pull request linked yet</span>
              <p>A finished turn does not guarantee a verified update or a published PR.</p>
            </>
          )}
          <dl className="factory-workspace">
            <dt>
              <GitBranchIcon aria-hidden="true" />
              Working branch
            </dt>
            <dd>{run.branch ?? "Not reported"}</dd>
            {run.worktreePath ? (
              <>
                <dt>Isolated worktree</dt>
                <dd>{run.worktreePath}</dd>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
      <Steering key={run.id} run={run} pending={props.steerPending} onSteer={props.onSteer} />
    </section>
  );
}

export function FactoryView(props: FactoryViewProps) {
  return (
    <div className="factory-page">
      <header className="factory-hero">
        <div className="factory-hero-top">
          <span className="factory-eyebrow">
            <FactoryIcon aria-hidden="true" />
            Lecturn Factory
          </span>
          <span className="factory-hero-stamp">
            Human direction.
            <br />
            Agent execution.
          </span>
        </div>
        <div className="factory-hero-copy">
          <h1>
            From release notes
            <br />
            to <em>pull request.</em>
          </h1>
          <p>
            Your providers keep shipping.
            <br />
            Put your agents on the integration work.
          </p>
        </div>
        <div className="factory-hero-bottom">
          <span>
            <span className="factory-signal" />
            Research. Implement. Verify. Review.
          </span>
          {props.run ? (
            <Button variant="ghost" className="factory-new-button" onClick={props.onNewRun}>
              <PlusIcon aria-hidden="true" />
              New run
            </Button>
          ) : (
            <span className="factory-hero-index">
              Built for the next release <ChevronRightIcon aria-hidden="true" />
            </span>
          )}
        </div>
      </header>
      <div className="factory-body">
        <AssemblyLine phase={props.run?.reportedPhase ?? null} />
        {props.recovery ? (
          <aside className="factory-recovery" role="status">
            <div>
              <strong>Inspect the previous launch</strong>
              <p>{props.recovery.message}</p>
              <p>
                Starting over keeps the original reference. It does not stop or resend that launch.
              </p>
            </div>
            {props.recovery.canInspect ? (
              <Button variant="outline" onClick={props.onInspectRecovery}>
                Inspect conversation
                <ArrowUpRightIcon aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={props.onReleaseRecovery}
              disabled={props.launchPending}
            >
              Keep reference &amp; start over
            </Button>
          </aside>
        ) : null}
        {props.launchError ? (
          <p className="factory-error" role="alert">
            {props.launchError}
          </p>
        ) : null}
        {props.run ? <ActiveRun {...props} run={props.run} /> : <LaunchForm {...props} />}
        {props.actionError ? (
          <p className="factory-error" role="alert">
            {props.actionError}
          </p>
        ) : null}
        {props.actionNotice ? (
          <p className="factory-hint" role="status">
            {props.actionNotice}
          </p>
        ) : null}
        {props.runs.length > 0 ? (
          <section className="factory-history" aria-label="Recent factory runs">
            <div className="factory-section-label">
              <span>From the factory floor</span>
              <span>
                {props.runs.length} {props.runs.length === 1 ? "run" : "runs"}
              </span>
            </div>
            <ul>
              {props.runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => props.onSelectRun(run.id)}
                    aria-current={props.run?.id === run.id ? "true" : undefined}
                  >
                    <span className="factory-history-icon">
                      <GitBranchIcon aria-hidden="true" />
                    </span>
                    <span className="factory-history-title">
                      <strong>{run.title}</strong>
                      <small>
                        {run.projectLabel} · {run.sourceLabel}
                      </small>
                    </span>
                    <span className="factory-status" data-tone={run.statusTone}>
                      <span />
                      {run.statusLabel}
                    </span>
                    <ArrowUpRightIcon className="factory-history-arrow" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <footer className="factory-footnote">
          <FactoryIcon aria-hidden="true" />
          <span>Every run is a conversation. Every decision leaves a trail.</span>
        </footer>
      </div>
    </div>
  );
}
