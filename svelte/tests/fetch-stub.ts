/**
 * Build a real `typeof fetch` out of a plain handler.
 *
 * `typeof fetch` is not just a call signature: it also carries the static
 * `preconnect` member. A bare `handler as typeof fetch` is therefore rejected
 * as a non-overlapping conversion, and the usual escape hatch
 * (`as unknown as typeof fetch`) would switch type checking off for the stub's
 * arguments too — exactly the checking these tests want.
 *
 * So instead of casting the shape away, satisfy it: attach a no-op
 * `preconnect` and let the result be assignable on its own merits. No cast is
 * involved, so a handler that reads the wrong argument shape still fails to
 * compile.
 */
export type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function fetchStub(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, {
    // Tests never preconnect; the member exists only to match `typeof fetch`.
    preconnect: () => {},
  });
}
