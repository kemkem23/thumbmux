import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const PROD_PORTS = new Set([47779, 47780]);

function fail(message: string): never {
  throw new Error(`thumbmux e2e isolation: ${message}`);
}

function oneLine(entries: Map<string, string>, key: string): string {
  const value = entries.get(key);
  if (!value) fail('run attestation is incomplete');
  return value;
}

export function assertLocalDemoUrl(raw: string | undefined): string {
  if (!raw) fail('DEMO_URL is required from the canonical runner');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('DEMO_URL is malformed');
  }
  const port = Number(url.port);
  const queryKeys = [...url.searchParams.keys()];
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1024
    || port > 65_535
    || PROD_PORTS.has(port)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.hash !== ''
    || queryKeys.length !== 1
    || queryKeys[0] !== 't'
    || !/^[a-f0-9]{32}$/.test(url.searchParams.get('t') ?? '')) {
    fail('DEMO_URL is not an authenticated ephemeral 127.0.0.1 test endpoint');
  }
  return url.toString();
}

export type ThumbmuxE2eRuntime = {
  attestation: string;
  containerId: string;
  dockerId: string;
  dockerRoot: string;
  dockerSocketIdentity: string;
  runId: string;
  scope: 'e2e' | 'media';
};

function statIdentity(path: string, includeMode: boolean): string {
  const value = statSync(path);
  const fields: Array<string | number> = [value.dev, value.ino, value.uid];
  if (includeMode) fields.push((value.mode & 0o7777).toString(8));
  return fields.join(':');
}

function gitOutput(checkout: string, args: string[], maxBuffer = 1024 * 1024): string {
  return execFileSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
}

function assertThumbmuxHostedRuntime(
  scope: 'e2e' | 'media',
  env: NodeJS.ProcessEnv = process.env,
): ThumbmuxE2eRuntime {
  const uid = process.getuid?.();
  if (uid === undefined
    || uid === 0
    || env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_REPOSITORY !== 'kemkem23/thumbmux'
    || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    || env.USER !== 'runner'
    || env.LOGNAME !== 'runner'
    || !/^github-hosted(?:-frozen-export)?$/.test(env.THUMBMUX_GUARD_PROVIDER ?? '')
    || env.THUMBMUX_TEST_SCOPE !== scope) {
    fail('GitHub-hosted disposable-job heuristic is missing');
  }

  let workspace: string;
  let checkout: string;
  let runnerTemp: string;
  let attestation: string;
  try {
    workspace = realpathSync(env.GITHUB_WORKSPACE ?? '');
    checkout = realpathSync(env.THUMBMUX_GUARD_CHECKOUT ?? '');
    runnerTemp = realpathSync(env.RUNNER_TEMP ?? '');
    attestation = realpathSync(env.THUMBMUX_TEST_ATTESTATION ?? '');
  } catch {
    fail('runner paths or run attestation are unavailable');
  }
  const provider = env.THUMBMUX_GUARD_PROVIDER;
  const checkoutBoundaryOk = provider === 'github-hosted'
    ? checkout === workspace
    : /^\/home\/runner\/work\/_temp\/thumbmux-ci-parity\.[A-Za-z0-9]{8}\/export$/.test(checkout);
  if (checkout !== PACKAGE_ROOT
    || !checkoutBoundaryOk
    || !/^\/home\/runner\/work\/[^/]+\/[^/]+$/.test(workspace)
    || runnerTemp !== '/home/runner/work/_temp'
    || !new RegExp(`^thumbmux-${scope}\\.[A-Za-z0-9]{8}/runtime-attestation$`)
      .test(relative(runnerTemp, attestation))) {
    fail('checkout/runtime paths are outside the public disposable job');
  }

  const attestationLstat = lstatSync(attestation);
  const attestationStat = statSync(attestation);
  if (!attestationLstat.isFile()
    || attestationLstat.isSymbolicLink()
    || attestationStat.uid !== uid
    || (attestationStat.mode & 0o7777) !== 0o600
    || lstatSync(checkout).isSymbolicLink()
    || statSync(workspace).uid !== uid
    || statSync(runnerTemp).uid !== uid) {
    fail('run attestation ownership/mode is unsafe');
  }

  const receiptIdentityBeforeRead = statIdentity(attestation, false);
  const receiptSource = readFileSync(attestation, 'utf8');
  if (receiptIdentityBeforeRead !== statIdentity(attestation, false)
    || lstatSync(attestation).isSymbolicLink()) {
    fail('run attestation inode changed while it was read');
  }
  if (!receiptSource.endsWith('\n') || receiptSource.endsWith('\n\n')) {
    fail('run attestation does not have one exact trailing newline');
  }
  const lines = receiptSource.slice(0, -1).split('\n');
  const entries = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) fail('run attestation is malformed');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (entries.has(key)) fail('run attestation contains duplicate fields');
    entries.set(key, value);
  }
  const expectedKeys = [
    'version', 'provider', 'checkout', 'git-sha', 'git-tree',
    'checkout-identity', 'runtime-identity', 'receipt-identity',
    'docker-host', 'docker-id', 'docker-root', 'docker-socket-identity',
    'scope', 'run-id',
  ];
  if (lines.length !== expectedKeys.length
    || [...entries.keys()].some((key, index) => key !== expectedKeys[index])
    || oneLine(entries, 'version') !== '2'
    || oneLine(entries, 'provider') !== provider
    || oneLine(entries, 'checkout') !== PACKAGE_ROOT
    || oneLine(entries, 'git-sha') !== env.GITHUB_SHA
    || !/^[a-f0-9]{40,64}$/.test(oneLine(entries, 'git-tree'))
    || oneLine(entries, 'checkout-identity') !== statIdentity(checkout, true)
    || oneLine(entries, 'checkout-identity') !== env.THUMBMUX_GUARD_CHECKOUT_IDENTITY
    || oneLine(entries, 'runtime-identity') !== statIdentity(dirname(attestation), true)
    || oneLine(entries, 'runtime-identity') !== env.THUMBMUX_GUARD_RUNTIME_IDENTITY
    || oneLine(entries, 'receipt-identity') !== receiptIdentityBeforeRead
    || oneLine(entries, 'receipt-identity') !== env.THUMBMUX_GUARD_ATTESTATION_IDENTITY
    || oneLine(entries, 'docker-host') !== 'unix:///var/run/docker.sock'
    || oneLine(entries, 'docker-root') !== '/var/lib/docker'
    || oneLine(entries, 'scope') !== scope) {
    fail('run attestation does not describe the admitted public job');
  }

  const runId = oneLine(entries, 'run-id');
  const dockerId = oneLine(entries, 'docker-id');
  const containerId = env.THUMBMUX_CONTAINER ?? '';
  const socketIdentity = env.THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY ?? '';
  if (!/^[a-f0-9]{32}$/.test(runId)
    || env.THUMBMUX_TEST_RUN_ID !== runId
    || !/^[A-Za-z0-9:._-]{8,128}$/.test(dockerId)
    || env.THUMBMUX_GUARD_DOCKER_ID !== dockerId
    || env.THUMBMUX_GUARD_DOCKER_ROOT !== '/var/lib/docker'
    || env.THUMBMUX_GUARD_DOCKER_HOST !== 'unix:///var/run/docker.sock'
    || oneLine(entries, 'docker-socket-identity') !== socketIdentity
    || !/^\d+:\d+:\d+:[0-7]{3,4}$/.test(socketIdentity)
    || !/^[a-f0-9]{64}$/.test(containerId)) {
    fail('run/container identity is not bound to the attestation');
  }

  const currentTree = gitOutput(checkout, ['rev-parse', 'HEAD^{tree}']).trim();
  const currentHead = gitOutput(checkout, ['rev-parse', 'HEAD']).trim();
  const checkoutStatus = gitOutput(
    checkout,
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    4 * 1024 * 1024,
  );
  if (currentTree !== oneLine(entries, 'git-tree')
    || checkoutStatus !== ''
    || (provider === 'github-hosted' && currentHead !== env.GITHUB_SHA)) {
    fail('checkout commit/tree changed after shell admission');
  }

  return {
    attestation,
    containerId,
    dockerId,
    dockerRoot: '/var/lib/docker',
    dockerSocketIdentity: socketIdentity,
    runId,
    scope,
  };
}

export function assertThumbmuxPlaywrightRuntime(
  env: NodeJS.ProcessEnv = process.env,
): ThumbmuxE2eRuntime {
  if (env !== process.env) return assertThumbmuxHostedRuntime('e2e', env);
  return assertThumbmuxDockerContainer('e2e');
}

export function assertThumbmuxMediaRuntime(
  env: NodeJS.ProcessEnv = process.env,
): ThumbmuxE2eRuntime {
  return assertThumbmuxHostedRuntime('media', env);
}

export function assertThumbmuxDockerContainer(
  scope: 'e2e' | 'media',
): ThumbmuxE2eRuntime {
  const runtime = assertThumbmuxHostedRuntime(scope);
  const socket = '/var/run/docker.sock';
  const socketLstat = lstatSync(socket);
  const socketStat = statSync(socket);
  const socketIdentity = [
    socketStat.dev,
    socketStat.ino,
    socketStat.uid,
    (socketStat.mode & 0o7777).toString(8),
  ].join(':');
  if (!socketLstat.isSocket()
    || socketLstat.isSymbolicLink()
    || socketIdentity !== runtime.dockerSocketIdentity) {
    fail('Docker socket identity changed');
  }
  const daemon = execFileSync(
    '/usr/bin/docker',
    ['info', '--format', '{{.ID}}|{{.DockerRootDir}}'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  ).trim();
  if (daemon !== `${runtime.dockerId}|${runtime.dockerRoot}`) {
    fail('Docker daemon identity changed');
  }
  const identity = execFileSync(
    '/usr/bin/docker',
    [
      'inspect',
      '--format',
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.kemcortex.thumbmux.run-id"}}|{{index .Config.Labels "com.kemcortex.thumbmux.scope"}}',
      runtime.containerId,
    ],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  ).trim();
  if (identity !== `${runtime.containerId}|/thumbmux-${scope}-${runtime.runId}|${runtime.runId}|${scope}`) {
    fail('container ID/labels changed');
  }
  return runtime;
}
