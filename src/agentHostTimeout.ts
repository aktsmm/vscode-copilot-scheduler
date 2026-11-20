/**
 * Agent Host run timeout settings.
 *
 * The timeout cancels a running turn, so it is off by default: agent tasks can
 * legitimately run for hours. A user who set the minutes before the on/off
 * option existed keeps the timeout they chose.
 */
import type * as vscode from "vscode";

export const DEFAULT_AGENT_HOST_TIMEOUT_MINUTES = 180;
export const MAX_AGENT_HOST_TIMEOUT_MINUTES = 720;
/** Input observation of a queued message ends after this when there is no run timeout. */
export const AGENT_HOST_OBSERVATION_CAP_MS = MAX_AGENT_HOST_TIMEOUT_MINUTES * 60 * 1000;

type TimeoutConfig = Pick<vscode.WorkspaceConfiguration, "get" | "inspect">;

export interface AgentHostTimeout {
  /** Cancel a running turn after this long; undefined waits without cancelling. */
  runMs: number | undefined;
  /** How long to watch a queued message for input requests. */
  observationMs: number;
}

// The settings are machine-scoped, so only the user (or remote) value counts;
// a workspace value is ignored. In a remote window `globalValue` carries the
// remote machine's settings.
function hasHonoredValue(config: TimeoutConfig, key: string): boolean {
  return config.inspect<unknown>(key)?.globalValue !== undefined;
}

export function resolveAgentHostTimeout(config: TimeoutConfig): AgentHostTimeout {
  const configured = Math.floor(
    Number(
      config.get<number>(
        "agentHostTimeoutMinutes",
        DEFAULT_AGENT_HOST_TIMEOUT_MINUTES,
      ),
    ),
  );
  const minutes = Math.min(
    Math.max(
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_AGENT_HOST_TIMEOUT_MINUTES,
      1,
    ),
    MAX_AGENT_HOST_TIMEOUT_MINUTES,
  );
  const enabled = hasHonoredValue(config, "agentHostTimeoutEnabled")
    ? config.get<boolean>("agentHostTimeoutEnabled", false) === true
    : hasHonoredValue(config, "agentHostTimeoutMinutes");
  return enabled
    ? { runMs: minutes * 60 * 1000, observationMs: minutes * 60 * 1000 }
    : { runMs: undefined, observationMs: AGENT_HOST_OBSERVATION_CAP_MS };
}
