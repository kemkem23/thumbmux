/**
 * Text query matching — the one "lowercase + includes" the menus search with.
 *
 * The host used to keep two hand-rolled copies of this: the skills panel
 * trimmed its filter and used the result to highlight/dim chips without ever
 * removing one, while the manage dropdown did not trim and used the result to
 * filter four inventory groups. Both are still possible, and both still behave
 * exactly as before, because the only thing that ever differed was whether the
 * query got trimmed first.
 *
 * Deliberately not here: RegExp, Unicode normalization, locale-aware case
 * folding, word boundaries, fuzzy scoring. The menus never had them; adding
 * one silently changes which rows a query finds.
 *
 * The empty query matches everything, which is what `String.includes('')`
 * already means. That is what keeps the manage dropdown showing every row when
 * its box is empty. A caller that instead wants "no query, no highlight" — the
 * skills panel — decides that from its own term, as it always did:
 *
 * ```ts
 * const term = filter.trim().toLowerCase();
 * const matches = term !== '' && matchesTextQuery(haystack, filter, { trimQuery: true });
 * const dimmed = term !== '' && !matches;
 * ```
 */

export interface TextQueryOptions {
  /**
   * Trim whitespace off the query before matching. Whitespace inside the
   * query, and the text itself, are left alone either way.
   *
   * @default false
   */
  trimQuery?: boolean;
}

/**
 * True when `query` occurs in `text`, ignoring case.
 *
 * @param text  the haystack; hosts compose it themselves (name, badge, warning…)
 * @param query the raw search box value
 */
export function matchesTextQuery(
  text: string,
  query: string,
  options?: TextQueryOptions,
): boolean {
  const needle = options?.trimQuery ? query.trim() : query;
  // Preserve MANAGE's empty-filter guard, including falsy runtime values
  // that can arrive before the host's string state is ready.
  if (!needle) return true;
  return text.toLowerCase().includes(needle.toLowerCase());
}
