# Pre-send drafts, session metadata and the theme-source switch

New in **v0.20.0** (tier `S` — optional, additive, no migration).

Five names land together because they are the pieces a host writes by hand
around a terminal session: the row that says *where* the session is, the switch
that says *whose* colours it wears, and the two panels that hold an attachment
or an annotated screenshot *before* it is sent. A sixth name, `matchesTextQuery`,
is the filter those lists and menus all re-implemented.

Everything here is presentation plus a small instance API. **No component in
this file performs a network request, reads the clipboard, probes a permission,
touches `localStorage`, or knows what an agent, topic or provider is.** The host
keeps all of that. A component hands you a `Blob`, a `File[]`, or a callback —
never a URL, a receipt, or a path under `uploads/`.

## `matchesTextQuery` — `thumbmux/core`

```ts
import { matchesTextQuery, type TextQueryOptions } from 'thumbmux/core';

matchesTextQuery('Izmir SKILLS', 'kill');   // true  — substring, not prefix
matchesTextQuery('Izmir', ' izmir');        // false — the query is not trimmed
matchesTextQuery('Izmir', ' izmir', { trimQuery: true }); // true
```

Lowercase on both sides, then `includes`. That is the whole algorithm, and it is
deliberately the same one the hosts already had: this release is a lift, not a
behaviour change. Three consequences worth stating out loud, because each one is
a place a caller might expect more than it gets.

Regex metacharacters are literal — `'[0.19'` matches `'v[0.19.0'` and there is no
pattern language to escape. The **haystack is never trimmed**, in either mode;
only `trimQuery` moves, and it defaults to `false` so the drop-in replacement
keeps a leading-space query failing exactly as it did before. And a non-string
`text` or `query` is not coerced at runtime, because the code being lifted did
not coerce either.

`TextQueryOptions` is the paired type. There is no `isBlankQuery` helper: a
caller that wants "empty query shows everything" still writes that guard itself,
which is what the existing call sites do.

## `SessionMetadata` — `thumbmux/svelte`

The cwd row and the last-activity row.

```svelte
<SessionMetadata cwd={session.cwd} activityLabel="ขยับล่าสุด 3 นาทีที่แล้ว" />
```

`cwd` and `activityLabel` are both optional, and **when both are absent the
component renders nothing at all** rather than leaving an empty frame. The full
path is kept in the DOM as a `title`, so truncation is a CSS concern
(`text-overflow: ellipsis`) and a host copying from the node still gets the whole
path — a sliced string would have silently destroyed it. Pass `activityDatetime`
to get a machine-readable `<time datetime>`; omit it and you get a plain `<span>`.

## `ThemeSourceChoice` — `thumbmux/svelte`

The two-state "session colours / agent colours" control.

```svelte
<ThemeSourceChoice
  enabled={usingAgentColours}
  offLabel="สีเดิมของ session"
  onLabel="ทำสีตาม agent"
  onChange={(next) => (usingAgentColours = next)}
/>
```

`offLabel`, `onLabel` and `onChange` are required; everything else is optional.
Selected state derives from `enabled` alone and is published twice — as
`class:on` for the host's existing CSS and as `aria-pressed` for assistive tech
and tests. **Pressing the side that is already selected does not call
`onChange`**, so a host that persists on every callback does not write a no-op.
The `hint` string is host-supplied; the component does not know that CC, CODEX
and GROK exist.

## `AttachmentDraftPicker` — `thumbmux/svelte`

A pre-send list of files the user has chosen but not yet sent.

Props: `files?: File[]` (pass a new array to re-seed — `[]` after a send),
`accept?`, `multiple?`, `disabled?`, and the required
`onChange: (files: File[]) => void`, which fires on every draft change and hands
back plain `File[]` — no ids, no URLs, no host metadata.

Instance API, shaped after the existing `UploadAction.open()`:
`open()`, `addFiles(File[] | FileList)`, `acceptPaste(ClipboardEvent): boolean`,
`clear()`, `currentFiles(): File[]`.

```svelte
<script>
  let picker;
  let drafts = $state([]);
</script>
<AttachmentDraftPicker bind:this={picker} files={drafts} onChange={(f) => (drafts = f)} />
<button onclick={() => picker.open()}>แนบไฟล์</button>
```

**Choosing a file issues no request.** Upload, endpoint choice, filename and hash
policy, and the claim/settle receipt all stay with the host — the picker's job
ends at `currentFiles()`. Its internal `attachment-draft` module is not exported;
if you find yourself wanting it, the thing you want is a reserved public name,
not a reach into a private helper.

## `ImageAnnotator` — `thumbmux/svelte`

A pre-send markup panel: draw on an image, add a comment, submit.

Props: `image?: Blob | null` and `comment?: string` are both `$bindable` — bind
them if you want the draft to survive the panel closing, since REMOVE and CLEAR
set `image` to `null`. `onSubmit` and `onClose` are required.

Instance API: `submit(): Promise<void>`, `clearAll()`, `removeImage()`.

```svelte
<script>
  let draftImage = $state(null);
  let draftComment = $state('');
</script>

<ImageAnnotator
  bind:image={draftImage}
  bind:comment={draftComment}
  onSubmit={({ image, comment }) => send(image, comment)}
  onClose={closePanel}
/>
```

`onSubmit` receives one object — the exported PNG as a `Blob` plus the trimmed
comment — and is awaited before the panel reports success. That is the entire
output. The annotator has **no paste path of its own** — finding images is the
picker's job via `acceptPaste()`, and a host wires the two together. It also
registers no overlay and no mobile back-button entry: it is a bare panel that
your route places inside whatever overlay it already owns.

## What a host still owns after adopting these

Upload transport and endpoints · receipt claim/settle · filename, hashing and
`uploads/` paths · clipboard reads and permission prompts · mobile overlay and
history entries · persistence of the theme choice · which strings appear, in
which language.
