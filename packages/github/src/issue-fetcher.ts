import type { Octokit } from "octokit";
import type { IssueFetcher } from "@rusty-bot/core";
import { logger } from "@rusty-bot/core";

const log = logger.child({ package: "github" });

export function createOctokitIssueFetcher(octokit: Octokit): IssueFetcher {
  return async (owner, repo, issueNumber) => {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });
      return data;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      log.warn({ err, owner, repo, issueNumber }, "installation token issue fetch failed");
      return null;
    }
  };
}
