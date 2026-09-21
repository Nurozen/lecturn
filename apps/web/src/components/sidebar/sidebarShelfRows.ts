/** The current conversation stays in place while its surrounding shelf folds away. */
export function partitionShelfRows<T>(rows: readonly T[], isCurrent: (row: T) => boolean) {
  const index = rows.findIndex(isCurrent);
  return {
    before: index < 0 ? rows : rows.slice(0, index),
    current: index < 0 ? undefined : rows[index],
    after: index < 0 ? [] : rows.slice(index + 1),
  };
}
