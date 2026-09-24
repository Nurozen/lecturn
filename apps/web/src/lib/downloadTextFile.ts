import type { DesktopSaveTextFileResult } from "@lecturn/contracts";

/** Desktop reports the native write result; browsers hand off a download request. */
export async function downloadTextFile(
  content: string,
  fileName: string,
  mimeType: string,
): Promise<DesktopSaveTextFileResult | { status: "requested" }> {
  if (typeof window !== "undefined" && window.desktopBridge) {
    if (!window.desktopBridge.saveTextFile)
      return { status: "error", message: "Update Lecturn to save decision exports." };
    try {
      return await window.desktopBridge.saveTextFile({
        content,
        format: mimeType === "application/json" ? "json" : "markdown",
      });
    } catch {
      return { status: "error", message: "Could not save the export. Try again." };
    }
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the blob alive through the browser download handoff.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return { status: "requested" };
}
