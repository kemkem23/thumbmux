# thumbmux compatibility contract

Status: this is the public compatibility policy for the 0.8.x line. It installs
the gates needed to earn a 1.0 release; it does not declare those gates passed.

This contract covers the public exports of `thumbmux/core`, `thumbmux/server`,
`thumbmux/svelte`, and `thumbmux/app` in published `v0.8.x-dist` tags, together
with their documented wire behavior and defaults. The manifest at the matching
release tag, not a list copied into prose, is the source of truth for which
names are covered and which tier each name occupies.

## How these promises are checked

The policy below refers to these enforcement layers. A compatibility claim is
not complete unless one of these layers can expose a violation.

| Layer | Mechanism | What it detects |
| --- | --- | --- |
| Surface gate | `contract/manifest/core.json`, `server.json`, `svelte.json`, and `app.json`, checked by `scripts/contract-check.ts` against declarations from a freshly built `git-dist` | A missing or changed F/S export, a new export with no intentional tier, or removal before a recorded deprecation date makes the check fail. The manifest records each name, kind, tier, declaration signature, and deprecation metadata. |
| Frozen consumers | `contract/fixtures/minimal-host`, `guarded-host`, and `app-host`, run by `scripts/contract-fixtures.sh` against the packed `git-dist` artifact | Public types that no longer compile and integration behavior that no longer works make a representative consumer fail. |
| Wire compatibility | `contract/goldens/*.jsonl` and `server/tests/protocol-goldens.test.ts`, supplemented by `server/tests/conformance.test.ts` | A current server that rejects a recorded old client message, a change to any frame shape recorded in the goldens, or a pinned protocol semantic that changes makes a test fail. The goldens pin what they record — a frame kind or field never recorded is not covered by them, only by the surface gate. It does **not** claim that no new frame kind may appear: a reader that rejects unknown kinds outright is outside what these goldens verify. `auth_error` is exactly that case — emitted only when a host opts into a guard, safe for every bundled client — versions before v0.8.0 drop it because it carries no channel, and v0.8.0 re-emits it as a `thumbmux:auth-error` window event, and shape-gated like every other frame, but a strict custom reader must tolerate unknown kinds before enabling a guard. |
| Deprecation ceremony | Emitted `.d.ts` JSDoc, manifest metadata, the `Deprecated` section of `CHANGELOG.md`, `core/src/deprecate.test.ts`, and the frozen-fixture review rule below | A missing stamp, malformed runtime warning, early removal, or unsupported old spelling blocks the release. |
| Distribution rail | `.github/workflows/release.yml`, `scripts/smoke-git-dist.sh`, and the resolved commit in a consumer lockfile | The release workflow builds and tests the artifact, consumer smoke tests its public entry points, and each release creates a new exact `-dist` tag rather than changing an older pin. |

Changing an expected value in an ordinary test does not make a breaking change
compatible. A change to a frozen manifest, consumer fixture, or wire golden is
itself a contract event and must follow the policy below.

## Versioning model

### The 0.8.x line

The 0.8.x line uses an explicit compatibility policy that is stricter than the
usual freedom available to pre-1.0 software: an F-tier name does not receive a
breaking change anywhere in 0.8.x. The surface gate checks names and declaration
signatures; frozen consumers, wire goldens, and conformance tests check behavior
that declarations cannot express.

An exact published `vX.Y.Z-dist` tag identifies an immutable consumer artifact.
Minor releases may make only the tier-specific changes described below, and
patch releases may not be used to bypass a tier's minor-release ceremony. The
distribution rail and the manifest diff make both decisions reviewable.

### The gate to 1.0

The intended 1.0 release is a no-code-delta retag of the final proven pre-1.0
release. It introduces no new API: release review must show only version fields
and this document's release status changing. All four of these measurable gates
must pass first:

1. The reference consumer has used `thumbmux/app` in production on
   `/embed/terminal`, `/m/hub`, and `/m/t/[session]` for at least seven days,
   with no migration-driven patch to the thumbmux package source. Migration
   reports must either contain no package findings or show that every finding
   was fixed in the package and shipped through a normal release; deployment
   records and the package history are the evidence.
2. The outsider re-audit reports feature 9 as PROVIDED, feature 12 as at least
   HOST WORK, and no new GAP. The archived re-audit report is the evidence, and
   any contrary probe result keeps this gate closed.
3. At least one name has completed the whole deprecation lifecycle from warning
   through removal. The server-side `JournalRecordV1` alias is the first planned
   exercise; its declaration history, manifest dates, changelog entries, and
   warning/removal checks are the evidence.
4. The surface gate and all three frozen consumer fixtures have remained green
   throughout the compatibility line, and mutation proof has demonstrated at
   least once that each layer catches a real breaking change. CI history and the
   recorded mutation output are the evidence.

Until all four evidence records exist, project documentation and releases must
not claim that thumbmux is "SemVer 1.0 compliant".

## Tier definitions

| Tier | Contract | Enforcement |
| --- | --- | --- |
| F — frozen | No breaking change anywhere in 0.8.x. After 1.0, an F name may break only in a new major release. | The surface gate pins its exported name, kind, and declaration signature; the relevant frozen consumer, golden, or conformance test pins behavior. |
| S — stabilizing | A change is allowed only at a minor boundary and must preserve the old route through the alias and deprecation policy. The goal is to promote surviving S surface to F for 1.0. | The manifest marks the name S; the surface gate and deprecation metadata keep both spellings and the removal date visible. Frozen consumers continue to use the old route during the window. |
| X — experimental | An X name may change or be removed in a minor release without an alias or warning. Public documentation that mentions it must call it experimental. | An intentional `tier: "X"` manifest entry is the machine-readable warning; the surface gate reports X drift instead of treating it as an F/S break, and release review rejects an unmarked public mention. |
| D — data-default | D applies only to an exported default's value. The value may change in a minor release, never a patch. D does not permit removing or renaming the export or changing its declared shape. | The manifest pins the name and shape and identifies the value as D; the release must add a `Changed defaults` changelog entry. Relevant default tests or frozen consumers pin the old value until that ceremony occurs. |

The manifest files under `contract/manifest/` are the only tier inventory. This
document deliberately does not duplicate the hundreds of public names. A new
export makes `scripts/contract-check.ts` fail until its name, kind, signature,
and tier are added intentionally. Changing the manifest cannot retroactively
weaken an existing promise: an F entry cannot be demoted to S or X within 0.8.x
to authorize a change that would otherwise be breaking. The manifest diff and
release review enforce that rule.

For an F-tier Svelte component, the frozen surface is the set and declaration
of its existing props. Adding an optional prop is an additive minor change;
removing or changing an existing prop is breaking. Component declaration hashes
in the surface gate and the frozen app consumer check this distinction.

The same rule applies to an F-tier interface a host implements or supplies, such
as `MuxHooks` and `TmuxDriver`. **Adding an optional member is additive**;
removing one, renaming one, or changing the signature of an existing one is
breaking. This is a deliberate decision, not an oversight. These interfaces exist
to be extended — an extension point that can never gain a member without a major
release is not an extension point — and every hook this package has added since
v0.7.1 is optional, so a host that does not implement the new name is unaffected.

One case is not covered by that, and it is the same one that bit `WsLike.close`:
if a host already has a member of the new name with an incompatible shape, adding
it here stops that host compiling. Optional does not help — the conflict is the
name, not the presence. A release adding a hook should therefore prefer a name
unlikely to collide, and treat a report of such a collision as a real break.

The known cost, stated rather than hidden: a consumer that enumerates the
interface exhaustively — `Record<keyof MuxHooks, ...>`, or a mapped type over its
keys — does stop compiling when a member is added. That pattern is asserting the
member list is complete, which is the one thing an extension point cannot promise.
Such a consumer should key off the members it actually uses. If you need the
complete-set guarantee, pin the `-dist` tag; the artifact at a tag never changes.

`AppAdapters.sendSubmissionKeys` is the optional composer-submission transport.
`SessionView` and `EmbedView` use it for `submitPlan` steps only; raw terminal,
desktop-key, direct-mode, D-pad, and non-submitting shortcut input stays on
`sendKeys` or its singleton fallback. The shell awaits each promise returned by
the submission transport before starting the next step. That acknowledgement
satisfies the following planned delay, while a synchronous return retains the
delay. When the adapter is omitted, the existing delayed `sendKeys`/singleton
submission path and its byte order remain in use. The app view tests pin both
routes, and the frozen app consumer omits the adapter to exercise the additive
case.

## Deprecation policy

1. **Apply all stamps in one release.** A deprecated name must receive all of
   the following in the same release:

   - JSDoc in the emitted declaration with the form
     `@deprecated since vX.Y.Z — use <replacement>; removal no earlier than vA.B.C`;
   - a deprecated manifest entry with `since`, `removeNoEarlierThan`, and
     `replacement` fields;
   - a `Deprecated` entry in `CHANGELOG.md`; and
   - for a function or class, a `warnDeprecated()` call that logs
     `[thumbmux] <key> is deprecated since vX.Y.Z — use <replacement>; removal no earlier than vA.B.C`
     only once per key per process.

   A type has no runtime call, so it uses the first three stamps. Declaration
   emission, `scripts/contract-check.ts`, changelog review, and
   `core/src/deprecate.test.ts` check the four stamps.

2. **Keep a measurable removal window.** Before 1.0, a name deprecated in
   0.8.x cannot be removed before v0.9.0 and must remain usable with its warning
   for at least one complete minor line. After 1.0, removal is allowed only in
   the next major, and that major cannot ship until at least two minor releases
   have shipped after the deprecation. The manifest's `since` and
   `removeNoEarlierThan` fields make early removal fail the surface gate; tag and
   changelog history prove that the required minor releases occurred.

3. **A rename keeps an alias.** The old and new exported names must coexist for
   the entire removal window. The manifest contains both names, the surface gate
   rejects early disappearance, and frozen consumers keep compiling the old
   spelling.

4. **Wire changes are additive-only.** Across the compatibility interval from
   0.8.x through 1.x, a newer server must accept messages produced by older
   clients. Existing wire fields cannot be removed, renamed, or repurposed; new
   fields must be optional, and readers must tolerate fields they do not know.
   The v0.7.1 wire goldens, old-reader validation in
   `server/tests/protocol-goldens.test.ts`, and protocol conformance tests turn a
   violation red.

5. **D values change only through a minor release.** A D-tier value cannot
   change in a patch. A minor that changes it must record the change under
   `Changed defaults` in `CHANGELOG.md`. The manifest identifies which values
   use this rule; the relevant default test or frozen consumer and changelog
   review enforce the boundary.

6. **Consumer fixtures are frozen policy.** A file under
   `contract/fixtures/` may change only in the same change as a corresponding
   manifest update and the stamping and timing ceremony in items 1 and 2. A
   review must reject a fixture diff without that manifest diff. The unchanged
   fixtures are then rebuilt and run by `scripts/contract-fixtures.sh` against
   the release artifact.

## What "breaking" means here

The following are breaking changes even when source-level unit tests have been
updated to pass:

| Change | What exposes it |
| --- | --- |
| Removing an F export or changing its public signature | Its checked-in manifest entry differs from the declarations built into `git-dist`, so the surface gate fails. |
| Removing or changing an existing prop of an F component | The component props signature differs in the surface gate, and the frozen app consumer may stop compiling or running. |
| Removing, renaming, changing the type of, or repurposing an existing wire-frame field | The old message/frame goldens or old-reader test fails; changing the golden invokes the contract ceremony rather than erasing the break. |
| Changing semantics pinned by a conformance test, wire golden, or frozen consumer | The corresponding assertion fails. Updating that assertion is evidence of a contract change, not evidence that the change is compatible. |
| Changing a documented default | The test or frozen consumer that records the default fails. The only exception is a D value changed in a minor release with the `Changed defaults` ceremony. A public default must have such a test or fixture before it is treated as guaranteed. |

New exported names and new optional component props are additive minor changes,
but they still require an intentional manifest entry. A new wire field is
additive only when it is optional and unknown-field-tolerant; the surface or
wire gate must pass before release.

## Consumer upgrade playbook

Pin one exact, published `vX.Y.Z-dist` tag. Do not pin `main`, a source tag, a
branch, or a floating version range. Then upgrade in this order:

1. Read the target tag's `CHANGELOG.md`, especially its `Breaking` and
   `Deprecated` sections.
2. Change the dependency pin and lockfile to the selected `-dist` tag, then
   reinstall dependencies.
3. Run the consumer's full typecheck.
4. Exercise the consumer and capture its browser and server console output.
5. Search that output for warnings matching `\[thumbmux\].*deprecated`, and
   replace each reported name before its recorded removal release.

Publishing a different thumbmux release cannot change the bytes selected by an
unchanged exact `-dist` pin. Therefore a consumer that keeps the same exact pin
and resolved commit cannot break merely because thumbmux published something
newer. The release workflow creates a new tag without force, and the consumer
lockfile records the selected commit. This guarantee is about thumbmux release
publication; changes to the consumer, its runtime, peer dependencies, or its
lockfile remain outside it.

## Known non-guarantees

- **`thumbmux/app` is stabilizing.** Every export in that subpath is S for the
  whole 0.8.x line, so it is not frozen before 1.0. It may change only at a minor
  boundary under the S alias/deprecation rule. The surviving app surface is
  intended to freeze only after the reference consumer's migration gate above
  passes. The app manifest and surface gate expose any earlier or unannounced
  change.
- **X means experimental.** An X name may change or disappear at a minor
  release without deprecation. Its intentional X manifest entry is the warning;
  consumers that require compatibility must not build on it as though it were F.
- **Preferences are single-tenant.** `createPrefsHandler({ file })` stores one
  JSON document shared by every request that the host routes to that handler. It
  performs no authentication and does not partition by `TokenPrincipal`;
  `prefs-read` and `prefs-write` protect access to the shared document only.
  `TokenPrincipal` has no stable subject identifier, and scope, expiry, and
  session allowlists collide or rotate rather than identify a user, so a
  multi-user host must provide its own identity-backed preferences store. The
  public option/principal declaration shapes, `server/tests/prefs-handler.test.ts`,
  `server/tests/token-guard.test.ts`, and the decision recorded in commit
  `594b87c` make this boundary auditable.
- **The cookie name is not permanent across majors.** `createTokenGuard`
  currently defaults `cookieName` to `tmux_demo_t`. Changing that default would
  break existing hosts, so it remains pinned through 0.8.x and 1.x and is only a
  candidate for reconsideration at 2.0, not a promise that 2.0 will change it.
  Hosts may set `cookieName` explicitly now. `server/tests/token-guard.test.ts`
  pins the current default; the documented-default rule makes an earlier change
  breaking.
