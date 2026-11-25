import { parse as parseYaml } from "yaml";
import { countTokens } from "./diff/compress.js";
import { logger } from "./logger.js";
import { DEFAULT_SKILL_PATHS, type SkillSettings } from "./repo-config.js";
import type { GitProvider } from "./types.js";

const log = logger.child({ module: "skills" });

export const MAX_SKILLS = 40;
export const SKILLS_LISTING_TOKEN_BUDGET = 3000;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const SHORT_DESCRIPTION_CHARS = 200;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface RepoSkill {
  name: string;
  description: string;
  /** repo-relative folder holding SKILL.md, read on the index's ref */
  dir: string;
}

export interface SkillsListing {
  text: string;
  listing: "full" | "shortened" | "truncated";
  listingTokens: number;
  omittedFromListing: string[];
}

export interface SkillIndex {
  skills: RepoSkill[];
  /** the target branch every skill was read from */
  ref: string;
  listing: SkillsListing;
}

type ParsedSkill = { name: string; description: string; body: string } | { error: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillFile(content: string): ParsedSkill {
  const match = FRONTMATTER.exec(content);
  if (!match) return { error: "no frontmatter" };
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (err) {
    return { error: `invalid frontmatter YAML: ${(err as Error).message.split("\n")[0]}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: "frontmatter is not a mapping" };
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return { error: "name must be lowercase letters, digits and single hyphens" };
  }
  if (name.length > MAX_NAME_CHARS) return { error: `name longer than ${MAX_NAME_CHARS}` };
  if (typeof description !== "string" || description.trim() === "") {
    return { error: "missing description" };
  }
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine.length > MAX_DESCRIPTION_CHARS) {
    return { error: `description longer than ${MAX_DESCRIPTION_CHARS}` };
  }
  const body = content.slice(match[0].length).trim();
  if (body === "") return { error: "empty body" };
  return { name, description: oneLine, body };
}

const LISTING_HEADER =
  "## Available repository skills\n" +
  "When the diff touches an area a skill covers, call loadSkill before reporting findings there.";

function shorten(description: string): string {
  const sentence = /^.+?[.!?](?=\s|$)/.exec(description)?.[0] ?? description;
  if (sentence.length <= SHORT_DESCRIPTION_CHARS) return sentence;
  const cut = sentence.slice(0, SHORT_DESCRIPTION_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function render(lines: string[]): string {
  return [LISTING_HEADER, ...lines].join("\n");
}

/** the prompt section naming each skill; descriptions shrink, then skills drop, to stay within budget */
export function renderSkillsListing(
  skills: RepoSkill[],
  budget = SKILLS_LISTING_TOKEN_BUDGET,
): SkillsListing {
  const full = render(skills.map((s) => `- ${s.name} — ${s.description}`));
  if (countTokens(full) <= budget) {
    return {
      text: full,
      listing: "full",
      listingTokens: countTokens(full),
      omittedFromListing: [],
    };
  }
  const shortLines = skills.map((s) => `- ${s.name} — ${shorten(s.description)}`);
  const shortened = render(shortLines);
  if (countTokens(shortened) <= budget) {
    return {
      text: shortened,
      listing: "shortened",
      listingTokens: countTokens(shortened),
      omittedFromListing: [],
    };
  }
  let kept = 0;
  while (kept < shortLines.length && countTokens(render(shortLines.slice(0, kept + 1))) <= budget) {
    kept++;
  }
  const text = render(shortLines.slice(0, kept));
  return {
    text,
    listing: "truncated",
    listingTokens: countTokens(text),
    omittedFromListing: skills.slice(kept).map((s) => s.name),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the review skills a repository keeps on its target branch. Never fails
 * the run: anything unreadable or invalid is skipped with a warning. Returns
 * null when nothing usable was found, so callers keep the existing behaviour.
 */
export async function discoverSkills(
  provider: GitProvider,
  ref: string,
  settings: SkillSettings | undefined,
): Promise<SkillIndex | null> {
  const startedAt = Date.now();
  const paths = (settings?.paths ?? DEFAULT_SKILL_PATHS).map((p) => p.replace(/\/+$/, ""));
  const event: Record<string, unknown> = { ref, paths };

  if (process.env.RUSTY_SKILLS === "false" || settings?.enabled === false) {
    const reason = process.env.RUSTY_SKILLS === "false" ? "RUSTY_SKILLS=false" : "config";
    log.info({ ...event, outcome: "disabled", reason }, "skills discovery");
    return null;
  }
  if (!provider.listDirectory) {
    const reason = provider.listDirectoryUnavailable ?? "provider cannot list folders";
    log.info({ ...event, outcome: "unsupported", reason }, "skills discovery");
    return null;
  }

  const skills: RepoSkill[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let truncated = 0;
  const skip = (path: string, reason: string, extra: Record<string, unknown> = {}) => {
    skipped.push({ path, reason });
    log.warn({ ref, path, reason, ...extra }, "skipped repository skill");
  };

  for (const root of paths) {
    let dirs: string[];
    try {
      const entries = await provider.listDirectory(root, ref);
      dirs = (entries ?? [])
        .filter((e) => e.type === "dir")
        .map((e) => e.name)
        .sort();
    } catch (err) {
      skip(root, `listing failed: ${errorMessage(err)}`);
      continue;
    }

    let next = 0;
    while (next < dirs.length && skills.length < MAX_SKILLS) {
      // fetch only as many as can still be kept, so a huge folder costs no extra calls
      const batch = dirs.slice(next, next + MAX_SKILLS - skills.length).map((d) => `${root}/${d}`);
      next += batch.length;
      const contents = await Promise.all(
        batch.map((dir) =>
          provider.getFileContent(`${dir}/SKILL.md`, ref).then(
            (content) => ({ content }),
            (err: unknown) => ({ error: errorMessage(err) }),
          ),
        ),
      );
      for (const [i, dir] of batch.entries()) {
        const result = contents[i];
        if ("error" in result) {
          skip(dir, `SKILL.md read failed: ${result.error}`);
          continue;
        }
        if (result.content == null) {
          skip(dir, "no SKILL.md");
          continue;
        }
        const parsed = parseSkillFile(result.content);
        if ("error" in parsed) {
          skip(dir, parsed.error);
          continue;
        }
        const existing = skills.find((s) => s.name === parsed.name);
        if (existing) {
          skip(dir, `duplicate name "${parsed.name}"`, { keptFrom: existing.dir });
          continue;
        }
        skills.push({ name: parsed.name, description: parsed.description, dir });
      }
    }
    truncated += dirs.length - next;
  }

  const listing = skills.length > 0 ? renderSkillsListing(skills) : null;
  log.info(
    {
      ...event,
      outcome: skills.length > 0 ? "discovered" : "none",
      discovered: skills.length,
      skipped,
      truncated,
      ...(listing && {
        listing: listing.listing,
        listingTokens: listing.listingTokens,
        omittedFromListing: listing.omittedFromListing,
      }),
      durationMs: Date.now() - startedAt,
    },
    "skills discovery",
  );
  return listing ? { skills, ref, listing } : null;
}
