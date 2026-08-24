# Releasing the public split

The public repo is produced from the private host monorepo with `git subtree split`
(history of commits touching `packages/thumbmux` is preserved; pre-extraction
history stays in the private repo).

Names used below (already in this clone — do not invent new remotes or branches):

- `thumbmux-public` — git remote for the public repo (`git@github.com:kemkem23/thumbmux.git`)
- `thumbmux-public/main` — that remote's `main`, after `git fetch thumbmux-public`
- `thumbmux-release` — local branch created by `git subtree split`

## Why `git push … thumbmux-release:main` is always rejected

`git subtree split` walks the monorepo and mints a **new** commit graph every
time (same trees, new hashes). The fresh `thumbmux-release` tip is therefore
never a descendant of published `main`, which was itself an earlier split or
an earlier merge of a split. The two histories diverge by construction.
Git rejects the naive push as a non-fast-forward. **Never force-push public
`main`** (`--force`, `-f`, `--force-with-lease`) to "fix" this.

The method used for 0.16.2 and 0.17.0: confirm the tree diff is only this
round's files, then create a merge whose **tree is identical to the split**
and whose **parents are both** `thumbmux-public/main` and `thumbmux-release`,
then push **that** commit.

## Publish public `main`

Run from the monorepo root. The `packages/thumbmux` tree you want to publish
must already be committed on `HEAD`.

```bash
cd <monorepo-root>

# 0. Secret scan must be clean before anything is published
grep -rniE 'token|secret|password|api[_-]?key|ghp_|sk-' packages/thumbmux/

# 1. Update the public remote (creates/updates thumbmux-public/main)
git fetch thumbmux-public

# 2. Split onto a local branch. If a leftover thumbmux-release exists
#    from a previous attempt, delete it first:
#      git branch -D thumbmux-release
git subtree split --prefix=packages/thumbmux -b thumbmux-release

# 3. The split tip's tree must be this commit's packages/thumbmux
test "$(git rev-parse 'thumbmux-release^{tree}')" = "$(git rev-parse HEAD:packages/thumbmux)"

# 4. Tree diff vs published main — not a commit-range log. Histories
#    share no hashes, so `git log A..B` cannot answer this.
git diff --name-status thumbmux-public/main thumbmux-release
```

**"Only this round" means:** every path in that list is a file this release is
supposed to change (the five `package.json` lockstep bumps, `CHANGELOG.md`, and
the feature/fix files you are shipping). Status `D` = present on public `main`
but missing from the split (public has something the monorepo lacks) — **stop**.
Unexpected `A` or `M` (a path you did not touch this round) — **stop**.

If the list is this round only, create the merge and push **that** SHA:

```bash
# 5. Tree = the split. Parents = public main (first) + this split (second).
#    First-parent order is load-bearing: public `git log --first-parent`
#    must walk the previous merge(public) commits, not the freshly minted split.
SPLIT_TREE=$(git rev-parse 'thumbmux-release^{tree}')
MERGE=$(git commit-tree "$SPLIT_TREE" \
  -p thumbmux-public/main \
  -p thumbmux-release \
  -m "merge(public): retain split history for X.Y.Z")

# 6. Merge tree must be byte-identical to the split
test "$(git rev-parse "$MERGE^{tree}")" = "$SPLIT_TREE"

# 7. Push the merge. Never push thumbmux-release as main. Never --force.
git push thumbmux-public "$MERGE":main
```

Do **not** delete `thumbmux-release` yet — the tag step below uses it as the
source ref. After the tag is on the public remote, `git branch -D thumbmux-release`.

Rules:
- NEVER push the monorepo itself to the public remote.
- NEVER `git push --force` (or `-f` / `--force-with-lease`) of public `main`.
- Re-run the secret scan first:
  `grep -rniE 'token|secret|password|api[_-]?key|ghp_|sk-' packages/thumbmux/`
- The split repo root = this directory: README.md/LICENSE/package.json here
  become the public repo's root files.


## Release tags (the consumer rail)

After the merge is on public `main`, cut a release: `git push thumbmux-public thumbmux-release:refs/tags/vX.Y.Z`.
Then `git branch -D thumbmux-release`.
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
  version bump alone is not a release; it is half of one.
- **Run `bash scripts/ci-parity.sh` before pushing the tag.** The workflows in
  `.github/` only fire in the public repo, so a package developed inside the
  private monorepo can accumulate commits that CI has never seen — v0.8.0
  reached 51 of them, and the first thing CI ever said about that work was
  "no", twice, at the moment of release. The script exports the committed tree
  to a clean directory, installs from the lockfile, builds `git-dist`, and runs
  the same suite CI runs. It catches what a working-tree `bun test` cannot: a
  test reading a stale `git-dist` left over from an earlier build, a path that
  escapes the package and resolves against the host repo, and anything the
  lockfile installs differently from your incremental `node_modules`.
- Publish public `main` with the commit-tree merge above. Never
  `git push thumbmux-public thumbmux-release:main`. Never `--force`.
- Push the `vX.Y.Z` source tag and let `release-dist` publish `vX.Y.Z-dist`.
- Bump every consumer pin together, then reinstall (npm consumers:
  `--include=dev` if your shell exports NODE_ENV=production).
