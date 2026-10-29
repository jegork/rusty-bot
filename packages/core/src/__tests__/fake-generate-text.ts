import type * as AiModule from "ai";

export interface FakeResponse {
  object?: unknown;
  output?: unknown;
  text?: string;
  usage?: Record<string, number>;
  [key: string]: unknown;
}

// mocks describe the outcome ({ object, text, usage, ... }); this turns it into
// what generateText returns. a native call (output requested) yields the object
// via `output`, or throws NoOutputGeneratedError like the sdk does when there is
// none. a call without output gets the object back as json text, which is how
// the prompt-injected path and the reviewer's prose for the structurer see it.
export function toGenerateTextResult(
  opts: Record<string, unknown>,
  r: FakeResponse | undefined,
  ai: typeof AiModule,
): unknown {
  const { object: obj, output: out, usage, ...rest } = r ?? {};
  const object = obj ?? out;
  const result = {
    text: object !== undefined && !opts.output ? JSON.stringify(object) : "",
    finishReason: "stop",
    toolCalls: [],
    warnings: [],
    steps: [{}],
    response: {},
    ...rest,
    usage,
    totalUsage: usage,
  };
  Object.defineProperty(result, "output", {
    get() {
      if (object === undefined) throw new ai.NoOutputGeneratedError();
      return object;
    },
  });
  return result;
}
