import {
  type AgentType,
  agentBareCommand,
  agentResumeCommand,
} from "./agentResume";
import { captureAgentSession, claimAgentSession } from "./agentSessionCapture";
import {
  submitToLeaf,
  usesCodexInlineScrollback,
  whenSessionReady,
} from "./useTerminalSession";

export type LaunchAgentOpts = {
  /** When set, resume this exact session instead of starting fresh. */
  sessionId?: string;
  cwd?: string | null;
  /** Other sessions in the same tab (splits) to exclude when capturing. */
  excludeIds?: string[];
  /** Called when a (new) session id is discovered — on fresh launch to bind it,
   * and on resume to track a forked/branched session. */
  onSessionCaptured?: (sessionId: string) => void;
};

async function submitWhenWritable(
  leafId: number,
  agent: AgentType,
  sessionId?: string,
  timeoutMs = 7000,
): Promise<boolean> {
  const submit = () => {
    const inlineScrollback = usesCodexInlineScrollback(leafId);
    const command = sessionId
      ? agentResumeCommand(agent, sessionId, inlineScrollback)
      : agentBareCommand(agent, inlineScrollback);
    return submitToLeaf(leafId, command);
  };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (submit()) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return submit();
}

/**
 * Launch (or resume) an agent inside a terminal leaf. Waits for the PTY to be
 * ready, writes the startup command, then polls for the live session id.
 *
 * Capturing runs on BOTH paths: a fresh launch binds the new id, and a resume
 * re-checks so a forked/branched session (Claude Code / Codex often start a new
 * session when resuming) is tracked. The current id is excluded, so a session
 * that simply continues stays put while a fork is picked up.
 */
export async function launchAgentInLeaf(
  leafId: number,
  agent: AgentType,
  opts: LaunchAgentOpts = {},
): Promise<void> {
  await whenSessionReady(leafId);
  // A resumed/restored session already belongs to this leaf — claim it so a
  // concurrently-launched agent in the same cwd can't capture it.
  if (opts.sessionId) claimAgentSession(opts.sessionId);
  const submitted = await submitWhenWritable(leafId, agent, opts.sessionId);
  if (!submitted) {
    console.warn("[terax] agent launch command could not be submitted", leafId);
    return;
  }

  if (opts.onSessionCaptured) {
    const excludeIds = opts.sessionId
      ? [opts.sessionId, ...(opts.excludeIds ?? [])]
      : (opts.excludeIds ?? []);
    captureAgentSession(
      agent,
      opts.cwd ?? null,
      Date.now(),
      excludeIds,
      opts.onSessionCaptured,
    );
  }
}
