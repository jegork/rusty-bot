// git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every subprocess it
// spawns (hooks especially), and those take precedence over a child's cwd — so
// a git command run with an explicit cwd still lands on the ambient repository
// unless they are removed. every git spawn in this package goes through here.
const REPO_REDIRECTING_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...extra };
  const redirecting: readonly string[] = REPO_REDIRECTING_VARS;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!redirecting.includes(key)) env[key] = value;
  }
  return env;
}
