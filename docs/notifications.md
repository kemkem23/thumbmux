# R2-NOTIFY-CONTRACT: `AgentNotificationEvent`

This contract documents `AgentNotificationEvent` as a pure validation and normalization boundary.
`thumbmux` core does not perform any delivery, transport, persistence, provider integration, or authN/Z policy.

## 1) Exact payload shape

`AgentNotificationEvent` always includes four required fields and up to four optional
fields:

- `id` (`string`, required)
- `session` (`string`, required)
- `state` (`"finished"` or `"waiting"`, required)
- `occurredAt` (`number`, required)
- `title` (`string`, optional)
- `body` (`string`, optional)
- `url` (`string`, optional)
- `tag` (`string`, optional)

The core rejects non-object input, non-string keys, missing required keys, and
any field outside this required-plus-optional set.

Use the public `validateAgentNotificationEvent` export from `thumbmux/core` at
the host boundary. It returns the normalized `AgentNotificationEvent` or throws
`AgentNotificationValidationError`:

```ts
import {
  validateAgentNotificationEvent,
  type AgentNotificationEvent,
} from "thumbmux/core";

const event: AgentNotificationEvent = validateAgentNotificationEvent({
  id: crypto.randomUUID(),
  session: "agent-42",
  state: "finished",
  occurredAt: Date.now(),
  title: "Agent finished",
  body: "Review its output.",
  url: "/sessions/agent-42?tab=output",
  tag: "agent-42-finished",
}, { origin: window.location.origin });

console.log(event.url); // canonical same-origin path, query, and hash only
```

`normalizeAgentNotificationEvent` exposes the same normalization contract, and
`sameOriginNotificationUrl` is available when a host needs to check a candidate
URL separately.

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

The browser helpers are exported from `thumbmux/svelte`. This module can be
copied into a browser entry point; the permission call remains synchronous with
the click before its first internal `await`:

```ts
import {
  registerServiceWorker,
  requestNotificationPermission,
  showLocalNotification,
} from "thumbmux/svelte";

const button = document.querySelector<HTMLButtonElement>("#enable-notifications");
if (!button) throw new Error("Missing #enable-notifications button");

button.addEventListener("click", async () => {
  const permission = await requestNotificationPermission();
  if (!permission.ok || permission.value !== "granted") return;

  const worker = await registerServiceWorker({
    scriptURL: "/notification-service-worker.js",
    options: { scope: "/" },
  });
  if (!worker.ok) throw new Error(worker.error.message);

  const shown = await showLocalNotification({
    registration: worker.value.registration,
    payload: {
      id: crypto.randomUUID(),
      session: "agent-42",
      state: "finished",
      occurredAt: Date.now(),
      title: "Agent finished",
      body: "Review its output.",
      url: "/sessions/agent-42",
      tag: "agent-42-finished",
    },
  });
  if (!shown.ok) throw new Error(shown.error.message);
});
```

The host must ship the referenced service-worker script. This example displays
a local notification only; real push additionally needs a provider, subscription
storage, delivery, and service-worker push handling.

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

## 7) Worked app-shell integration

For a host detector → `sessionMeta` → normalized event → browser-helper recipe,
see [Agent needs a human](app.md#4-agent-needs-a-human-feature-12). The provider,
subscription storage, persistence, and delivery boundaries above still apply.
