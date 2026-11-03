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
  /** repository-specific rules appended to the risk assessment prompt */
  instructions: z.string().optional(),
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
 * Fetch `.rusty-bot.json` from the repo root on the given ref. Read from the
 * target branch, like the convention file, so a PR cannot change the policy
 * that reviews it. A missing file or a transport error yields null (callers
 * fall back to their env settings); a file that exists but is malformed throws,
 * because a broken policy must be visible rather than quietly ignored.
 */
export async function fetchRepoConfig(
  getFileContent: FileContentFetcher,
  ref: string,
): Promise<RepoConfig | null> {
  let content: string | null;
  try {
    content = await getFileContent(REPO_CONFIG_FILENAME, ref);
  } catch (err) {
    log.warn({ ref, err }, "failed to fetch repo config, falling back to env settings");
    return null;
  }
  if (content == null) return null;
  const config = parseRepoConfig(content);
  log.info({ ref, sections: Object.keys(config) }, "loaded repo config");
  return config;
}
