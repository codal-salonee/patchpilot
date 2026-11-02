import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";

test("action and consumer workflows parse and preserve the privilege boundary", async () => {
  for (const file of [
    "action.yml",
    ".github/workflows/ci.yml",
    "examples/patchpilot-demo-ci.yml",
    "examples/patchpilot-demo-heal.yml",
  ]) {
    const document = parseDocument(await readFile(file, "utf8"), {
      uniqueKeys: true,
    });
    assert.deepEqual(document.errors, [], `${file} must be valid YAML`);
  }
  const content = await readFile("examples/patchpilot-demo-heal.yml", "utf8");
  assert.match(content, /workflow_run:/);
  assert.match(content, /actions: read/);
  assert.doesNotMatch(content, /actions\/checkout|pull_request_target/);
  const action = await readFile("action.yml", "utf8");
  assert.match(action, /npm ci --ignore-scripts/);
  assert.doesNotMatch(action, /run:.*\$\{\{\s*inputs\./);
});
