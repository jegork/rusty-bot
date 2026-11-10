import { z } from "zod";
import { logger } from "./logger.js";

const log = logger.child({ module: "repo-config" });

export const REPO_CONFIG_FILENAME = ".rusty-bot.json";

// strict on purpose: a misspelled key in a policy file must fail the run, not
// silently fall back to the defaults
const RiskPolicySchema = z.strictObject({
  /** ask the review for a risk assessment and compare it with the author's label */
  enabled: z.boolean().default(true),
  /** label prefix the author's level is read from, e.g. `risk:` for `risk:high` */
  labelPrefix: z.string().min(1).default("risk:"),
  /** fail the run when the PR carries no (or more than one) risk label */
  requireLabel: z.boolean().default(true),
  /** the only reason tags the assessment may use, when the team wants a fixed vocabulary */
  reasons: z.array(z.string().min(1)).optional(),
  /** repo-relative path of a markdown rubric that replaces the bot's default risk prose */
  promptFile: z.string().min(1).optional(),
});

export const RepoConfigSchema = z.strictObject({
  risk: RiskPolicySchema.optional(),
});

export type RiskPolicy = z.infer<typeof RiskPolicySchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

type FileContentFetcher = (path: string, ref: string) => Promise<string | null>;

export function parseRepoConfig(raw: string, source = REPO_CONFIG_FILENAME): RepoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source}: invalid JSON`);
  }
  const result = RepoConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`${source}: invalid repo config:\n${issues}`);
  }
  return result.data;
}

/**
 * Fetch the rubric named by `risk.promptFile` from the same ref as the config.
 * A file that is configured but absent throws, since reviewing with the default
 * prose would silently change the rubric the team signed off on. A failed read
 * also throws: the run fails rather than assessing against a different rubric.
 */
export async function fetchRiskPrompt(
  getFileContent: FileContentFetcher,
  ref: string,
  path: string,
): Promise<string> {
  const content = await getFileContent(path, ref);
  if (content == null || content.trim() === "") {
    throw new Error(`${REPO_CONFIG_FILENAME}: risk.promptFile "${path}" not found on ${ref}`);
  }
  log.info({ ref, path, chars: content.length }, "loaded risk prompt file");
  return content;
}

/**
 * Fetch `.rusty-bot.json` from the repo root on the given ref. Read from the
 * target branch, like the convention file, so a PR cannot change the policy
 * that reviews it. A missing file yields null and callers fall back to their
 * env settings. A file that exists but is malformed throws, and so does a
 * failed read, because a policy that silently stops applying is worse than a
 * failed run. Providers whose file reader maps every failure to null (GitHub,
 * GitLab) cannot tell the two apart; Azure DevOps exposes `readFile` for that.
 */
export async function fetchRepoConfig(
  getFileContent: FileContentFetcher,
  ref: string,
): Promise<RepoConfig | null> {
  const content = await getFileContent(REPO_CONFIG_FILENAME, ref);
  if (content == null) return null;
  const config = parseRepoConfig(content);
  log.info({ ref, sections: Object.keys(config) }, "loaded repo config");
  return config;
}
