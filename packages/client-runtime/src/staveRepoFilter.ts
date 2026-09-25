/**
 * Filtering for Stave repo pickers (space and saga creation). Pure so web and
 * mobile narrow the registry the same way.
 */

/** The registry fields a repo query matches against. */
export interface StaveRepoSearchFields {
  readonly name: string;
  readonly defaultBranch?: string | undefined;
}

function queryTerms(query: string): ReadonlyArray<string> {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether a repo matches a free-text query. Every whitespace-separated term
 * must appear in the repo name or its default branch, case-insensitively. A
 * blank query matches everything.
 */
export function staveRepoMatchesQuery(repo: StaveRepoSearchFields, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = [repo.name, repo.defaultBranch ?? ""].join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Picker rows (keyed by repo name) that match `query`, in their original
 * order. `registry` supplies each repo's default branch; rows it does not know
 * still match on name.
 */
export function filterStaveRepoRows<Row extends { readonly repo: string }>(
  rows: ReadonlyArray<Row>,
  query: string,
  registry: ReadonlyArray<StaveRepoSearchFields> = [],
): ReadonlyArray<Row> {
  if (queryTerms(query).length === 0) return rows;
  const branches = new Map(registry.map((entry) => [entry.name, entry.defaultBranch] as const));
  return rows.filter((row) =>
    staveRepoMatchesQuery({ name: row.repo, defaultBranch: branches.get(row.repo) }, query),
  );
}
