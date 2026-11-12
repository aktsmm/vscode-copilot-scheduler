import * as vscode from "vscode";

// Root hooks: the executor and scheduler tests drive the chat route with stubbed
// commands. Agent Host runs (the default route) would otherwise try the real host
// of the test VS Code and detach scheduler claims.
suiteSetup(async () => {
  await vscode.workspace
    .getConfiguration("copilotScheduler")
    .update("executionRoute", "chat", vscode.ConfigurationTarget.Global);
});

suiteTeardown(async () => {
  await vscode.workspace
    .getConfiguration("copilotScheduler")
    .update("executionRoute", undefined, vscode.ConfigurationTarget.Global);
});
