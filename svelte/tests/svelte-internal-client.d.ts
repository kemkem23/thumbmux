/**
 * Types for the one private Svelte export these tests reach for.
 *
 * `svelte/internal/client` is Svelte's compiler runtime and ships no `.d.ts`
 * on purpose, so importing it is an error under `noImplicitAny`. The tests
 * need `proxy` — the same deep-reactive wrapper the compiler wraps `$state`
 * in — so a plain object passed as a prop reacts the way a compiled one does.
 *
 * Declared narrowly and with its real signature: only `proxy` exists here, so
 * reaching for any other private export still fails to compile. If Svelte ever
 * publishes types for this entry point, delete this file.
 */
declare module "svelte/internal/client" {
  /** Wrap `value` in Svelte 5's deep reactivity proxy. */
  export function proxy<T>(value: T): T;
}
