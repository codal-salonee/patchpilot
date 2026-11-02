import { ESLint } from "eslint";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { z } from "zod";
import { openAI } from "../src/llm.js";
import { repair } from "../src/loop.js";
import { defaultPolicy } from "../src/patch.js";
import { command, git } from "../src/process.js";
import { diagnostic, redact } from "../src/redact.js";
import { verifyDocker, type Verification } from "../src/verify.js";
import { assertDiff } from "../src/workspace.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const bugSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  source: z.string(),
  old: z.string(),
  new: z.string(),
  tests: z.array(z.string()),
});
type Bug = z.infer<typeof bugSchema>;

async function createFixture(root: string, bug: Bug): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        ...manifest,
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint src",
          test: "tsc && node --test test/value.test.mjs",
        },
      },
      null,
      2,
    ),
  );
  for (const file of ["package-lock.json", "eslint.config.js", ".gitignore"])
    await copyFile(path.join(project, file), path.join(root, file));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          types: [],
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, "src/value.ts"), bug.source);
  await writeFile(
    path.join(root, "src/helpers.ts"),
    "export const twice = (value: number): number => value * 2;\n",
  );
  await writeFile(
    path.join(root, "test/value.test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { solve } from '../dist/value.js';",
      `test(${JSON.stringify(bug.description)}, async () => {`,
      ...bug.tests.map((line) => `  ${line}`),
      "});",
      "",
    ].join("\n"),
  );
  await git(root, ["-c", "init.templateDir=", "init", "--quiet"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=PatchPilot Evaluation",
    "-c",
    "user.email=evaluation@example.com",
    "commit",
    "--quiet",
    "-m",
    bug.id,
  ]);
}

async function verifyOracleFixture(root: string): Promise<Verification> {
  const checks: string[] = [];
  const config = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  const prefix = "Fixture source under test: src/value.ts:1\n";
  if (errors.length) {
    const output = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    });
    return { ok: false, output: prefix + output, checks };
  }
  checks.push("typecheck");
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: path.join(project, "eslint.config.js"),
  });
  const lint = await eslint.lintFiles(["src/**/*.ts"]);
  if (lint.some((result) => result.errorCount || result.warningCount)) {
    return {
      ok: false,
      output:
        prefix + (await (await eslint.loadFormatter("stylish")).format(lint)),
      checks,
    };
  }
  checks.push("lint");
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  const emitted = program.emit();
  if (emitted.emitSkipped)
    return { ok: false, output: prefix + "TypeScript emit failed", checks };
  const tested = await command(
    process.execPath,
    ["--test", "test/value.test.mjs"],
    { cwd: root, timeoutMs: 15_000 },
  );
  if (tested.ok) checks.push("test");
  return { ok: tested.ok, output: prefix + tested.output, checks };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      case: { type: "string" },
      output: { type: "string", default: "evaluation-results.json" },
    },
  });
  const bugs = z
    .array(bugSchema)
    .parse(
      JSON.parse(
        await readFile(path.join(project, "fixtures/bugs.json"), "utf8"),
      ),
    )
    .filter((bug) => !values.case || bug.id === values.case);
  if (!bugs.length) throw new Error("No matching benchmark case");
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (values.live && !apiKey) throw new Error("--live requires OPENAI_API_KEY");
  const secrets = [apiKey, process.env.GITHUB_TOKEN ?? ""];
  const model = process.env.PATCHPILOT_MODEL ?? "gpt-4.1-mini";
  const mode = values.live ? "live-model" : "oracle";
  const cases = [];
  console.log(`PatchPilot evaluation: ${mode}. ${bugs.length} seeded bugs.`);
  if (!values.live)
    console.log(
      "Known repairs test the harness, not LLM accuracy. No API calls are made.",
    );
  for (const bug of bugs) {
    const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-eval-"));
    const started = Date.now();
    try {
      await createFixture(root, bug);
      const verify = values.live ? verifyDocker : verifyOracleFixture;
      const baseline = await verify(root);
      if (baseline.infrastructure)
        throw new Error(diagnostic(baseline.output, secrets));
      if (baseline.ok)
        throw new Error(`Seeded bug did not fail verification: ${bug.id}`);
      console.log(`BASELINE FAIL ${bug.id}: reproduced`);
      const result = await repair({
        root,
        log: `Fixture source under test: src/value.ts:1\n${baseline.output}`,
        tracked: new Set([
          "src/value.ts",
          "src/helpers.ts",
          "test/value.test.mjs",
        ]),
        policy: defaultPolicy,
        maxAttempts: 3,
        secrets,
        verify,
        generate: values.live
          ? openAI({ apiKey, model, secrets })
          : async () => ({
              summary: bug.description,
              edits: [{ file: "src/value.ts", old: bug.old, new: bug.new }],
            }),
        assertDiff: async () => {
          await assertDiff(root, defaultPolicy);
        },
      });
      cases.push({
        id: bug.id,
        baselineFailed: true,
        fixed: result.ok,
        attempts: result.attempts.length,
        durationMs: Date.now() - started,
        checks: result.verification?.checks ?? [],
        failure: result.ok
          ? null
          : redact(
              result.attempts.at(-1)?.detail ?? "Unknown failure",
              secrets,
            ),
      });
      console.log(
        `${result.ok ? "PASS" : "FAIL"} ${bug.id}: ${result.attempts.length} attempt(s)`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const fixed = cases.filter((result) => result.fixed).length;
  const report = {
    mode,
    model: values.live ? model : null,
    timestamp: new Date().toISOString(),
    total: cases.length,
    fixed,
    successRate: fixed / cases.length,
    note: values.live
      ? "Measured model repairs; tests are visible context, not a held-out benchmark."
      : "Oracle repairs validate the harness. This is NOT a measured LLM success rate.",
    cases,
  };
  await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `${fixed}/${cases.length} verified (${(report.successRate * 100).toFixed(1)}%). Report: ${values.output}`,
  );
  if (fixed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    diagnostic(error, [
      process.env.OPENAI_API_KEY ?? "",
      process.env.GITHUB_TOKEN ?? "",
    ]),
  );
  process.exitCode = 1;
});
