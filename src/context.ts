import path from "node:path";
import { assertAllowedPath, readEvidence, type PatchPolicy } from "./patch.js";

export type SourceContext = {
  file: string;
  startLine: number;
  content: string;
  editable: boolean;
};

export function locations(log: string): { file: string; line: number }[] {
  const found = new Map<string, number>();
  const pattern =
    /(?:^|[\s("'/:])((?:[\w@.-]+\/)+[\w.-]+\.(?:[cm]?[jt]sx?|css))(?::|\()(\d+)?/gm;
  for (const match of log.matchAll(pattern)) {
    const file = match[1];
    if (!file) continue;
    const src = file.indexOf("src/");
    const normalized = src >= 0 ? file.slice(src) : file;
    if (!found.has(normalized))
      found.set(normalized, Math.max(1, Number(match[2]) || 1));
  }
  return [...found].map(([file, line]) => ({ file, line }));
}

export async function collectContext(
  root: string,
  log: string,
  tracked: ReadonlySet<string>,
  policy: PatchPolicy,
): Promise<SourceContext[]> {
  const queue = locations(log);
  const visited = new Set<string>();
  const result: SourceContext[] = [];
  let remaining = 40_000;
  for (const location of queue) {
    if (
      visited.has(location.file) ||
      !tracked.has(location.file) ||
      result.length >= 5
    )
      continue;
    visited.add(location.file);
    let editable = true;
    try {
      assertAllowedPath(location.file, policy);
    } catch {
      editable = false;
      if (
        !/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\./.test(
          location.file,
        )
      )
        continue;
    }
    let content: string;
    try {
      content = await readEvidence(root, location.file);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const start =
      content.length <= 10_000 ? 0 : Math.max(0, location.line - 41);
    const excerpt = (
      content.length <= 10_000
        ? content
        : lines.slice(start, start + 80).join("\n")
    ).slice(0, Math.min(12_000, remaining));
    if (!excerpt || remaining <= 0) continue;
    result.push({
      file: location.file,
      startLine: start + 1,
      content: excerpt,
      editable,
    });
    remaining -= excerpt.length;
    for (const match of excerpt.matchAll(
      /(?:from\s*|import\s*\()['"]([^'"]+)['"]/g,
    )) {
      const imported = match[1];
      if (
        !imported ||
        (!imported.startsWith(".") && !imported.startsWith("@/"))
      )
        continue;
      const base = imported.startsWith("@/")
        ? `src/${imported.slice(2)}`
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(location.file), imported),
          );
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
        base.replace(/\.js$/, ".ts"),
      ];
      const dependency = candidates.find((file) => tracked.has(file));
      if (dependency && queue.length < 20)
        queue.push({ file: dependency, line: 1 });
    }
  }
  return result;
}
