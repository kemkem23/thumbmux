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
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const mounted: Mounted[] = [];
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const malformedSuccessError =
  "Invalid upload response: expected a non-empty files array with stored paths";

function replaceFetch(fetchImpl: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mountUploadAction(
  overrides: Partial<UploadActionProps> = {},
  configureProps?: (props: UploadActionProps) => void,
): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const props: UploadActionProps = {
    onUploaded: () => {},
    onError: () => {},
    ...overrides,
  };
  configureProps?.(props);

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
    expect(result.message).toBe(
      'Uploaded "alpha note.txt" → remote-artifacts/srv-a81_alpha-note.txt\n' +
        'Uploaded "diagram.png" → remote-artifacts/srv-b29_diagram.png',
    );
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

  for (const malformed of [
    { name: "a missing files key", body: { ok: true } },
    { name: "null files", body: { ok: true, files: null } },
    { name: "an empty files array", body: { ok: true, files: [] } },
    { name: "non-array files", body: { ok: true, files: { stored: "not-an-array.txt" } } },
    {
      name: "a file item without stored",
      body: {
        ok: true,
        files: [
          { original: "valid.txt", stored: "stored-valid.txt" },
          { original: "missing-stored.txt" },
        ],
      },
    },
  ]) {
    test(`rejects a successful response with ${malformed.name}`, async () => {
      const uploadResults: Array<{ message: string; files: UploadedFile[] }> = [];
      const surfacedErrors: string[] = [];

      replaceFetch((async () => Response.json(malformed.body, { status: 201 })) as typeof fetch);

      const { app } = mountUploadAction({
        onUploaded: (message, files) => uploadResults.push({ message, files }),
        onError: (message) => surfacedErrors.push(message),
      });

      await (app as UploadActionInstance).uploadFiles([
        new File(["payload"], "malformed-response.txt", { type: "text/plain" }),
      ]);

      expect(surfacedErrors).toEqual([malformedSuccessError]);
      expect(uploadResults).toHaveLength(0);
    });
  }

  for (const scenario of [
    { outcome: "success", settlementOrder: [0, 1], orderName: "start order" },
    { outcome: "failure", settlementOrder: [1, 0], orderName: "reverse order" },
  ] as const) {
    test(`keeps busy true until concurrent uploads settle with ${scenario.outcome} in ${scenario.orderName}`, async () => {
      const requests = [deferred<Response>(), deferred<Response>()];
      const uploadResults: Array<{ message: string; files: UploadedFile[] }> = [];
      const surfacedErrors: string[] = [];
      let fetchIndex = 0;
      let boundBusy = false;
      const labels = ["first", "second"] as const;

      replaceFetch((async () => requests[fetchIndex++]!.promise) as typeof fetch);

      const { app } = mountUploadAction(
        {
          onUploaded: (message, files) => uploadResults.push({ message, files }),
          onError: (message) => surfacedErrors.push(message),
        },
        (props) => {
          Object.defineProperty(props, "busy", {
            configurable: true,
            enumerable: true,
            get: () => boundBusy,
            set: (value: boolean) => {
              boundBusy = value;
            },
          });
        },
      );
      const instance = app as UploadActionInstance;

      const uploads = [
        instance.uploadFiles([new File(["first"], "first.txt")]),
        instance.uploadFiles([new File(["second"], "second.txt")]),
      ];
      const busyWithBothRequestsPending = boundBusy;
      const fetchCountWithBothRequestsPending = fetchIndex;

      const settle = (request: Deferred<Response>, label: (typeof labels)[number]) => {
        if (scenario.outcome === "success") {
          request.resolve(
            Response.json(
              {
                ok: true,
                files: [{ original: `${label}.txt`, stored: `stored-${label}.txt` }],
              },
              { status: 201 },
            ),
          );
        } else {
          request.reject(new Error(`${label} upload failed`));
        }
      };

      const firstSettledIndex = scenario.settlementOrder[0];
      settle(requests[firstSettledIndex]!, labels[firstSettledIndex]);
      await uploads[firstSettledIndex];
      const busyWhileOtherRequestWasPending = boundBusy;

      const lastSettledIndex = scenario.settlementOrder[1];
      settle(requests[lastSettledIndex]!, labels[lastSettledIndex]);
      await uploads[lastSettledIndex];

      expect(fetchCountWithBothRequestsPending).toBe(2);
      expect(busyWithBothRequestsPending).toBe(true);
      expect(busyWhileOtherRequestWasPending).toBe(true);
      expect(boundBusy).toBe(false);
      expect(uploadResults).toHaveLength(scenario.outcome === "success" ? 2 : 0);
      expect(surfacedErrors).toEqual(
        scenario.outcome === "failure"
          ? scenario.settlementOrder.map((index) => `${labels[index]} upload failed`)
          : [],
      );
    });
  }

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
