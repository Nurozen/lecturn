import type {
  ContributionCard,
  MemoryDuplicateJudgment,
  MemoryJudgments,
  MemoryStandardJudgment,
  MemoryVerdict,
} from "@lecturn/contracts";
import { FileIcon, LockIcon, SparklesIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import {
  draftBlock,
  hasSecretInBody,
  SUMMARY_MAX_LENGTH,
  verdictBlock,
  type GateVerdict,
} from "../gateState";
import {
  Eyebrow,
  FLAG_CLASS,
  GOLD,
  goldMix,
  KeyCap,
  NodeTypeIcon,
  OP_CLASS,
  VERDICT_KEYS,
  WordDiffText,
} from "./gateVisuals";

export interface GateCardProps {
  readonly card: ContributionCard;
  readonly decided: GateVerdict | undefined;
  readonly draft: string | null;
  readonly suggested: MemoryVerdict | null;
  readonly pulled: boolean;
  readonly onVerdict: (verdict: MemoryVerdict) => void;
  readonly onDraftChange: (text: string) => void;
  readonly onConfirmEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onUnpull: () => void;
  /** Display label for a territory id. */
  readonly territoryLabel: (territoryId: string) => string;
}

/** One review card: den node beside its warren target, diffs, judgments, verdict keys. */
export function GateCard({
  card,
  decided,
  draft,
  suggested,
  pulled,
  onVerdict,
  onDraftChange,
  onConfirmEdit,
  onCancelEdit,
  onUnpull,
  territoryLabel,
}: GateCardProps) {
  const summary = decided?.summary ?? card.den.summary;
  const editing = draft !== null;
  const contextChanged =
    card.target !== null &&
    card.target.context.trim() !== "" &&
    card.den.context.trim() !== "" &&
    card.target.context.trim() !== card.den.context.trim();

  return (
    <article
      data-gate-card
      aria-label={`Card ${card.nodeId}`}
      className="relative w-full rounded-[14px] border bg-card px-5 pt-4 pb-3.5 text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
        <span
          className={cn(
            "rounded-[4px] px-1.5 py-0.5 font-bold font-mono text-[10px] uppercase tracking-[0.1em]",
            OP_CLASS[card.op],
          )}
        >
          {card.op}
        </span>
        <NodeTypeIcon type={card.type} className="ml-1" />
        <span>{card.type}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{territoryLabel(card.territoryId)}</span>
        <span aria-hidden>·</span>
        <span>
          lands at <span className="font-mono text-foreground/80">{card.destination}</span>
        </span>
        {pulled ? (
          <Button size="micro" variant="ghost-muted" className="ml-auto" onClick={onUnpull}>
            Return to auto tier
          </Button>
        ) : null}
      </div>

      <h3 className="mt-1.5 mb-2 break-all font-display text-[21px] leading-snug tracking-[-0.01em]">
        {card.nodeId}
      </h3>

      {card.flags.length > 0 ? (
        <ul className="mb-2.5 flex flex-col gap-1">
          {card.flags.map((flag) => (
            <li
              key={`${flag.kind}:${flag.reason}`}
              className="flex items-baseline gap-2 text-muted-foreground text-xs"
            >
              <span
                className={cn(
                  "inline-flex h-5 shrink-0 items-center rounded-full px-2 font-medium text-[11px]",
                  FLAG_CLASS[flag.kind],
                )}
              >
                {flag.kind}
              </span>
              <span className="min-w-0">{flag.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_17px_minmax(0,1fr)] rounded-lg border bg-[color-mix(in_srgb,var(--background)_55%,var(--card))]">
        <section className="min-w-0 px-3.5 py-3">
          <Eyebrow className="mb-1.5">
            <span aria-hidden className="size-[7px] rounded-full" style={{ background: GOLD }} />
            Den node
            {decided?.verdict === "edit" ? (
              <span className="ml-auto font-normal normal-case tracking-normal">edited</span>
            ) : null}
          </Eyebrow>
          <p className="text-[13px] leading-relaxed">{summary}</p>
          {card.den.context.trim() ? (
            <p className="mt-1.5 line-clamp-4 text-muted-foreground text-xs leading-relaxed">
              {card.den.context}
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <FileIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{card.den.sourcePath ?? "no source path"}</span>
          </div>
        </section>
        <div aria-hidden className="relative">
          <span
            className="absolute inset-y-2 left-2 w-px"
            style={{
              background: `linear-gradient(180deg, var(--lecturn-thread-line), ${GOLD} 38%, var(--lecturn-thread-tip) 50%, ${GOLD} 62%, var(--lecturn-thread-line))`,
              boxShadow: "0 0 5px 1px var(--lecturn-thread-glow)",
            }}
          />
        </div>
        {card.target ? (
          <section className="min-w-0 px-3.5 py-3">
            <Eyebrow className="mb-1.5">
              <LockIcon aria-hidden className="size-3" />
              Warren target
              <span className="ml-auto min-w-0 truncate font-mono font-normal normal-case tracking-normal">
                {card.target.id}
              </span>
            </Eyebrow>
            <p className="text-[13px] leading-relaxed">{card.target.summary}</p>
            {card.target.context.trim() ? (
              <p className="mt-1.5 line-clamp-4 text-muted-foreground text-xs leading-relaxed">
                {card.target.context}
              </p>
            ) : null}
          </section>
        ) : (
          <section className="grid min-w-0 place-content-center gap-1 px-3.5 py-3 text-center text-muted-foreground text-xs">
            <b className="font-display font-normal text-base text-foreground">New in the warren</b>
            <span>
              Lands in territory{" "}
              <span className="font-mono">{territoryLabel(card.territoryId)}</span>
            </span>
          </section>
        )}
      </div>

      {editing ? (
        <DiffBlock
          label="Summary diff"
          detail={card.target ? "warren to your edit" : "den to your edit"}
          before={card.target?.summary ?? card.den.summary}
          after={draft}
        />
      ) : card.target ? (
        <>
          <DiffBlock
            label="Summary diff"
            detail="warren to den"
            before={card.target.summary}
            after={summary}
          />
          {contextChanged ? (
            <DiffBlock
              label="Context diff"
              detail="warren to den"
              before={card.target.context}
              after={card.den.context}
            />
          ) : null}
        </>
      ) : null}

      {editing ? (
        <EditBox
          card={card}
          draft={draft}
          onDraftChange={onDraftChange}
          onConfirm={onConfirmEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <JudgmentsBlock judgments={card.judgments} />
          <VerdictBar
            card={card}
            chosen={decided?.verdict ?? null}
            suggested={decided ? null : suggested}
            onVerdict={onVerdict}
          />
        </>
      )}
    </article>
  );
}

function DiffBlock({
  label,
  detail,
  before,
  after,
}: {
  label: string;
  detail: string;
  before: string;
  after: string;
}) {
  return (
    <div className="mt-2.5 rounded-md border border-dashed px-3 py-2 text-[12.5px] leading-[1.7]">
      <Eyebrow className="mb-0.5 gap-2.5">
        {label}
        <span className="font-normal normal-case tracking-normal">{detail}</span>
      </Eyebrow>
      <div>
        <WordDiffText before={before} after={after} />
      </div>
    </div>
  );
}

const STANDARD_TONE = {
  fail: "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
  uncertain: "bg-warning/12 text-warning-foreground dark:bg-warning/18",
  pass: "border border-border bg-background/60 text-muted-foreground",
} as const;

function standardValue(standard: MemoryStandardJudgment): string {
  switch (standard.kind) {
    case "noul":
      return standard.p.toFixed(2);
    case "score":
      return standard.score.toFixed(2);
    case "choice":
      return `${standard.choice} ${standard.confidence.toFixed(2)}`;
  }
}

/** Recorded or heuristic standards plus the duplicate bar. Replaces the mockup's agent-draft slot. */
function JudgmentsBlock({ judgments }: { judgments: MemoryJudgments }) {
  if (judgments.standards.length === 0 && judgments.duplicate === null) return null;
  const recorded = judgments.method === "recorded-jev";
  return (
    <div
      className="mt-2.5 rounded-md border px-3 py-2.5 text-xs"
      style={
        recorded
          ? { background: goldMix(7), borderColor: goldMix(32, "var(--border)") }
          : { borderStyle: "dashed" }
      }
    >
      <div className="mb-2 flex items-center gap-2 text-muted-foreground">
        <SparklesIcon
          aria-hidden
          className="size-3.5 shrink-0"
          style={recorded ? { color: GOLD } : undefined}
        />
        <span className="font-medium text-foreground">
          {recorded ? `recorded Jev judgments, ${judgments.model ?? "jev"}` : "heuristic"}
        </span>
        <span>{recorded ? "synthetic spike data" : "computed locally for a live write"}</span>
      </div>
      {judgments.standards.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {judgments.standards.map((standard) => (
            <li
              key={standard.id}
              className={cn(
                "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[11.5px]",
                STANDARD_TONE[standard.kind === "choice" ? "pass" : standard.verdict],
              )}
            >
              <span className="font-mono font-semibold">{standard.id}</span>
              <span className="truncate">{standard.title}</span>
              <span className="font-mono tabular-nums">{standardValue(standard)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {judgments.duplicate ? <DuplicateBar duplicate={judgments.duplicate} /> : null}
    </div>
  );
}

const LEVELS = ["different", "related", "same"] as const;
const LEVEL_STYLE: Record<(typeof LEVELS)[number], { className?: string; background?: string }> = {
  different: { className: "bg-muted-foreground/30" },
  related: { className: "bg-warning/70" },
  same: { background: GOLD },
};

function DuplicateBar({ duplicate }: { duplicate: MemoryDuplicateJudgment }) {
  const p = duplicate.probabilities;
  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-baseline gap-2 text-muted-foreground">
        <span className="font-mono font-semibold text-foreground">D1</span>
        <span className="min-w-0 truncate">
          duplicate check against <span className="font-mono">{duplicate.targetId}</span>
        </span>
        <span className="ml-auto font-mono text-foreground tabular-nums">
          {duplicate.level} {p[duplicate.level].toFixed(2)}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Duplicate: different ${p.different.toFixed(2)}, related ${p.related.toFixed(2)}, same ${p.same.toFixed(2)}`}
        className="flex h-2 gap-0.5 overflow-hidden rounded-[4px]"
      >
        {LEVELS.map((level) => (
          <i
            key={level}
            className={cn("block h-full min-w-0.5", LEVEL_STYLE[level].className)}
            style={{
              flexGrow: Math.max(p[level], 0.005),
              flexBasis: 0,
              background: LEVEL_STYLE[level].background,
              opacity: level === duplicate.level ? 1 : 0.55,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-3 font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {LEVELS.map((level) => (
          <span key={level} className={level === duplicate.level ? "text-foreground" : undefined}>
            {level} {p[level].toFixed(2)}
          </span>
        ))}
      </div>
    </div>
  );
}

function verdictLabel(verdict: MemoryVerdict, card: ContributionCard): string {
  switch (verdict) {
    case "accept":
      return card.op === "supersede"
        ? "Accept supersede"
        : card.op === "update"
          ? "Accept update"
          : "Accept";
    case "edit":
      return "Edit summary";
    case "merge":
      return "Merge";
    case "distinct":
      return "Keep both";
    case "skip":
      return "Skip, stays in den";
  }
}

function VerdictBar({
  card,
  chosen,
  suggested,
  onVerdict,
}: {
  card: ContributionCard;
  chosen: MemoryVerdict | null;
  suggested: MemoryVerdict | null;
  onVerdict: (verdict: MemoryVerdict) => void;
}) {
  const acceptBlock = verdictBlock(card, "accept");
  const note = hasSecretInBody(card) ? (
    <span className="text-destructive-foreground">
      The secret is in the body, which Edit cannot change. Press S to keep it in the den.
    </span>
  ) : acceptBlock ? (
    <span className="text-destructive-foreground">
      Accept is blocked while the summary looks like a secret. Press E to edit it out, or S to keep
      it in the den.
    </span>
  ) : card.target === null ? (
    "Merge and Keep both need a warren target. This card is a new node."
  ) : card.op === "supersede" ? (
    <>
      Accept retires <span className="font-mono">{card.target.id}</span>. Keep both costs the same
      single key.
    </>
  ) : null;
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3">
        {VERDICT_KEYS.map(([key, verdict]) => {
          const blocked = verdict === "edit" ? null : verdictBlock(card, verdict);
          const isChosen = chosen === verdict;
          return (
            <span key={verdict} className="contents">
              {verdict === "skip" ? (
                <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />
              ) : null}
              <Button
                variant="outline"
                data-verdict={verdict}
                disabled={blocked !== null}
                aria-keyshortcuts={key}
                aria-pressed={isChosen}
                onClick={() => onVerdict(verdict)}
                className="h-9 gap-2 border-b-2 pr-3 pl-1.5 font-medium text-[12.5px] data-pressed:translate-y-px data-pressed:border-b sm:h-9"
                style={isChosen ? { background: goldMix(14), borderColor: GOLD } : undefined}
              >
                <KeyCap className="h-[21px] min-w-[21px] text-[11.5px]">{key}</KeyCap>
                {verdictLabel(verdict, card)}
                {suggested === verdict ? (
                  <span
                    className="absolute -top-2 right-1.5 rounded-[3px] px-1 py-px font-mono font-semibold text-[9px] text-white uppercase tracking-[0.08em]"
                    style={{ background: GOLD }}
                  >
                    suggested
                  </span>
                ) : null}
              </Button>
            </span>
          );
        })}
        <span className="ml-auto flex items-center gap-1 text-muted-foreground text-xs">
          <KeyCap>J</KeyCap>
          <KeyCap>K</KeyCap>
          <span className="mr-1.5">move</span>
          <KeyCap>U</KeyCap>
          <span>undo</span>
        </span>
      </div>
      {note ? <p className="mt-2 text-muted-foreground text-xs">{note}</p> : null}
      {suggested ? (
        <p className="mt-1 text-muted-foreground text-xs">
          Press <KeyCap className="mx-0.5">⏎</KeyCap> to take the suggestion.
        </p>
      ) : null}
    </>
  );
}

function EditBox({
  card,
  draft,
  onDraftChange,
  onConfirm,
  onCancel,
}: {
  card: ContributionCard;
  draft: string;
  onDraftChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const error = draftBlock(card, draft);
  const length = draft.trim().length;
  return (
    <div
      data-gate-draft
      className="mt-2.5 rounded-lg border border-ring bg-card p-3 ring-[3px] ring-ring/18"
    >
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <b className="font-semibold text-foreground">Edit summary, then accept</b>
        <span
          className={cn(
            "ml-auto font-mono text-muted-foreground tabular-nums",
            length > SUMMARY_MAX_LENGTH && "text-destructive-foreground",
          )}
        >
          {length}/{SUMMARY_MAX_LENGTH}
        </span>
      </div>
      <Textarea
        autoFocus
        rows={3}
        value={draft}
        aria-label="Summary"
        aria-invalid={error !== null && length > 0 ? true : undefined}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(event) => onDraftChange(event.currentTarget.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className={cn("text-xs", error ? "text-destructive-foreground" : "text-muted-foreground")}
        >
          {error ?? "Shift+Enter for a new line."}
        </span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel <KeyCap>Esc</KeyCap>
        </Button>
        <Button size="sm" disabled={error !== null} onClick={onConfirm}>
          Save and accept
          <KeyCap className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground">
            ⏎
          </KeyCap>
        </Button>
      </div>
    </div>
  );
}
