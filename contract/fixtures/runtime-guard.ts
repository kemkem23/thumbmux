import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

function fail(message: string): never {
  throw new Error(`contract fixture isolation: ${message}`);
}

function identity(path: string, includeMode: boolean): string {
  const value = statSync(path);
  const fields: Array<string | number> = [value.dev, value.ino, value.uid];
  if (includeMode) fields.push((value.mode & 0o7777).toString(8));
  return fields.join(":");
}

export function assertContractFixtureRuntime(): string {
  const uid = process.getuid?.();
  const runtimeRaw = process.env.THUMBMUX_TEST_RUNTIME ?? "";
  const runId = process.env.THUMBMUX_TEST_RUN_ID ?? "";
  const socket = process.env.THUMBMUX_TEST_TMUX_SOCKET ?? "";
  const scope = process.env.THUMBMUX_TEST_SCOPE ?? "";
  if (uid === undefined || uid === 0
    || process.env.CI !== "true"
    || process.env.GITHUB_ACTIONS !== "true"
    || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
    || process.env.GITHUB_REPOSITORY !== "kemkem23/thumbmux"
    || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
    || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
    || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
    || process.env.USER !== "runner"
    || process.env.LOGNAME !== "runner"
    || scope !== "contract-fixtures"
    || !/^[a-f0-9]{32}$/.test(runId)
    || !/^\/home\/runner\/work\/_temp\/thumbmux-contract-fixtures\.[A-Za-z0-9]{8}$/.test(runtimeRaw)
    || process.env.TMUX !== undefined
    || process.env.TMUX_PANE !== undefined
    || process.env.TMUX_TMPDIR !== undefined
    || process.env.CHROMIUM_PATH !== undefined) {
    fail("private runtime identity is missing");
  }

  let runtime: string;
  let receipt: string;
  let tmuxShim: string;
  let checkout: string;
  let bunBin: string;
  try {
    runtime = realpathSync(runtimeRaw);
    receipt = realpathSync(`${runtime}/runtime-attestation`);
    tmuxShim = realpathSync(`${runtime}/bin/tmux`);
    checkout = realpathSync(process.env.THUMBMUX_GUARD_CHECKOUT ?? "");
    bunBin = realpathSync(process.env.THUMBMUX_GUARD_BUN_BIN ?? "");
  } catch {
    fail("runtime receipt or private tmux shim is unavailable");
  }
  const runtimeStat = statSync(runtime);
  const privateBinStat = statSync(`${runtime}/bin`);
  const tmuxRootStat = statSync(`${runtime}/tmux`);
  const socketParent = `${runtime}/tmux/tmux-${uid}`;
  const socketParentStat = statSync(socketParent);
  const tmuxShimStat = statSync(tmuxShim);
  const bunBinStat = statSync(bunBin);
  const pathParts = process.env.PATH?.split(":") ?? [];
  if (runtime !== runtimeRaw
    || lstatSync(runtimeRaw).isSymbolicLink()
    || runtimeStat.uid !== uid
    || (runtimeStat.mode & 0o7777) !== 0o700
    || identity(runtime, true) !== process.env.THUMBMUX_GUARD_RUNTIME_IDENTITY
    || socket !== `${socketParent}/default`
    || pathParts.length !== 5
    || pathParts[0] !== `${runtime}/bin`
    || pathParts[1] !== "/usr/bin"
    || pathParts[2] !== "/bin"
    || !/^(?:\/opt\/hostedtoolcache\/bun\/[^/]+\/x64|\/home\/runner\/(?:setup-bun|\.bun)\/bin)$/.test(pathParts[3] ?? "")
    || pathParts[4] !== "/opt/hostedtoolcache/node/22.23.2/x64/bin"
    || bunBin !== process.env.THUMBMUX_GUARD_BUN_BIN
    || dirname(bunBin) !== pathParts[3]
    || !/^(?:\/opt\/hostedtoolcache\/bun\/[^/]+\/x64\/bun|\/home\/runner\/(?:setup-bun|\.bun)\/bin\/bun)$/.test(bunBin)
    || !lstatSync(bunBin).isFile()
    || lstatSync(bunBin).isSymbolicLink()
    || (bunBinStat.uid !== 0 && bunBinStat.uid !== uid)
    || (bunBinStat.mode & 0o111) === 0
    || privateBinStat.uid !== uid
    || (privateBinStat.mode & 0o7777) !== 0o700
    || lstatSync(`${runtime}/tmux`).isSymbolicLink()
    || tmuxRootStat.uid !== uid
    || (tmuxRootStat.mode & 0o7777) !== 0o700
    || lstatSync(socketParent).isSymbolicLink()
    || socketParentStat.uid !== uid
    || (socketParentStat.mode & 0o7777) !== 0o700
    || lstatSync(`${runtime}/bin/tmux`).isSymbolicLink() !== true
    || tmuxShim !== `${runtime}/source/scripts/private-test-tmux.sh`
    || !lstatSync(tmuxShim).isFile()
    || lstatSync(tmuxShim).isSymbolicLink()
    || tmuxShimStat.uid !== uid
    || (tmuxShimStat.mode & 0o111) === 0) {
    fail("private runtime/socket/tmux shim is not exact");
  }
  if (existsSync(socket)) {
    const socketStat = lstatSync(socket);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== uid) {
      fail("private tmux socket changed type or owner");
    }
  }

  const receiptLstat = lstatSync(receipt);
  const receiptStat = statSync(receipt);
  if (!receiptLstat.isFile()
    || receiptLstat.isSymbolicLink()
    || receiptStat.uid !== uid
    || (receiptStat.mode & 0o7777) !== 0o600
    || dirname(receipt) !== runtime
    || identity(receipt, false) !== process.env.THUMBMUX_GUARD_ATTESTATION_IDENTITY) {
    fail("runtime receipt identity changed");
  }

  const receiptIdentityBeforeRead = identity(receipt, false);
  const receiptSource = readFileSync(receipt, "utf8");
  if (receiptIdentityBeforeRead !== identity(receipt, false)
    || lstatSync(receipt).isSymbolicLink()) {
    fail("runtime receipt inode changed while it was read");
  }
  if (!receiptSource.endsWith("\n") || receiptSource.endsWith("\n\n")) {
    fail("runtime receipt does not have one exact trailing newline");
  }
  const lines = receiptSource.slice(0, -1).split("\n");
  const expectedKeys = [
    "version", "provider", "checkout", "git-sha", "git-tree",
    "checkout-identity", "runtime-identity", "receipt-identity",
    "docker-host", "docker-id", "docker-root", "docker-socket-identity",
    "scope", "run-id",
  ];
  if (lines.length !== expectedKeys.length) fail("runtime receipt schema is not exact");
  const values = new Map<string, string>();
  lines.forEach((line, index) => {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || key !== expectedKeys[index] || values.has(key)) {
      fail("runtime receipt schema is not exact");
    }
    values.set(key, line.slice(separator + 1));
  });
  const provider = values.get("provider") ?? "";
  const workspace = realpathSync(process.env.GITHUB_WORKSPACE ?? "");
  const checkoutBoundaryOk = provider === "github-hosted"
    ? checkout === workspace
    : /^\/home\/runner\/work\/_temp\/thumbmux-ci-parity\.[A-Za-z0-9]{8}\/export$/.test(checkout);
  if (values.get("version") !== "2"
    || !/^github-hosted(?:-frozen-export)?$/.test(provider)
    || !checkoutBoundaryOk
    || lstatSync(checkout).isSymbolicLink()
    || values.get("checkout") !== checkout
    || values.get("git-sha") !== process.env.GITHUB_SHA
    || !/^[a-f0-9]{40,64}$/.test(values.get("git-tree") ?? "")
    || values.get("checkout-identity") !== identity(checkout, true)
    || values.get("checkout-identity") !== process.env.THUMBMUX_GUARD_CHECKOUT_IDENTITY
    || values.get("runtime-identity") !== identity(runtime, true)
    || values.get("runtime-identity") !== process.env.THUMBMUX_GUARD_RUNTIME_IDENTITY
    || values.get("receipt-identity") !== receiptIdentityBeforeRead
    || values.get("receipt-identity") !== process.env.THUMBMUX_GUARD_ATTESTATION_IDENTITY
    || values.get("docker-host") !== "unix:///var/run/docker.sock"
    || values.get("docker-host") !== process.env.THUMBMUX_GUARD_DOCKER_HOST
    || !/^[A-Za-z0-9:._-]{8,128}$/.test(values.get("docker-id") ?? "")
    || values.get("docker-id") !== process.env.THUMBMUX_GUARD_DOCKER_ID
    || values.get("docker-root") !== "/var/lib/docker"
    || values.get("docker-root") !== process.env.THUMBMUX_GUARD_DOCKER_ROOT
    || !/^\d+:\d+:\d+:[0-7]{3,4}$/.test(values.get("docker-socket-identity") ?? "")
    || values.get("docker-socket-identity") !== process.env.THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY
    || values.get("scope") !== scope
    || values.get("run-id") !== runId) {
    fail("runtime receipt does not bind this exact fixture run");
  }
  return runtime;
}

export function assertContractFixturePort(port: number | undefined): void {
  if (port === undefined || !Number.isInteger(port) || port < 1024 || port > 65_535
    || port === 47_779 || port === 47_780) {
    fail(`unsafe or reserved loopback port ${port}`);
  }
}
