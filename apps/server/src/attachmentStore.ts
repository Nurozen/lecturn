// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i",
);
const ATTACHMENT_ID_UUID_EXACT_PATTERN = new RegExp(`^${ATTACHMENT_ID_UUID_PATTERN}$`);

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).toLowerCase();
  // ".part" is reserved for in-flight uploads; a stored "archive.part" would
  // look stale to sweepStalePendingAttachments and get deleted.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

export function createPendingAttachmentId(extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[3]?.toLowerCase() ?? null;
}

export function createAttachmentId(threadId: string, extension?: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

/** Null for attachment types this build does not know; callers skip those. */
export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}${attachmentFileExtension(attachment.name)}`;
    default:
      return null;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (!relativePath) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const fileExtension = parseAttachmentFileExtension(normalizedId);
  if (fileExtension) {
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}.${fileExtension.toLowerCase()}`,
    });
    return filePath && NodeFS.existsSync(filePath) ? filePath : null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) {
    return { ok: false, reason: "invalid attachment id" };
  }

  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" };
  }

  const currentPath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }
  const fileExtension = parseAttachmentFileExtension(input.attachmentId) ?? undefined;
  const finalId = createAttachmentId(input.threadId, fileExtension);
  if (!finalId) {
    return { ok: false, reason: "failed to create attachment id" };
  }

  const expectedFinalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!expectedFinalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath: expectedFinalPath,
  };
}

/**
 * Child-namespaced id for an attachment copied into another thread: the
 * destination thread's segment, the caller-supplied deterministic uuid and
 * the source id's extension suffix. Pure — the fork assembler derives the
 * copied message rows' ids with it, and copyClaimedAttachment reuses it so
 * the file copy lands at the same id.
 */
export function deriveCopiedAttachmentId(input: {
  readonly sourceAttachmentId: string;
  readonly childThreadId: string;
  readonly uuid: string;
}): string | null {
  if (!ATTACHMENT_ID_UUID_EXACT_PATTERN.test(input.uuid)) {
    return null;
  }
  const childSegment = toSafeThreadAttachmentSegment(input.childThreadId);
  if (!childSegment) {
    return null;
  }
  const fileExtension = parseAttachmentFileExtension(input.sourceAttachmentId);
  return `${childSegment}-${input.uuid}${attachmentIdExtensionSuffix(fileExtension ?? undefined)}`;
}

/**
 * Plan copying a thread-owned attachment into another thread's namespace.
 *
 * The caller supplies the uuid (derived deterministically from the source and
 * destination) so retries produce the same final id. Resolution goes through
 * the full attachment rather than an id-only lookup because legacy attachment
 * ids may lack an embedded extension. The caller performs the file copy.
 */
export function copyClaimedAttachment(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
  readonly childThreadId: string;
  readonly uuid: string;
}): AttachmentClaimPlan {
  if (!ATTACHMENT_ID_UUID_EXACT_PATTERN.test(input.uuid)) {
    return { ok: false, reason: "invalid attachment uuid" };
  }
  const childSegment = toSafeThreadAttachmentSegment(input.childThreadId);
  if (!childSegment) {
    return { ok: false, reason: "invalid thread id" };
  }

  const currentPath = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: input.attachment,
  });
  if (!currentPath || !NodeFS.existsSync(currentPath)) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }

  const finalId = deriveCopiedAttachmentId({
    sourceAttachmentId: input.attachment.id,
    childThreadId: input.childThreadId,
    uuid: input.uuid,
  });
  if (!finalId) {
    return { ok: false, reason: "failed to derive attachment id" };
  }
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!finalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath,
  };
}

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
    }

    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  return { deleted };
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
