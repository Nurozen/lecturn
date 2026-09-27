import { ContextualPacket, type ContextualDeliveryReceipt } from "@lecturn/contracts";
import { Context, Deferred, Effect, Layer, Schema, Semaphore, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { ContextualSummaryOutput } from "../textGeneration/TextGenerationPrompts.ts";
import { ContextualNotifications } from "./ContextualNotifications.ts";
import { contextualPacketText } from "./ContextualPacketText.ts";
import { appendContextualEvent } from "./ContextualSettings.ts";

const decodePacket = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPacket));
const decodeSummary = Schema.decodeUnknownEffect(ContextualSummaryOutput);
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const generator = yield* TextGeneration;
  const notifications = yield* ContextualNotifications;
  const scope = yield* Effect.scope;
  const permits = yield* Semaphore.make(2);
  const active = new Map<string, Deferred.Deferred<void>>();

  const retained = Effect.fn("ContextualSummary.retained")(function* (
    receipt: ContextualDeliveryReceipt,
  ) {
    // Permission revisions, accepted receipt and retained bytes jointly fence both reads and writes.
    const rows = yield* sql<{ packet_json: string }>`SELECT p.packet_json FROM contextual_packets p
      JOIN contextual_receipts r ON r.packet_id=p.id AND r.id=${receipt.id}
      JOIN contextual_host_state h ON h.singleton=1
      JOIN contextual_thread_settings ts ON ts.thread_id=p.thread_id
      JOIN contextual_project_settings ps ON ps.project_id=ts.project_id
      JOIN projection_threads t ON t.thread_id=p.thread_id
      JOIN projection_projects pr ON pr.project_id=t.project_id
      WHERE p.id=${receipt.packetId} AND p.retention='available' AND p.packet_json IS NOT NULL
        AND json_extract(r.receipt_json,'$.acceptance')='accepted' AND json_extract(r.receipt_json,'$.evidenceIncluded')=1
        AND t.deleted_at IS NULL AND pr.deleted_at IS NULL AND ts.enabled=1
        AND ts.revision=json_extract(p.packet_json,'$.task.threadSettingsRevision')
        AND ts.exclusion_revision=json_extract(p.packet_json,'$.task.threadExclusionRevision')
        AND ps.revision=json_extract(p.packet_json,'$.task.projectSettingsRevision')
        AND h.source_revision=json_extract(p.packet_json,'$.task.sourceScopeRevision')
        AND h.purge_generation=json_extract(p.packet_json,'$.task.purgeGeneration')
        AND h.funding_generation=json_extract(p.packet_json,'$.task.fundingGeneration')`;
    return rows[0]?.packet_json ?? null;
  });
  const generate = Effect.fn("ContextualSummary.generate")(function* (
    receipt: ContextualDeliveryReceipt,
  ) {
    const original = yield* retained(receipt);
    if (!original || !generator.generateContextualSummary) return;
    const existing =
      yield* sql`SELECT 1 FROM contextual_display_summaries WHERE packet_id=${receipt.packetId}`;
    if (existing.length) return;
    const packet = yield* decodePacket(original);
    const message = contextualPacketText(packet);
    if (message.length <= 600 || message.length > 12000) return;
    const { textGenerationModelSelection } = yield* settings.getSettings;
    const changes = yield* notifications.subscribe;
    const inference = generator
      .generateContextualSummary({
        // Supported adapters create their own empty directory; no task workspace is supplied.
        cwd: "/",
        message,
        modelSelection: textGenerationModelSelection,
      })
      .pipe(Effect.flatMap(decodeSummary), Effect.timeout("45 seconds"));
    const invalidated = Stream.fromSubscription(changes).pipe(
      Stream.mapEffect(() => retained(receipt)),
      Stream.filter((current) => current !== original),
      Stream.take(1),
      Stream.runDrain,
      Effect.as(null),
    );
    const result = yield* Effect.raceFirst(inference, invalidated);
    if (!result) return;
    const text = result.text.trim();
    if (!text) return;
    const saved = yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* retained(receipt)) !== original) return false;
        yield* sql`INSERT OR IGNORE INTO contextual_display_summaries(packet_id,text) VALUES(${packet.id},${text})`;
        yield* appendContextualEvent(sql, {
          threadId: packet.task.threadId,
          revision: 0,
          kind: "display-summary-ready",
          entityId: packet.id,
        });
        return true;
      }),
    );
    if (saved) yield* notifications.publish;
  }, Effect.scoped);
  const schedule = Effect.fn("ContextualSummary.schedule")(function* (
    receipt: ContextualDeliveryReceipt,
  ) {
    if (
      receipt.acceptance !== "accepted" ||
      !receipt.evidenceIncluded ||
      !receipt.packetId ||
      active.has(receipt.packetId)
    )
      return;
    const packetId = receipt.packetId;
    const done = yield* Deferred.make<void>();
    active.set(packetId, done);
    yield* generate(receipt).pipe(
      permits.withPermits(1),
      // Optional presentation must never fail delivery or retain source-bearing errors.
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => active.delete(packetId)).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
        ),
      ),
      Effect.forkIn(scope),
    );
  });
  const drain = Effect.suspend(() =>
    Effect.forEach([...active.values()], Deferred.await, { discard: true }),
  );
  return { schedule, drain };
});
export class ContextualDisplaySummary extends Context.Service<
  ContextualDisplaySummary,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualDisplaySummary") {}
export const layer = Layer.effect(ContextualDisplaySummary, make);
