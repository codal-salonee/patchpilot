import { spawn } from "node:child_process";

export type CommandResult = {
  ok: boolean;
  output: string;
  code: number | null;
};

export function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function command(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutput?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-(options.maxOutput ?? 60_000));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        output: timedOut ? `${output}\nCommand timed out` : output,
      });
    });
  });
}

export async function git(
  root: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await command(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
    {
      cwd: root,
      ...(env ? { env } : {}),
      maxOutput: 1_000_000,
    },
  );
  if (!result.ok) throw new Error(`Git operation failed: ${result.output}`);
  return result.output.trimEnd();
}
