/**
 * The guest URL with what the embed reads from its hash: the token (the hash never reaches the
 * server or a Referer, and the guest strips it on load), the iframe parent's origin, and whether
 * the host lists threads itself.
 */
export function embedGuestUrl(
  url: string,
  token: string,
  options: { readonly parentOrigin?: string; readonly switcher?: boolean } = {},
): string {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.hash.slice(1));
  params.set("embedToken", token);
  if (options.parentOrigin !== undefined) params.set("parentOrigin", options.parentOrigin);
  if (options.switcher === false) params.set("switcher", "0");
  parsed.hash = params.toString();
  return parsed.toString();
}

/**
 * Links the view may hand to the OS: web pages, and Lecturn's own deep links
 * (a thread continued in Lecturn opens there, D33).
 */
export function isExternalLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return true;
  return parsed.protocol === "lecturn:" && parsed.host === "apps";
}
