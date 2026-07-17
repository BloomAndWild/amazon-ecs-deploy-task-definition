# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GitHub JavaScript Action that registers an Amazon ECS task definition and deploys it — to an ECS service (rolling `ECS` controller or blue/green `CODE_DEPLOY` controller) and/or as an ad-hoc `RunTask`. This is **BloomAndWild's fork** of [`aws-actions/amazon-ecs-deploy-task-definition`](https://github.com/aws-actions/amazon-ecs-deploy-task-definition), intentionally diverged; we do **not** re-sync features from upstream (see Fork discipline below).

## Commands

```bash
npm install                         # deps (Node 24 — see engines/.nvmrc)
npm test                            # eslint . && jest --coverage  (the full gate)
npm run lint                        # eslint . (flat config: eslint.config.js)
npx jest -t "run task with options" # run a single test by name
npx jest --coverage=false           # faster local run without coverage
npm run package                     # ncc build index.js -o dist  (REQUIRED after any index.js change — see below)
```

## Architecture

- **`index.js`** (repo root) is the entire hand-written source. There is no `src/`. Its single entry is `run()` (exported; also self-invokes when run as main).
- **`dist/index.js`** is the ncc-bundled artifact that the action actually executes (`action.yml` → `runs.main`). It is generated, committed, and must stay in sync with `index.js`.
- **`index.test.js`** is the jest suite (30 tests) covering `run()` end-to-end.

`run()` flow: read inputs → resolve the task-def ARN (register from file, OR use the passed-in ARN when `run-task-use-arn: true`) → optionally run an ad-hoc task (`run-task: true`) → if a `service` is given, `describeServices` and branch on the deployment controller: `ECS`/absent → `updateService`; `CODE_DEPLOY` → `createCodeDeployDeployment` (patches the appspec with the new ARN and starts a deployment). Waits use AWS SDK **v3** waiters (`waitUntilTasksStopped` / `waitUntilServicesStable` / `waitUntilDeploymentSuccessful`).

Uses AWS SDK v3: `@aws-sdk/client-ecs` and `@aws-sdk/client-codedeploy` (the CodeDeploy client is required — it powers the blue/green deployment path, not optional). Region is read via `await <client>.config.region()`.

## Critical, non-obvious rules

- **Rebuild `dist/` after every `index.js` change.** The action runs `dist/index.js`, not the source. CI (`package.yml`) runs `git diff --exit-code dist/index.js` and fails if the committed bundle doesn't match a fresh `npm run package`. Always `npm run package` and commit `dist/` in the same change as an `index.js` edit. (A README/docs-only change does not need a rebuild — only `index.js` is bundled.)
- **`@actions/core` is pinned to exactly `1.10.1` — do not bump it.** `>=1.11.0` transitively loads `@actions/io`'s `io-util.js`, which reads `fs.constants` at import time and crashes `index.test.js`'s `jest.mock('fs', ...)` factory. There is a Dependabot ignore rule guarding this; the caret was removed deliberately.
- **Test mocking style:** tests use `jest.mock('@aws-sdk/client-ecs')` / `jest.mock('@aws-sdk/client-codedeploy')` (NOT `aws-sdk-client-mock`), mocking aggregated client methods to return promises directly and exposing `waitUntil*` as `jest.fn()`s. `config.region` is mocked as `() => Promise.resolve('fake-region')` (it is async in v3).

## Fork discipline

- Changes should be **behavior-preserving** unless a change is explicitly the goal. Preserve the four custom features: ad-hoc task runs (`run-task*`, `run-task-started-by`), the task-definition ARN option (`run-task-use-arn` input, `task-definition-arn` output), verbose outputs, and CodeDeploy description truncation (512-char cap with `…`).
- **Keep BloomAndWild's console-URL formats** (e.g. `/ecs/home?region=...#/clusters/...`). Do NOT adopt upstream's `/ecs/v2/...` format when referencing upstream as a pattern.
- A known latent bug is documented inline in `runTask` (`index.js`): when `run-task-subnets`/`run-task-security-groups` are both empty, an empty `awsvpcConfiguration` is sent (harmless for FARGATE-with-subnets usage; would break EC2/no-VPC ad-hoc tasks). Left as-is intentionally.

## CI and merge requirements

Three workflows, all on `pull_request`: `check.yml` (unit tests), `package.yml` (rebuilds and verifies `dist/`), and a conventional-commit PR-title check. `main`'s branch protection requires those three checks to pass plus **1 approving review**. PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). CodeQL was removed from this fork (see README "Fork maintenance notes").

## Background

The AWS SDK v2→v3 + Node 24 modernization is documented under `docs/superpowers/` (design spec and implementation plan) — useful context for why the current structure and pins exist.
