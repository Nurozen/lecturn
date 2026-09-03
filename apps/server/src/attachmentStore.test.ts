// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import { uuidV5, UUID_NAMESPACE_DNS } from "@t3tools/shared/uuid";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentFileExtension,
  copyClaimedAttachment,
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending")!)).toBe("_pending");
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
  });

  it("preserves safe file extensions in attachment ids and paths", () => {
    const attachmentId = createPendingAttachmentId(".PDF");

    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("pending");
    expect(parseAttachmentUuid(attachmentId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseAttachmentFileExtension(attachmentId)).toBe("pdf");
    expect(attachmentFileExtension("report.PDF")).toBe(".pdf");
    expect(attachmentFileExtension("report")).toBe(".bin");
    expect(attachmentFileExtension("report.extensiontoolong")).toBe(".bin");
    // ".part" is the in-flight upload suffix; storing it would make the file
    // look like a stale partial to the sweep.
    expect(attachmentFileExtension("archive.part")).toBe(".bin");
    expect(createAttachmentId("x".repeat(80), ".abcdefghij")?.length).toBeLessThanOrEqual(128);
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves generic attachments without scanning the attachment directory", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-file-attachment-"),
    );
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-zip";
      const archivePath = NodePath.join(attachmentsDir, `${attachmentId}.zip`);
      NodeFS.writeFileSync(archivePath, Buffer.from("archive"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(archivePath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: `pending-${uuid}`,
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans deterministic child-thread copies of claimed attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-copy-"),
    );
    try {
      const sourceId = "parent-thread-00000000-0000-4000-8000-000000000004-pdf";
      const sourcePath = NodePath.join(attachmentsDir, `${sourceId}.pdf`);
      NodeFS.writeFileSync(sourcePath, Buffer.from("document"));
      const attachment: ChatAttachment = {
        type: "file",
        id: sourceId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };
      const uuid = uuidV5(UUID_NAMESPACE_DNS, `${sourceId}:child-thread`);

      const plan = copyClaimedAttachment({
        attachmentsDir,
        attachment,
        childThreadId: "child-thread",
        uuid,
      });
      expect(plan).toEqual({
        ok: true,
        finalId: `child-thread-${uuid}-pdf`,
        currentPath: sourcePath,
        finalPath: NodePath.join(attachmentsDir, `child-thread-${uuid}-pdf.pdf`),
      });
      if (!plan.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(plan.finalId)).toBe("child-thread");
      expect(parseThreadSegmentFromAttachmentId(plan.finalId)).not.toBe(
        parseThreadSegmentFromAttachmentId(sourceId),
      );
      expect(parseAttachmentUuid(plan.finalId)).toBe(uuid);
      expect(parseAttachmentFileExtension(plan.finalId)).toBe("pdf");

      const again = copyClaimedAttachment({
        attachmentsDir,
        attachment,
        childThreadId: "child-thread",
        uuid,
      });
      expect(again).toEqual(plan);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves legacy ids without an embedded extension from the full attachment", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-legacy-"),
    );
    try {
      const legacyId = "parent-thread-00000000-0000-4000-8000-000000000005";
      const sourcePath = NodePath.join(attachmentsDir, `${legacyId}.pdf`);
      NodeFS.writeFileSync(sourcePath, Buffer.from("document"));
      const attachment: ChatAttachment = {
        type: "file",
        id: legacyId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };

      // The id-only lookup scans image extensions and ".bin" and misses this file.
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: legacyId })).toBeNull();

      const uuid = "00000000-0000-4000-8000-000000000006";
      const plan = copyClaimedAttachment({
        attachmentsDir,
        attachment,
        childThreadId: "child-thread",
        uuid,
      });
      expect(plan).toEqual({
        ok: true,
        finalId: `child-thread-${uuid}`,
        currentPath: sourcePath,
        finalPath: NodePath.join(attachmentsDir, `child-thread-${uuid}.pdf`),
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects copy plans whose uuid does not match the store pattern", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-bad-uuid-"),
    );
    try {
      const attachment: ChatAttachment = {
        type: "file",
        id: "parent-thread-00000000-0000-4000-8000-000000000007-pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };

      expect(
        copyClaimedAttachment({
          attachmentsDir,
          attachment,
          childThreadId: "child-thread",
          uuid: "not-a-uuid",
        }),
      ).toEqual({ ok: false, reason: "invalid attachment uuid" });
      expect(
        copyClaimedAttachment({
          attachmentsDir,
          attachment,
          childThreadId: "child-thread",
          uuid: "00000000-0000-4000-8000-00000000000A",
        }),
      ).toEqual({ ok: false, reason: "invalid attachment uuid" });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const pendingFilePath = NodePath.join(attachmentsDir, `pending-${uuid}-pdf.pdf`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, pendingFilePath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 3 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(pendingFilePath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
