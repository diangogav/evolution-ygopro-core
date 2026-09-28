# Feature: edison-auto-sync

Repository-relative locator: `odd/tasks/edison-auto-sync.md`
Branch: `ci/edison-auto-sync` (from `edison`, the default branch)
Engram mirror topic: `odd/edison-auto-sync/tasks`

## Objective
Close the manual gap in the fork's upstream-sync chain so that an upstream
movement in `purerosefallen/ygopro-core` ends, without human typing, as a
mergeable sync PR carrying the re-pinned reproducible sha, and a merged sync PR
ends as a tagged release whose consumer pin PRs are opened by the existing
release workflow. The two remaining human gates are: merging the sync PR on
this repo, and merging the pin PR on the server.

## Problem / why
`edison-upstream-watch.yml` already rebases and opens a PR, and
`edison-build.yml` already releases on a `v*-edison` tag and opens the pin PRs.
Between them a human must build, re-pin `EXPECTED_SHA`, update the base in
`EDISON-FORK.md`, commit and tag. The sync PR also arrives red because the sha
assert fails on any source change. The ABI flag is a filename heuristic; the
definitive check (exports/imports of the built binary) is never run.

## Scope (authorized)
- `tools/build-edison.sh`: opt-in re-pin mode that rewrites `EXPECTED_SHA`.
- `tools/edison-release-lib.sh`: pure functions `next_edison_tag` and
  `wasm_abi_signature`, jest-tested.
- `.github/workflows/edison-upstream-watch.yml`: build in CI after a clean
  rebase, re-pin sha + doc base in the sync branch, definitive ABI diff against
  the current release asset in the PR body.
- `.github/workflows/edison-auto-tag.yml` (new): on merged `upstream-sync` PR,
  compute next minor `vX.Y.Z-edison`, tag, dispatch `edison-build.yml` on it.
- `EDISON-FORK.md`: document the automated chain, the two human gates, the
  version rule, and the secrets.
Out of scope: auto-merging any PR; changing consumer repos; touching core C++.

## Constraints
- Never merge upstream into `edison`; rebase only (existing policy).
- Tag pushes made with `GITHUB_TOKEN` do not trigger workflows, so the auto-tag
  job must dispatch `edison-build.yml` explicitly via `workflow_dispatch`.
- `UPSTREAM_SYNC_TOKEN` and `CONSUMER_PIN_TOKEN` are the user's to create; every
  workflow must degrade to reporting when they are absent.
- TDD: strict (session config). Runner: `npx jest <path>` (jest 30, ts-jest;
  testMatch `**/*.integration.test.ts` under `test/`).
- Artifacts in English. Conventional Commits, no AI attribution.

## Tasks
- [x] T1 Reconcile local `edison` with `origin/edison` (rebase --autostash).
      Route: inline (git state). Evidence: 5862cc8 on top of 17bc10c, 1 ahead 0 behind.
- [x] T2 `tools/edison-release-lib.sh` + `tools/build-edison.sh` re-pin mode,
      with `test/tools/edison-release-lib.integration.test.ts` (RED first).
      Route: delegated writer (writer trigger: 3+ non-trivial files).
      Evidence: cdfef82; writer observed RED 5/7 failing then GREEN 7/7.
- [x] T3 Extend `edison-upstream-watch.yml`: CI build, re-pin commit, ABI diff.
      Route: delegated writer. Evidence: 7b04f0e; YAML parses.
- [~] T4 New `edison-auto-tag.yml`: tag on merged sync PR, dispatch build.
      Route: delegated writer. Evidence: 8933c9a; YAML parses.
      REOPENED 2026-09-28: invalidated by T7. A sync PR is a rebased history
      and can never be merged by GitHub's buttons (PR #1: CONFLICTING on the
      two pin files; "Rebase and merge" would replay upstream commits on top
      of the feature stack), so `pull_request closed && merged` never fires.
- [x] T7 Replace auto-tag with `edison-promote-sync.yml` (workflow_dispatch):
      verify the open sync PR, force-with-lease `upstream-sync` onto `edison`
      with the PAT, tag the next minor, push the tag (PAT push triggers the
      tag build), close the PR. Update the watch PR body, EDISON-FORK.md and
      the build comment. Route: delegated writer. Evidence: dd1881e, 6733c94;
      YAML parses, `bash -n` on all 7 run blocks OK, auto-tag removed.
      Not exercised: the promotion itself (the user's gate on PR #1).
- [x] T5 `EDISON-FORK.md` docs update. Route: delegated writer. Evidence: e987710.
- [x] T6 Spot check. Route: inline. Evidence: `npx jest test/tools` re-run by
      the orchestrator: 7 passed. Review found three gaps, fixed in 7988db0:
      PR-title shell injection in auto-tag (moved to env), sync PR opened with
      GITHUB_TOKEN raises no pull_request event (PAT fallback), tag build
      failures were silent (issue report + `issues: write`).

## Acceptance criteria
- `EDISON_REPIN=1 tools/build-edison.sh` exits 0 after a build and leaves the
  actual sha in `EXPECTED_SHA`; default mode still asserts and fails on mismatch.
- `next_edison_tag v1.1.0-edison` prints `v1.2.0-edison`; invalid input exits 1.
- `wasm_abi_signature <wasm>` prints a deterministic sorted list of imports and
  exports with kinds; identical binaries yield identical output.
- Sync PR opened by the watch contains the re-pin commit and an ABI verdict.
- Merging the sync PR creates the next tag and a build run on it.
- Docs describe the chain end to end.

## Checks
- `npx jest test/tools` green.
- Workflow YAML parses; shell blocks pass `bash -n` where extractable.

## Progress / evidence
- 2026-09-26: T1 done. Feature doc created.
- 2026-09-26: T2–T5 delivered by one writer (4 commits), T6 spot check done,
  hardening commit 7988db0. Premise verified against docs.github.com:
  GITHUB_TOKEN-triggered events create no runs except workflow_dispatch and
  repository_dispatch; GITHUB_REF on dispatch is the branch or tag dispatched.
  Not exercised: the docker build inside the watch (no upstream movement to
  test against) and the auto-tag end to end (needs a merged sync PR).

## Delivery
Strategy: ask-on-risk. Forecast ~350 authored changed lines.

## Next step
User: create a PAT (repo + workflow), store it as `UPSTREAM_SYNC_TOKEN` and
`CONSUMER_PIN_TOKEN`, merge `ci/edison-auto-sync` into `edison`, then dispatch
`edison-upstream-watch.yml` once to exercise the chain.

## Runs
- 2026-09-28 run 36431769566: rebase, CI build, re-pin (sha 60f57217…) and
  branch publish worked; PR/issue creation failed because gh inside a fork
  targets the parent repo. Fixed in 50e3ba0 (GH_REPO pin, PAT only for
  `gh pr create`).
- 2026-09-28 run 36432878352: full success, PR #1 opened, ABI verdict
  identical to v1.1.0-edison, same sha as the previous run (reproducible).

## Review evidence
- 2026-09-28: native review (lineage review-7fa7fb7cec0c44c1) on
  904c2cd..bd97769, tier high, consent granted, four lenses, approved,
  acknowledged and burned. 12 advisory findings; two were happy-path breakers
  fixed in 84c94ed: GitHub auto-marks the sync PR merged after the force-push
  so `gh pr close` failed, and a re-run after the tag push refused on
  "tag exists". Remaining follow-ups: the provenance gate is only a commit
  subject regex; anyone with write access can push a matching branch.
- 2026-09-26: native review (lineage review-8e994b31f2323500) on edison..e8eea94,
  tier high, consent granted by the user, four lenses captured, state
  approved, acknowledged and burned. 21 advisory non-blocking findings; the
  ones worth a follow-up task:
  - auto-tag is not re-run safe when the tag push succeeds and the dispatch
    fails (the pre-existing-tag guard then refuses); recover by dispatching
    the existing tag instead of failing.
  - the watch build step runs upstream-controlled build scripts with
    GH_TOKEN in scope; move the docker build into a step without the token.
  - `wasm_abi_diff` exit 1 is read as "ABI changed" even when a signature
    could not be produced; distinguish tooling failure from a real diff.
  - the failed-tag-build reporter sits before the consumer propagation step,
    so a propagation failure still goes unreported; move it last.
