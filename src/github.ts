import { Octokit } from "@octokit/rest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { quoted, redact } from "./redact.js";
import type { RepairResult } from "./loop.js";

export type Run = {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  event: string;
  head_sha: string;
  head_branch: string | null;
  head_repository: { full_name?: string } | null;
  html_url: string;
};

export function skipReason(
  run: Run,
  repository: string,
  defaultBranch: string,
  workflows: string[],
): string | undefined {
  if (run.status !== "completed" || run.conclusion !== "failure")
    return "Run is not a completed failure";
  if (!run.name || !workflows.includes(run.name))
    return "Workflow is not allowlisted";
  if (run.event !== "push") return "Only push-triggered CI is supported";
  if (
    run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()
  )
    return "Fork or unknown head repository";
  if (run.head_branch?.startsWith("patchpilot/")) return "Bot branch ignored";
  if (run.head_branch !== defaultBranch)
    return "Only the default branch is eligible";
  if (!/^[a-f0-9]{40}$/.test(run.head_sha)) return "Invalid commit SHA";
  return undefined;
}

async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.ok || !response.body)
    throw new Error(`Log download failed (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new Error("Job log exceeds the 2 MB download limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class GitHub {
  readonly api: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(
    readonly repository: string,
    private readonly token: string,
    private readonly secrets: string[],
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error("Repository must be owner/name");
    [this.owner, this.repo] = repository.split("/") as [string, string];
    this.api = new Octokit({ auth: token, request: { timeout: 30_000 } });
  }

  get coordinates() {
    return { owner: this.owner, repo: this.repo };
  }

  async run(
    id: number,
  ): Promise<{ run: Run; defaultBranch: string; currentSha: string }> {
    const [{ data: run }, { data: repo }] = await Promise.all([
      this.api.actions.getWorkflowRun({ ...this.coordinates, run_id: id }),
      this.api.repos.get(this.coordinates),
    ]);
    const { data: branch } = await this.api.repos.getBranch({
      ...this.coordinates,
      branch: repo.default_branch,
    });
    return {
      run: { ...run, name: run.name ?? null },
      defaultBranch: repo.default_branch,
      currentSha: branch.commit.sha,
    };
  }

  async existing(runId: number): Promise<string | undefined> {
    const { data: prs } = await this.api.pulls.list({
      ...this.coordinates,
      head: `${this.owner}:patchpilot/run-${runId}`,
      state: "all",
    });
    if (prs[0]) return prs[0].html_url;
    const issues = await this.api.paginate(this.api.issues.listForRepo, {
      ...this.coordinates,
      state: "open",
      per_page: 100,
    });
    return issues.find((issue) =>
      issue.body?.includes(`<!-- patchpilot:run:${runId} -->`),
    )?.html_url;
  }

  async logs(run: Run): Promise<string> {
    const jobs = await this.api.paginate(
      this.api.actions.listJobsForWorkflowRun,
      {
        ...this.coordinates,
        run_id: run.id,
        filter: "latest",
        per_page: 100,
      },
    );
    const failed = jobs
      .filter((job) => ["failure", "timed_out"].includes(job.conclusion ?? ""))
      .slice(0, 3);
    const logs: string[] = [];
    for (const job of failed) {
      let response = await fetch(
        `https://api.github.com/repos/${this.repository}/actions/jobs/${job.id}/logs`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 302) {
        const location = response.headers.get("location");
        if (!location || new URL(location).protocol !== "https:")
          throw new Error("Unsafe log redirect");
        response = await fetch(location, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
      }
      logs.push(
        `Failed job: ${job.name}\n${redact(await boundedText(response, 2_000_000), this.secrets).slice(-20_000)}`,
      );
    }
    if (!logs.length) throw new Error("No failed-job logs were available");
    return logs.join("\n\n").slice(-50_000);
  }

  async issue(run: Run, detail: string): Promise<string> {
    const prior = await this.existing(run.id);
    if (prior) return prior;
    const { data } = await this.api.issues.create({
      ...this.coordinates,
      title: `PatchPilot: manual repair needed for CI run ${run.id}`,
      body: [
        `<!-- patchpilot:run:${run.id} -->`,
        `PatchPilot could not verify a repair for [CI run ${run.id}](${run.html_url}).`,
        `Commit: ${run.head_sha}. No changes were merged. A maintainer needs to investigate.`,
        "### Sanitized Diagnostics",
        quoted(redact(detail, this.secrets).slice(-16_000)),
      ].join("\n\n"),
    });
    return data.html_url;
  }

  async pullRequest(options: {
    run: Run;
    base: string;
    root: string;
    files: string[];
    result: RepairResult;
  }): Promise<string> {
    const { run, base, root, files, result } = options;
    const { data: current } = await this.api.repos.getBranch({
      ...this.coordinates,
      branch: base,
    });
    if (current.commit.sha !== run.head_sha)
      throw new Error(
        "Default branch advanced during repair; refusing a stale PR",
      );
    const { data: original } = await this.api.git.getCommit({
      ...this.coordinates,
      commit_sha: run.head_sha,
    });
    const tree = [];
    for (const file of files) {
      const { data: blob } = await this.api.git.createBlob({
        ...this.coordinates,
        content: (await readFile(path.join(root, file))).toString("base64"),
        encoding: "base64",
      });
      tree.push({
        path: file,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      });
    }
    const { data: patchedTree } = await this.api.git.createTree({
      ...this.coordinates,
      base_tree: original.tree.sha,
      tree,
    });
    const { data: commit } = await this.api.git.createCommit({
      ...this.coordinates,
      message: `fix: repair CI run ${run.id} with PatchPilot`,
      tree: patchedTree.sha,
      parents: [run.head_sha],
    });
    const branch = `patchpilot/run-${run.id}`;
    try {
      await this.api.git.createRef({
        ...this.coordinates,
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      const { data: ref } = await this.api.git.getRef({
        ...this.coordinates,
        ref: `heads/${branch}`,
      });
      if (ref.object.sha !== commit.sha) throw error;
    }
    const { data: pr } = await this.api.pulls.create({
      ...this.coordinates,
      head: branch,
      base,
      draft: true,
      title: `fix: repair CI run ${run.id}`,
      body: [
        `<!-- patchpilot:run:${run.id} -->`,
        `Repairs [CI run ${run.id}](${run.html_url}) at ${run.head_sha}.`,
        "### Diagnosis And Repair",
        quoted(redact(result.summary, this.secrets)),
        "### Verification",
        `Passed in an isolated Docker copy: ${result.verification?.checks.join(", ")}.`,
        `Attempts: ${result.attempts.length}. Changed files: ${files.length}.`,
        "### Human Review Required",
        "Generated code is untrusted. Review the diff and run normal PR CI before merging. PatchPilot never auto-merges.",
      ].join("\n\n"),
    });
    return pr.html_url;
  }
}
