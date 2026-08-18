/**
 * Copilot Scheduler - Preferred workspace folder resolution
 *
 * A workspace-scoped task binds to exactly one folder, so task creation,
 * attachment picking, and prompt placeholders must all agree on which folder
 * that is.
 */

import * as vscode from "vscode";

export function getPreferredWorkspaceFolder():
  | vscode.WorkspaceFolder
  | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder?.uri.fsPath) {
      return folder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

export function getPreferredWorkspaceRootPath(): string | undefined {
  return getPreferredWorkspaceFolder()?.uri.fsPath;
}

export function getPreferredWorkspaceName(): string {
  return getPreferredWorkspaceFolder()?.name || "";
}
