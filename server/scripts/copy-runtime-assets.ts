import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  PIPE_VT_LICENSE_FILE,
  PIPE_VT_VENDOR_FILE,
  PIPE_VT_VENDOR_SHA256,
  PIPE_VT_WORKER_FILE,
} from "../src/pipe-vt-worker";

export const TERMINAL_PTY_WAL_PROXY_ASSET = "terminal-pty-wal-proxy.py";
/** NEWARCH pipe-pane VT worker assets, resolved beside the bundle via import.meta. */
export const PIPE_VT_RUNTIME_ASSETS = [PIPE_VT_WORKER_FILE, PIPE_VT_VENDOR_FILE, PIPE_VT_LICENSE_FILE] as const;

const DEFAULT_SERVER_ROOT = resolve(import.meta.dir, "..");
const PYTHON_SHEBANG = "#!/usr/bin/env python3\n";
const PUBLISHED_MODE = 0o755;

function assertRuntimeAsset(path: string, label: string, requireExecutable: boolean): Buffer {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (metadata.size === 0) throw new Error(`${label} is empty: ${path}`);
  if ((metadata.mode & 0o444) !== 0o444) throw new Error(`${label} is not readable by every runtime user: ${path}`);
  if (requireExecutable && (metadata.mode & 0o111) !== 0o111) {
    throw new Error(`${label} is not executable by every runtime user: ${path}`);
  }
  const contents = readFileSync(path);
  if (!contents.subarray(0, Buffer.byteLength(PYTHON_SHEBANG)).equals(Buffer.from(PYTHON_SHEBANG))) {
    throw new Error(`${label} does not start with the expected Python 3 shebang: ${path}`);
  }
  if (contents.includes(0)) throw new Error(`${label} contains a NUL byte: ${path}`);
  return contents;
}

/**
 * Copy non-JavaScript runtime helpers into server/dist after the bundle is built.
 * The asset is written under its final basename because the bundled resolver uses
 * import.meta.url and must work unchanged in server/dist and aggregate git-dist.
 */
export function copyServerRuntimeAssets(serverRoot = DEFAULT_SERVER_ROOT): string {
  const source = resolve(serverRoot, "src", "integrations", TERMINAL_PTY_WAL_PROXY_ASSET);
  const targetDirectory = resolve(serverRoot, "dist");
  const target = resolve(targetDirectory, TERMINAL_PTY_WAL_PROXY_ASSET);
  const temporary = `${target}.tmp-${process.pid}`;
  const expected = assertRuntimeAsset(source, "terminal PTY WAL proxy source asset", true);

  mkdirSync(targetDirectory, { recursive: true });
  rmSync(temporary, { force: true });
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, PUBLISHED_MODE);
    const copied = assertRuntimeAsset(temporary, "copied terminal PTY WAL proxy asset", true);
    if (!copied.equals(expected)) throw new Error(`copied runtime asset differs from source: ${temporary}`);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }

  const published = assertRuntimeAsset(target, "published terminal PTY WAL proxy asset", true);
  if (!published.equals(expected)) throw new Error(`published runtime asset differs from source: ${target}`);
  return target;
}

/**
 * Copy the pipe-pane VT worker, its pinned vendor archive and the licence into
 * server/dist (flat, as `pipeVtAssets(import.meta.dir)` resolves them). The
 * vendor archive must hash to PIPE_VT_VENDOR_SHA256 and the licence must name
 * it, in the source and again in the published copy.
 */
export function copyPipeVtRuntimeAssets(serverRoot = DEFAULT_SERVER_ROOT): string[] {
  const targetDirectory = resolve(serverRoot, "dist");
  mkdirSync(targetDirectory, { recursive: true });
  const check = (directory: string, label: string) => {
    for (const name of PIPE_VT_RUNTIME_ASSETS) {
      const path = resolve(directory, name);
      if (!existsSync(path)) throw new Error(`missing ${label} ${name}: ${path}`);
      const metadata = statSync(path);
      if (!metadata.isFile() || metadata.size === 0) throw new Error(`${label} ${name} is empty or not a file: ${path}`);
      if ((metadata.mode & 0o444) !== 0o444) throw new Error(`${label} ${name} is not readable by every runtime user: ${path}`);
    }
    const sha = createHash("sha256").update(readFileSync(resolve(directory, PIPE_VT_VENDOR_FILE))).digest("hex");
    if (sha !== PIPE_VT_VENDOR_SHA256) throw new Error(`${label} vendor hash ${sha} is not the pinned ${PIPE_VT_VENDOR_SHA256}`);
    if (!readFileSync(resolve(directory, PIPE_VT_LICENSE_FILE), "utf8").includes(PIPE_VT_VENDOR_SHA256)) {
      throw new Error(`${label} licence does not cover the pinned vendor archive`);
    }
    if (!readFileSync(resolve(directory, PIPE_VT_WORKER_FILE), "utf8").includes(PIPE_VT_VENDOR_SHA256)) {
      throw new Error(`${label} worker does not pin the vendor archive`);
    }
  };
  const source = resolve(serverRoot, "src");
  check(source, "source pipe-vt asset");
  const targets: string[] = [];
  for (const name of PIPE_VT_RUNTIME_ASSETS) {
    const target = resolve(targetDirectory, name);
    const temporary = `${target}.tmp-${process.pid}`;
    rmSync(temporary, { force: true });
    try {
      copyFileSync(resolve(source, name), temporary);
      chmodSync(temporary, name.endsWith(".py") ? PUBLISHED_MODE : 0o644);
      if (!readFileSync(temporary).equals(readFileSync(resolve(source, name)))) throw new Error(`copied asset differs from source: ${name}`);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    targets.push(target);
  }
  check(targetDirectory, "published pipe-vt asset");
  return targets;
}

if (import.meta.main) {
  const target = copyServerRuntimeAssets();
  console.log(`copied server runtime asset: ${target}`);
  for (const copied of copyPipeVtRuntimeAssets()) console.log(`copied server runtime asset: ${copied}`);
}
