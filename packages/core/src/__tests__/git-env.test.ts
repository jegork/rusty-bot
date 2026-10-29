import { afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "../repo/git-env.js";

describe("gitEnv", () => {
  const keysToRestore: string[] = [];

  afterEach(() => {
    for (const key of keysToRestore) Reflect.deleteProperty(process.env, key);
    keysToRestore.length = 0;
  });

  function setEnv(key: string, value: string) {
    process.env[key] = value;
    keysToRestore.push(key);
  }

  it("strips repo-redirecting variables", () => {
    setEnv("GIT_DIR", "/some/other/.git");
    setEnv("GIT_WORK_TREE", "/some/other");
    setEnv("GIT_INDEX_FILE", "/some/other/.git/index");

    const env = gitEnv();

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
  });

  it("preserves identity and unrelated variables", () => {
    setEnv("GIT_AUTHOR_NAME", "Test User");
    setEnv("PATH", process.env.PATH ?? "");

    const env = gitEnv();

    expect(env.GIT_AUTHOR_NAME).toBe("Test User");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("lets extra values win over inherited ones", () => {
    setEnv("GIT_AUTHOR_NAME", "Inherited User");

    const env = gitEnv({ GIT_AUTHOR_NAME: "Override User" });

    expect(env.GIT_AUTHOR_NAME).toBe("Override User");
  });

  it("returns a copy, not a reference to process.env", () => {
    const env = gitEnv();
    env.SOME_NEW_KEY = "mutated";

    expect(process.env.SOME_NEW_KEY).toBeUndefined();
  });

  it("trusts every directory and never prompts for credentials", () => {
    setEnv("GIT_TERMINAL_PROMPT", "1");

    const env = gitEnv();

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("*");
  });

  it("appends extraConfig as numbered pairs, keeping duplicate keys in order", () => {
    const env = gitEnv(
      {},
      {
        extraConfig: [
          ["http.extraheader", ""],
          ["http.extraheader", "AUTHORIZATION: bearer t"],
        ],
      },
    );

    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(["http.extraheader", ""]);
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual([
      "http.extraheader",
      "AUTHORIZATION: bearer t",
    ]);
  });

  it("appends after inherited config pairs instead of overwriting them", () => {
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "core.autocrlf");
    setEnv("GIT_CONFIG_VALUE_0", "false");

    const env = gitEnv();

    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["core.autocrlf", "false"]);
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(["safe.directory", "*"]);
  });

  it("ignores a malformed inherited count", () => {
    setEnv("GIT_CONFIG_COUNT", "garbage");

    const env = gitEnv();

    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
  });
});
