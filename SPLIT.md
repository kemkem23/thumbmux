# Releasing to github.com/kemkem23/thumbmux

The public repo is produced from the private host monorepo with `git subtree split`
(history of commits touching `packages/thumbmux` is preserved; pre-extraction
history stays in the private repo).

```bash
cd <monorepo-root>
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
The host monorepo consumes that pin in each consumer package.json — bump every pin
together, then reinstall (npm consumers: `--include=dev` if your shell exports NODE_ENV=production).
