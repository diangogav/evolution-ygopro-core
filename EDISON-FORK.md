# Edison ocgcore fork

A maintained fork of [`purerosefallen/ygopro-core`](https://github.com/purerosefallen/ygopro-core)
that restores four 2010/Edison (MR1) rulings the modern engine no longer
applies. It builds the WASM core used by the Evolution server's Edison rooms.

## What this fork adds

Three of the four features are **gated by `duel_rule <= 1`**, so modern duels
(`duel_rule >= 2`) are **bit-for-bit identical to upstream** — the whole ocgcore
regression suite passes green on both binaries. That is what lets the server run
this single fork for every format instead of swapping cores per duel.

| Commit subject | Rule | Gate | File |
|---|---|---|---|
| union 1-per-monster | Edison #3 | `duel_rule <= 1` | `card.cpp` |
| 0-ATK mutual destruction | Edison #13 | `duel_rule <= 1` | `processor.cpp` |
| LP cost cannot pay to 0 | Edison #10 | `duel_rule <= 1` | `field.cpp` |
| `EFFECT_EXTRA_RELEASE_OPT` (Soul Exchange pre-errata) | — | additive effect code | `effect.h`, `field.cpp` |

The additive effect code (10159) is only used by pre-errata card scripts, so
cards on the stock effect codes behave identically.

## Branch model

- `upstream/master` — pristine mirror of `purerosefallen/ygopro-core`.
- `edison` — the four features as four atomic commits on top of the pinned
  upstream base. This is the shippable branch.

Each feature is one isolated commit so an upstream rebase surfaces conflicts
per-feature instead of as one opaque blob.

## Tracking upstream

**Never merge upstream into `edison`.** A merge commit changes the core sources
without moving `EXPECTED_SHA`, so the reproducible-build assert fails and the
branch stops being a clean feature stack. Rebase, always.

### The automated chain

Taking an upstream update is one chain of automation with exactly two human
gates — merging the sync PR here, and merging the pin PR on the server:

1. **Watch** (`edison-upstream-watch.yml`, Mondays 06:00 UTC or manually
   dispatched) detects upstream movement and rebases the four edison feature
   commits onto the new upstream tip.
2. **Clean rebase** → the workflow builds the WASM in the same run, in
   `EDISON_REPIN` mode: it re-pins `EXPECTED_SHA` in `tools/build-edison.sh`
   and updates the base column in the pinned triple below, then commits both
   on the `upstream-sync` branch — so the sync PR arrives green instead of
   with a known-failing sha assert. It also runs the **definitive ABI diff**:
   the new binary's exports/imports (`tools/edison-release-lib.sh`,
   `wasm_abi_signature`/`wasm_abi_diff`) against the currently released asset,
   and puts the verdict in the PR body. Conflicted or unpublishable, it opens
   an issue with the manual recipe instead. It never passes silently.
3. **Sync PR — human gate 1.** Review the ABI verdict, then **do not use the
   merge button.** The sync PR is a rebased history of `edison`'s feature
   stack, not an ordinary feature branch: a merge commit would stop `edison`
   being a clean rebased stack, and "rebase and merge" would replay every
   commit on the PR — including upstream's own — on top of `edison`,
   duplicating history already there. Instead, run the **Edison fork —
   promote sync** workflow (`edison-promote-sync.yml`, `workflow_dispatch`
   from the Actions tab). Running it is the human gate; there is nothing to
   click on the PR itself.
4. **Promote** (`edison-promote-sync.yml`) verifies the sync PR is exactly
   what the watch published and still sits on the current upstream tip, then
   force-with-lease pushes `upstream-sync` onto `edison`, computes and tags
   the next minor release on that commit, and closes the PR.
5. **Build + release** (`edison-build.yml`) is triggered directly by the
   promote workflow's PAT-authored push of `edison` and of the release tag —
   a `GITHUB_TOKEN` push would not raise that event, which is why the promote
   workflow needs `UPSTREAM_SYNC_TOKEN`. It rebuilds, publishes the release
   asset, and opens the consumer pin-bump PRs.
6. **Pin PR on the server — human gate 2.** Before merging it, run the
   **dual-core regression suite** in `evolution-pre-errata-scripts`
   (`bash test/setup-test-resources.sh && npx jest`) against the released
   binary. It must stay green on both the stock and fork binaries. The
   behavior tests live there because they depend on that repo's
   `HeadlessDuel` harness and its pre-errata card scripts; this repo owns
   only the source, the reproducible build, and the published artifact.

> The differential tests (`soul-exchange`, `lp-cost-limit`, `machina-gearframe`)
> pin each core per-duel through `wasmPath`, so `OCGCORE_WASM` does **not**
> re-point them. They exercise whichever binary the setup script provisioned.

### Version rule

Every upstream sync is a **minor bump** (`vX.Y.0-edison`), computed by
`next_edison_tag` in `tools/edison-release-lib.sh` — the chain above always
takes this path. A hand-authored feature or fix commit (not an upstream sync)
is still tagged manually, at whatever bump fits that change.

### Manual fallback

If a step in the chain reports instead of automating (no rebase-publish
token, a conflict, a failed build, or working outside CI), do it by hand:

```bash
git fetch upstream
git rebase upstream/master edison        # resolve per-feature conflicts if any
EDISON_REPIN=1 ./tools/build-edison.sh   # rebuilds and re-pins EXPECTED_SHA
```

Then update the base in the pinned triple below and commit both together.
Tagging `vX.Y.Z-edison` publishes the release asset and opens the pin-bump
PRs on the consumers — run the dual-core regression suite above before
merging those.

If a sync PR already exists and only the promote step needs to run by hand
(e.g. `edison-promote-sync.yml` itself failed partway through — check which
steps it reports as already completed before re-running any of this):

```bash
git fetch origin upstream-sync
git push --force-with-lease origin origin/upstream-sync:edison
git tag <next> <sha>   # <next> from next_edison_tag; <sha> is upstream-sync's tip
git push origin <next>
```

### Automation secrets

Without them nothing breaks: each workflow degrades to reporting what a
human should run. With them, the paperwork disappears. `UPSTREAM_SYNC_TOKEN`
cannot degrade for the promote workflow specifically — it stops before
pushing, tagging, or closing anything, and says so, when the secret is unset,
because only a PAT-authored push raises the event that triggers the release
build.

| Secret | Needed for | Scope |
|---|---|---|
| `UPSTREAM_SYNC_TOKEN` | publishing the weekly sync branch; promoting it to `edison` and tagging | `workflow` on this repo |
| `CONSUMER_PIN_TOKEN` | the pin-bump PRs on release | write on the two consumer repos |

`UPSTREAM_SYNC_TOKEN` exists because an upstream delta regularly touches
`.github/workflows/*`, and the default `GITHUB_TOKEN` is refused on those paths
by design — the `workflows` permission it asks for cannot be granted through a
workflow's `permissions` block. One PAT carrying `repo` and `workflow` can serve
as both secrets.

## Building

```bash
./tools/build-edison.sh
```

Needs only `docker`. Downloads Lua, runs premake5 and emmake in pinned
containers, and fails loudly unless the output matches the sha256 pinned in
`EXPECTED_SHA` (in `tools/build-edison.sh` — not quoted here, since the
automated chain above moves it on every upstream sync). Deterministic: same
commit + same emsdk = identical bytes.

## Provenance & the `koishipro-core.js` coupling (ABI anchor)

The consumer (EDOpro-server-ts) does **not** fork the JS side. It depends on the
npm package **`koishipro-core.js`** — the emscripten JS glue + a default stock
WASM — and swaps in this fork's `.wasm` via the wrapper's `wasmBinary` option
(`createOcgcoreWrapper({ wasmBinary })`). We reuse the glue and override only the
binary. `koishipro-core.js` stays a dependency of the **server**, never of this
repo.

That reuse only works while the WASM stays **ABI-compatible** with the glue:
same `ocgapi` exports/imports, struct layout, and emscripten ABI the glue was
generated against. So three things move as one pinned triple:

| ygopro-core base | koishipro-core.js | emscripten |
|---|---|---|
| `25eb27f` | `1.5.2` | `3.1.7` |

**When taking an upstream update:**
- **ABI-compatible change** (gameplay logic only — no `ocgapi.*` / struct /
  export changes, same emscripten): rebuild the WASM and swap it. The pinned
  `koishipro-core.js 1.5.2` is untouched. This is the common path.
- **ABI or emscripten change**: the old glue no longer matches the new WASM.
  Bump `koishipro-core.js` (server-side) to a version whose glue was regenerated
  for that ABI/emsdk, realign the emsdk pin here, then rebuild. Only vendor/fork
  the JS if upstream stops publishing a matching `koishipro-core.js`.

**Safety net:** the server's dual-core regression suite runs the real glue
against this WASM, so an ABI mismatch surfaces as a boot/test failure — never a
silent miscompile. The upstream-watch CI (below) flags PRs whose diff touches
`ocgapi.*` or public structs as "may need a koishipro-core.js bump".
