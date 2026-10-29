import { logger } from "../logger.js";
import { RepoCheckout, runGit, type GitRunError } from "./checkout.js";

const log = logger.child({ module: "repo-checkout" });

const FETCH_TIMEOUT_MS = 60_000;
// rejects anything that could be read as an option or a revision expression
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface ResolveRepoCheckoutOptions {
  repoPath: string | undefined;
  headSha: string | undefined;
  // full Authorization header value, e.g. "bearer <token>"; travels via env, never argv
  fetchAuthHeader?: string;
}

// finds the PR head commit in a CI checkout, fetching it when the shallow
// merge-commit checkout lacks it. never throws: null means "no local repo",
// approximate means "searching the workspace HEAD instead of the PR head".
export async function resolveRepoCheckout(
  options: ResolveRepoCheckoutOptions,
): Promise<RepoCheckout | null> {
  const { repoPath, fetchAuthHeader } = options;
  const headSha =
    options.headSha && SHA_PATTERN.test(options.headSha) ? options.headSha : undefined;
  const startedAt = Date.now();
  const event: Record<string, unknown> = {
    repoPath,
    headSha: options.headSha,
    authSupplied: Boolean(fetchAuthHeader),
  };

  if (!repoPath || !(await succeeds(repoPath, ["rev-parse", "--git-dir"]))) {
    log.info(
      { ...event, outcome: "no-repo" },
      "resolveRepoCheckout: no local checkout; tools fall back to the provider API",
    );
    return null;
  }

  let resolution = "head-present";
  let tree: string | undefined;
  if (headSha && (await hasCommit(repoPath, headSha))) {
    tree = headSha;
  } else if (headSha) {
    const fetchStartedAt = Date.now();
    try {
      await runGit(repoPath, ["fetch", "--depth=1", "--no-tags", "origin", headSha], {
        timeoutMs: FETCH_TIMEOUT_MS,
        // the empty value resets any http.extraheader already in the repo config
        // so the request does not carry two Authorization headers
        extraConfig: fetchAuthHeader
          ? [
              ["http.extraheader", ""],
              ["http.extraheader", `AUTHORIZATION: ${fetchAuthHeader}`],
            ]
          : [],
      });
      event.fetchMs = Date.now() - fetchStartedAt;
      if (await hasCommit(repoPath, headSha)) {
        tree = headSha;
        resolution = "fetched";
      }
    } catch (err) {
      const e = err as GitRunError;
      event.fetchMs = Date.now() - fetchStartedAt;
      event.fetchError = e.stderr?.trim() || e.message;
    }
  }

  const checkout = tree
    ? new RepoCheckout({ repoPath, tree, approximate: false })
    : new RepoCheckout({ repoPath, tree: "HEAD", approximate: true });
  Object.assign(event, {
    outcome: tree ? resolution : "workspace-head",
    tree: checkout.tree,
    approximate: checkout.approximate,
    durationMs: Date.now() - startedAt,
  });
  if (checkout.approximate) {
    log.warn(
      event,
      "resolveRepoCheckout: PR head not in checkout; searching the workspace HEAD (merge commit)",
    );
  } else {
    log.info(event, "resolveRepoCheckout: using the PR head commit");
  }
  return checkout;
}

async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  return succeeds(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
}

async function succeeds(repoPath: string, args: string[]): Promise<boolean> {
  try {
    await runGit(repoPath, args);
    return true;
  } catch {
    return false;
  }
}
