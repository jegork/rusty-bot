import { describe, it, expect, vi, beforeEach } from "vitest";

// capture createAzure call args (especially the fetch wrapper) so we can
// invoke the wrapper directly and assert it strips api-key + sets bearer.
const createAzureCalls: Record<string, unknown>[] = [];

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn((opts: Record<string, unknown>) => {
    createAzureCalls.push(opts);
    return Object.assign((deployment: string) => `${deployment}:default`, {
      chat: (deployment: string) => `${deployment}:chat`,
    });
  }),
}));

// fake credential — getToken returns a stable token so we can assert on it.
const FAKE_TOKEN = "fake-entra-access-token";
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken() {
      return { token: FAKE_TOKEN, expiresOnTimestamp: Date.now() + 3600_000 };
    }
  },
}));

// import after the mocks are registered
const { resolveModel } = await import("../agent/model.js");

// the real global fetch is mocked too — we want to assert on what the
// wrapper hands to it, not actually hit the network.
const globalFetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

describe("Entra ID fetch wrapper — azure-managed-identity", () => {
  beforeEach(() => {
    createAzureCalls.length = 0;
    globalFetchMock.mockClear();
    vi.stubGlobal("fetch", globalFetchMock);
  });

  it("passes a non-empty apiKey placeholder to createAzure (otherwise @ai-sdk/azure throws AI_LoadAPIKeyError pre-flight)", () => {
    resolveModel({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.4-mini",
    });

    expect(createAzureCalls).toHaveLength(1);
    const args = createAzureCalls[0];
    expect(args.apiKey).toBeTruthy();
    expect(typeof args.apiKey).toBe("string");
    expect((args.apiKey as string).length).toBeGreaterThan(0);
  });

  it("the fetch wrapper deletes the api-key header and sets Authorization: Bearer <entra-token>", async () => {
    resolveModel({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.4-mini",
    });

    const wrapper = createAzureCalls[0].fetch as (
      input: unknown,
      init?: Record<string, unknown>,
    ) => Promise<Response>;

    // simulate what @ai-sdk/azure's getHeaders produces: api-key set to the
    // placeholder apiKey, no Authorization yet
    await wrapper("https://test.invalid/", {
      method: "POST",
      headers: { "api-key": "managed-identity", "content-type": "application/json" },
      body: '{"messages":[]}',
    });

    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = globalFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headersSent = new Headers(init.headers);
    // the placeholder must be stripped — azure rejects requests with BOTH
    // headers set ("Conflicting authentication mechanisms")
    expect(headersSent.has("api-key")).toBe(false);
    expect(headersSent.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    // unrelated headers must pass through unmodified
    expect(headersSent.get("content-type")).toBe("application/json");
  });

  it("preserves the method and body when delegating to global fetch", async () => {
    resolveModel({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.4-mini",
    });
    const wrapper = createAzureCalls[0].fetch as (
      input: unknown,
      init?: Record<string, unknown>,
    ) => Promise<Response>;

    await wrapper("https://test.invalid/", {
      method: "POST",
      headers: { "api-key": "managed-identity" },
      body: '{"hello":"world"}',
    });

    const [url, init] = globalFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test.invalid/");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"hello":"world"}');
  });
});

describe("Entra ID fetch wrapper — azure-foundry-managed-identity", () => {
  beforeEach(() => {
    createAzureCalls.length = 0;
    globalFetchMock.mockClear();
    vi.stubGlobal("fetch", globalFetchMock);
  });

  it("passes a non-empty apiKey placeholder to createAzure for the foundry path too", () => {
    resolveModel({
      type: "azure-foundry-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "DeepSeek-V4-Flash",
    });

    expect(createAzureCalls).toHaveLength(1);
    expect(createAzureCalls[0].apiKey).toBeTruthy();
  });

  it("the foundry fetch wrapper also deletes api-key and sets Authorization: Bearer <token>", async () => {
    resolveModel({
      type: "azure-foundry-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "DeepSeek-V4-Flash",
    });

    const wrapper = createAzureCalls[0].fetch as (
      input: unknown,
      init?: Record<string, unknown>,
    ) => Promise<Response>;

    await wrapper("https://test.invalid/", {
      method: "POST",
      headers: { "api-key": "managed-identity" },
      body: '{"messages":[]}',
    });

    const [, init] = globalFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headersSent = new Headers(init.headers);
    expect(headersSent.has("api-key")).toBe(false);
    expect(headersSent.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});
