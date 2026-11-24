import { usePreferencesStore } from "@/modules/settings/preferences";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagent } from "../agents/runSubagent";
import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import { buildSubagentTools } from "./subagent";

vi.mock("../agents/runSubagent", () => ({ runSubagent: vi.fn() }));

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

beforeEach(() => vi.clearAllMocks());

describe("run_subagent configuration snapshot", () => {
  it("updates progress only while the originating session is active", async () => {
    useChatStore.setState({ activeSessionId: "origin-session" });
    useChatStore.getState().resetAgentMeta();
    vi.mocked(runSubagent).mockImplementation(async ({ onStep }) => {
      onStep?.("origin-progress");
      expect(useChatStore.getState().agentMeta.step).toBe("origin-progress");
      useChatStore.setState({ activeSessionId: "other-session" });
      useChatStore.getState().patchAgentMeta({ step: "other-progress" });
      onStep?.("late-origin-progress");
      return { summary: "Summary", stepCount: 2, durationMs: 5 };
    });
    const execute = buildSubagentTools(ctx).run_subagent.execute;
    if (!execute) throw new Error("Missing subagent executor");
    await execute(
      { type: "explore", prompt: "Inspect" },
      { toolCallId: "subagent", messages: [] },
    );
    expect(useChatStore.getState().agentMeta.step).toBe("other-progress");
  });

  it("copies provider and endpoint settings before starting the runner", async () => {
    const keys = {
      ...EMPTY_PROVIDER_KEYS,
      "openai-compatible": "synthetic-legacy",
    };
    const endpointKeys = { local: "synthetic-local" };
    const endpoint = {
      id: "local",
      name: "Local",
      baseURL: "http://localhost:1234/v1",
      modelId: "local-model",
      contextLimit: 8192,
    };
    useChatStore.setState({
      apiKeys: keys,
      customEndpointKeys: endpointKeys,
      selectedModelId: "compat-local",
    });
    usePreferencesStore.setState({
      customEndpoints: [endpoint],
      openaiCompatibleBaseURL: "https://legacy.example/v1",
      openaiCompatibleModelId: "legacy-model",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runSubagent).mockImplementation(async () => {
      await gate;
      return { summary: "Summary", stepCount: 1, durationMs: 5 };
    });
    const execute = buildSubagentTools(ctx).run_subagent.execute;
    if (!execute) throw new Error("Missing subagent executor");
    const pending = execute(
      { type: "explore", prompt: "Inspect", description: "Research" },
      { toolCallId: "subagent", messages: [] },
    );
    const args = vi.mocked(runSubagent).mock.calls[0][0];
    keys["openai-compatible"] = "changed-legacy";
    endpointKeys.local = "changed-local";
    endpoint.baseURL = "http://changed.example/v1";
    endpoint.modelId = "changed-model";
    useChatStore.setState({ selectedModelId: "glm-4-flash" });
    usePreferencesStore.setState({
      openaiCompatibleModelId: "changed-legacy-model",
    });
    release();
    await pending;
    expect(args).toMatchObject({
      modelId: "compat-local",
      keys: { "openai-compatible": "synthetic-legacy" },
      localProviderConfig: {
        openaiCompatibleBaseURL: "https://legacy.example/v1",
        openaiCompatibleModelId: "legacy-model",
        customEndpoints: [
          {
            ...endpoint,
            baseURL: "http://localhost:1234/v1",
            modelId: "local-model",
          },
        ],
        customEndpointKeys: { local: "synthetic-local" },
      },
    });
  });
});
