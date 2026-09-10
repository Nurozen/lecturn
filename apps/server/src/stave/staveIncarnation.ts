/** Compare Stave incarnation stamps without dropping nanosecond precision. */
export function sameManifestIncarnation(left: string, right: string): boolean {
  const epoch = (value: string) => {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (match === null) return null;
    const seconds = Date.parse(`${match[1]}${match[3]}`);
    return Number.isFinite(seconds)
      ? BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
      : null;
  };
  const first = epoch(left);
  return first !== null && first === epoch(right);
}
