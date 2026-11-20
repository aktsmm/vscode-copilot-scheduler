/**
 * Agent Host run timeout settings.
 *
 * The timeout cancels a running turn, so it is off by default: agent tasks can
 * legitimately run for hours. A user who set the minutes before the on/off
 * option existed keeps the timeout they chose. The Copilot CLI timeout follows
 * the same rule.
 */
import type * as vscode from "vscode";
import type { TaskTimeout } from "./types";

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
  /** True when the task's own timeout decided this, not the settings. */
  viaTask: boolean;
}

// The settings are machine-scoped, so only the user (or remote) value counts;
// a workspace value is ignored. In a remote window `globalValue` carries the
// remote machine's settings.
function hasHonoredValue(config: TimeoutConfig, key: string): boolean {
  return config.inspect<unknown>(key)?.globalValue !== undefined;
}

interface OptInTimeout {
  enabled: boolean;
  minutes: number;
  viaTask: boolean;
}

function clampMinutes(value: number): number {
  return Math.min(Math.max(value, 1), MAX_AGENT_HOST_TIMEOUT_MINUTES);
}

function resolveOptInTimeout(
  config: TimeoutConfig,
  enabledKey: string,
  minutesKey: string,
  override: TaskTimeout | undefined,
): OptInTimeout {
  const configured = Math.floor(
    Number(config.get<number>(minutesKey, DEFAULT_AGENT_HOST_TIMEOUT_MINUTES)),
  );
  const minutes = clampMinutes(
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AGENT_HOST_TIMEOUT_MINUTES,
  );
  if (override?.mode === "off") {
    return { enabled: false, minutes, viaTask: true };
  }
  if (override?.mode === "on") {
    const taskMinutes = Math.floor(Number(override.minutes));
    return {
      enabled: true,
      minutes: Number.isFinite(taskMinutes) && taskMinutes > 0 ? clampMinutes(taskMinutes) : minutes,
      viaTask: true,
    };
  }
  const enabled = hasHonoredValue(config, enabledKey)
    ? config.get<boolean>(enabledKey, false) === true
    : hasHonoredValue(config, minutesKey);
  return { enabled, minutes, viaTask: false };
}

/**
 * Validates a task-level timeout. "inherit" is stored as no value at all; an
 * "on" timeout may omit its minutes to use the configured ones.
 */
export function parseTaskTimeout(
  value: unknown,
): { ok: true; value: TaskTimeout | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const { mode, minutes } = value as { mode?: unknown; minutes?: unknown };
  if (mode === "inherit") return { ok: true, value: undefined };
  if (mode === "off") return { ok: true, value: { mode: "off" } };
  if (mode !== "on") return { ok: false };
  if (minutes === undefined) return { ok: true, value: { mode: "on" } };
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_AGENT_HOST_TIMEOUT_MINUTES
  ) {
    return { ok: false };
  }
  return { ok: true, value: { mode: "on", minutes } };
}

/** A stored value that no longer validates is ignored at run time (the global setting applies). */
export function effectiveTaskTimeout(value: unknown): TaskTimeout | undefined {
  const parsed = parseTaskTimeout(value);
  return parsed.ok ? parsed.value : undefined;
}

export function resolveAgentHostTimeout(
  config: TimeoutConfig,
  taskTimeout?: TaskTimeout,
): AgentHostTimeout {
  const { enabled, minutes, viaTask } = resolveOptInTimeout(
    config,
    "agentHostTimeoutEnabled",
    "agentHostTimeoutMinutes",
    effectiveTaskTimeout(taskTimeout),
  );
  return enabled
    ? { runMs: minutes * 60 * 1000, observationMs: minutes * 60 * 1000, viaTask }
    : { runMs: undefined, observationMs: AGENT_HOST_OBSERVATION_CAP_MS, viaTask };
}

export interface CliTimeout {
  /** Stop the CLI run after this long; undefined lets it run until it exits. */
  runMs: number | undefined;
  /** The configured minutes, for the "stopped after N minutes" message. */
  minutes: number;
  /** True when the task's own timeout decided this, not the settings. */
  viaTask: boolean;
}

/** Same opt-in rule as the Agent Host timeout, for `cliTimeoutEnabled` / `cliTimeoutMinutes`. */
export function resolveCliTimeout(
  config: TimeoutConfig,
  taskTimeout?: TaskTimeout,
): CliTimeout {
  const { enabled, minutes, viaTask } = resolveOptInTimeout(
    config,
    "cliTimeoutEnabled",
    "cliTimeoutMinutes",
    effectiveTaskTimeout(taskTimeout),
  );
  return { runMs: enabled ? minutes * 60 * 1000 : undefined, minutes, viaTask };
}
