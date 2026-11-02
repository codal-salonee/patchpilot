import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, type CommandResult } from "./process.js";

export type Verification = {
  ok: boolean;
  output: string;
  checks: string[];
  infrastructure?: boolean;
};
export type Verifier = (root: string) => Promise<Verification>;
export const checkScripts = ["typecheck", "lint", "test"];

export async function verifyDocker(
  root: string,
  image = "node:22-bookworm-slim",
  run = command,
): Promise<Verification> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const script of checkScripts) {
    if (!manifest.scripts?.[script])
      throw new Error(`Target must define npm run ${script}`);
  }
  await readFile(path.join(root, "package-lock.json"));
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "patchpilot-verify-"));
  const name = `patchpilot-${path.basename(snapshot).toLowerCase()}`;
  const checks: string[] = [];
  const output: string[] = [];
  const docker = async (
    args: string[],
    timeoutMs = 300_000,
  ): Promise<CommandResult> => run("docker", args, { cwd: root, timeoutMs });
  try {
    const ready = await docker(
      ["info", "--format", "{{.ServerVersion}}"],
      15_000,
    );
    if (!ready.ok)
      return {
        ok: false,
        output: "Docker daemon is unavailable",
        checks,
        infrastructure: true,
      };
    await cp(root, snapshot, {
      recursive: true,
      filter: (source) =>
        !path
          .relative(root, source)
          .split(path.sep)
          .some(
            (part) =>
              [
                ".git",
                "node_modules",
                ".npmrc",
                ".yarnrc",
                ".next",
                "dist",
              ].includes(part) || part.startsWith(".env"),
          ),
    });
    const base = [
      "run",
      "--rm",
      "--name",
      name,
      "--init",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=2g",
      "--cpus=2",
      "--pids-limit=256",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "--user",
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      "--mount",
      `type=bind,src=${snapshot},dst=/workspace`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "CI=true",
      "--env",
      "NEXT_TELEMETRY_DISABLED=1",
    ];
    const installed = await docker([
      ...base,
      "--network=bridge",
      image,
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    output.push(`npm ci --ignore-scripts\n${installed.output}`);
    if (!installed.ok)
      return {
        ok: false,
        output: output.join("\n"),
        checks,
        infrastructure: true,
      };
    for (const script of checkScripts) {
      const result = await docker([
        ...base,
        "--network=none",
        image,
        "npm",
        "--ignore-scripts",
        "run",
        script,
      ]);
      output.push(`npm run ${script}\n${result.output}`);
      if (!result.ok)
        return { ok: false, output: output.join("\n").slice(-40_000), checks };
      checks.push(script);
    }
    return { ok: true, output: output.join("\n").slice(-40_000), checks };
  } finally {
    await docker(["rm", "-f", name], 15_000).catch(() => undefined);
    await rm(snapshot, { recursive: true, force: true });
  }
}
