import { App } from "@octokit/app";
import type { Octokit } from "octokit";
import { RustyOctokit } from "./octokit.js";

export async function createAppOctokit(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<Octokit> {
  const app = new App({ appId, privateKey, Octokit: RustyOctokit });
  const installationOctokit = await app.getInstallationOctokit(installationId);
  return installationOctokit;
}
