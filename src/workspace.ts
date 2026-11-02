import { assertAllowedPath, type PatchPolicy } from "./patch.js";
import { cleanEnvironment, git } from "./process.js";

export async function fetchWorkspace(
  root: string,
  repository: string,
  sha: string,
  token: string,
): Promise<Set<string>> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid fetch target");
  await git(root, ["-c", "init.templateDir=", "init", "--quiet"]);
  await git(root, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repository}.git`,
  ]);
  await git(root, ["fetch", "--depth=1", "--no-tags", "origin", sha], {
    ...cleanEnvironment(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  });
  await git(root, ["checkout", "--quiet", "--detach", sha]);
  return new Set((await git(root, ["ls-files"])).split("\n"));
}

export async function assertDiff(
  root: string,
  policy: PatchPolicy,
): Promise<string[]> {
  const files = (
    await git(root, ["diff", "--name-only", "--no-ext-diff", "HEAD", "--"])
  )
    .split("\n")
    .filter(Boolean);
  if (!files.length || files.length > policy.maxFiles)
    throw new Error("Final diff has no changes or too many files");
  for (const file of files) assertAllowedPath(file, policy);
  const numstat = await git(root, [
    "diff",
    "--numstat",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
  ]);
  let lines = 0;
  for (const row of numstat.split("\n")) {
    const [added, removed] = row.split("\t");
    if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(removed ?? ""))
      throw new Error("Binary diff rejected");
    lines += Number(added) + Number(removed);
  }
  const diff = await git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
  ]);
  if (
    lines > policy.maxChangedLines ||
    Buffer.byteLength(diff) > policy.maxBytes
  )
    throw new Error("Cumulative diff exceeds policy");
  return files;
}
