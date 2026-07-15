# Modernize `amazon-ecs-deploy-task-definition` fork — Design

**Date:** 2026-07-15
**Status:** Approved (pending spec review)
**Owner:** BloomAndWild platform

## Context

`BloomAndWild/amazon-ecs-deploy-task-definition` is a long-lived fork of
`aws-actions/amazon-ecs-deploy-task-definition`. The fork intentionally diverged from
upstream because upstream feature development moved too slowly; the fork carries four
custom features that upstream either lacks or implemented differently. **This has proven
to be the correct decision and we are not re-syncing with upstream.**

However, the fork has drifted onto deprecated foundations:

- **AWS SDK v2** (`aws-sdk ^2.1368.0`) — AWS end-of-support. All 12 AWS call sites use the
  v2 `.promise()` idiom.
- **Node 16 action runtime** (`action.yml: using: 'node16'`) — deprecated. Node 20 is
  itself now deprecated and is **removed from GitHub-hosted runners on 2026-09-16**; JS
  actions are forced onto Node 24 by default as of 2026-06-02.
- **Aging dev/runtime dependencies** across the board (eslint 8, jest 29, older ncc,
  `@actions/core`, `yaml`).

Upstream already performed the **exact** AWS SDK v2→v3 transform (commit `a2f6d4a`) on a
source file that was nearly identical to ours at the fork point. We will use that diff as
a **mechanical reference only** — we migrate our own source; we do not merge or cherry-pick
upstream, so no feature re-sync occurs.

## Goal & guardrails

Pure, **behavior-preserving modernization**. No feature changes. No upstream feature re-sync.

The four custom features are preserved exactly:

| Feature | Source markers |
|---|---|
| Ad-hoc task runs | `run-task*` inputs, `run-task-started-by` (index.js:26) |
| Task-definition ARN option | `run-task-use-arn` (index.js:371), `task-definition-arn` output (index.js:397) |
| Verbose output settings | additional `core.setOutput` calls |
| CodeDeploy description truncation | 512-char cap (index.js:318-319) |

Success = supported runtime + supported SDK + current dependencies, with the existing test
suite green and `dist/` rebuilt, and **no observable change in the action's behavior**.

## Non-goals

- Adopting any upstream feature (managed tags, capacity-provider strategy, desired-tasks,
  bridge-network fix, etc.).
- Changing input/output surface or deployment behavior.
- Refactoring beyond what the SDK/runtime migration mechanically requires.

## Workstreams

### 1. AWS SDK v2 → v3

- Replace `aws-sdk` with `@aws-sdk/client-ecs` and `@aws-sdk/client-codedeploy`.
- Rewrite the 12 call sites:
  - `new aws.ECS({...})` → `new ECS({...})`; `new aws.CodeDeploy({...})` → `new CodeDeploy({...})`.
  - Drop all 10 `.promise()` calls — v3 client methods return promises directly.
- Replace hand-rolled waiting/polling helpers with v3 built-in waiters, **keeping our
  feature logic around them and only swapping the AWS mechanics**:
  - task stop wait → `waitUntilTasksStopped`
  - service stability wait → `waitUntilServicesStable`
  - CodeDeploy wait → `waitUntilDeploymentSuccessful`
- Update error handling to v3 shapes (`error.name` rather than v2 `error.code`).
- Reference (pattern only, do not merge): upstream `index.js` imports
  `const { ECS, waitUntilServicesStable, waitUntilTasksStopped } = require('@aws-sdk/client-ecs')`
  and `const { CodeDeploy, waitUntilDeploymentSuccessful } = require('@aws-sdk/client-codedeploy')`.

### 2. Node runtime → node24

- `action.yml`: `using: 'node16'` → `using: 'node24'`.
- Add `.nvmrc` pinned to `24` and `engines.node` in `package.json` for local/dev consistency.
- Add `actions/setup-node@v4` with `node-version: 24` to the workflows (`check.yml`,
  `package.yml`, `codeql-analysis.yml` as applicable) — they currently pin no Node version.

### 3. Dependency upgrades

- Runtime deps → latest: `@actions/core`, `yaml`.
- Dev deps → latest majors: `@vercel/ncc`, `jest` (29 → 30), `eslint` (8 → 9).
- **eslint 9 flat config**: migrate to `eslint.config.js` (approved). Remove/retire the old
  `.eslintrc*` config. Update the `lint` script if the invocation changes.
- Rebuild and commit `dist/index.js` via `npm run package` (the action runs `dist/index.js`,
  not the root source).

### 4. Test suite rewrite

- `index.test.js` (1,421 lines, 20 v2 `promise()` stubs) is written against the v2 mock
  idiom, which v3 breaks.
- Rewrite the AWS mocking to **`aws-sdk-client-mock`** (the v3 testing standard, also used
  upstream). Add it as a dev dependency.
- **Preserve every existing test case and assertion** — this is a translation of the mock
  layer, not a redesign of coverage.

## Verification

- `npm test` (eslint flat config + jest with coverage) passes.
- `npm run package` produces a clean `dist/` with no uncommitted diff afterward.
- Real end-to-end confidence requires live AWS (the action performs real ECS deploys), so
  CI confidence rests on the translated test suite. Determine during planning whether a
  sandbox/staging smoke-deploy is feasible; if so, run one before merge.

## Sequencing

Single branch, staged commits, one PR at the end:

1. Dependency upgrades + Node runtime (`action.yml`, `.nvmrc`, `engines`, workflows, eslint 9 flat config).
2. AWS SDK v3 source migration (`index.js`).
3. Test suite rewrite (`index.test.js` → `aws-sdk-client-mock`).
4. Rebuild and commit `dist/`.

Rationale: get tooling/runtime current first so lint/build run on the target stack, then do
the source migration, then make tests green against it, then ship the built artifact.

## Risks

- **SDK v3 semantic drift**: v3 waiters and error shapes differ subtly from our hand-rolled
  v2 logic. Mitigation: preserve feature logic, lean on upstream's reference for the exact
  mapping, and keep test assertions unchanged.
- **Test rewrite scope**: the 1,421-line test file is the largest single task and the main
  source of hidden effort. Mitigation: mechanical, case-by-case translation to
  `aws-sdk-client-mock`.
- **No prod-equivalent verification in CI**: the action deploys real infrastructure.
  Mitigation: flag sandbox smoke-deploy feasibility during planning.
