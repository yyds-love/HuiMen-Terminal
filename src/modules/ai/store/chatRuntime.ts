import { usePreferencesStore } from "@/modules/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { MAX_AGENT_STEPS, providerNeedsKey, resolveModel } from "../config";
import type { AgentUsageDelta } from "../lib/agent";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  hasPendingToolApprovals,
  settleInterruptedToolApprovals,
} from "../lib/approval";
import { createTransport as createTransportRaw } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import { useAgentsStore } from "./agentsStore";
import {
  chats,
  getActiveProviderKey,
  seedMessages,
  touchChat,
  useChatStore,
} from "./chatStore";
import { usePlanStore } from "./planStore";

function makeChat(sessionId: string): Chat<UIMessage> {
  const isActive = () => useChatStore.getState().activeSessionId === sessionId;
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () => useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
    spawnAgent: (prompt) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
    readAgentOutput: (leafId) =>
      useChatStore.getState().live.readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createTransportRaw({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAgentsStore.getState();
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return a.instructions;
    },
    getLive: () => {
      const live = useChatStore.getState().live;
      return {
        ...live,
        spawnAgent: () => null,
        readAgentOutput: () => null,
        readCache: new Map(),
        getSessionId: () => sessionId,
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getOpenaiCompatibleBaseURL: () =>
      usePreferencesStore.getState().openaiCompatibleBaseURL,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getOpenaiCompatibleContextLimit: () =>
      usePreferencesStore.getState().openaiCompatibleContextLimit,
    getCustomEndpoints: () => usePreferencesStore.getState().customEndpoints,
    getCustomEndpointKeys: () => useChatStore.getState().customEndpointKeys,
    onStep: (step: string) => {
      if (!isActive()) return;
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info: { droppedCount: number }) => {
      if (!isActive()) return;
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onFinishMeta: ({ finishReason, steps }) => {
      if (!isActive()) return;
      useChatStore.getState().patchAgentMeta({
        hitStepCap: finishReason === "tool-calls" && steps >= MAX_AGENT_STEPS,
      });
    },
    onUsage: (delta: AgentUsageDelta) => {
      if (!isActive()) return;
      const cur = useChatStore.getState().agentMeta.tokens;
      useChatStore.getState().patchAgentMeta({
        tokens: {
          inputTokens: cur.inputTokens + (delta.inputTokens ?? 0),
          outputTokens: cur.outputTokens + (delta.outputTokens ?? 0),
          cachedInputTokens:
            cur.cachedInputTokens + (delta.cachedInputTokens ?? 0),
          totalTokens:
            cur.totalTokens +
            (delta.totalTokens ??
              (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0)),
          reasoningTokens: cur.reasoningTokens + (delta.reasoningTokens ?? 0),
        },
      });
    },
  });

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  const chat = new Chat<UIMessage>({
    id: sessionId,
    transport,
    // A restored execution has no live runner. Record uncertainty rather than
    // replaying an approved mutation or leaving the conversation blocked.
    messages: initialMessages
      ? settleInterruptedToolApprovals(initialMessages)
      : undefined,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError) return;
      const settled = settleInterruptedToolApprovals(chat.messages);
      if (settled !== chat.messages) chat.messages = settled;
    },
    onError: (e) => {
      if (!isActive()) return;
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });
  return chat;
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  const c = makeChat(sessionId);
  touchChat(sessionId, c);
  return c;
}

export function trySendMessage(
  sessionId: string,
  parts: UIMessage["parts"],
): Promise<void> | null {
  const chat = getOrCreateChat(sessionId);
  if (
    chat.status === "submitted" ||
    chat.status === "streaming" ||
    hasPendingToolApprovals(chat.messages)
  )
    return null;
  // Explicit parts avoid the SDK's asynchronous FileList conversion between
  // checking approvals and appending the user message.
  return chat.sendMessage({ role: "user", parts });
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (
    providerNeedsKey(
      resolveModel(
        state.selectedModelId,
        usePreferencesStore.getState().customEndpoints,
      ).provider,
    ) &&
    !getActiveProviderKey()
  )
    return false;
  const pending = trySendMessage(sessionId, [{ type: "text", text }]);
  if (!pending) return false;
  await pending;
  return true;
}
