# Separate Next.js Demo

Keep `patchpilot-demo` in its own repository. This bot repository contains no Next.js dashboard or application.

## Create The Target

From the parent directory, create a sibling project:

```sh
npx create-next-app@latest patchpilot-demo --typescript --eslint --app --src-dir --use-npm
cd patchpilot-demo
npm install --save-dev vitest
```

Use a Node 22-compatible Next.js version. Add `typecheck: tsc --noEmit`, `lint: eslint .`, and `test: vitest run` to package scripts. Commit the npm lockfile. Do not use the removed `next lint` command on modern Next.js versions.

Use the two workflows in this bot repository's `examples/` directory, then replace the pinned Action placeholder as described in the README. Keep the workflow name `CI` aligned with both the `workflow_run` trigger and `workflow-names` input.

## Seed One Bug

Create a source helper at `src/lib/quantity.ts`:

```ts
export function quantity(value: number | undefined): number {
  return value || 10;
}
```

Create a test at `test/quantity.test.ts`:

```ts
import { expect, test } from 'vitest';
import { quantity } from '../src/lib/quantity';

test('preserves zero and defaults only an absent quantity', () => {
  expect(quantity(0)).toBe(0);
  expect(quantity(undefined)).toBe(10);
  expect(quantity(4)).toBe(4);
});
```

This deliberately fails for zero. Test diagnostics point to the test; PatchPilot reads it as evidence, follows the relative source import, and can propose replacing `||` with `??`. Test edits are forbidden. Keep the helper connected to a real page/cart workflow as the demo evolves, rather than inventing unrelated CI failures.

## Demo Sequence

1. Run the tests locally to show the failure.
2. Commit/push the bug and test to the demo default branch. Only do this in the disposable demo repository.
3. Show the failed CI and automatically triggered repair run.
4. Inspect the draft PR's explanation, diff, and verification summary.
5. Run normal PR CI manually if using `GITHUB_TOKEN`, review, and merge yourself.

Expand the demo with the 12 cases in `fixtures/bugs.json`, one isolated bug per run. Do not commit unrelated simultaneous bugs when measuring per-case repair success. Record model, attempts, and results; report failed cases as well as successful ones.