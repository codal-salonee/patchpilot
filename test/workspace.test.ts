import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "../src/process.js";
import { assertDiff } from "../src/workspace.js";
import { defaultPolicy } from "../src/patch.js";

test("enforces cumulative diff limits against the original commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-diff-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src/math.ts"),
      "export const answer = 40;\n",
    );
    await git(root, ["-c", "init.templateDir=", "init", "--quiet"]);
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    await assert.rejects(assertDiff(root, defaultPolicy), /no changes/);
    await writeFile(
      path.join(root, "src/math.ts"),
      "export const answer = 42;\n",
    );
    assert.deepEqual(await assertDiff(root, defaultPolicy), ["src/math.ts"]);
    await assert.rejects(
      assertDiff(root, { ...defaultPolicy, maxChangedLines: 1 }),
      /Cumulative/,
    );
    await assert.rejects(
      assertDiff(root, { ...defaultPolicy, maxBytes: 1 }),
      /Cumulative/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
