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
