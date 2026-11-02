import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repair } from "../src/loop.js";
import { defaultPolicy } from "../src/patch.js";

test("feeds failed checks back into the next attempt, then passes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-loop-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/math.ts"), "export const answer = 40;");
  try {
    let calls = 0;
    const result = await repair({
      root,
      log: "src/math.ts:1:1: wrong answer",
      tracked: new Set(["src/math.ts"]),
      policy: defaultPolicy,
      maxAttempts: 3,
      secrets: [],
      assertDiff: async () => {},
      generate: async (request) => {
        if (request.attempt === 2)
          assert.match(request.feedback, /Expected 42/);
        return {
          summary: "Correct the answer",
          edits: [
            {
              file: "src/math.ts",
              old: request.attempt === 1 ? "40" : "41",
              new: request.attempt === 1 ? "41" : "42",
            },
          ],
        };
      },
      verify: async () => {
        calls++;
        const ok = (
          await readFile(path.join(root, "src/math.ts"), "utf8")
        ).includes("42");
        return {
          ok,
          output: ok ? "pass" : "Expected 42; got 41",
          checks: ok ? ["typecheck", "lint", "test"] : [],
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.status),
      ["failed", "passed"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops at the attempt limit without executing invalid edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-loop-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/math.ts"), "40");
  try {
    let generated = 0;
    const result = await repair({
      root,
      log: "src/math.ts:1 error",
      tracked: new Set(["src/math.ts"]),
      policy: defaultPolicy,
      maxAttempts: 2,
      secrets: [],
      assertDiff: async () => {},
      generate: async () => {
        generated++;
        return {
          summary: "Unsafe",
          edits: [{ file: "../escape.ts", old: "40", new: "42" }],
        };
      },
      verify: async () => {
        throw new Error("Must not execute");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(generated, 2);
    assert.equal(result.attempts.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rolls back a proposal rejected by the cumulative diff check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-loop-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/math.ts"), "40");
  try {
    const result = await repair({
      root,
      log: "src/math.ts:1 error",
      tracked: new Set(["src/math.ts"]),
      policy: defaultPolicy,
      maxAttempts: 1,
      secrets: [],
      generate: async () => ({
        summary: "Too big",
        edits: [{ file: "src/math.ts", old: "40", new: "42" }],
      }),
      assertDiff: async () => {
        throw new Error("Cumulative diff exceeds policy");
      },
      verify: async () => {
        throw new Error("Must not execute");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(await readFile(path.join(root, "src/math.ts"), "utf8"), "40");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
