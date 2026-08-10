/**
 * Prompt resolution for the role contract (tz-01 criterion 2, model §8 step 2).
 *
 * Order: the contract's own `prompt_file` FIRST, then the canonical
 * `<roleDir>/<role>/prompt.md`, then the bare `<roleDir>/<role>.md`. Today the
 * execution path ignores `prompt_file` entirely (prompt-builder.ts:94 →
 * role-dir-loader.ts:34-36); every fallback below is reported so a role that
 * silently runs on the wrong prompt is visible.
 */
import fs from "node:fs";
import path from "node:path";

export interface PromptResolution {
  path: string | null;
  text: string | null;
  /** Empty when `prompt_file` itself was used. */
  warnings: string[];
}

/** Candidate paths for `prompt_file`, in the order they are tried. */
function promptFileCandidates(
  promptFile: string,
  role: string,
  roleDir: string,
): string[] {
  if (path.isAbsolute(promptFile)) return [promptFile];
  return [
    // Next to the role's own contract, which is where a package keeps assets.
    path.join(roleDir, role, promptFile),
    // Flat layout (legacy `roles/<role>.md` siblings).
    path.join(roleDir, promptFile),
  ];
}

function readIfPresent(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function resolveRolePrompt(
  role: string,
  roleDir: string,
  promptFile: string,
): PromptResolution {
  for (const cand of promptFileCandidates(promptFile, role, roleDir)) {
    const text = readIfPresent(cand);
    if (text !== null) return { path: cand, text, warnings: [] };
  }
  const canonical = path.join(roleDir, role, "prompt.md");
  const canonicalText = readIfPresent(canonical);
  if (canonicalText !== null) {
    return {
      path: canonical,
      text: canonicalText,
      warnings: [
        `prompt_file "${promptFile}" not found — fell back to ${canonical}`,
      ],
    };
  }
  const bare = path.join(roleDir, `${role}.md`);
  const bareText = readIfPresent(bare);
  if (bareText !== null) {
    return {
      path: bare,
      text: bareText,
      warnings: [
        `prompt_file "${promptFile}" not found — fell back to ${bare}`,
      ],
    };
  }
  return { path: null, text: null, warnings: [] };
}
