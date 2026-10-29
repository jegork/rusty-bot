import { logger } from "./logger.js";

const log = logger.child({ module: "convention-file" });

const CONVENTION_FILENAMES = [".rusty-bot.md", "REVIEW-BOT.md", "AGENTS.md"] as const;

const MAX_CONVENTION_TOKENS = 15_000;

type FileContentFetcher = (path: string, ref: string) => Promise<string | null>;

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenLimit(content: string, maxTokens: number): string {
  const tokens = countTokens(content);
  if (tokens <= maxTokens) return content;

  // rough char estimate: 4 chars per token
  const maxChars = maxTokens * 4;
  const truncated = content.slice(0, maxChars);
  // cut at the last newline to avoid splitting mid-line
  const lastNewline = truncated.lastIndexOf("\n");
  const result = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;

  log.warn(
    { tokens, maxTokens, truncatedLength: result.length },
    "convention file exceeded token limit, truncated",
  );

  return result;
}

/**
 * Fetch the first matching convention file from the repo root.
 *
 * Tries `.rusty-bot.md`, `REVIEW-BOT.md`, `AGENTS.md` in order and returns
 * the content of the first one found, truncated to the token limit.
 * Returns `null` if none exist. Swallows errors and logs a warning.
 */
export async function fetchConventionFile(
  getFileContent: FileContentFetcher,
  ref: string,
): Promise<string | null> {
  for (const filename of CONVENTION_FILENAMES) {
    try {
      const content = await getFileContent(filename, ref);
      if (content != null) {
        log.info({ filename, ref }, "loaded convention file");
        return truncateToTokenLimit(content, MAX_CONVENTION_TOKENS);
      }
    } catch (err) {
      log.warn({ filename, ref, err }, "failed to fetch convention file, skipping");
    }
  }

  return null;
}
