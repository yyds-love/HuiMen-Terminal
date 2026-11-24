import {
  type ChatTransport,
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import {
  type CustomEndpoint,
  endpointIdFromCompatModel,
  getModelContextLimit,
  MAX_AGENT_STEPS,
  selectSystemPrompt,
} from "../config";
import type { ToolContext } from "../tools/context";
import { buildTools } from "../tools/tools";
import {
  type AgentUsage,
  type AgentUsageDelta,
  buildConfiguredLanguageModel,
} from "./agent";
import { compactModelMessagesDetailed } from "./compact";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";

export type { AgentUsage, AgentUsageDelta };

export type Live = {
  getCwd: () => string | null;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  getTerminalContext: () => string | null;
  injectIntoActivePty: (text: string) => boolean;
  openPreview: (url: string) => boolean;
  spawnAgent: (prompt: string) => { tabId: number; leafId: number } | null;
  readAgentOutput: (leafId: number) => string | null;
  readCache: Map<string, { size: number; hash: number }>;
  getSessionId: () => string | null;
};

export type TransportDeps = {
  getLive: () => Live;
  getKeys: () => ProviderKeys;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => string | null;
  toolContext: ToolContext;
  onStep: (step: string) => void;
  onUsage: (delta: AgentUsageDelta) => void;
  onCompact: (info: { droppedCount: number }) => void;
  onFinishMeta: (meta: { finishReason: string; steps: number }) => void;
  getOllamaBaseURL?: () => string;
  getOllamaModelId?: () => string;
  getOpenaiCompatibleBaseURL?: () => string;
  getOpenaiCompatibleModelId?: () => string;
  getOpenaiCompatibleContextLimit?: () => number;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  getPlanMode?: () => boolean;
};

function formatEnvBlock(live: Live): string | null {
  const cwd = live.getCwd();
  const root = live.getWorkspaceRoot();
  const file = live.getActiveFile();
  if (!cwd && !root && !file) return null;
  const parts: string[] = [];
  if (root) parts.push(`workspace_root=${root}`);
  if (cwd) parts.push(`active_terminal_cwd=${cwd}`);
  if (file) parts.push(`active_file=${file}`);
  return parts.length ? `<env>\n${parts.join("\n")}\n</env>` : null;
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "user") index--;
  if (index < 0) return messages;
  const last = messages[index];
  // UIMessage content is an array of parts, prepend env block as text
  const updated = {
    ...last,
    parts: [{ type: "text" as const, text: `${envBlock}\n\n` }, ...last.parts],
  };
  return [...messages.slice(0, index), updated, ...messages.slice(index + 1)];
}

export function createTransport(deps: TransportDeps): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      abortSignal?.throwIfAborted();
      // Resolve once per request, so a settings change cannot reroute its
      // continuation to another model or endpoint mid-stream.
      const modelId = deps.getModelId();
      const endpoints = deps.getCustomEndpoints?.();
      const compatibleContextLimit = deps.getOpenaiCompatibleContextLimit?.();
      const system = [
        selectSystemPrompt(modelId),
        deps.getAgentPersona(),
        deps.getCustomInstructions(),
        deps.getPlanMode?.()
          ? "Plan mode is active. Approved file edits are queued for review; do not claim they have been applied."
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      const live = deps.getLive();
      const envBlock = formatEnvBlock(live);
      const messagesForRun = envBlock
        ? injectEnvIntoLastUser(messages, envBlock)
        : messages;
      const tools = buildTools(deps.toolContext);
      const model = await buildConfiguredLanguageModel(
        modelId,
        deps.getKeys(),
        {
          openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
          openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
          customEndpoints: endpoints,
          customEndpointKeys: deps.getCustomEndpointKeys?.(),
        },
      );
      abortSignal?.throwIfAborted();
      const modelMessages = await convertToModelMessages(messagesForRun, {
        tools,
        ignoreIncompleteToolCalls: true,
      });
      abortSignal?.throwIfAborted();
      const endpointLimit = endpoints?.find(
        (ep) => ep.id === endpointIdFromCompatModel(modelId),
      )?.contextLimit;
      const contextLimit = getModelContextLimit(
        modelId,
        endpointLimit ?? compatibleContextLimit,
      );
      let failed = false;
      const result = streamText({
        model,
        system,
        messages: modelMessages,
        tools,
        abortSignal,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        prepareStep: ({ messages: stepMessages }) => {
          const compact = compactModelMessagesDetailed(
            stepMessages,
            contextLimit,
          );
          if (compact.compacted)
            deps.onCompact({ droppedCount: compact.droppedCount });
          return { messages: compact.messages };
        },
        onStepFinish: ({ toolCalls, usage }) => {
          if (abortSignal?.aborted) return;
          for (const call of toolCalls) deps.onStep(call.toolName);
          deps.onUsage({
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
            reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          });
        },
        onError: () => {
          failed = true;
        },
        onFinish: ({ finishReason, steps }) => {
          if (!failed && !abortSignal?.aborted) {
            deps.onFinishMeta({ finishReason, steps: steps.length });
          }
        },
      });
      return result.toUIMessageStream({ originalMessages: messages });
    },
    async reconnectToStream() {
      // Requests execute in-process; there is no persisted server stream.
      return null;
    },
  };
}
