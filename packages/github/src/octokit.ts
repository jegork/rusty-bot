import { Octokit } from "octokit";

type ThrottleHandler = (
  retryAfter: number,
  options: { method: string; url: string; request: { retryCount: number } },
  octokit: { log: { warn: (msg: string) => void; info: (msg: string) => void } },
) => boolean;

const NO_RETRY_ROUTES = new Set(["/search/code"]);

// octokit's defaults sleep for up to a minute and retry once; for code search that
// stalls the review and the retry hits the same 10 requests/minute window anyway
function retryOnce(kind: string): ThrottleHandler {
  return (retryAfter, options, octokit) => {
    octokit.log.warn(`${kind} for request ${options.method} ${options.url}`);
    if (NO_RETRY_ROUTES.has(options.url)) return false;
    if (options.request.retryCount === 0) {
      octokit.log.info(`Retrying after ${retryAfter} seconds!`);
      return true;
    }
    return false;
  };
}

export const onRateLimit = retryOnce("Request quota exhausted");
export const onSecondaryRateLimit = retryOnce("SecondaryRateLimit detected");

export const RustyOctokit: typeof Octokit = Octokit.defaults({
  throttle: { onRateLimit, onSecondaryRateLimit },
});
