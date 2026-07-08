# Releasing to github.com/kemkem23/thumbmux

The public repo is produced from the kemcortex monorepo with `git subtree split`
(history of commits touching `packages/thumbmux` is preserved; pre-extraction
history stays in the private repo).

```bash
cd ~/kemcortex/cortex-orchestrator
git subtree split --prefix=packages/thumbmux -b thumbmux-release
git push git@github.com:kemkem23/thumbmux.git thumbmux-release:main
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
CI (release-dist.yml) builds dists, runs the suite, and publishes `vX.Y.Z-dist` —
the ONLY ref consumers should pin (`"thumbmux": "github:kemkem23/thumbmux#vX.Y.Z-dist"`).
kemcortex itself consumes that pin (brain-ui/package.json + root package.json — bump BOTH,
then `npm install --include=dev --legacy-peer-deps` in brain-ui and `bun install` at root).
