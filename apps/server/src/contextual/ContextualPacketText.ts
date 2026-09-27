import { ContextualEvidence as EvidenceSchema } from "@lecturn/contracts";
import { Schema } from "effect";
import type {
  ContextualPacket,
  ContextualPacketGroup,
  ContextualEvidence,
  ContextualCandidate,
} from "@lecturn/contracts";
import { renderContextualEvidence } from "../provider/ContextualDispatch.ts";

type RenderGroup = Pick<ContextualPacketGroup, "evidence" | "attribution" | "derivedSummary">;
type RenderPacket = Pick<ContextualPacket, "purpose" | "resolutionIds"> & {
  readonly groups: readonly RenderGroup[];
};
export function contextualDecisionSummary(candidate: ContextualCandidate): string | null {
  if (candidate.sourceKind !== "lecturn-decision") return null;
  const summary = candidate.derivedSummary;
  return `${summary.userEdited ? "User-edited" : "Generated"} saved Decision: ${summary.title.replace(/\s+/gu, " ")}\n${summary.body}${summary.rationale ? `\nRationale: ${summary.rationale}` : ""}`;
}

/** Title and authorship changes alone do not change the saved commitment. */
export function contextualDecisionMeaning(summary: string | null): string {
  return summary?.split("\n").slice(1).join("\n") ?? "";
}
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(EvidenceSchema));
/** Preserve both guidance identities while sharing one exact, contiguous immutable source span. */
export function normalizeContextualPacketGroups(
  groups: readonly ContextualPacketGroup[],
): ContextualPacketGroup[] | null {
  const shared = new Map<string, ContextualEvidence>();
  for (const group of groups)
    for (const evidence of group.evidence) {
      const prior = shared.get(evidence.id);
      if (!prior || encodeEvidence(prior) === encodeEvidence(evidence)) {
        shared.set(evidence.id, evidence);
        continue;
      }
      const metadata = (item: ContextualEvidence) =>
        encodeEvidence({ ...item, start: 0, end: 1, quote: "x", prefix: "", suffix: "" });
      if (metadata(prior) !== metadata(evidence)) return null;
      const [left, right] = prior.start <= evidence.start ? [prior, evidence] : [evidence, prior];
      if (right.start > left.end) return null;
      const overlap = Math.min(left.end, right.end) - right.start;
      if (
        left.quote.slice(right.start - left.start, right.start - left.start + overlap) !==
        right.quote.slice(0, overlap)
      )
        return null;
      shared.set(evidence.id, {
        ...left,
        end: Math.max(left.end, right.end),
        quote: left.quote + right.quote.slice(Math.max(0, left.end - right.start)),
        suffix: right.end > left.end ? right.suffix : left.suffix,
      });
    }
  return groups.map((group) => ({
    ...group,
    evidence: group.evidence.map((e) => shared.get(e.id)!),
  }));
}
export function contextualPacketText(packet: RenderPacket): string {
  const rendered = new Set<string>();
  return (
    `Purpose: ${packet.purpose}\n` +
    packet.groups
      .map((group) =>
        [
          ...(group.attribution ? [`Decision attribution: ${group.attribution}`] : []),
          ...group.evidence.flatMap((evidence) => {
            const identity = encodeEvidence(evidence);
            if (rendered.has(identity)) return [];
            rendered.add(identity);
            return [
              `${evidence.author ?? "Source"} (${evidence.occurredAt ?? "undated"}): ${evidence.quote}`,
            ];
          }),
          ...(group.derivedSummary
            ? [
                `${packet.resolutionIds.length ? "Task-scoped user resolution" : "Derived summary"}: ${group.derivedSummary}`,
              ]
            : []),
        ].join("\n"),
      )
      .join("\n\n")
  );
}

/** Bound the actual provider text, not the larger disclosure/provenance JSON.
 * The longest purpose and summary labels keep selection conservative before
 * the final packet has its purpose and task resolution IDs. */
export function contextualPacketByteBound(groups: readonly RenderGroup[]): number {
  return new TextEncoder().encode(
    renderContextualEvidence(
      contextualPacketText({
        purpose: "restored-after-compaction",
        resolutionIds: ["bound"],
        groups,
      }),
    ),
  ).length;
}
export function contextualEvidenceByteBound(evidence: readonly ContextualEvidence[]): number {
  return contextualPacketByteBound([{ evidence, attribution: null, derivedSummary: null }]);
}
