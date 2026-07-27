# R2-NOTIFY-CONTRACT: `AgentNotificationEvent`

This contract documents `AgentNotificationEvent` as a pure validation and normalization boundary.
`thumbmux` core does not perform any delivery, transport, persistence, provider integration, or authN/Z policy.

## 1) Exact payload shape

`AgentNotificationEvent` is an object with **exactly eight fields**:

- `id` (`string`, required)
- `session` (`string`, required)
- `state` (`"finished"` or `"waiting"`, required)
- `occurredAt` (`number`, required)
- `title` (`string`, optional)
- `body` (`string`, optional)
- `url` (`string`, optional)
- `tag` (`string`, optional)

The core rejects non-object input and any object with non-string keys, missing required keys, or any field outside this set.

## 2) Bounded, NFC-normalized validation posture

- `id`: NFC+trim, length `1..128` code points.
- `session`: NFC+trim, length `1..256` code points.
- `title`: optional NFC+trim, length `1..160` code points when present.
- `body`: optional NFC+trim, length `1..4096` code points when present.
- `tag`: optional NFC+trim, length `1..128` code points when present.
- `state`: only `"finished"` or `"waiting"`.
- `occurredAt`: must be a safe integer in `[0, 8_640_000_000_000_000]`.
- `url`: length limit is `<= 2048` code points, and accepted only when canonicalized through trusted-origin logic (see below).

`id`, `session`, optional text fields, and `url` are normalized by `trim` +
`normalize("NFC")` prior to validation. `state` is checked as the exact enum;
it is not normalized or inferred. Empty optional strings are omitted from the
normalized payload.

Only plain objects (no class instances, no arrays) and own enumerable data fields are accepted.
Object property descriptors must be ordinary data properties; accessor fields and non-enumerables are rejected.

## 3) URL acceptance and click destination behavior

`url` is accepted only when caller supplies a trusted `origin` and all of the following are true:

- origin is a non-empty `http`/`https` origin with no username/password and no path/query/hash.
- candidate is a valid same-origin URL candidate.
- unsafe candidates are rejected, including `javascript:`, `data:`,
  protocol-relative `//host`, embedded credentials, and cross-origin targets.
- candidate can be resolved to a same-origin destination.

When valid, the URL is returned in canonical internal form:

- `pathname + search + hash`

So click targets are always same-origin path/search/hash only; they can never resolve to an external or credential-bearing destination.

## 4) Host responsibilities (outside core)

The host (and not core) is responsible for:

- detecting agent state transitions,
- deciding dedupe semantics (`id`/`tag` strategy and replay suppression),
- choosing and operating delivery/transport channels,
- isolating and handling provider failures,
- owning all authentication/authorization policy.

Core behavior is intentionally transport-agnostic and does not provide end-to-end delivery guarantees.

## 5) Permission and push behavior boundaries

- Browser notification permission should be requested only on a **real user gesture** by host UI code.
- Demo or local `showNotification` calls are local browser-side behavior only and are **not proof of real push delivery**.

## 6) Explicit exclusions for this module

The core contract is specifically not responsible for:

- terminal-text semantic classification,
- provider integration,
- push subscription database,
- push credentials,
- secret storage,
- persistence,
- network delivery,
- any real-push claim.
