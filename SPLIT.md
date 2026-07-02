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
