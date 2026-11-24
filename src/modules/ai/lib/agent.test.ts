import { generateText, type LanguageModel, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomEndpoint, ProviderId } from "../config";
import { buildConfiguredLanguageModel, buildLanguageModel } from "./agent";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "./keyring";

// Keep the SDK adapters real; replace only native HTTP with controlled fetch.
vi.mock("./proxyFetch", () => ({
  createProxyFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, init),
}));

type CapturedRequest = {
  url: string;
  headers: Headers;
  body: {
    model: string;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
  };
};

let requests: CapturedRequest[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      const body = requests[requests.length - 1].body;
      if (body.stream) {
        const chunks: unknown[] = [
          {
            id: "controlled-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Controlled answer" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "controlled-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        if (body.stream_options?.include_usage) {
          chunks.push({
            id: "controlled-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
              prompt_tokens_details: { cached_tokens: 5 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          });
        }
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "controlled-response",
        object: "chat.completion",
        created: 1,
        model: "controlled-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Controlled answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function request(model: LanguageModel): Promise<CapturedRequest> {
  const result = await generateText({ model, prompt: "Hello", maxRetries: 0 });
  expect(result.text).toBe("Controlled answer");
  return requests[requests.length - 1];
}

function keysFor(provider: ProviderId, key = "synthetic-key"): ProviderKeys {
  return { ...EMPTY_PROVIDER_KEYS, [provider]: key };
}

const builtins = [
  {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner"],
  },
  {
    provider: "zhipu",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.1", "glm-4-flash"],
  },
  {
    provider: "minimax",
    baseURL: "https://api.minimax.chat/v1",
    models: ["MiniMax-M2.7", "MiniMax-Text-01"],
  },
  {
    provider: "kimi",
    baseURL: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.6", "kimi-latest"],
  },
  {
    provider: "xiaomimimo",
    baseURL: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.5-pro", "mimo-latest"],
  },
] as const;

const endpoint: CustomEndpoint = {
  id: "selected-endpoint",
  name: "Selected endpoint",
  baseURL: "http://127.0.0.1:1234/v1",
  modelId: "local-model",
  contextLimit: 32_000,
};

describe("configured language model routing", () => {
  for (const { provider, baseURL, models } of builtins) {
    it.each(models)(`routes %s to ${provider}`, async (modelId) => {
      const model = await buildConfiguredLanguageModel(
        modelId,
        keysFor(provider),
      );
      const sent = await request(model);
      expect(sent.url).toBe(`${baseURL}/chat/completions`);
      expect(sent.body.model).toBe(modelId);
      expect(sent.headers.get("authorization")).toBe("Bearer synthetic-key");
    });

    it(`rejects ${provider} without its required key`, async () => {
      await expect(
        buildConfiguredLanguageModel(models[0], EMPTY_PROVIDER_KEYS),
      ).rejects.toThrow(provider);
      expect(requests).toEqual([]);
    });
  }

  it("uses the selected endpoint URL, model and own key", async () => {
    const model = await buildConfiguredLanguageModel(
      "compat-selected-endpoint",
      EMPTY_PROVIDER_KEYS,
      {
        customEndpoints: [endpoint],
        customEndpointKeys: { [endpoint.id]: "synthetic-endpoint-key" },
        openaiCompatibleBaseURL: "https://unused.example/v1",
        openaiCompatibleModelId: "unused-model",
      },
    );
    const sent = await request(model);
    expect(sent.url).toBe(`${endpoint.baseURL}/chat/completions`);
    expect(sent.body.model).toBe(endpoint.modelId);
    expect(sent.headers.get("authorization")).toBe(
      "Bearer synthetic-endpoint-key",
    );
  });

  it.each([
    undefined,
    null,
    "",
  ])("does not send the legacy key when the selected endpoint key is %s", async (endpointKey) => {
    const model = await buildConfiguredLanguageModel(
      "compat-selected-endpoint",
      keysFor("openai-compatible", "synthetic-legacy-key"),
      {
        customEndpoints: [endpoint],
        customEndpointKeys:
          endpointKey === undefined ? {} : { [endpoint.id]: endpointKey },
      },
    );
    expect((await request(model)).headers.has("authorization")).toBe(false);
  });

  it("accepts a local endpoint without any key", async () => {
    const model = await buildConfiguredLanguageModel(
      "compat-selected-endpoint",
      EMPTY_PROVIDER_KEYS,
      { customEndpoints: [endpoint] },
    );
    expect((await request(model)).headers.has("authorization")).toBe(false);
  });

  it("uses the legacy compatible model, URL and provider key", async () => {
    const model = await buildConfiguredLanguageModel(
      "openai-compatible-custom",
      keysFor("openai-compatible", "synthetic-legacy-key"),
      {
        openaiCompatibleBaseURL: "https://legacy.example/v1",
        openaiCompatibleModelId: "legacy-model",
      },
    );
    const sent = await request(model);
    expect(sent.url).toBe("https://legacy.example/v1/chat/completions");
    expect(sent.body.model).toBe("legacy-model");
    expect(sent.headers.get("authorization")).toBe(
      "Bearer synthetic-legacy-key",
    );
  });

  it("prefers a legacy endpoint key over the provider key", async () => {
    const model = await buildConfiguredLanguageModel(
      "openai-compatible-custom",
      keysFor("openai-compatible", "synthetic-provider-key"),
      {
        openaiCompatibleBaseURL: "https://legacy.example/v1",
        openaiCompatibleModelId: "legacy-model",
        customEndpointKeys: { "openai-compatible": "synthetic-override-key" },
      },
    );
    expect((await request(model)).headers.get("authorization")).toBe(
      "Bearer synthetic-override-key",
    );
  });

  it("accepts the legacy compatible endpoint without a key", async () => {
    const model = await buildConfiguredLanguageModel(
      "openai-compatible-custom",
      EMPTY_PROVIDER_KEYS,
      { openaiCompatibleBaseURL: "http://localhost:8080/v1" },
    );
    expect((await request(model)).headers.has("authorization")).toBe(false);
  });

  it("rejects a compatible endpoint without its URL", async () => {
    await expect(
      buildConfiguredLanguageModel(
        "openai-compatible-custom",
        keysFor("openai-compatible"),
      ),
    ).rejects.toThrow("URL");
    expect(requests).toEqual([]);
  });

  it("rejects a deleted endpoint even if its model was previously cached", async () => {
    await buildConfiguredLanguageModel(
      "compat-selected-endpoint",
      keysFor("openai-compatible"),
      { customEndpoints: [endpoint] },
    );
    expect(() =>
      buildConfiguredLanguageModel(
        "compat-selected-endpoint",
        keysFor("openai-compatible"),
        { customEndpoints: [] },
      ),
    ).toThrow("Unknown custom endpoint: selected-endpoint");
    expect(requests).toEqual([]);
  });

  it("rejects unknown model and endpoint IDs before any request", () => {
    expect(() =>
      buildConfiguredLanguageModel("unknown-model", EMPTY_PROVIDER_KEYS),
    ).toThrow("Unknown model: unknown-model");
    expect(() =>
      buildConfiguredLanguageModel("compat-missing", EMPTY_PROVIDER_KEYS),
    ).toThrow("Unknown custom endpoint: missing");
    expect(requests).toEqual([]);
  });
});

describe("language model cache isolation", () => {
  it("reuses identical configurations and separates key, URL and model changes", async () => {
    const build = (key: string, baseURL: string, modelId: string) =>
      buildConfiguredLanguageModel(
        "compat-selected-endpoint",
        keysFor("openai-compatible"),
        {
          customEndpoints: [{ ...endpoint, baseURL, modelId }],
          customEndpointKeys: { [endpoint.id]: key },
        },
      );
    const original = await build(
      "cache-key",
      endpoint.baseURL,
      endpoint.modelId,
    );
    expect(await build("cache-key", endpoint.baseURL, endpoint.modelId)).toBe(
      original,
    );
    expect(
      await build("different-key", endpoint.baseURL, endpoint.modelId),
    ).not.toBe(original);
    expect(
      await build("cache-key", "http://localhost:8081/v1", endpoint.modelId),
    ).not.toBe(original);
    expect(
      await build("cache-key", endpoint.baseURL, "different-model"),
    ).not.toBe(original);
  });

  it("separates providers and their changed credentials", async () => {
    const first = await buildLanguageModel(
      "unused",
      "deepseek",
      keysFor("deepseek"),
      "same-model",
    );
    const second = await buildLanguageModel(
      "unused",
      "kimi",
      keysFor("kimi"),
      "same-model",
    );
    const changed = await buildLanguageModel(
      "unused",
      "deepseek",
      keysFor("deepseek", "changed-key"),
      "same-model",
    );
    expect(first).not.toBe(second);
    expect(first).not.toBe(changed);
    expect((await request(changed)).headers.get("authorization")).toBe(
      "Bearer changed-key",
    );
  });

  it("does not collide when credentials and model IDs contain separators", async () => {
    const build = (key: string, modelId: string) =>
      buildConfiguredLanguageModel(
        "compat-selected-endpoint",
        keysFor("openai-compatible"),
        {
          customEndpoints: [{ ...endpoint, modelId }],
          customEndpointKeys: { [endpoint.id]: key },
        },
      );
    const first = await build("collision alpha", "beta");
    const second = await build("collision", "alpha beta");
    expect(second).not.toBe(first);
    const sent = await request(second);
    expect(sent.body.model).toBe("alpha beta");
    expect(sent.headers.get("authorization")).toBe("Bearer collision");
  });
});

describe("provider streaming usage", () => {
  it("requests and parses streaming usage for DeepSeek", async () => {
    const model = await buildConfiguredLanguageModel(
      "deepseek-v4-flash",
      keysFor("deepseek"),
    );
    const result = streamText({ model, prompt: "Hello", maxRetries: 0 });
    expect(await result.text).toBe("Controlled answer");
    expect(requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(await result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      cachedInputTokens: 5,
      reasoningTokens: 2,
    });
  });

  it("does not impose usage options on arbitrary compatible endpoints", async () => {
    const model = await buildConfiguredLanguageModel(
      "compat-selected-endpoint",
      EMPTY_PROVIDER_KEYS,
      { customEndpoints: [endpoint] },
    );
    const result = streamText({ model, prompt: "Hello", maxRetries: 0 });
    expect(await result.text).toBe("Controlled answer");
    expect(requests[0].body).not.toHaveProperty("stream_options");
  });

  it.each(
    builtins.filter(({ provider }) => provider !== "deepseek"),
  )("does not assume $provider supports include_usage", async ({
    provider,
    models,
  }) => {
    const model = await buildConfiguredLanguageModel(
      models[0],
      keysFor(provider),
    );
    const result = streamText({ model, prompt: "Hello", maxRetries: 0 });
    expect(await result.text).toBe("Controlled answer");
    expect(requests[0].body).not.toHaveProperty("stream_options");
  });
});
