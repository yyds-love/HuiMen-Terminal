import { usePreferencesStore } from "@/modules/settings/preferences";
import { tool } from "ai";
import { z } from "zod";
import { SUBAGENTS, type SubagentType } from "../agents/registry";
import { runSubagent } from "../agents/runSubagent";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";

const TYPE_KEYS = Object.keys(SUBAGENTS) as [SubagentType, ...SubagentType[]];

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `启动一个隔离的子智能体，具有独立的受限工具集和全新的消息历史。当需要委派独立的只读调查（大规模搜索、代码审查、安全审计）且不想污染自身上下文时使用此工具。子智能体返回单个文本摘要；请选择与任务匹配的 'type'。

Types:
${TYPE_KEYS.map((k) => `- ${k}: ${SUBAGENTS[k].description}`).join("\n")}

自动执行，无需批准 -- 子智能体默认为只读。`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        prompt: z
          .string()
          .describe(
            "独立指令。子智能体没有先前对话的记忆 -- 请包含所有相关上下文。",
          ),
        description: z
          .string()
          .optional()
          .describe("在聊天界面的启动卡片上显示的简短标签。"),
      }),
      execute: async ({ type, prompt, description }) => {
        const { apiKeys, customEndpointKeys, selectedModelId, patchAgentMeta } =
          useChatStore.getState();
        const preferences = usePreferencesStore.getState();
        try {
          const r = await runSubagent({
            type,
            prompt,
            keys: { ...apiKeys },
            modelId: selectedModelId,
            localProviderConfig: {
              openaiCompatibleBaseURL: preferences.openaiCompatibleBaseURL,
              openaiCompatibleModelId: preferences.openaiCompatibleModelId,
              customEndpoints: preferences.customEndpoints.map((endpoint) => ({
                ...endpoint,
              })),
              customEndpointKeys: { ...customEndpointKeys },
            },
            toolContext: ctx,
            onStep: (label) => {
              if (
                useChatStore.getState().activeSessionId !== ctx.getSessionId()
              ) {
                return;
              }
              patchAgentMeta({ step: label });
            },
          });
          return {
            type,
            description,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
          };
        } catch (e) {
          return { error: String(e), type };
        }
      },
    }),
  } as const;
}
