import picomatch from "picomatch";
import type { FilePatch } from "../types.js";

const DEFAULT_IGNORE = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
];

export function filterFiles(patches: FilePatch[], ignorePatterns: string[] = []): FilePatch[] {
  const allPatterns = [...DEFAULT_IGNORE, ...ignorePatterns];
  // picomatch's basename option also retries slash patterns against the file name
  // (so `vendor/**` would match `src/vendor/a.ts`), hence the two matchers
  const isNameIgnored = picomatch(
    allPatterns.filter((p) => !p.includes("/")),
    { basename: true },
  );
  const isPathIgnored = picomatch(allPatterns.filter((p) => p.includes("/")));

  return patches.filter((p) => {
    if (p.isBinary) return false;
    return !isNameIgnored(p.path) && !isPathIgnored(p.path);
  });
}
