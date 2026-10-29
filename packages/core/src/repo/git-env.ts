// git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every subprocess it
// spawns (hooks especially), and those take precedence over a child's cwd — so
// a git command run with an explicit cwd still lands on the ambient repository
// unless they are removed. every git spawn goes through here.
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

export interface GitEnvOptions {
  // appended as GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n so values (auth headers)
  // never appear on argv. pairs, not a record, because multi-valued keys like
  // http.extraheader need an empty reset entry before the real one.
  extraConfig?: readonly (readonly [key: string, value: string])[];
}

export function gitEnv(
  extra: NodeJS.ProcessEnv = {},
  options: GitEnvOptions = {},
): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...extra };
  const redirecting: readonly string[] = REPO_REDIRECTING_VARS;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!redirecting.includes(key)) env[key] = value;
  }

  env.GIT_TERMINAL_PROMPT = "0";

  // the CI container runs as root over a checkout owned by the runner user;
  // without this git refuses every command with "dubious ownership".
  const config: (readonly [string, string])[] = [
    ["safe.directory", "*"],
    ...(options.extraConfig ?? []),
  ];
  // append after any inherited pairs instead of clobbering them
  const inherited = Number(env.GIT_CONFIG_COUNT);
  const offset = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${offset + i}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(offset + config.length);
  return env;
}
