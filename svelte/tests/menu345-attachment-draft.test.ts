/**
 * W3-I1 · A20 + A22 — hold attachments before sending them.
 *
 * The whole point of AttachmentDraftPicker is what it does *not* do: no
 * request when a file is picked or pasted. These tests pin that, plus the
 * object-URL lifecycle (remove / clear / prop re-seed / unmount), and they
 * re-assert that UploadAction's send-immediately default is untouched.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import AttachmentDraftPicker from "../src/AttachmentDraftPicker.svelte";
import AttachmentDraftHost from "./AttachmentDraftHost.svelte";
import UploadAction from "../src/UploadAction.svelte";
import {
  acceptableDraftFiles,
  appendDraftFiles,
  attachmentLabel,
  createDraftItems,
  draftFileName,
  draftFilesOf,
  fileMatchesAccept,
  imageFilesFromClipboard,
  loadAnnotationImage,
  releaseDraftItems,
  removeDraftItem,
  syncDraftItems,
  type AnnotationImageHandlers,
  type AnnotationImageLike,
  type ObjectUrlPorts,
} from "../src/attachment-draft";

type PickerInstance = {
  open(): void;
  addFiles(files: File[] | FileList): void;
  acceptPaste(event: ClipboardEvent): boolean;
  clear(): void;
  currentFiles(): File[];
};

type Mounted = {
  app: PickerInstance;
  target: HTMLElement;
  input: HTMLInputElement;
};

const mounted: Array<{ app: unknown; target: HTMLElement }> = [];
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let created: string[] = [];
let revoked: string[] = [];
let fetchCalls: Array<{ input: string; init?: RequestInit }> = [];

function imageFile(name: string, type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

/** Records every object URL so a leak shows up as an unrevoked entry. */
function installUrlSpies(): void {
  let counter = 0;
  URL.createObjectURL = ((_blob: Blob) => {
    counter += 1;
    const url = `blob:draft/${counter}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
}

function recordingPorts(): ObjectUrlPorts & { created: string[]; revoked: string[] } {
  const createdHere: string[] = [];
  const revokedHere: string[] = [];
  let counter = 0;
  return {
    created: createdHere,
    revoked: revokedHere,
    createObjectURL: () => {
      counter += 1;
      const url = `blob:unit/${counter}`;
      createdHere.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedHere.push(url);
    },
  };
}

/** Keep image completion under the test's control, including after cancellation. */
function pendingImageLoad(handlers: AnnotationImageHandlers) {
  const ports = recordingPorts();
  const image: AnnotationImageLike = {
    width: 0, height: 0, src: "", onload: null, onerror: null,
  };
  const load = loadAnnotationImage(imageFile("broken.png"), {
    ...ports,
    createImage: () => image,
  }, handlers);
  expect(ports.created).toHaveLength(1);
  expect(image.src).toBe(ports.created[0]!);
  expect(image.onerror).toBeFunction();
  return { ports, image, load };
}

/** A fetch that must never be called; every call is recorded and fails loudly. */
function installFetchTripwire(): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input: String(input), init });
      return Response.json({ files: [{ stored: "unexpected.png" }] });
    }) as typeof fetch,
  });
}

function mountPicker(props: {
  files?: File[];
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onChange: (files: File[]) => void;
}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: PickerInstance;
  flushSync(() => {
    app = mount(AttachmentDraftPicker, { target, props }) as unknown as PickerInstance;
  });
  const input = target.querySelector<HTMLInputElement>('[data-testid="attachment-draft-input"]');
  if (!input) throw new Error("picker did not render its file input");
  mounted.push({ app, target });
  return { app, target, input };
}

type HostInstance = {
  /** Moves the `files` prop after mount — what no test did before W3-I1b. */
  setFiles(next: File[]): void;
  currentProp(): File[];
  inner(): PickerInstance;
};

type MountedHost = {
  host: HostInstance;
  target: HTMLElement;
  input: HTMLInputElement;
};

/** Mounts the picker underneath a host that can hand it a different array. */
function mountHost(props: {
  initialFiles?: File[];
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onChange: (files: File[]) => void;
}): MountedHost {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let host!: HostInstance;
  flushSync(() => {
    host = mount(AttachmentDraftHost, { target, props }) as unknown as HostInstance;
  });
  const input = target.querySelector<HTMLInputElement>('[data-testid="attachment-draft-input"]');
  if (!input) throw new Error("picker did not render its file input");
  mounted.push({ app: host, target });
  return { host, target, input };
}

function thumbUrls(target: HTMLElement): string[] {
  return Array.from(
    target.querySelectorAll<HTMLImageElement>('[data-testid="attachment-draft-thumb"]'),
  ).map((node) => node.getAttribute("src") ?? "");
}

function chooseFiles(input: HTMLInputElement, files: File[]): void {
  const fileList = input.files;
  if (!fileList) throw new Error("file input has no FileList");
  (fileList as unknown as File[]).push(...files);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function pasteEvent(
  items: Array<{ kind: string; type: string; file: File | null }>,
): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file,
      })),
    },
  });
  return event;
}

function itemNames(target: HTMLElement): string[] {
  return Array.from(target.querySelectorAll('[data-testid="attachment-draft-name"]')).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  created = [];
  revoked = [];
  fetchCalls = [];
  installUrlSpies();
  installFetchTripwire();
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  } else {
    delete (globalThis as { fetch?: unknown }).fetch;
  }
});

describe("attachment-draft helpers", () => {
  test("names a clipboard file from its type and labels non-images by extension", () => {
    const pasted = new File([new Uint8Array([1])], "", { type: "image/webp" });
    expect(draftFileName(pasted, 2, 1_700_000_000_000)).toBe("pasted-1700000000000-2.webp");
    expect(draftFileName(imageFile("shot.png"), 0, 1)).toBe("shot.png");
    expect(attachmentLabel("report.pdf")).toBe("PDF");
    expect(attachmentLabel("archive.tar.gz")).toBe("GZ");
    expect(attachmentLabel("LICENSE")).toBe("FILE");
  });

  test("syncDraftItems keeps surviving URLs and revokes only what left", () => {
    const ports = recordingPorts();
    const keep = imageFile("keep.png");
    const drop = imageFile("drop.png");
    const items = createDraftItems([keep, drop], ports);
    const keptUrl = items[0]!.url;
    const droppedUrl = items[1]!.url;

    const added = imageFile("added.png");
    const next = syncDraftItems(items, [keep, added], ports);

    expect(draftFilesOf(next)).toEqual([keep, added]);
    expect(next[0]!.url).toBe(keptUrl);
    expect(ports.revoked).toEqual([droppedUrl]);
    expect(ports.created).toHaveLength(3);
  });

  test("removeDraftItem revokes exactly one URL and release revokes the rest", () => {
    const ports = recordingPorts();
    const items = createDraftItems([imageFile("a.png"), imageFile("b.png")], ports);
    const survivors = removeDraftItem(items, items[0]!.id, ports);

    expect(ports.revoked).toEqual([items[0]!.url]);
    expect(survivors).toHaveLength(1);

    releaseDraftItems(survivors, ports);
    expect(ports.revoked).toEqual([items[0]!.url, items[1]!.url]);
  });

  test("appendDraftFiles never re-creates a URL for what is already in the draft", () => {
    const ports = recordingPorts();
    const first = createDraftItems([imageFile("a.png")], ports);
    const grown = appendDraftFiles(first, [imageFile("b.png")], ports);

    expect(grown[0]!.url).toBe(first[0]!.url);
    expect(ports.created).toHaveLength(2);
    expect(ports.revoked).toEqual([]);
    expect(appendDraftFiles(grown, [], ports)).toBe(grown);
  });

  test("accept filtering follows the input grammar and multiple=false keeps one", () => {
    const png = imageFile("a.png");
    const pdf = new File([new Uint8Array([1])], "b.pdf", { type: "application/pdf" });

    expect(fileMatchesAccept(png, "image/*")).toBe(true);
    expect(fileMatchesAccept(pdf, "image/*")).toBe(false);
    expect(fileMatchesAccept(pdf, ".pdf")).toBe(true);
    expect(fileMatchesAccept(pdf, "application/pdf")).toBe(true);
    expect(fileMatchesAccept(pdf, undefined)).toBe(true);

    expect(acceptableDraftFiles([png, pdf], { accept: "image/*" })).toEqual([png]);
    expect(acceptableDraftFiles([png, pdf], { multiple: false })).toEqual([png]);
  });

  test("clipboard scan takes image files only", () => {
    const png = imageFile("clip.png");
    const files = imageFilesFromClipboard([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "application/pdf", getAsFile: () => new File([], "x.pdf") },
      { kind: "file", type: "image/png", getAsFile: () => png },
      { kind: "file", type: "image/jpeg", getAsFile: () => null },
    ]);
    expect(files).toEqual([png]);
  });
});

describe("attachment-draft · image error lifecycle", () => {
  test("an error after cancel calls neither handler and does not revoke twice", () => {
    const onLoad = mock(() => {});
    const onError = mock(() => {});
    const { ports, image, load } = pendingImageLoad({ onLoad, onError });

    load.cancel();
    expect(ports.revoked).toEqual([image.src]);
    // Invoke the installed handler: optional chaining could hide missing wiring.
    image.onerror!();

    expect(onError).toHaveBeenCalledTimes(0);
    expect(onLoad).toHaveBeenCalledTimes(0);
    expect(ports.revoked).toEqual([image.src]);
    load.release();
    expect(ports.revoked).toEqual([image.src]);
  });

  test("an error without an onError callback releases the URL and never reports a load", () => {
    const onLoad = mock(() => {});
    const { ports, image, load } = pendingImageLoad({ onLoad });

    expect(ports.revoked).toEqual([]);
    image.onerror!();
    expect(onLoad).toHaveBeenCalledTimes(0);
    expect(ports.revoked).toEqual([image.src]);

    load.cancel();
    load.release();
    expect(ports.revoked).toEqual([image.src]);
  });
});

describe("AttachmentDraftPicker", () => {
  test("picking files sends nothing and reports plain File[]", async () => {
    const changes: File[][] = [];
    const { app, target, input } = mountPicker({ onChange: (files) => changes.push(files) });
    await tick();

    const png = imageFile("shot.png");
    const pdf = new File([new Uint8Array([1])], "notes.pdf", { type: "application/pdf" });
    chooseFiles(input, [png, pdf]);
    flushSync();
    await tick();

    expect(fetchCalls).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([png, pdf]);
    // Exactly File objects — no ids, urls or host metadata smuggled alongside.
    expect(changes[0]![0]).toBe(png);
    expect(Object.keys(changes[0]![0] as unknown as object)).toEqual([]);
    expect(app.currentFiles()).toEqual([png, pdf]);

    expect(itemNames(target)).toEqual(["shot.png", "notes.pdf"]);
    expect(target.querySelectorAll('[data-testid="attachment-draft-thumb"]')).toHaveLength(1);
    expect(target.querySelector('[data-testid="attachment-draft-badge"]')?.textContent?.trim()).toBe(
      "PDF",
    );
    expect(created).toHaveLength(2);
    expect(input.value).toBe("");
  });

  test("pasting an image is taken without a request; a text paste is declined", async () => {
    const changes: File[][] = [];
    const { app } = mountPicker({ onChange: (files) => changes.push(files) });
    await tick();

    const pasted = new File([new Uint8Array([9])], "", { type: "image/png" });
    expect(app.acceptPaste(pasteEvent([{ kind: "file", type: "image/png", file: pasted }]))).toBe(
      true,
    );
    flushSync();
    await tick();

    expect(fetchCalls).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([pasted]);

    expect(app.acceptPaste(pasteEvent([{ kind: "string", type: "text/plain", file: null }]))).toBe(
      false,
    );
    expect(changes).toHaveLength(1);
  });

  test("remove gives back that one preview URL and reports the survivors", async () => {
    const changes: File[][] = [];
    const { target, input } = mountPicker({ onChange: (files) => changes.push(files) });
    await tick();

    const first = imageFile("first.png");
    const second = imageFile("second.png");
    chooseFiles(input, [first, second]);
    flushSync();
    await tick();

    const removeButtons = target.querySelectorAll<HTMLButtonElement>(
      '[data-testid="attachment-draft-remove"]',
    );
    expect(removeButtons).toHaveLength(2);
    removeButtons[0]!.click();
    flushSync();
    await tick();

    expect(revoked).toEqual([created[0]!]);
    expect(itemNames(target)).toEqual(["second.png"]);
    expect(changes.at(-1)).toEqual([second]);
    expect(fetchCalls).toEqual([]);
  });

  test("clear() empties the draft and revokes every URL it still held", async () => {
    const changes: File[][] = [];
    const { app, target, input } = mountPicker({ onChange: (files) => changes.push(files) });
    await tick();

    chooseFiles(input, [imageFile("a.png"), imageFile("b.png")]);
    flushSync();
    await tick();

    app.clear();
    flushSync();
    await tick();

    expect(revoked.sort()).toEqual([...created].sort());
    expect(itemNames(target)).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  test("unmount revokes the URLs of everything still pending", async () => {
    const { app, target, input } = mountPicker({ onChange: () => {} });
    await tick();

    chooseFiles(input, [imageFile("a.png"), imageFile("b.png")]);
    flushSync();
    await tick();
    expect(revoked).toEqual([]);

    const entry = mounted.pop()!;
    unmount(app);
    entry.target.remove();
    flushSync();

    expect(revoked.sort()).toEqual([...created].sort());
    expect(target.querySelectorAll('[data-testid="attachment-draft-item"]')).toHaveLength(0);
  });

  test("disabled blocks picking, pasting and removing", async () => {
    const changes: File[][] = [];
    const { app, target, input } = mountPicker({
      files: [imageFile("seeded.png")],
      disabled: true,
      onChange: (files) => changes.push(files),
    });
    await tick();

    expect(input.disabled).toBe(true);
    app.addFiles([imageFile("late.png")]);
    expect(app.acceptPaste(pasteEvent([{ kind: "file", type: "image/png", file: imageFile("p.png") }]))).toBe(
      false,
    );
    flushSync();
    await tick();

    expect(changes).toEqual([]);
    expect(itemNames(target)).toEqual(["seeded.png"]);
    expect(
      target.querySelector<HTMLButtonElement>('[data-testid="attachment-draft-remove"]')!.disabled,
    ).toBe(true);
  });

  test("accept and multiple=false narrow what the draft will take", async () => {
    const changes: File[][] = [];
    const { app, target } = mountPicker({
      accept: "image/*",
      multiple: false,
      onChange: (files) => changes.push(files),
    });
    await tick();

    const png = imageFile("one.png");
    app.addFiles([new File([new Uint8Array([1])], "no.pdf", { type: "application/pdf" }), png]);
    flushSync();
    await tick();
    expect(changes.at(-1)).toEqual([png]);

    const replacement = imageFile("two.png");
    app.addFiles([replacement]);
    flushSync();
    await tick();

    expect(changes.at(-1)).toEqual([replacement]);
    expect(itemNames(target)).toEqual(["two.png"]);
    // The replaced file's preview URL went back before the new one appeared.
    expect(revoked).toEqual([created[0]!]);
  });

  test("UploadAction keeps its send-immediately default — the split is real", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ input: String(input), init });
        return Response.json({ files: [{ original: "a.png", stored: "srv-a.png" }] });
      }) as typeof fetch,
    });

    const target = document.createElement("div");
    document.body.appendChild(target);
    let app!: unknown;
    const uploaded: string[] = [];
    flushSync(() => {
      app = mount(UploadAction, {
        target,
        props: { onUploaded: (message: string) => uploaded.push(message), onError: () => {} },
      });
    });
    mounted.push({ app, target });

    const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]')!;
    chooseFiles(input, [imageFile("a.png")]);
    // The upload chain is several awaits deep; drain until it settles.
    for (let i = 0; i < 10 && uploaded.length === 0; i += 1) await tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.input).toBe("/api/upload");
    expect(uploaded).toHaveLength(1);
  });
});

/**
 * W3-I1b — the `files` prop moving *after* mount.
 *
 * The re-seed `$effect` in AttachmentDraftPicker had no test walking into it:
 * every earlier test passed `files` once, at mount, where the effect's first
 * run always takes the `incoming === known` early return. Proof: a `throw`
 * placed inside the branch left all 31 tests green. These three lock what the
 * host actually sees, and they count `onChange` calls instead of reading
 * `changes.at(-1)` — the old shape cannot see a call that should not exist.
 */
describe("AttachmentDraftPicker · host moves the files prop", () => {
  test("a new array from the host re-seeds the draft and fires onChange zero times", async () => {
    const changes: File[][] = [];
    const kept = imageFile("kept.png");
    const dropped = imageFile("dropped.png");
    const { host, target, input } = mountHost({ onChange: (files) => changes.push(files) });
    await tick();

    chooseFiles(input, [kept, dropped]);
    flushSync();
    await tick();
    expect(changes).toHaveLength(1);
    expect(created).toHaveLength(2);
    const keptUrl = created[0]!;
    const droppedUrl = created[1]!;

    // The host swaps in a different array: one file survives, one leaves, one is new.
    const arrived = imageFile("arrived.png");
    host.setFiles([kept, arrived]);
    flushSync();
    await tick();

    expect(itemNames(target)).toEqual(["kept.png", "arrived.png"]);
    expect(host.inner().currentFiles()).toEqual([kept, arrived]);
    // Count, not last value: a re-seed that reported itself back would be a loop.
    expect(changes).toHaveLength(1);
    expect(fetchCalls).toEqual([]);
    // The survivor keeps its preview URL; only the file that left gave one back.
    expect(created).toHaveLength(3);
    expect(thumbUrls(target)).toEqual([keptUrl, created[2]!]);
    expect(revoked).toEqual([droppedUrl]);

    // The re-seeded list is what unmount now owns — no double revoke of the dropped one.
    const entry = mounted.pop()!;
    unmount(entry.app);
    entry.target.remove();
    flushSync();
    expect(revoked).toEqual([droppedUrl, keptUrl, created[2]!]);
  });

  test("the array from onChange handed straight back does not re-seed and stays silent", async () => {
    const changes: File[][] = [];
    const { host, target, input } = mountHost({ onChange: (files) => changes.push(files) });
    await tick();

    chooseFiles(input, [imageFile("a.png"), imageFile("b.png")]);
    flushSync();
    await tick();
    expect(changes).toHaveLength(1);
    const echoed = changes[0]!;
    const urlsBefore = thumbUrls(target);
    expect(urlsBefore).toEqual([created[0]!, created[1]!]);

    // A controlled host mirrors onChange into its own state — that array comes
    // straight back as the prop, and must not be treated as a new instruction.
    host.setFiles(echoed);
    flushSync();
    await tick();

    expect(host.currentProp()).toBe(echoed);
    expect(itemNames(target)).toEqual(["a.png", "b.png"]);
    expect(host.inner().currentFiles()).toEqual(echoed);
    expect(changes).toHaveLength(1);
    // No preview URL was re-created and none was handed back.
    expect(created).toHaveLength(2);
    expect(revoked).toEqual([]);
    expect(thumbUrls(target)).toEqual(urlsBefore);
    expect(fetchCalls).toEqual([]);
  });

  test("host empties the draft with [] after a send — list clears, every URL comes back", async () => {
    const changes: File[][] = [];
    const { host, target, input } = mountHost({ onChange: (files) => changes.push(files) });
    await tick();

    chooseFiles(input, [imageFile("one.png"), imageFile("two.png")]);
    flushSync();
    await tick();
    expect(changes).toHaveLength(1);
    expect(created).toHaveLength(2);

    // What a host does once its own upload succeeded: hand back an empty draft.
    host.setFiles([]);
    flushSync();
    await tick();

    expect(itemNames(target)).toEqual([]);
    expect(target.querySelector('[data-testid="attachment-draft-list"]')).toBeNull();
    expect(host.inner().currentFiles()).toEqual([]);
    expect(revoked.sort()).toEqual([...created].sort());
    // Emptying the draft is the host telling us, not us telling the host.
    expect(changes).toHaveLength(1);
    expect(fetchCalls).toEqual([]);

    // Nothing is left to revoke a second time on unmount.
    const entry = mounted.pop()!;
    unmount(entry.app);
    entry.target.remove();
    flushSync();
    expect(revoked.sort()).toEqual([...created].sort());
  });
});
