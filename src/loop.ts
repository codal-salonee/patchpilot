import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyProposal, type PatchPolicy } from "./patch.js";
import { collectContext } from "./context.js";
import type { FixGenerator } from "./llm.js";
import type { Verifier, Verification } from "./verify.js";
import { diagnostic, redact } from "./redact.js";

export type Attempt = {
  number: number;
  status: "rejected" | "failed" | "passed";
  detail: string;
};
export type RepairResult = {
  ok: boolean;
  summary: string;
  attempts: Attempt[];
  verification?: Verification;
};

export async function repair(options: {
  root: string;
  log: string;
  tracked: ReadonlySet<string>;
  policy: PatchPolicy;
  maxAttempts: number;
  generate: FixGenerator;
  verify: Verifier;
  assertDiff: () => Promise<void>;
  secrets: string[];
}): Promise<RepairResult> {
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 3
  ) {
    throw new Error("maxAttempts must be between 1 and 3");
  }
  const attempts: Attempt[] = [];
  let feedback = "";
  let summary = "";
  for (let number = 1; number <= options.maxAttempts; number++) {
    const originals = new Map<string, string>();
    let applied = false;
    let accepted = false;
    try {
      const context = await collectContext(
        options.root,
        `${feedback}\n${options.log}`,
        options.tracked,
        options.policy,
      );
      if (!context.some((source) => source.editable))
        throw new Error(
          "No allowed, tracked source files found in diagnostics",
        );
      const proposal = await options.generate({
        log: options.log,
        context,
        feedback,
        attempt: number,
        policy: options.policy,
      });
      for (const source of context.filter((source) => source.editable))
        originals.set(
          source.file,
          await readFile(path.join(options.root, source.file), "utf8"),
        );
      await applyProposal(
        options.root,
        proposal,
        options.policy,
        new Set(originals.keys()),
      );
      applied = true;
      await options.assertDiff();
      accepted = true;
      summary = redact(proposal.summary, options.secrets);
      const verification = await options.verify(options.root);
      feedback = redact(verification.output, options.secrets).slice(-16_000);
      attempts.push({
        number,
        status: verification.ok ? "passed" : "failed",
        detail: feedback,
      });
      if (verification.ok) return { ok: true, summary, attempts, verification };
      if (verification.infrastructure)
        return { ok: false, summary, attempts, verification };
    } catch (error) {
      if (applied && !accepted) {
        for (const [file, content] of originals)
          await writeFile(path.join(options.root, file), content, "utf8");
      }
      feedback = diagnostic(error, options.secrets);
      attempts.push({ number, status: "rejected", detail: feedback });
    }
  }
  return { ok: false, summary, attempts };
}
