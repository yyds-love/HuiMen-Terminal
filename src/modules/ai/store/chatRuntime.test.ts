import { usePreferencesStore } from "@/modules/settings/preferences";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredLanguageModel } from "../lib/agent";
import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import { getOrCreateChat, sendMessage } from "./chatRuntime";
import { chats, seedMessages, useChatStore } from "./chatStore";

vi.mock("../lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agent")>()),
  buildConfiguredLanguageModel: vi.fn(),
}));

function reply() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: "Synthetic reply" },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 },
            outputTokens: { total: 5, text: 3, reasoning: 2 },
          },
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  chats.clear();
  seedMessages.clear();
  useChatStore.getState().resetAgentMeta();
  useChatStore.setState({
    activeSessionId: "a",
    selectedModelId: "glm-4-flash",
    apiKeys: { ...EMPTY_PROVIDER_KEYS, zhipu: "synthetic" },
    customEndpointKeys: {},
  });
  usePreferencesStore.setState({
    customEndpoints: [
      {
        id: "local",
        name: "Local",
        baseURL: "http://localhost:1234/v1",
        modelId: "local-model",
        contextLimit: 8192,
      },
    ],
  });
  vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(
    new MockLanguageModelV3({ doStream: reply() }),
  );
});
afterEach(async () => {
  await Promise.all([...chats.values()].map((chat) => chat.stop()));
  chats.clear();
});

describe("chat runtime model and session integration", () => {
  it.each([
    true,
    false,
  ])("recovers a restored interrupted approval (%s) without replaying its tool", async (approved) => {
    const history = [
      {
        id: "assistant",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-write_file" as const,
            toolCallId: "interrupted",
            state: "approval-responded" as const,
            input: { path: "/repo/file.txt", content: "synthetic" },
            approval: { id: "approval", approved },
          },
        ],
      },
    ];
    seedMessages.set("a", history);
    const chat = getOrCreateChat("a");
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: approved ? "output-error" : "output-denied",
    });
    expect(history[0].parts[0].state).toBe("approval-responded");
    expect(await sendMessage("check current state")).toBe(true);
    expect(chat.error).toBeUndefined();
  });

  it.each([
    "abort",
    "error",
  ])("settles an approval interrupted by %s during model initialization", async (outcome) => {
    seedMessages.set("a", [
      {
        id: "assistant",
        role: "assistant",
        parts: [
          {
            type: "tool-write_file",
            toolCallId: "interrupted",
            state: "approval-requested",
            input: { path: "/repo/file.txt", content: "synthetic" },
            approval: { id: "approval" },
          },
        ],
      },
    ]);
    let resolveModel!: (model: MockLanguageModelV3) => void;
    let rejectModel!: (error: Error) => void;
    vi.mocked(buildConfiguredLanguageModel).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolveModel = resolve;
        rejectModel = reject;
      }),
    );
    const chat = getOrCreateChat("a");
    await chat.addToolApprovalResponse({ id: "approval", approved: true });
    await vi.waitFor(() =>
      expect(buildConfiguredLanguageModel).toHaveBeenCalledTimes(1),
    );
    const model = new MockLanguageModelV3({ doStream: reply() });
    if (outcome === "abort") {
      await chat.stop();
      resolveModel(model);
    } else rejectModel(new Error("controlled model failure"));
    await vi.waitFor(() => expect(["ready", "error"]).toContain(chat.status));
    expect(chat.messages[0].parts[0]).toMatchObject({ state: "output-error" });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(await sendMessage("check current state")).toBe(true);
  });

  it("waits for an approved tool's continuation before accepting a followup", async () => {
    const chat = getOrCreateChat("a");
    chat.messages = [
      {
        id: "assistant",
        role: "assistant",
        parts: [
          {
            type: "tool-write_file",
            toolCallId: "pending",
            state: "approval-responded",
            input: { path: "/repo/file.txt", content: "synthetic" },
            approval: { id: "approval", approved: true },
          },
        ],
      },
    ];
    const original = JSON.stringify(chat.messages);
    expect(await sendMessage("followup")).toBe(false);
    expect(JSON.stringify(chat.messages)).toBe(original);
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
  });

  it("refuses overlapping submits while the actual chat is busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        await gate;
        return reply();
      },
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const first = sendMessage("first");
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(1));
    const second = sendMessage("second");
    release();
    await first;
    expect(await second).toBe(false);
    expect(
      getOrCreateChat("a").messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("preserves pending approvals instead of appending a new user message", async () => {
    seedMessages.set("a", [
      { id: "user", role: "user", parts: [{ type: "text", text: "write" }] },
      {
        id: "assistant",
        role: "assistant",
        parts: [
          {
            type: "tool-write_file",
            toolCallId: "pending",
            state: "approval-requested",
            input: { path: "/repo/file.txt", content: "synthetic" },
            approval: { id: "approval" },
          },
        ],
      },
    ]);
    const chat = getOrCreateChat("a");
    const original = JSON.stringify(chat.messages);
    expect(await sendMessage("followup")).toBe(false);
    expect(JSON.stringify(chat.messages)).toBe(original);
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
    await chat.addToolApprovalResponse({ id: "approval", approved: false });
    await vi.waitFor(() =>
      expect(chat.messages.slice(-1)[0]?.parts).toContainEqual(
        expect.objectContaining({ type: "text", text: "Synthetic reply" }),
      ),
    );
    expect(chat.error).toBeUndefined();
    expect(await sendMessage("continue")).toBe(true);
  });

  it("sends with a named custom endpoint without requiring an unrelated key", async () => {
    useChatStore.setState({
      selectedModelId: "compat-local",
      apiKeys: { ...EMPTY_PROVIDER_KEYS },
    });
    await expect(sendMessage("hello")).resolves.toBe(true);
    expect(getOrCreateChat("a").error).toBeUndefined();
    expect(buildConfiguredLanguageModel).toHaveBeenCalledWith(
      "compat-local",
      EMPTY_PROVIDER_KEYS,
      expect.objectContaining({
        customEndpoints: usePreferencesStore.getState().customEndpoints,
      }),
    );
    expect(getOrCreateChat("a").messages.slice(-1)[0]?.role).toBe("assistant");
  });

  it("preserves usage totals including reasoning tokens", async () => {
    await sendMessage("hello");
    expect(getOrCreateChat("a").error).toBeUndefined();
    expect(useChatStore.getState().agentMeta.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 15,
    });
  });

  it("does not overwrite active-session metadata after switching away", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        await gate;
        return reply();
      },
    });
    vi.mocked(buildConfiguredLanguageModel).mockResolvedValue(model);
    const pending = sendMessage("hello");
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(1));
    useChatStore.setState({ activeSessionId: "b" });
    useChatStore
      .getState()
      .patchAgentMeta({ step: "session-b", hitStepCap: true });
    const meta = useChatStore.getState().agentMeta;
    release();
    await pending;
    expect(useChatStore.getState().agentMeta).toEqual(meta);
  });

  it("does not overwrite active-session errors from an inactive chat", async () => {
    let rejectModel!: (error: Error) => void;
    vi.mocked(buildConfiguredLanguageModel).mockReturnValue(
      new Promise((_, reject) => {
        rejectModel = reject;
      }),
    );
    const pending = sendMessage("hello");
    await vi.waitFor(() =>
      expect(buildConfiguredLanguageModel).toHaveBeenCalled(),
    );
    useChatStore.setState({ activeSessionId: "b" });
    useChatStore
      .getState()
      .patchAgentMeta({ error: "session-b-error", status: "error" });
    rejectModel(new Error("session-a-error"));
    await pending;
    expect(useChatStore.getState().agentMeta.error).toBe("session-b-error");
    expect(getOrCreateChat("a").error?.message).toBe("session-a-error");
  });

  it("does not create a chat when a required provider key is missing", async () => {
    useChatStore.setState({ apiKeys: { ...EMPTY_PROVIDER_KEYS } });
    expect(await sendMessage("hello")).toBe(false);
    expect(chats.size).toBe(0);
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
  });

  it("does not send without an active session", async () => {
    useChatStore.setState({ activeSessionId: null });
    expect(await sendMessage("hello")).toBe(false);
    expect(buildConfiguredLanguageModel).not.toHaveBeenCalled();
  });
});
