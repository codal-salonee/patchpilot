import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const proposalSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  edits: z
    .array(
      z.strictObject({
        file: z.string().min(1).max(300),
        old: z.string().min(1).max(24_000),
        new: z.string().max(24_000),
      }),
    )
    .min(1)
    .max(10),
});

export type Proposal = z.infer<typeof proposalSchema>;
export type PatchPolicy = {
  allowedPaths: string[];
  maxFiles: number;
  maxChangedLines: number;
  maxBytes: number;
};

export const defaultPolicy: PatchPolicy = {
  allowedPaths: ["src/"],
  maxFiles: 5,
  maxChangedLines: 200,
  maxBytes: 24_000,
};

function assertRepositoryPath(file: string): void {
  if (
    path.posix.isAbsolute(file) ||
    file.includes("\\") ||
    file.includes("\0") ||
    file
      .split("/")
      .some((part) => part === ".." || part === "." || part.startsWith(".")) ||
    file.split("/").includes("node_modules") ||
    !/\.(?:[cm]?[jt]sx?|css)$/.test(file)
  ) {
    throw new Error(`Disallowed source path: ${file}`);
  }
}

export function assertAllowedPath(file: string, policy: PatchPolicy): void {
  assertRepositoryPath(file);
  if (
    /(?:^|\/)(?:test|tests|__tests__|__snapshots__)(?:\/|$)|\.(?:test|spec)\./.test(
      file,
    ) ||
    !policy.allowedPaths.some(
      (prefix) => prefix.endsWith("/") && file.startsWith(prefix),
    )
  )
    throw new Error(`Disallowed source path: ${file}`);
}

export async function readEvidence(
  root: string,
  file: string,
): Promise<string> {
  assertRepositoryPath(file);
  let current = root;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Symlink rejected: ${file}`);
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > 200_000)
    throw new Error(`Invalid source file: ${file}`);
  return readFile(current, "utf8");
}

export async function readSource(
  root: string,
  file: string,
  policy: PatchPolicy,
): Promise<string> {
  assertAllowedPath(file, policy);
  return readEvidence(root, file);
}

export async function applyProposal(
  root: string,
  input: unknown,
  policy: PatchPolicy = defaultPolicy,
  contextFiles?: ReadonlySet<string>,
): Promise<string[]> {
  const proposal = proposalSchema.parse(input);
  const planned = new Map<string, string>();
  let bytes = 0;
  let changedLines = 0;
  for (const edit of proposal.edits) {
    assertAllowedPath(edit.file, policy);
    if (contextFiles && !contextFiles.has(edit.file))
      throw new Error(`File not in context: ${edit.file}`);
    const content =
      planned.get(edit.file) ?? (await readSource(root, edit.file, policy));
    const first = content.indexOf(edit.old);
    if (first < 0 || content.indexOf(edit.old, first + 1) >= 0) {
      throw new Error(`Replacement must match exactly once: ${edit.file}`);
    }
    if (edit.old === edit.new) throw new Error(`No-op edit: ${edit.file}`);
    if (
      /\b(?:ts-ignore|ts-nocheck|eslint-disable)\b/.test(edit.new) &&
      !/\b(?:ts-ignore|ts-nocheck|eslint-disable)\b/.test(edit.old)
    ) {
      throw new Error(`Diagnostic suppression rejected: ${edit.file}`);
    }
    planned.set(
      edit.file,
      content.slice(0, first) +
        edit.new +
        content.slice(first + edit.old.length),
    );
    bytes += Buffer.byteLength(edit.old) + Buffer.byteLength(edit.new);
    changedLines += edit.old.split("\n").length + edit.new.split("\n").length;
  }
  if (
    planned.size > policy.maxFiles ||
    bytes > policy.maxBytes ||
    changedLines > policy.maxChangedLines
  ) {
    throw new Error("Patch exceeds policy limits");
  }
  for (const [file, content] of planned)
    await writeFile(path.join(root, file), content, "utf8");
  return [...planned.keys()];
}
