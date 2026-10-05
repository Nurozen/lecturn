import { afterEach, expect, it, vi } from "vite-plus/test";
import { downloadTextFile } from "./downloadTextFile";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("keeps a requested export alive through asynchronous save handoff and then releases it", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const anchor = {
    href: "",
    download: "",
    click: () => events.push("click"),
    remove: () => events.push("remove"),
  };
  vi.stubGlobal("document", {
    createElement: () => anchor,
    body: { appendChild: () => events.push("attach") },
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:lecturn://app/export");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  expect(await downloadTextFile("# Decision", "decisions.md", "text/markdown")).toEqual({
    status: "requested",
  });
  expect(events).toEqual(["attach", "click", "remove"]);
  expect(anchor.download).toBe("decisions.md");
  vi.advanceTimersByTime(1);
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(29_999);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:lecturn://app/export");
});

for (const result of [
  { status: "saved", filePath: "/chosen/decisions.json" },
  { status: "canceled" },
  { status: "error", message: "Permission denied" },
]) {
  it(`desktop export reports ${result.status} without starting a blob download`, async () => {
    const saveTextFile = vi.fn().mockResolvedValue(result);
    vi.stubGlobal("window", { desktopBridge: { saveTextFile } });
    const blob = vi.spyOn(URL, "createObjectURL");
    expect(
      await downloadTextFile('{"decisions":[]}', "decisions.json", "application/json"),
    ).toEqual(result);
    expect(saveTextFile).toHaveBeenCalledExactlyOnceWith({
      format: "json",
      content: '{"decisions":[]}',
    });
    expect(blob).not.toHaveBeenCalled();
  });
}
it("desktop IPC failure and older shells do not claim a successful export", async () => {
  vi.stubGlobal("window", {
    desktopBridge: { saveTextFile: vi.fn().mockRejectedValue(new Error("private sentinel")) },
  });
  expect(await downloadTextFile("# Decision", "decisions.md", "text/markdown")).toEqual({
    status: "error",
    message: "Could not save the export. Try again.",
  });
  vi.stubGlobal("window", { desktopBridge: {} });
  expect(await downloadTextFile("# Decision", "decisions.md", "text/markdown")).toEqual({
    status: "error",
    message: "Update Lecturn to save decision exports.",
  });
});
