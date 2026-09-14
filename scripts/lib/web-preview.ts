// @effect-diagnostics globalFetch:off - Small deployment entrypoint uses an injectable Vercel API transport.
type Environment = Readonly<Record<string, string | undefined>>;

export function webPreviewHostname(prNumber: string): string {
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error("A valid PR number is required.");
  return `pr-${prNumber}.preview.lecturn.cloudgatherer.net`;
}

/** Assign only this PR's controlled alias; never latest, nightly or production. */
export async function assignWebPreview(
  env: Environment,
  request: typeof fetch = fetch,
): Promise<string> {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  const hostname = webPreviewHostname(required("PR_NUMBER"));
  const branch = required("PR_HEAD_REF");
  const token = required("VERCEL_TOKEN");
  const team = required("VERCEL_ORG_ID");
  const project = required("VERCEL_PROJECT_ID");
  const deployment = new URL(required("DEPLOYMENT_URL"));
  if (
    deployment.protocol !== "https:" ||
    !deployment.hostname.endsWith(".vercel.app") ||
    deployment.username ||
    deployment.password
  ) {
    throw new Error("Expected a Vercel preview deployment URL.");
  }
  const api = async (path: string, method = "GET", body?: unknown, allowConflict = false) => {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", team);
    const response = await request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowConflict && response.status === 409) return null;
    if (!response.ok) throw new Error(`Vercel ${method} ${path} failed (${response.status}).`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const projectPath = encodeURIComponent(project);
  const domain = await api(
    `/v10/projects/${projectPath}/domains`,
    "POST",
    { name: hostname, gitBranch: branch },
    true,
  );
  if (domain === null) {
    // The project-scoped update fails if another project owns this name.
    await api(`/v9/projects/${projectPath}/domains/${hostname}`, "PATCH", { gitBranch: branch });
  }
  const details = await api(`/v13/deployments/${encodeURIComponent(deployment.hostname)}`);
  if (
    !details ||
    typeof details.id !== "string" ||
    details.projectId !== project ||
    details.target === "production" ||
    details.readyState !== "READY"
  ) {
    throw new Error("Expected a ready preview deployment belonging to this Vercel project.");
  }
  await api(`/v2/deployments/${encodeURIComponent(details.id)}/aliases`, "POST", {
    alias: hostname,
  });
  return `https://${hostname}`;
}
