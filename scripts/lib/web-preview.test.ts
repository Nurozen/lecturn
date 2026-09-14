import { describe, expect, it, vi } from "vite-plus/test";

import { assignWebPreview, webPreviewHostname } from "./web-preview.ts";

const env = {
  PR_NUMBER: "33",
  PR_HEAD_REF: "feat/teams-connect",
  VERCEL_TOKEN: "test-token",
  VERCEL_ORG_ID: "team_test",
  VERCEL_PROJECT_ID: "prj_test",
  DEPLOYMENT_URL: "https://lecturn-test.vercel.app",
};
const ready = { id: "dpl_test", projectId: "prj_test", target: null, readyState: "READY" };

describe("authenticated web preview alias", () => {
  it("assigns only the PR's domain to its ready preview and pins the branch", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ verified: true }))
      .mockResolvedValueOnce(Response.json(ready))
      .mockResolvedValueOnce(Response.json({ alias: "ok" }));
    expect(await assignWebPreview(env, request)).toBe(
      "https://pr-33.preview.lecturn.cloudgatherer.net",
    );
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      name: "pr-33.preview.lecturn.cloudgatherer.net",
      gitBranch: "feat/teams-connect",
    });
    expect(JSON.parse(request.mock.calls[2]![1]!.body as string)).toEqual({
      alias: "pr-33.preview.lecturn.cloudgatherer.net",
    });
    for (const [url] of request.mock.calls)
      expect(new URL(String(url)).origin).toBe("https://api.vercel.com");
  });
  it("updates the project-scoped domain after a conflict", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ verified: true }))
      .mockResolvedValueOnce(Response.json(ready))
      .mockResolvedValueOnce(Response.json({}));
    await assignWebPreview(env, request);
    expect(request.mock.calls[1]![1]!.method).toBe("PATCH");
    expect(String(request.mock.calls[1]![0])).toContain(
      "/projects/prj_test/domains/pr-33.preview.lecturn.cloudgatherer.net",
    );
  });
  it.each([
    { ...ready, target: "production" },
    { ...ready, projectId: "prj_other" },
    { ...ready, readyState: "BUILDING" },
  ])("refuses an unsafe deployment", async (details) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(details));
    await expect(assignWebPreview(env, request)).rejects.toThrow("Expected a ready preview");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed PR numbers before any API request", async () => {
    expect(() => webPreviewHostname("33/production")).toThrow();
    const request = vi.fn<typeof fetch>();
    await expect(assignWebPreview({ ...env, PR_NUMBER: "" }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
