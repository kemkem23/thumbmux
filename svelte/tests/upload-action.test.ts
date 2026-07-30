import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import UploadAction from "../src/UploadAction.svelte";

type UploadedFile = { original: string; stored: string };
type UploadActionInstance = {
  open(): void;
  uploadFiles(files: File[] | FileList): Promise<void>;
};
type UploadActionProps = {
  endpoint?: string;
  dir?: string;
  accept?: string;
  busy?: boolean;
  onUploaded: (message: string, files: UploadedFile[]) => void;
  onError: (message: string) => void;
};
type Mounted = {
  app: Record<string, unknown>;
  input: HTMLInputElement;
  target: HTMLElement;
};

const mounted: Mounted[] = [];
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function replaceFetch(fetchImpl: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });
}

function mountUploadAction(overrides: Partial<UploadActionProps> = {}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const props: UploadActionProps = {
    onUploaded: () => {},
    onError: () => {},
    ...overrides,
  };

  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(UploadAction, { target, props }) as Record<string, unknown>;
  });

  const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]');
  if (!input) throw new Error("UploadAction did not render its file input");

  const entry = { app, input, target };
  mounted.push(entry);
  return entry;
}

function chooseFiles(input: HTMLInputElement, files: File[]): void {
  const fileList = input.files;
  if (!fileList) throw new Error("file input has no FileList");
  (fileList as unknown as File[]).push(...files);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

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

  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  }
});

describe("UploadAction", () => {
  test("mounts as a real Svelte component", async () => {
    const { input, target } = mountUploadAction();
    await tick();

    expect(target.querySelectorAll('[data-testid="upload-input"]')).toHaveLength(1);
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
  });

  test("uses the endpoint prop, uploads every selected file, and falls back to the prop dir", async () => {
    const endpoint = "/tenant/acme/attachments";
    const fallbackDir = "remote-artifacts";
    const storedByServer: UploadedFile[] = [
      { original: "alpha note.txt", stored: "srv-a81_alpha-note.txt" },
      { original: "diagram.png", stored: "srv-b29_diagram.png" },
    ];
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

    replaceFetch((async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return Response.json({ ok: true, files: storedByServer }, { status: 201 });
    }) as typeof fetch);

    let resolveUploaded!: (result: { message: string; files: UploadedFile[] }) => void;
    const uploaded = new Promise<{ message: string; files: UploadedFile[] }>((resolve) => {
      resolveUploaded = resolve;
    });
    const uploadResults: Array<{ message: string; files: UploadedFile[] }> = [];

    const { input } = mountUploadAction({
      endpoint,
      dir: fallbackDir,
      onUploaded: (message, files) => {
        const result = { message, files };
        uploadResults.push(result);
        resolveUploaded(result);
      },
    });

    const selectedFiles = [
      new File(["first payload"], "alpha note.txt", { type: "text/plain" }),
      new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", { type: "image/png" }),
    ];
    chooseFiles(input, selectedFiles);
    const result = await uploaded;

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe(endpoint);
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    const body = fetchCalls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).getAll("files")).toHaveLength(selectedFiles.length);

    expect(uploadResults).toHaveLength(1);
    expect(result.files).toEqual(storedByServer);
    for (const stored of storedByServer) {
      expect(result.message).toContain(`${fallbackDir}/${stored.stored}`);
    }
  });

  test("prefers the server dir over the fallback dir in the uploaded message", async () => {
    const fallbackDir = "stale-client-dir";
    const serverDir = "server-owned-dir";
    const storedByServer: UploadedFile = {
      original: "report.txt",
      stored: "srv-report.txt",
    };
    const uploadResults: Array<{ message: string; files: UploadedFile[] }> = [];

    replaceFetch((async () =>
      Response.json(
        { ok: true, files: [storedByServer], dir: serverDir },
        { status: 201 },
      )) as typeof fetch);

    const { app } = mountUploadAction({
      dir: fallbackDir,
      onUploaded: (message, files) => uploadResults.push({ message, files }),
    });

    await (app as UploadActionInstance).uploadFiles([
      new File(["payload"], "report.txt", { type: "text/plain" }),
    ]);

    expect(uploadResults).toHaveLength(1);
    expect(uploadResults[0]?.files).toEqual([storedByServer]);
    expect(uploadResults[0]?.message).toContain(`${serverDir}/${storedByServer.stored}`);
    expect(uploadResults[0]?.message).not.toContain(`${fallbackDir}/${storedByServer.stored}`);
  });

  for (const response of [
    {
      status: 413,
      make: () => Response.json({ error: "upstream attachment limit exceeded" }, { status: 413 }),
      expectedError: "upstream attachment limit exceeded",
    },
    {
      status: 400,
      make: () => new Response("not-json", { status: 400 }),
      expectedError: "HTTP 400",
    },
  ]) {
    test(`surfaces ${response.status} errors without reporting an upload`, async () => {
      let fetchCount = 0;
      const uploadResults: Array<{ message: string; files: UploadedFile[] }> = [];
      const surfacedErrors: string[] = [];

      replaceFetch((async () => {
        fetchCount += 1;
        return response.make();
      }) as typeof fetch);

      const { app } = mountUploadAction({
        onUploaded: (message, files) => uploadResults.push({ message, files }),
        onError: (message) => surfacedErrors.push(message),
      });

      await (app as UploadActionInstance).uploadFiles([
        new File(["rejected payload"], "too-large.bin"),
      ]);

      expect(fetchCount).toBe(1);
      expect(uploadResults).toHaveLength(0);
      expect(surfacedErrors).toEqual([response.expectedError]);
    });
  }

  test("does not fetch for an empty upload or a cancelled picker", async () => {
    let fetchCount = 0;
    replaceFetch((async () => {
      fetchCount += 1;
      throw new Error("empty selections must not reach fetch");
    }) as typeof fetch);

    const { app, input } = mountUploadAction();
    const instance = app as UploadActionInstance;

    await instance.uploadFiles([]);
    instance.open();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    expect(fetchCount).toBe(0);
  });
});
