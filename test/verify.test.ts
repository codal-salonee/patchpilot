import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { command } from "../src/process.js";
import { verifyDocker } from "../src/verify.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-verify-test-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { typecheck: "tsc", lint: "eslint", test: "node --test" },
    }),
  );
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(root, ".env"), "TOKEN=secret");
  await writeFile(
    path.join(root, ".npmrc"),
    "//registry.npmjs.org/:_authToken=secret",
  );
  await mkdir(path.join(root, ".git"));
  return root;
}

test("sandbox command contract excludes secrets and Git metadata and disables check networking", async () => {
  const root = await fixture();
  const invocations: string[][] = [];
  let snapshot = "";
  const run: typeof command = async (executable, args) => {
    assert.equal(executable, "docker");
    invocations.push(args);
    if (args[0] === "run") {
      const mount = args[args.indexOf("--mount") + 1] ?? "";
      snapshot = mount
        .replace("type=bind,src=", "")
        .replace(",dst=/workspace", "");
      await readFile(path.join(snapshot, "package.json"));
      for (const file of [".git", ".env", ".npmrc"])
        await assert.rejects(access(path.join(snapshot, file)));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges"));
      assert.ok(args.includes("--read-only"));
      assert.ok(!args.some((arg) => arg.includes("secret")));
    }
    return { ok: true, code: 0, output: "ok" };
  };
  try {
    const result = await verifyDocker(root, undefined, run);
    assert.equal(result.ok, true);
    assert.deepEqual(result.checks, ["typecheck", "lint", "test"]);
    const commands = invocations.filter((args) => args[0] === "run");
    assert.equal(commands.length, 4);
    assert.ok(commands[0]?.includes("--network=bridge"));
    assert.ok(commands[0]?.includes("--ignore-scripts"));
    for (const args of commands.slice(1))
      assert.ok(args.includes("--network=none"));
    await assert.rejects(access(snapshot));
    assert.deepEqual(invocations.at(-1)?.slice(0, 2), ["rm", "-f"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency failures stop as infrastructure errors before running checks", async () => {
  const root = await fixture();
  const commands: string[][] = [];
  const run: typeof command = async (_executable, args) => {
    commands.push(args);
    return {
      ok: args[0] !== "run",
      code: args[0] === "run" ? 1 : 0,
      output: "dependency error",
    };
  };
  try {
    const result = await verifyDocker(root, undefined, run);
    assert.equal(result.infrastructure, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.checks, []);
    assert.equal(commands.filter((args) => args[0] === "run").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
