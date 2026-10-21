import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";
import { isLoopbackHost } from "./preview.ts";

/** The hosted Lecturn web clients a provider sign-in may return to. */
const HOSTED_RETURN_ORIGINS: ReadonlySet<string> = new Set([
  new URL(DEFAULT_HOSTED_APP_URL).origin,
  "https://nightly.lecturn.cloudgatherer.net",
]);

/** Only return to a local client or the hosted Lecturn client, never an arbitrary OAuth-supplied URL. */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["lecturn:", "lecturn-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || HOSTED_RETURN_ORIGINS.has(url.origin));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
