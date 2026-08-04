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

```bash
git fetch upstream
git rebase upstream/master edison   # resolve per-feature conflicts if any
./build-edison.sh                   # rebuild + verify the WASM
```

Then run the **dual-core regression suite** in EDOpro-server-ts against the new
binary (`OCGCORE_WASM=<path> npm test -- ocgcore`). It must stay green on both
the stock and fork binaries before the new core is pinned. The behavior tests
live in the server repo because they depend on its `HeadlessDuel` harness; this
repo owns only the source, the reproducible build, and the published artifact.

## Building

```bash
./build-edison.sh
```

Needs only `docker`. Downloads Lua, runs premake5 and emmake in pinned
containers, and fails loudly unless the output matches the expected sha256
(`4272eb0d…`). Deterministic: same commit + same emsdk = identical bytes.

## Provenance

- Upstream base: `973672d` (master), the commit the vendored
  `koishipro-core.js` 1.5.2 JS glue is built from.
- Emscripten: `3.1.7` — keeps the `.wasm` ABI-compatible with that JS glue, so
  only the binary is swapped on the consumer side (wrapper `wasmBinary` option).
  A future upstream bump that needs a newer emsdk also needs the JS glue updated.
