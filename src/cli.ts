#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { GitHub, skipReason } from "./github.js";
import { openAI } from "./llm.js";
import { repair } from "./loop.js";
import { defaultPolicy } from "./patch.js";
import { diagnostic } from "./redact.js";
import { verifyDocker } from "./verify.js";
import { assertDiff, fetchWorkspace } from "./workspace.js";

const configSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  PATCHPILOT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
  PATCHPILOT_WORKFLOWS: z.string().min(1).default("CI"),
  PATCHPILOT_ALLOWED_PATHS: z.string().default("src/"),
  PATCHPILOT_MODEL: z.string().min(1).default("gpt-4.1-mini"),
});

async function main(): Promise<void> {
  if (process.argv[2] !== "heal") {
    console.log(
      "Usage: patchpilot heal [run-id]\nRequires GITHUB_TOKEN, GITHUB_REPOSITORY, OPENAI_API_KEY, Docker, and git.",
    );
    return;
  }
  const config = configSchema.parse(process.env);
  const secrets = [config.GITHUB_TOKEN, process.env.OPENAI_API_KEY ?? ""];
  let runId = Number(process.argv[3]);
  if (
    !runId &&
    process.env.GITHUB_EVENT_NAME === "workflow_run" &&
    process.env.GITHUB_EVENT_PATH
  ) {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    ) as { workflow_run?: { id?: number } };
    runId = Number(event.workflow_run?.id);
  }
  if (!Number.isSafeInteger(runId) || runId <= 0)
    throw new Error("Provide a valid workflow run ID or workflow_run event");
  const github = new GitHub(
    config.GITHUB_REPOSITORY,
    config.GITHUB_TOKEN,
    secrets,
  );
  const { run, defaultBranch, currentSha } = await github.run(runId);
  const reason = skipReason(
    run,
    config.GITHUB_REPOSITORY,
    defaultBranch,
    config.PATCHPILOT_WORKFLOWS.split(",").map((value) => value.trim()),
  );
  if (reason) {
    console.log(JSON.stringify({ status: "skipped", reason }));
    return;
  }
  const existing = await github.existing(run.id);
  if (existing) {
    console.log(JSON.stringify({ status: "existing", url: existing }));
    return;
  }
  if (currentSha !== run.head_sha) {
    console.log(
      JSON.stringify({
        status: "skipped",
        reason: "Failed commit is no longer the default branch tip",
      }),
    );
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpilot-work-"));
  try {
    const allowedPaths = config.PATCHPILOT_ALLOWED_PATHS.split(",").map(
      (value) => value.trim(),
    );
    if (
      allowedPaths.some(
        (value) =>
          !/^(?:[\w-]+\/)+$/.test(value) ||
          /^(?:node_modules|dist|test|tests)\//.test(value),
      )
    ) {
      throw new Error(
        "Allowed paths must be relative source directories ending in /",
      );
    }
    const policy = { ...defaultPolicy, allowedPaths };
    if (!process.env.OPENAI_API_KEY)
      throw new Error("OPENAI_API_KEY is required");
    const log = await github.logs(run);
    const tracked = await fetchWorkspace(
      root,
      config.GITHUB_REPOSITORY,
      run.head_sha,
      config.GITHUB_TOKEN,
    );
    const baseline = await verifyDocker(root);
    if (baseline.infrastructure) throw new Error(baseline.output);
    if (baseline.ok) {
      console.log(
        JSON.stringify({
          status: "skipped",
          reason: "Failure did not reproduce in required checks",
        }),
      );
      return;
    }
    const result = await repair({
      root,
      log: `${log}\n\nLocal reproduction:\n${baseline.output}`,
      tracked,
      policy,
      maxAttempts: config.PATCHPILOT_MAX_ATTEMPTS,
      secrets,
      generate: openAI({
        apiKey: process.env.OPENAI_API_KEY,
        model: config.PATCHPILOT_MODEL,
        secrets,
      }),
      verify: verifyDocker,
      assertDiff: async () => {
        await assertDiff(root, policy);
      },
    });
    if (!result.ok) {
      const url = await github.issue(
        run,
        result.attempts
          .map(
            (attempt) =>
              `Attempt ${attempt.number}: ${attempt.status}\n${attempt.detail}`,
          )
          .join("\n\n"),
      );
      console.log(
        JSON.stringify({
          status: "issue",
          url,
          attempts: result.attempts.length,
        }),
      );
      return;
    }
    const files = await assertDiff(root, policy);
    const url = await github.pullRequest({
      run,
      base: defaultBranch,
      root,
      files,
      result,
    });
    console.log(
      JSON.stringify({
        status: "pull-request",
        url,
        attempts: result.attempts.length,
      }),
    );
  } catch (error) {
    const url = await github.issue(run, diagnostic(error, secrets));
    console.log(JSON.stringify({ status: "issue", url }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const secrets = [
    process.env.GITHUB_TOKEN ?? "",
    process.env.OPENAI_API_KEY ?? "",
  ];
  const message =
    error instanceof z.ZodError
      ? "Invalid PatchPilot environment configuration; check required variables and limits"
      : diagnostic(error, secrets);
  console.error(message);
  process.exitCode = 1;
});
