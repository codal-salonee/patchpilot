import assert from "node:assert/strict";
import { test } from "node:test";
import { skipReason, type Run } from "../src/github.js";

const run: Run = {
  id: 1,
  name: "CI",
  status: "completed",
  conclusion: "failure",
  event: "push",
  head_sha: "a".repeat(40),
  head_branch: "main",
  head_repository: { full_name: "owner/demo" },
  html_url: "https://github.com/owner/demo/actions/runs/1",
};

test("only accepts failed allowlisted push runs on the same-repo default branch", () => {
  assert.equal(skipReason(run, "owner/demo", "main", ["CI"]), undefined);
  for (const overrides of [
    { event: "pull_request" },
    { conclusion: "success" },
    { status: "in_progress" },
    { head_repository: { full_name: "fork/demo" } },
    { head_repository: null },
    { head_branch: "patchpilot/run-1" },
    { head_branch: "feature" },
    { name: "Deploy" },
    { head_sha: "not-a-sha" },
  ])
    assert.ok(
      skipReason({ ...run, ...overrides }, "owner/demo", "main", ["CI"]),
    );
});
