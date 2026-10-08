/* Mirror of the server's secret patterns (apps/server/src/memoryDemo/tiering.ts).
   The server flags cards and refuses to land a secret; the Gate re-tests edited
   text with the same list so a draft that still leaks is blocked before landing.
   Keep the two lists in step. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/whsec_/, "a webhook signing secret (whsec_)"],
  [/sk_live_/, "a live Stripe key (sk_live_)"],
  [/AKIA/, "an AWS access key (AKIA)"],
  [/password\s*[:=]/i, "a password assignment"],
];

/** What `text` looks like it leaks (e.g. "a live Stripe key (sk_live_)"), or null. */
export function findSecret(text: string): string | null {
  return SECRET_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
