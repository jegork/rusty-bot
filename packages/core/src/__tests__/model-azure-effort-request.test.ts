import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveDefaultAgentOptions, resolveModel, type ModelConfig } from "../agent/model.js";

type LanguageModel = Exclude<ReturnType<typeof resolveModel>, string>;

// runs the real @ai-sdk/azure responses model and captures the request body, so
// a wrong providerOptions key (the sdk silently ignores unknown ones) fails here
async function captureRequestBody(config: ModelConfig): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      throw new Error("request captured");
    }),
  );

  const model = resolveModel(config) as LanguageModel;
  await expect(
    model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      ...resolveDefaultAgentOptions(config),
    }),
  ).rejects.toThrow();

  if (!body) throw new Error("no request was sent");
  return body;
}

describe("azure-openai reasoning effort on the wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends reasoning.effort for a deployment whose name the sdk does not recognise", async () => {
    const body = await captureRequestBody({
      type: "azure-api-key",
      resourceName: "r",
      deploymentName: "review-model",
      apiKey: "k",
      reasoningEffort: "xhigh",
    });

    expect(body.model).toBe("review-model");
    expect(body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("sends no reasoning block when no effort is set", async () => {
    const body = await captureRequestBody({
      type: "azure-api-key",
      resourceName: "r",
      deploymentName: "review-model",
      apiKey: "k",
    });

    expect(body.reasoning).toBeUndefined();
  });
});
