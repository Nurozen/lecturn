/**
 * The versioned thread copy bundle (`apps.exportThreads`/`apps.importThreads`).
 * It lives apart from apps.ts because it embeds orchestration messages and
 * turn items, and orchestrationV2.ts imports apps.ts.
 */
import * as Schema from "effect/Schema";

import {
  AppId,
  AppWorkspaceRoot,
  ConnectedAppHistoryRevision,
  ConnectedAppThreadData,
  ConnectedAppThreadSubtitle,
} from "./apps.ts";
import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const hasNoOmittedOutput = (items: ReadonlyArray<object>) =>
  items.every((item) => !("outputOmitted" in item) || item.outputOmitted !== true);

export const ConnectedAppThreadBundleThread = Schema.Struct({
  sourceThreadId: ThreadId,
  title: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  historyRevision: ConnectedAppHistoryRevision,
  appData: Schema.NullOr(ConnectedAppThreadData),
  subtitle: Schema.NullOr(ConnectedAppThreadSubtitle),
  pinned: Schema.Boolean,
  messages: Schema.Array(OrchestrationV2ConversationMessageJson),
  // Wire turn items may withhold large output; a copy must carry it all.
  turnItems: Schema.Array(OrchestrationV2TurnItemJson).check(
    Schema.makeFilter(hasNoOmittedOutput, { expected: "turn items with their full output" }),
  ),
});
export type ConnectedAppThreadBundleThread = typeof ConnectedAppThreadBundleThread.Type;

export const ConnectedAppThreadBundleProject = Schema.Struct({
  workspaceRoot: AppWorkspaceRoot,
  title: Schema.String,
  threads: Schema.Array(ConnectedAppThreadBundleThread),
});
export type ConnectedAppThreadBundleProject = typeof ConnectedAppThreadBundleProject.Type;

/** Card HTML captures and uploaded attachments; ids are remapped on import. */
export const ConnectedAppThreadBundleAsset = Schema.Struct({
  sourceAttachmentId: ChatAttachmentId,
  mimeType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  byteLength: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  dataBase64: Schema.String,
});
export type ConnectedAppThreadBundleAsset = typeof ConnectedAppThreadBundleAsset.Type;

export const ConnectedAppThreadBundleV1 = Schema.Struct({
  version: Schema.Literal(1),
  appId: AppId,
  sourceEnvironmentId: EnvironmentId,
  exportedAt: IsoDateTime,
  projects: Schema.Array(ConnectedAppThreadBundleProject),
  assets: Schema.Array(ConnectedAppThreadBundleAsset),
});
export type ConnectedAppThreadBundleV1 = typeof ConnectedAppThreadBundleV1.Type;
