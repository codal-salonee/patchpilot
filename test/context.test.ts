import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectContext, locations } from "../src/context.js";
import { defaultPolicy } from "../src/patch.js";
import { redact } from "../src/redact.js";

test("extracts tsc, Next.js, and stack-trace source locations", () => {
  assert.deepEqual(
    locations(
      "src/math.ts(3,2): error TS2322\n./src/view.tsx:9:4\n at fn (/home/runner/work/demo/src/cart.ts:12:8)",
    ),
    [
      { file: "src/math.ts", line: 3 },
      { file: "src/view.tsx", line: 9 },
      { file: "src/cart.ts", line: 12 },
    ],
  );
});

test("redacts known secrets, token formats, authorization, and secret assignments", () => {
  const result = redact(
    "\u001b[31mfailure\u001b[0m token=abc123\nAuthorization: Bearer abcdef\nghp_12345 secret-value sk-abcdefghijklmnop",
    ["secret-value"],
  );
  for (const value of [
    "abc123",
    "abcdef",
    "ghp_12345",
    "secret-value",
    "sk-abcdefghijklmnop",
    "\u001b",
  ])
    assert.ok(!result.includes(value));
  assert.match(result, /failure/);
});

test("follows test imports to source without permitting test edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-context-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "test"));
    await writeFile(
      path.join(root, "test/cart.test.ts"),
      "import { total } from '../src/cart.js';\n",
    );
    await writeFile(
      path.join(root, "src/cart.ts"),
      "export const total = 41;\n",
    );
    const context = await collectContext(
      root,
      "test/cart.test.ts:1:1 AssertionError",
      new Set(["test/cart.test.ts", "src/cart.ts"]),
      defaultPolicy,
    );
    assert.deepEqual(
      context.map((source) => [source.file, source.editable]),
      [
        ["test/cart.test.ts", false],
        ["src/cart.ts", true],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
