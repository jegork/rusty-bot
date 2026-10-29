import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  gitEnv,
  parseDiff,
  RepoCheckout,
  type CodeSearchResult,
  type FilePatch,
  type GitProvider,
  type PRMetadata,
} from "@rusty-bot/core";

const execFileAsync = promisify(execFile);

export interface LocalGitProviderOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  prTitle?: string;
  prDescription?: string;
  prAuthor?: string;
  prUrl?: string;
}

// Local provider that backs the review with `git` and the working tree.
// Network-only operations (posting comments, updating PR fields) are no-ops;
// the CLI prints results to stdout instead.
export class LocalGitProvider implements GitProvider {
  private checkoutPromise?: Promise<RepoCheckout>;

  constructor(private readonly opts: LocalGitProviderOptions) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.opts.repoPath,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    });
    return stdout;
  }

  async getDiff(): Promise<FilePatch[]> {
    const raw = await this.git([
      "diff",
      "--no-color",
      `${this.opts.baseRef}...${this.opts.headRef}`,
    ]);
    return parseDiff(raw);
  }

  async getPRMetadata(): Promise<PRMetadata> {
    let headSha: string | undefined;
    try {
      headSha = (await this.git(["rev-parse", this.opts.headRef])).trim();
    } catch {
      headSha = undefined;
    }

    let author = this.opts.prAuthor;
    if (!author) {
      try {
        author = (await this.git(["log", "-1", "--format=%an", this.opts.headRef])).trim();
      } catch {
        author = "unknown";
      }
    }

    return {
      id: headSha?.slice(0, 7) ?? "local",
      title: this.opts.prTitle ?? `Local review: ${this.opts.baseRef}...${this.opts.headRef}`,
      description: this.opts.prDescription ?? "",
      author,
      sourceBranch: this.opts.headRef,
      targetBranch: this.opts.baseRef,
      url: this.opts.prUrl ?? "",
      headSha,
    };
  }

  // search and file reads run on the commit headRef resolves to, so they see
  // exactly what the diff shows regardless of which branch is checked out.
  checkout(): Promise<RepoCheckout> {
    this.checkoutPromise ??= this.git([
      "rev-parse",
      "--verify",
      `${this.opts.headRef}^{commit}`,
    ]).then(
      (sha) =>
        new RepoCheckout({ repoPath: this.opts.repoPath, tree: sha.trim(), approximate: false }),
    );
    return this.checkoutPromise;
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    // only short-circuit to the working tree when the user explicitly chose
    // HEAD as the head ref. for any other ref the working tree may be on a
    // different branch and would return content that does not match the diff.
    if (ref === this.opts.headRef && this.opts.headRef === "HEAD") {
      try {
        const abs = isAbsolute(path) ? path : join(this.opts.repoPath, path);
        return await readFile(abs, "utf8");
      } catch {
        // fall through to git show
      }
    }

    const checkout =
      ref === this.opts.headRef
        ? await this.checkout()
        : new RepoCheckout({ repoPath: this.opts.repoPath, tree: ref, approximate: false });
    return checkout.readFile(path);
  }

  async searchCode(query: string): Promise<CodeSearchResult[]> {
    return (await this.checkout()).grep(query);
  }

  async postSummaryComment(): Promise<void> {
    // no-op — CLI prints the summary to stdout instead.
  }

  async postInlineComments(): Promise<void> {
    // no-op — CLI prints inline findings to stdout instead.
  }

  async deleteExistingBotComments(): Promise<void> {
    // no-op — there are no existing comments to clean up locally.
  }

  async updatePRDescription(): Promise<void> {
    // no-op — there is no PR to update locally.
  }

  async updatePRTitle(): Promise<void> {
    // no-op — there is no PR to update locally.
  }
}
