# Modernize `amazon-ecs-deploy-task-definition` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the BloomAndWild fork of the ECS deploy action onto supported foundations (AWS SDK v3, Node 24 runtime, current dependencies) with zero change to observable behavior.

**Architecture:** Three staged, individually-green commits on branch `chore/modernize-sdk-node-deps`: (1) bump tooling + runtime while keeping AWS SDK v2 so tests stay green; (2) migrate source + tests to AWS SDK v3 as one atomic TDD change; (3) rebuild the `dist/` bundle and verify. Upstream's completed v3 migration (`aws-actions@a2f6d4a`) is used as a mechanical pattern reference only — nothing is merged or cherry-picked, so the fork's four custom features are untouched.

**Tech Stack:** Node.js 24, `@aws-sdk/client-ecs` v3, `@aws-sdk/client-codedeploy` v3, `@actions/core`, `yaml`, `jest` 30, `eslint` 9 (flat config), `@vercel/ncc`.

## Global Constraints

- **Runtime:** action runs on `node24` (`action.yml: runs.using`). Node 20 is removed from GitHub runners on 2026-09-16.
- **Behavior-preserving:** no change to inputs, outputs, deployment logic, log messages, or console-URL formats. This is modernization only.
- **Preserve all four custom features verbatim:** ad-hoc task runs (`run-task*`, `run-task-started-by`), task-definition ARN option (`run-task-use-arn` input, `task-definition-arn` output), verbose output settings, CodeDeploy description truncation (512-char cap with `…`).
- **No upstream feature re-sync:** upstream is a pattern reference only. Do NOT adopt upstream's changed console-URL formats, managed-tags, capacity-provider, or other features.
- **Testing approach:** module-level `jest.mock('@aws-sdk/client-ecs')` / `jest.mock('@aws-sdk/client-codedeploy')` (mirrors the existing structure). Do NOT introduce `aws-sdk-client-mock`.
- **Every commit must be green:** `npm test` (eslint + jest) passes at the end of each task.
- **Dependency versions:** install with `@latest` and commit whatever npm resolves; version floors — `eslint@^9`, `jest@^30`, `@aws-sdk/client-ecs@^3`, `@aws-sdk/client-codedeploy@^3`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `package.json` | deps, scripts, engines | Modify (both tasks) |
| `eslint.config.js` | eslint 9 flat config | Create (Task 1) |
| `.eslintrc.json` | old eslint config | Delete (Task 1) |
| `.nvmrc` | local Node version pin | Create (Task 1) |
| `action.yml` | action runtime | Modify (Task 1) |
| `.github/workflows/check.yml` | CI test workflow | Modify (Task 1) |
| `.github/workflows/package.yml` | dist packaging workflow | Modify (Task 1) |
| `.github/workflows/codeql-analysis.yml` | CodeQL workflow | Modify (Task 1) |
| `index.js` | action source | Modify (Task 2) |
| `index.test.js` | test suite | Modify (Task 2) |
| `dist/index.js` | ncc bundle the action runs | Rebuild (Task 3) |

---

## Task 1: Tooling + runtime modernization (AWS SDK unchanged)

Bump dev/runtime tooling and move the action + CI to Node 24, **keeping `aws-sdk` v2 installed and the source unchanged** so the suite stays green. This isolates tooling risk (eslint 9 flat config, jest 30) from the SDK migration.

**Files:**
- Modify: `package.json`
- Create: `eslint.config.js`
- Delete: `.eslintrc.json`
- Create: `.nvmrc`
- Modify: `action.yml:69`
- Modify: `.github/workflows/check.yml`, `.github/workflows/package.yml`, `.github/workflows/codeql-analysis.yml`
- Test: `index.test.js` (matcher future-proofing only)

**Interfaces:**
- Produces: a repo on Node 24 with eslint 9 flat config and jest 30, `aws-sdk` v2 still present, all existing tests green. Task 2 consumes this as its starting point.

- [ ] **Step 1: Pin Node version locally**

Create `.nvmrc`:
```
24
```

- [ ] **Step 2: Update `package.json` — engines, scripts, tooling deps (keep aws-sdk)**

Set `engines`, change the `lint` script to the flat-config-friendly invocation, and bump dev tooling. Leave `dependencies` (`aws-sdk`, `@actions/core`, `yaml`) in place for now except bumping `@actions/core` and `yaml`.

```jsonc
{
  // ...unchanged fields...
  "scripts": {
    "lint": "eslint .",
    "package": "ncc build index.js -o dist",
    "test": "eslint . && jest --coverage"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "@actions/core": "^1.11.1",
    "aws-sdk": "^2.1368.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@vercel/ncc": "^0.38.1",
    "eslint": "^9.0.0",
    "globals": "^15.0.0",
    "jest": "^30.0.0"
  }
}
```
Then resolve real latest versions:
```bash
npm install @actions/core@latest yaml@latest
npm install -D eslint@latest @eslint/js@latest globals@latest jest@latest @vercel/ncc@latest
```

- [ ] **Step 3: Create eslint 9 flat config**

Create `eslint.config.js` translating the old `.eslintrc.json` (env → globals, `eslint:recommended`, `ecmaVersion`). Ignore build/coverage output.
```js
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2018,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
        Atomics: 'readonly',
        SharedArrayBuffer: 'readonly',
      },
    },
    rules: {},
  },
];
```

- [ ] **Step 4: Delete the old eslint config**

```bash
git rm .eslintrc.json
```

- [ ] **Step 5: Future-proof jest matcher aliases in the test**

`index.test.js` uses the deprecated `toBeCalledWith` alias 10 times. Replace all with the canonical form so jest 30 stays warning/error-free:
```bash
sed -i 's/\.toBeCalledWith(/.toHaveBeenCalledWith(/g' index.test.js
```
Verify no `toBeCalledWith` remain:
```bash
grep -c 'toBeCalledWith' index.test.js   # expect: 0
```

- [ ] **Step 6: Move the action runtime to node24**

In `action.yml`, change line 69:
```yaml
runs:
  using: 'node24'
  main: 'dist/index.js'
```

- [ ] **Step 7: Update workflows to supported runners/actions**

`.github/workflows/check.yml` — bump checkout, add setup-node 24 before the test step:
```yaml
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Run tests
        run: |
          npm ci
          npm test
```
In the same file, bump the conventional-commits job's `actions/github-script@v6` → `actions/github-script@v7`.

`.github/workflows/package.yml` — bump `actions/checkout@v2` → `@v4` and add setup-node 24 before the Package step:
```yaml
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
```

`.github/workflows/codeql-analysis.yml` — bump any `actions/checkout@v2` → `@v4` and any `github/codeql-action/*@v1|v2` → `@v3` present in the file. (Open the file, update the pinned versions; do not change scan config.)

- [ ] **Step 8: Install and run the full suite (must stay green on v2 source)**

Run:
```bash
npm install
npm test
```
Expected: eslint passes under the flat config; jest passes with coverage. The source is still v2 (`aws-sdk` present), so behavior is unchanged — this proves the tooling bump alone is clean. If eslint's recommended set flags any pre-existing issue, fix it minimally (do not disable rules wholesale).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json eslint.config.js .nvmrc action.yml .github/workflows/ index.test.js
git rm --cached .eslintrc.json 2>/dev/null; git add -A
git commit -m "chore: modernize tooling and move action+CI to node24

Bump @actions/core, yaml, jest 30, eslint 9 (flat config), ncc.
Set action runtime to node24 and pin CI to Node 24. AWS SDK unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: AWS SDK v2 → v3 migration (source + tests, atomic)

Migrate `index.js` and `index.test.js` to AWS SDK v3 in one commit. Source and its mocks must change together, so this follows internal TDD: swap deps → convert tests (goes red) → migrate source → back to green.

**Files:**
- Modify: `package.json` (swap `aws-sdk` → v3 clients)
- Modify: `index.js`
- Modify: `index.test.js`

**Interfaces:**
- Consumes: Task 1 output (node24, jest 30, eslint 9).
- Produces: `index.js` importing `{ ECS, waitUntilServicesStable, waitUntilTasksStopped }` from `@aws-sdk/client-ecs` and `{ CodeDeploy, waitUntilDeploymentSuccessful }` from `@aws-sdk/client-codedeploy`; all AWS calls promise-based (no `.promise()`); region via `await <client>.config.region()`. `module.exports = run` unchanged.

- [ ] **Step 1: Swap the AWS SDK dependency**

```bash
npm uninstall aws-sdk
npm install @aws-sdk/client-ecs@latest @aws-sdk/client-codedeploy@latest
```
Confirm `package.json` `dependencies` now lists `@aws-sdk/client-ecs` and `@aws-sdk/client-codedeploy` and no `aws-sdk`.

- [ ] **Step 2: Convert the test mock harness to v3 (RED-inducing)**

In `index.test.js`, replace the v2 mock scaffolding (currently lines ~12–40) with v3 module mocks. Key changes:

Replace the `config` object and single `jest.mock('aws-sdk', ...)` with two module mocks and async region:
```js
const core = require('@actions/core');
const { ECS, waitUntilServicesStable, waitUntilTasksStopped } = require('@aws-sdk/client-ecs');
const { CodeDeploy, waitUntilDeploymentSuccessful } = require('@aws-sdk/client-codedeploy');
const run = require('.');

const mockEcsRegisterTaskDef = jest.fn();
const mockEcsUpdateService = jest.fn();
const mockEcsDescribeServices = jest.fn();
const mockEcsDescribeTasks = jest.fn();
const mockRunTask = jest.fn();
const mockCodeDeployCreateDeployment = jest.fn();
const mockCodeDeployGetDeploymentGroup = jest.fn();

const config = {
  region: () => Promise.resolve('fake-region'),
};

jest.mock('@aws-sdk/client-ecs', () => {
  const actual = jest.requireActual('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECS: jest.fn(() => ({
      config,
      registerTaskDefinition: mockEcsRegisterTaskDef,
      updateService: mockEcsUpdateService,
      describeServices: mockEcsDescribeServices,
      describeTasks: mockEcsDescribeTasks,
      runTask: mockRunTask,
    })),
    waitUntilTasksStopped: jest.fn(() => Promise.resolve({})),
    waitUntilServicesStable: jest.fn(() => Promise.resolve({})),
  };
});

jest.mock('@aws-sdk/client-codedeploy', () => {
  const actual = jest.requireActual('@aws-sdk/client-codedeploy');
  return {
    ...actual,
    CodeDeploy: jest.fn(() => ({
      config,
      createDeployment: mockCodeDeployCreateDeployment,
      getDeploymentGroup: mockCodeDeployGetDeploymentGroup,
    })),
    waitUntilDeploymentSuccessful: jest.fn(() => Promise.resolve({})),
  };
});
```

Then update mock **implementations** throughout the file: v2 stubs return `{ promise: () => Promise.resolve(x) }`; v3 methods return the promise directly. Replace every occurrence of the pattern:
```js
// BEFORE (v2)
mockEcsRegisterTaskDef.mockImplementation(() => {
  return { promise() { return Promise.resolve({ taskDefinition: { taskDefinitionArn: '...' } }); } };
});
// AFTER (v3)
mockEcsRegisterTaskDef.mockImplementation(() => Promise.resolve({ taskDefinition: { taskDefinitionArn: '...' } }));
```
Apply the same unwrap to `mockEcsUpdateService`, `mockEcsDescribeServices`, `mockEcsDescribeTasks`, `mockRunTask`, `mockCodeDeployCreateDeployment`, `mockCodeDeployGetDeploymentGroup`.

Replace the two waiter mocks: delete `mockEcsWaiter` / `mockCodeDeployWaiter` and their `.mockImplementation` setup. Assertions that checked `mockEcsWaiter`/`mockCodeDeployWaiter` become assertions on the imported `waitUntilTasksStopped` / `waitUntilServicesStable` / `waitUntilDeploymentSuccessful` jest.fns. In `beforeEach`, reset them:
```js
waitUntilTasksStopped.mockClear();
waitUntilServicesStable.mockClear();
waitUntilDeploymentSuccessful.mockClear();
```

Leave every **assertion string unchanged** — especially the console-URL expectations (e.g. `https://console.aws.amazon.com/ecs/home?region=fake-region#/clusters/cluster-789/services/service-456/events`). These are BloomAndWild's formats and must not become upstream's.

- [ ] **Step 3: Run tests to confirm RED**

Run:
```bash
npm test -- --silent 2>&1 | tail -20
```
Expected: FAIL. With `aws-sdk` uninstalled and `index.js` still requiring it, the suite fails to load `index.js` (`Cannot find module 'aws-sdk'`). This confirms the tests now target v3.

- [ ] **Step 4: Migrate `index.js` imports and clients**

Line 3 — replace the v2 import:
```js
const { ECS, waitUntilServicesStable, waitUntilTasksStopped } = require('@aws-sdk/client-ecs');
const { CodeDeploy, waitUntilDeploymentSuccessful } = require('@aws-sdk/client-codedeploy');
```
In `run()` (lines ~351, ~354) — drop the `aws.` prefix:
```js
const ecs = new ECS({
  customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
});
const codedeploy = new CodeDeploy({
  customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
});
```

- [ ] **Step 5: Remove all `.promise()` calls and fix region lookups**

Remove `.promise()` from all 10 call sites (lines ~51, 89, 100, 128, 145, 280, 321, 343, 388, 415 in the v2 source), and replace every `aws.config.region` with an awaited region from the relevant client.

In `runTask` — add region lookup and use it (preserves the existing log line exactly):
```js
const region = await ecs.config.region();
// ...
const runTaskResponse = await ecs.runTask({ /* unchanged params */ });
// ...
core.info(`Task running: https://console.aws.amazon.com/ecs/home?region=${region}#/clusters/${clusterName}/tasks`);
```

In `updateEcsService`:
```js
await ecs.updateService({ /* unchanged params */ });
const region = await ecs.config.region();
const consoleHostname = region.startsWith('cn') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';
core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${region}#/clusters/${clusterName}/services/${service}/events`);
```
(Keep this URL format verbatim — it is the fork's format, not upstream's.)

In `tasksExitCode`: `await ecs.describeTasks({ ... });` (drop `.promise()`).

In `createCodeDeployDeployment`: drop `.promise()` from `getDeploymentGroup` and `createDeployment`; replace the region in the CodeDeploy console URL:
```js
const region = await codedeploy.config.region();
core.info(`Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${region}`);
```

In `run()`: drop `.promise()` from `registerTaskDefinition` (line ~388) and `describeServices` (line ~415).

- [ ] **Step 6: Replace the three v2 waiters with v3 waiter functions**

`waitForTasksStopped` — replace the `ecs.waitFor('tasksStopped', {...}).promise()` block (keep the `MAX_WAIT_MINUTES` cap and log lines):
```js
if (waitForMinutes > MAX_WAIT_MINUTES) {
  waitForMinutes = MAX_WAIT_MINUTES;
}
core.info(`Waiting for tasks to stop. Will wait for ${waitForMinutes} minutes`);
const waitTaskResponse = await waitUntilTasksStopped(
  { client: ecs, maxWaitTime: waitForMinutes * 60, minDelay: WAIT_DEFAULT_DELAY_SEC },
  { cluster: clusterName, tasks: taskArns }
);
core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`);
core.info(`SUCCESS - task ${taskArns} completed`);
```

`updateEcsService` service-stability wait — replace `ecs.waitFor('servicesStable', {...}).promise()`:
```js
await waitUntilServicesStable(
  { client: ecs, maxWaitTime: waitForMinutes * 60, minDelay: WAIT_DEFAULT_DELAY_SEC },
  { services: [service], cluster: clusterName }
);
```

`createCodeDeployDeployment` deployment wait — replace `codedeploy.waitFor('deploymentSuccessful', {...}).promise()` (keep the `totalWaitMin` computation and `MAX_WAIT_MINUTES` cap):
```js
await waitUntilDeploymentSuccessful(
  { client: codedeploy, maxWaitTime: totalWaitMin * 60, minDelay: WAIT_DEFAULT_DELAY_SEC },
  { deploymentId: createDeployResponse.deploymentId }
);
```
`WAIT_DEFAULT_DELAY_SEC` stays in use (as `minDelay`), preserving the 15-second poll cadence. `MAX_WAIT_MINUTES` remains referenced by the cap logic.

- [ ] **Step 7: Run tests and iterate to GREEN**

Run:
```bash
npm test
```
Expected: PASS with coverage. If a waiter assertion fails, confirm the test asserts on the imported `waitUntil*` jest.fn (Step 2) and that the source passes `{ client, maxWaitTime, minDelay }` as the first arg (Step 6). If a region assertion fails, confirm the mocked `config.region` is `() => Promise.resolve('fake-region')` and the source awaits `<client>.config.region()`. Fix and re-run until green.

- [ ] **Step 8: Lint**

Run:
```bash
npm run lint
```
Expected: clean. `aws-sdk`'s old global `aws.config.region` references must all be gone (grep `git grep -n "aws-sdk\|aws\.config\|\.promise()" index.js` should return nothing).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json index.js index.test.js
git commit -m "feat!: migrate to AWS SDK v3

Replace aws-sdk v2 with @aws-sdk/client-ecs and @aws-sdk/client-codedeploy.
Use v3 waiters (waitUntilTasksStopped/ServicesStable/DeploymentSuccessful)
and async config.region(). Behavior and custom features unchanged.
Reference only: aws-actions@a2f6d4a (no feature re-sync).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rebuild `dist/` bundle and verify

The action runs `dist/index.js`, and `package.yml` enforces `git diff --exit-code dist/index.js`. Rebuild the bundle from the migrated source and confirm it is in sync.

**Files:**
- Modify (regenerate): `dist/index.js` (and any `dist/` assets ncc emits)

**Interfaces:**
- Consumes: Task 2 output (migrated `index.js`, v3 deps installed).
- Produces: a committed `dist/` bundle matching source; `git diff --exit-code dist/index.js` clean.

- [ ] **Step 1: Rebuild the bundle**

Run:
```bash
npm run package
```
Expected: ncc writes `dist/index.js` (bundling the v3 SDK). No errors.

- [ ] **Step 2: Confirm the bundle references v3, not v2**

Run:
```bash
grep -c "aws-sdk-js\|require('aws-sdk')" dist/index.js || true   # expect 0 matches of the v2 root package
grep -c "@aws-sdk/client-ecs" dist/index.js                      # expect > 0
```
Expected: no v2 `aws-sdk` root require; v3 client present.

- [ ] **Step 3: Full verification pass**

Run:
```bash
npm test && npm run package && git diff --exit-code dist/index.js
```
Expected: tests pass, package regenerates identically, `git diff --exit-code` returns 0 (bundle already committed/in-sync after the next step). The action's real end-to-end path (a live ECS deploy) cannot run in CI without AWS credentials; CI confidence rests on the green suite. If a staging ECS service is available, run one manual smoke deploy pointing `uses:` at this branch before opening the PR (see spec "Verification").

- [ ] **Step 4: Commit the bundle**

```bash
git add dist/
git commit -m "chore: rebuild dist bundle for AWS SDK v3

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin chore/modernize-sdk-node-deps
gh pr create --title "chore: modernize (AWS SDK v3, node24, dependency upgrades)" --body "$(cat <<'EOF'
Behavior-preserving modernization. No upstream feature re-sync; upstream used only as a pattern reference.

## Changes
- AWS SDK v2 → v3 (`@aws-sdk/client-ecs`, `@aws-sdk/client-codedeploy`), v3 waiters, async region.
- Action runtime node16 → node24; CI pinned to Node 24; workflow actions bumped.
- Dependency upgrades: eslint 9 (flat config), jest 30, ncc, @actions/core, yaml.
- Test suite migrated to v3 module mocks (no aws-sdk-client-mock).
- Rebuilt `dist/` bundle.

## Preserved custom features
Ad-hoc task runs, task-definition ARN option, verbose outputs, CodeDeploy description truncation.

Design + plan: `docs/superpowers/`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** Workstream 1 (SDK v3) → Task 2; Workstream 2 (node24) → Task 1 steps 1,6,7; Workstream 3 (deps + eslint 9 flat config) → Task 1 steps 2–4; Workstream 4 (test rewrite) → Task 2 step 2; dist rebuild + verification → Task 3. All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; every code step shows concrete code; the one deferred item (staging smoke-deploy) is explicitly conditional on infra availability, per spec.
- **Type/name consistency:** client vars `ecs`/`codedeploy`; mock fns named consistently between Task 2 step 2 (test) and the operations they back; waiter fns `waitUntilTasksStopped`/`waitUntilServicesStable`/`waitUntilDeploymentSuccessful` used identically in source (Task 2 step 6) and test (Task 2 step 2); constants `MAX_WAIT_MINUTES`/`WAIT_DEFAULT_DELAY_SEC` retained and referenced.
- **Deviation from spec (recorded):** test approach uses `jest.mock` of the v3 modules rather than `aws-sdk-client-mock`; spec Workstream 4 was updated with rationale (upstream's proven, smaller-diff pattern).
