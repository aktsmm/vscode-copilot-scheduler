import * as vscode from "vscode";
import type { LogLevel } from "./types";

type Level = Exclude<LogLevel, "none">;

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Lazily create the dedicated "Copilot Scheduler" output channel so diagnostic
 * logs are visible in the Output panel (not just the Debug Console).
 */
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Copilot Scheduler");
  }
  return outputChannel;
}

/**
 * Initialize the logger output channel and register it for disposal.
 * Safe to call once during extension activation.
 */
export function initLogger(context: vscode.ExtensionContext): void {
  context.subscriptions.push(getOutputChannel());
}

function getConfiguredLogLevel(): LogLevel {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<LogLevel>("logLevel", "info");
}

function rank(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 3;
    case "info":
      return 2;
    case "error":
      return 1;
    default:
      return 0;
  }
}

function canLog(messageLevel: Level): boolean {
  const current = getConfiguredLogLevel();
  return rank(current) >= rank(messageLevel);
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function appendToChannel(args: unknown[]): void {
  // Only write to the channel if it has already been created (i.e. the
  // extension activated). Avoids creating UI during unit tests.
  if (outputChannel) {
    outputChannel.appendLine(formatArgs(args));
  }
}

export function logDebug(...args: unknown[]): void {
  if (!canLog("debug")) return;
  console.log(...args);
  appendToChannel(args);
}

export function logError(...args: unknown[]): void {
  if (!canLog("error")) return;
  console.error(...args);
  appendToChannel(args);
}
