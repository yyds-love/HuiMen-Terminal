import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import { native } from "../lib/native";
import type { ToolContext } from "../tools/context";
import { runSubagent } from "./runSubagent";

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("../lib/native", () => ({
  native: { canonicalize: vi.fn(), readFile: vi.fn() },
}));
vi.mock("../lib/proxyFetch", () => ({
  createProxyFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, init),
}));

const endpoint = {
  id: "subagent-local",
  name: "Local",
  baseURL: "http://localhost:1234/v1",
  modelId: "local-research-model",
  contextLimit: 8192,
};
const ctx: ToolContext = {
  getCwd: () => "/repo",
  getWorkspaceRoot: () => "/repo",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "origin-session",
};

type RequestBody = {
  model: string;
  tools: { function: { name: string } }[];
};
let sent: { url: string; headers: Headers; body: RequestBody }[];
let keepReading: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  ctx.readCache.clear();
  sent = [];
  keepReading = false;
  vi.mocked(native.canonicalize).mockImplementation(async (path) => path);
  vi.mocked(native.readFile).mockResolvedValue({
    kind: "text",
    content: "controlled source",
    size: 17,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        id: "controlled-subagent",
        object: "chat.completion",
        created: 1,
        model: "controlled-model",
        choices: [
          {
            index: 0,
            message: keepReading
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `read-${sent.length}`,
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"src/main.ts"}',
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "Research summary" },
            finish_reason: keepReading ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("subagent configured model routing", () => {
  it("uses a named endpoint's URL, model and key", async () => {
    const result = await runSubagent({
      type: "explore",
      prompt: "Inspect sources",
      modelId: "compat-subagent-local",
      keys: EMPTY_PROVIDER_KEYS,
      toolContext: ctx,
      localProviderConfig: {
        customEndpoints: [endpoint],
        customEndpointKeys: { [endpoint.id]: "synthetic-subagent-key" },
      },
    });
    expect(result.summary).toBe("Research summary");
    expect(result.stepCount).toBe(1);
    expect(sent[0].url).toBe(`${endpoint.baseURL}/chat/completions`);
    expect(sent[0].body.model).toBe(endpoint.modelId);
    expect(sent[0].headers.get("authorization")).toBe(
      "Bearer synthetic-subagent-key",
    );
  });

  it("passes legacy compatible URL and model configuration", async () => {
    const result = await runSubagent({
      type: "general",
      prompt: "Inspect sources",
      modelId: "openai-compatible-custom",
      keys: {
        ...EMPTY_PROVIDER_KEYS,
        "openai-compatible": "synthetic-legacy-key",
      },
      toolContext: ctx,
      localProviderConfig: {
        openaiCompatibleBaseURL: "https://legacy-subagent.example/v1",
        openaiCompatibleModelId: "legacy-subagent-model",
      },
    });
    expect(result.summary).toBe("Research summary");
    expect(sent[0].url).toBe(
      "https://legacy-subagent.example/v1/chat/completions",
    );
    expect(sent[0].body.model).toBe("legacy-subagent-model");
    expect(sent[0].headers.get("authorization")).toBe(
      "Bearer synthetic-legacy-key",
    );
  });

  it("keeps local named endpoints keyless even with a legacy key", async () => {
    await runSubagent({
      type: "security",
      prompt: "Inspect sources",
      modelId: "compat-subagent-local",
      keys: {
        ...EMPTY_PROVIDER_KEYS,
        "openai-compatible": "synthetic-unrelated-key",
      },
      toolContext: ctx,
      localProviderConfig: { customEndpoints: [endpoint] },
    });
    expect(sent[0].headers.has("authorization")).toBe(false);
  });

  it("retains the read-only tool whitelist and stops after twelve steps", async () => {
    keepReading = true;
    const onStep = vi.fn();
    const result = await runSubagent({
      type: "explore",
      prompt: "Keep inspecting",
      modelId: "glm-4-flash",
      keys: { ...EMPTY_PROVIDER_KEYS, zhipu: "synthetic-builtin-key" },
      toolContext: ctx,
      onStep,
    });
    expect(result.stepCount).toBe(12);
    expect(sent).toHaveLength(12);
    for (const request of sent) {
      expect(
        request.body.tools.map((tool) => tool.function.name).sort(),
      ).toEqual(["glob", "grep", "list_directory", "read_file"]);
    }
    expect(onStep).toHaveBeenCalledTimes(12);
    expect(native.readFile).toHaveBeenCalledWith("/repo/src/main.ts", {
      kind: "local",
    });
  });
});
