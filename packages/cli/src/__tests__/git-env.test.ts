import { afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "../git-env.js";

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
});
