# Releasing the public split

The public repo is produced from the private host monorepo with `git subtree split`
(history of commits touching `packages/thumbmux` is preserved; pre-extraction
history stays in the private repo).

```bash
cd <monorepo-root>
git subtree split --prefix=packages/thumbmux -b thumbmux-release
git push <public-remote> thumbmux-release:main
git branch -D thumbmux-release
```

Rules:
- NEVER push the monorepo itself to the public remote.
- Re-run the secret scan first:
  `grep -rniE 'token|secret|password|api[_-]?key|ghp_|sk-' packages/thumbmux/`
- The split repo root = this directory: README.md/LICENSE/package.json here
  become the public repo's root files.


## Release tags (the consumer rail)

After pushing main, cut a release: `git push <public> thumbmux-release:refs/tags/vX.Y.Z`.
CI workflow file `.github/workflows/release.yml` (workflow name `release-dist`)
builds dists, runs the suite, and publishes `vX.Y.Z-dist` — the ONLY ref
consumers should pin (`"thumbmux": "github:<owner>/<repo>#vX.Y.Z-dist"`).
The release build copies package output to a root-only `git-dist/`, rewrites
that aggregate's `@thumbmux/core` imports to relative paths, and points root
exports at the copies. Original standalone subpackage output and packs keep
their normal scoped-package dependency.

Release checklist:
- Bump root, core, server, svelte, **and app** `package.json` versions in lockstep —
  five files. `app` joined in v0.8.0; a bump that misses it ships a workspace
  claiming the previous version.
- **Bump the internal `@thumbmux/*` ranges in the same commit** — `server`,
  `svelte` and `app` each depend on `@thumbmux/core` (and `app` on
  `@thumbmux/svelte`) with a caret range. On a `0.x` version a caret does not
  cross the minor: `^0.7.1` means `>=0.7.1 <0.8.0`, so the moment `core`
  becomes `0.8.0` the range stops matching the workspace, bun falls through to
  the public registry, and the install dies on `404 @thumbmux/core`. The
  version bump alone is not a release; it is half of one. Verify with the CI
  command itself, in a clean tree:
  `bun install --frozen-lockfile`.
- Push main through the subtree split.
- Push the `vX.Y.Z` source tag and let `release-dist` publish `vX.Y.Z-dist`.
- Bump every consumer pin together, then reinstall (npm consumers:
  `--include=dev` if your shell exports NODE_ENV=production).
