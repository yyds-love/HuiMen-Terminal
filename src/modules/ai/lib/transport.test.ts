import { Chat } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AGENT_STEPS, selectSystemPrompt } from "../config";
import { usePlanStore } from "../store/planStore";
import { buildConfiguredLanguageModel } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { native } from "./native";
import { createTransport, type TransportDeps } from "./transport";

vi.mock("./agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent")>()),
  buildConfiguredLanguageModel: vi.fn(),
}));
vi.mock("./native", () => ({
  native: {
    canonicalize: vi.fn(async (path: string) => path),
    writeFile: vi.fn(async () => {}),
  },
}));

type ModelStream = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type ModelChunk =
  ModelStream["stream"] extends ReadableStream<infer T> ? T : never;
const usage = {
  inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};
function response(chunks: ModelChunk[], reason = "stop"): ModelStream {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...chunks,
        {
          type: "finish",
          finishReason: { unified: reason, raw: reason },
          usage,
        } as ModelChunk,
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}
function textResponse(text = "Hello"): ModelStream {
  return response([
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
  ]);
}
function toolResponse(toolName: string, input: unknown): ModelStream {
  return response(
    [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName,
        input: JSON.stringify(input),
      },
    ],
    "tool-calls",
  );
}
function sequence(
  ...responses: ModelStream[]
): MockLanguageModelV3["doStream"] {
  let index = 0;
  return async () => {
    const next = responses[index++];
    if (!next) throw new Error("Unexpected extra model request");
    return next;
  };
}
function fixture() {
  const ctx = {
    getCwd: () => "/repo",
    getWorkspaceRoot: () => "/repo",
    getTerminalContext: () => "synthetic terminal output",
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map<string, { size: number; hash: number }>(),
    getSessionId: () => "session",
  };
  const deps: TransportDeps = {
    getLive: () => ({ ...ctx, getActiveFile: () => "/repo/main.ts" }),
    getKeys: () => ({ ...EMPTY_PROVIDER_KEYS, zhipu: "synthetic-key" }),
    getModelId: () => "glm-4-flash",
    getCustomInstructions: () => "Use synthetic fixtures only.",
    getAgentPersona: () => "You are a careful reviewer.",
    toolContext: ctx,
    onStep: vi.fn(),
    onUsage: vi.fn(),
    onCompact: vi.fn(),
    onFinishMeta: vi.fn(),
  };
  const transport: ChatTransport<UIMessage> = createTransport(deps);
  return { deps, transport };
}
function makeChat(transport: ChatTransport<UIMessage>) {
  return new Chat<UIMessage>({
    id: "session",
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
}
function assistantText(chat: Chat<UIMessage>) {
  return chat.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}
function request(messages: UIMessage[] = [], signal?: AbortSignal) {
  return {
    chatId: "session",
    trigger: "submit-message" as const,
    messageId: undefined,
    messages,
    abortSignal: signal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlanStore.setState({ active: false, queue: [] });
  vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(
    new MockLanguageModelV3({ doStream: textResponse() }),
  );
});

describe("AI SDK chat transport", () => {
  it("streams assistant text through a real Chat and supports regeneration", async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence(textResponse("first"), textResponse("second")),
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { transport, deps } = fixture();
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "hello" });
    expect(chat.error).toBeUndefined();
    expect(assistantText(chat)).toBe("first");
    expect(chat.status).toBe("ready");
    expect(deps.onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 15,
    });
    expect(deps.onFinishMeta).toHaveBeenCalledWith({
      finishReason: "stop",
      steps: 1,
    });
    await chat.regenerate();
    expect(assistantText(chat)).toBe("second");
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("routes each request using current model and endpoint configuration", async () => {
    const { transport, deps } = fixture();
    const endpoint = {
      id: "a",
      name: "Local",
      baseURL: "http://localhost:1234/v1",
      modelId: "local-model",
      contextLimit: 8192,
    };
    deps.getModelId = () => "compat-a";
    deps.getCustomEndpoints = () => [endpoint];
    deps.getCustomEndpointKeys = () => ({ a: "endpoint-synthetic" });
    deps.getOpenaiCompatibleBaseURL = () => "http://localhost:5678/v1";
    deps.getOpenaiCompatibleModelId = () => "legacy-model";
    await transport.sendMessages(request());
    expect(buildConfiguredLanguageModel).toHaveBeenLastCalledWith(
      "compat-a",
      deps.getKeys(),
      {
        openaiCompatibleBaseURL: "http://localhost:5678/v1",
        openaiCompatibleModelId: "legacy-model",
        customEndpoints: [endpoint],
        customEndpointKeys: { a: "endpoint-synthetic" },
      },
    );
    deps.getModelId = () => "kimi-latest";
    await transport.sendMessages(request());
    expect(
      vi.mocked(buildConfiguredLanguageModel).mock.calls.slice(-1)[0]?.[0],
    ).toBe("kimi-latest");
  });

  it("injects environment and instructions without changing stored messages", async () => {
    const model = new MockLanguageModelV3({ doStream: textResponse() });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { transport } = fixture();
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "review" });
    expect(chat.messages[0].parts).toEqual([{ type: "text", text: "review" }]);
    const prompt = model.doStreamCalls[0].prompt;
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect(prompt[0].content).toContain(selectSystemPrompt("glm-4-flash"));
    expect(JSON.stringify(prompt[0])).toContain("Use synthetic fixtures only.");
    expect(JSON.stringify(prompt[0])).toContain("careful reviewer");
    expect(JSON.stringify(prompt)).toContain("workspace_root=/repo");
    expect(JSON.stringify(prompt)).toContain("active_terminal_cwd=/repo");
    expect(JSON.stringify(prompt)).toContain("active_file=/repo/main.ts");
    expect(JSON.stringify(prompt)).not.toContain("synthetic terminal output");
  });

  it("preserves reasoning chunks", async () => {
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(
      new MockLanguageModelV3({
        doStream: response([
          { type: "reasoning-start", id: "reason" },
          { type: "reasoning-delta", id: "reason", delta: "Thinking" },
          { type: "reasoning-end", id: "reason" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Done" },
          { type: "text-end", id: "text" },
        ]),
      }),
    );
    const chat = makeChat(fixture().transport);
    await chat.sendMessage({ text: "reason" });
    expect(chat.messages.slice(-1)[0]?.parts).toContainEqual(
      expect.objectContaining({ type: "reasoning", text: "Thinking" }),
    );
    expect(assistantText(chat)).toBe("Done");
  });

  it("continues after read-only tools and reports their usage once per step", async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence(
        toolResponse("get_terminal_output", {}),
        textResponse("Explained"),
      ),
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { deps, transport } = fixture();
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "explain last command" });
    expect(chat.error).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "synthetic terminal output",
    );
    expect(assistantText(chat)).toBe("Explained");
    expect(deps.onUsage).toHaveBeenCalledTimes(2);
    expect(deps.onStep).toHaveBeenCalledWith("get_terminal_output");
  });

  it.each([
    true,
    false,
  ])("requires approval before a write and respects decision %s", async (approved) => {
    const model = new MockLanguageModelV3({
      doStream: sequence(
        toolResponse("write_file", {
          path: "/repo/new.txt",
          content: "synthetic",
        }),
        textResponse("Finished"),
      ),
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const chat = makeChat(fixture().transport);
    await chat.sendMessage({ text: "write file" });
    expect(chat.error).toBeUndefined();
    const pending = chat.messages
      .slice(-1)[0]
      ?.parts.find((p) => "state" in p && p.state === "approval-requested");
    expect(pending).toBeDefined();
    if (!pending || !("approval" in pending) || !pending.approval)
      throw new Error("Missing approval");
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(1);
    await chat.addToolApprovalResponse({ id: pending.approval.id, approved });
    await vi.waitFor(() => expect(assistantText(chat)).toBe("Finished"));
    expect(chat.error).toBeUndefined();
    expect(native.writeFile).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(chat.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      approved ? "synthetic" : "denied",
    );
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "workspace_root=/repo",
    );
  });

  it("keeps approved plan edits queued instead of writing files", async () => {
    usePlanStore.setState({ active: true });
    const model = new MockLanguageModelV3({
      doStream: sequence(
        toolResponse("write_file", {
          path: "/repo/planned.txt",
          content: "synthetic",
        }),
        textResponse("Queued"),
      ),
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { deps, transport } = fixture();
    deps.getPlanMode = () => true;
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "plan" });
    expect(usePlanStore.getState().queue).toHaveLength(0);
    const pending = chat.messages
      .slice(-1)[0]
      ?.parts.find((p) => "state" in p && p.state === "approval-requested");
    if (!pending || !("approval" in pending) || !pending.approval)
      throw new Error("Missing approval");
    await chat.addToolApprovalResponse({
      id: pending.approval.id,
      approved: true,
    });
    await vi.waitFor(() => expect(assistantText(chat)).toBe("Queued"));
    expect(usePlanStore.getState().queue).toMatchObject([
      { path: "/repo/planned.txt", proposedContent: "synthetic" },
    ]);
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("compacts only request context using a named endpoint's context limit", async () => {
    const history: UIMessage[] = [];
    for (let i = 0; i < 15; i++) {
      history.push({
        id: `u${i}`,
        role: "user",
        parts: [{ type: "text", text: "read" }],
      });
      history.push({
        id: `a${i}`,
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            toolCallId: `read-${i}`,
            state: "output-available",
            input: { path: `/repo/file-${i}.txt` },
            output: {
              content:
                i === 0
                  ? `VERY_OLD_RESULT${"x".repeat(12000)}`
                  : "RECENT_RESULT",
            },
          },
        ],
      });
    }
    const model = new MockLanguageModelV3({ doStream: textResponse() });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { deps, transport } = fixture();
    deps.getModelId = () => "compat-small";
    deps.getCustomEndpoints = () => [
      {
        id: "small",
        name: "Small",
        baseURL: "http://localhost/v1",
        modelId: "small",
        contextLimit: 1000,
      },
    ];
    deps.getOpenaiCompatibleContextLimit = () => 100000;
    const snapshot = JSON.stringify(history);
    const chat = new Chat({ id: "session", transport, messages: history });
    await chat.sendMessage({ text: "continue" });
    expect(chat.error).toBeUndefined();
    expect(deps.onCompact).toHaveBeenCalled();
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).not.toContain("VERY_OLD_RESULT");
    expect(prompt).toContain("RECENT_RESULT");
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it("continues after a cancelled incomplete tool call without resending it", async () => {
    const model = new MockLanguageModelV3({ doStream: textResponse() });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { transport } = fixture();
    const chat = new Chat<UIMessage>({
      id: "session",
      transport,
      messages: [
        { id: "u", role: "user", parts: [{ type: "text", text: "read" }] },
        {
          id: "a",
          role: "assistant",
          parts: [
            {
              type: "tool-get_terminal_output",
              toolCallId: "incomplete",
              state: "input-available",
              input: {},
            },
          ],
        },
      ],
    });
    await chat.sendMessage({ text: "try again" });
    expect(chat.error).toBeUndefined();
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "incomplete",
    );
    expect(assistantText(chat)).toBe("Hello");
  });

  it("forwards cancellation during streaming and preserves received text", async () => {
    let activeSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        activeSignal = abortSignal;
        return {
          stream: new ReadableStream<ModelChunk>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text" });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "Partial",
              });
              abortSignal?.addEventListener(
                "abort",
                () => controller.error(abortSignal.reason),
                { once: true },
              );
            },
          }),
        };
      },
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { deps, transport } = fixture();
    const chat = makeChat(transport);
    const pending = chat.sendMessage({ text: "hello" });
    await vi.waitFor(() => expect(assistantText(chat)).toBe("Partial"));
    await chat.stop();
    await pending;
    expect(activeSignal?.aborted).toBe(true);
    expect(chat.status).toBe("ready");
    expect(chat.error).toBeUndefined();
    expect(assistantText(chat)).toBe("Partial");
    expect(deps.onFinishMeta).not.toHaveBeenCalled();
  });

  it("caps repeated tool steps", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => toolResponse("get_terminal_output", {}),
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const { deps, transport } = fixture();
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "loop" });
    expect(chat.error).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(MAX_AGENT_STEPS);
    expect(deps.onFinishMeta).toHaveBeenCalledWith({
      finishReason: "tool-calls",
      steps: MAX_AGENT_STEPS,
    });
  });

  it("does not start a request when already cancelled", async () => {
    const { transport } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      transport.sendMessages(request([], abort.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
  });

  it("does not call the model when cancelled during model initialization", async () => {
    let resolveModel!: (model: MockLanguageModelV3) => void;
    vi.mocked(buildConfiguredLanguageModel).mockReturnValue(
      new Promise((resolve) => {
        resolveModel = resolve;
      }),
    );
    const { transport } = fixture();
    const abort = new AbortController();
    const pending = transport.sendMessages(request([], abort.signal));
    abort.abort();
    const model = new MockLanguageModelV3({ doStream: textResponse() });
    resolveModel(model);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("exposes provider errors to Chat instead of reporting success", async () => {
    vi.mocked(buildConfiguredLanguageModel).mockRejectedValue(
      new Error("synthetic missing configuration"),
    );
    const chat = makeChat(fixture().transport);
    await chat.sendMessage({ text: "hello" });
    expect(chat.status).toBe("error");
    expect(chat.error?.message).toContain("synthetic missing configuration");
  });

  it("propagates stream errors to Chat", async () => {
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(
      new MockLanguageModelV3({
        doStream: {
          stream: new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic stream failure"));
            },
          }),
        },
      }),
    );
    const { deps, transport } = fixture();
    const chat = makeChat(transport);
    await chat.sendMessage({ text: "hello" });
    expect(chat.status).toBe("error");
    expect(chat.error?.message).toContain("synthetic stream failure");
    expect(deps.onFinishMeta).not.toHaveBeenCalled();
  });

  it("returns null for reconnect without issuing another request", async () => {
    const { transport } = fixture();
    expect(await transport.reconnectToStream({ chatId: "session" })).toBeNull();
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
  });
});
