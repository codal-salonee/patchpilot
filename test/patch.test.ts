import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyProposal, defaultPolicy } from "../src/patch.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-test-"));
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src/math.ts"),
    "export const answer = 41;\n",
  );
  return root;
}

test("applies an exact structured replacement", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(
      await applyProposal(root, {
        summary: "Correct the answer",
        edits: [{ file: "src/math.ts", old: "41", new: "42" }],
      }),
      ["src/math.ts"],
    );
    assert.equal(
      await readFile(path.join(root, "src/math.ts"), "utf8"),
      "export const answer = 42;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe paths, missing matches, no-ops, oversized edits, and unseen files", async () => {
  const root = await fixture();
  try {
    for (const file of [
      "../src/math.ts",
      "/src/math.ts",
      "src/../math.ts",
      ".github/workflows/ci.yml",
      "src/.env",
      "src\\math.ts",
      "src/math.test.ts",
      "src/__tests__/math.ts",
    ]) {
      await assert.rejects(
        applyProposal(root, {
          summary: "Bad",
          edits: [{ file, old: "41", new: "42" }],
        }),
      );
    }
    for (const [old, replacement] of [
      ["missing", "42"],
      ["41", "41"],
    ]) {
      await assert.rejects(
        applyProposal(root, {
          summary: "Bad",
          edits: [{ file: "src/math.ts", old, new: replacement }],
        }),
      );
    }
    const proposal = {
      summary: "Fix",
      edits: [{ file: "src/math.ts", old: "41", new: "42" }],
    };
    await assert.rejects(
      applyProposal(root, proposal, { ...defaultPolicy, maxBytes: 1 }),
    );
    await assert.rejects(
      applyProposal(root, proposal, defaultPolicy, new Set()),
    );
    await assert.rejects(
      applyProposal(root, {
        summary: "Hide error",
        edits: [{ file: "src/math.ts", old: "41", new: "// @ts-ignore\n42" }],
      }),
    );
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /41/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates every edit before writing any file", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      applyProposal(root, {
        summary: "Bad second edit",
        edits: [
          { file: "src/math.ts", old: "41", new: "42" },
          { file: "src/math.ts", old: "not present", new: "0" },
        ],
      }),
    );
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /41/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous matches and symlink escapes", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "src/math.ts"), "41 + 41");
    await assert.rejects(
      applyProposal(root, {
        summary: "Ambiguous",
        edits: [{ file: "src/math.ts", old: "41", new: "42" }],
      }),
    );
    await symlink(
      path.join(root, "src/math.ts"),
      path.join(root, "src/link.ts"),
    );
    await assert.rejects(
      applyProposal(root, {
        summary: "Symlink",
        edits: [{ file: "src/link.ts", old: "41 + 41", new: "42" }],
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
