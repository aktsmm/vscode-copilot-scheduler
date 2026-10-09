const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

function activate(context) {
  const vscode = require("vscode");
  const root = process.env.SCHEDULER_REPO;
  const observed = [];
  const selectedModels = [];
  require(
    path.join(root, "out/configured-model-provider.js"),
  ).registerConfiguredModelProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("scheduler-test-source", {
      provideLanguageModelChatInformation() {
        return [
          {
            id: "synthetic",
            name: "Synthetic",
            family: "synthetic",
            version: "1",
            maxInputTokens: 10000,
            maxOutputTokens: 1000,
            isUserSelectable: true,
            capabilities: { toolCalling: true },
            configurationSchema: {
              type: "object",
              properties: {
                reasoningEffort: {
                  type: "string",
                  enum: ["low", "high"],
                },
                mode: {
                  type: "string",
                  enum: ["normal:low", "fast:high"],
                  default: "normal:low",
                },
                contextSize: {
                  type: ["string", "number"],
                  enum: ["auto", 4096],
                  default: "auto",
                },
              },
            },
          },
        ];
      },
      provideLanguageModelChatResponse(model, _messages, options, progress) {
        observed.push({
          sourceModel: model.id,
          configuration: options.modelConfiguration,
          response: "DYNAMIC_EXECUTION_OK",
        });
        progress.report(
          new vscode.LanguageModelTextPart("DYNAMIC_EXECUTION_OK"),
        );
      },
      provideTokenCount() {
        return 1;
      },
    }),
  );
  context.subscriptions.push(
    vscode.chat.createChatParticipant(
      "local-test.scheduler-execution.assistant",
      async (request, _history, stream, token) => {
        selectedModels.push(request.model.id);
        const response = await request.model.sendRequest(
          [vscode.LanguageModelChatMessage.User(request.prompt)],
          {},
          token,
        );
        for await (const text of response.text) stream.markdown(text);
      },
    ),
  );
  return { observed, selectedModels };
}

async function tests() {
  const vscode = require("vscode");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { CopilotExecutor } = require(
    path.join(process.env.SCHEDULER_REPO, "out/copilotExecutor.js"),
  );
  const api = await vscode.extensions
    .getExtension("local-test.scheduler-execution")
    .activate();
  const configFile = path.join(
    process.env.SCHEDULER_TEST_DATA,
    "User/chatLanguageModels.json",
  );
  const original = fs.readFileSync(configFile, "utf8");
  const results = [];
  for (const scenario of [
    { configuration: { mode: "normal:low", contextSize: "auto" } },
    { configuration: { mode: "fast:high", contextSize: 4096 } },
    { configuration: { mode: "normal:low", contextSize: "auto" } },
    { configuration: { reasoningEffort: "high" }, legacyEffort: "high" },
  ]) {
    const configuration = scenario.configuration;
    const before = api.observed.length;
    await new CopilotExecutor().executePrompt(
      "@executionprobe Reply DYNAMIC_EXECUTION_OK",
      {
        model: "synthetic",
        modelVendor: "scheduler-test-source",
        agent: "ask",
        chatSession: "new",
        ...(scenario.legacyEffort
          ? { modelReasoningEffort: scenario.legacyEffort }
          : { modelConfiguration: configuration }),
      },
    );
    const received = api.observed.slice(before);
    assert.equal(received.length, 1);
    assert.deepEqual(
      received[0].configuration,
      scenario.legacyEffort
        ? { mode: null, contextSize: "auto", ...configuration }
        : configuration,
    );
    assert.equal(received[0].response, "DYNAMIC_EXECUTION_OK");
    results.push({
      requested: configuration,
      legacyEffort: scenario.legacyEffort,
      received: received[0],
    });
  }
  assert.equal(fs.readFileSync(configFile, "utf8"), original);
  assert.equal(api.selectedModels.length, results.length);
  assert.notEqual(api.selectedModels[0], api.selectedModels[1]);
  assert.equal(
    api.selectedModels[0],
    api.selectedModels[2],
    "Returning to the same options must reuse the immutable binding without cross-task bleed",
  );
  const proof = {
    vscodeVersion: vscode.version,
    route:
      "CopilotExecutor -> actual Chat -> production configured relay -> synthetic source",
    realNetworkInference: false,
    sharedSettingsUnchanged: true,
    bindingReuseVerified: true,
    selectedModels: api.selectedModels,
    results,
  };
  fs.writeFileSync(
    process.env.SCHEDULER_TEST_PROOF,
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(
    "Dynamic execution PASS: Low/High Fast/Low round trip, legacy High migration, immutable binding reuse, typed context, exact responses, shared settings unchanged",
  );
}

async function main() {
  const repo = path.resolve(__dirname, "..");
  const executable =
    process.argv[2] ||
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs/Microsoft VS Code/Code.exe",
    );
  if (
    !fs.existsSync(executable) ||
    !fs.existsSync(path.join(repo, "out/configured-model-provider.js"))
  )
    throw new Error(
      "Build with npm run pretest and supply a VS Code 1.141+ executable",
    );
  const output = path.resolve(
    process.argv[3] ||
      path.join(repo, "research/dynamic-execution-evidence.json"),
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "scheduler-fixed-request-"),
  );
  const extension = path.join(root, "extension");
  const data = path.join(root, "user-data");
  fs.mkdirSync(extension, { recursive: true });
  fs.mkdirSync(path.join(data, "User"), { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    path.join(extension, "package.json"),
    JSON.stringify({
      name: "scheduler-execution",
      publisher: "local-test",
      version: "0.0.1",
      engines: { vscode: "^1.141.0" },
      main: "extension.cjs",
      activationEvents: ["onStartupFinished"],
      enabledApiProposals: ["chatParticipantPrivate", "defaultChatParticipant"],
      contributes: {
        languageModelChatProviders: [
          { vendor: "scheduler-test-source", displayName: "Synthetic" },
          { vendor: "copilot-scheduler-configured", displayName: "Configured" },
        ],
        chatParticipants: [
          {
            id: "local-test.scheduler-execution.assistant",
            name: "executionprobe",
            fullName: "Execution Probe",
            description: "Synthetic test",
            isDefault: true,
          },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(extension, "extension.cjs"),
    `const path=require("node:path");exports.activate=${activate.toString()};`,
  );
  fs.writeFileSync(
    path.join(extension, "tests.cjs"),
    `exports.run=${tests.toString()};`,
  );
  fs.writeFileSync(
    path.join(data, "User/settings.json"),
    JSON.stringify({
      "telemetry.telemetryLevel": "off",
      "security.workspace.trust.enabled": false,
    }),
  );
  fs.writeFileSync(
    path.join(data, "User/chatLanguageModels.json"),
    JSON.stringify([
      { name: "Synthetic", vendor: "scheduler-test-source", configuration: {} },
    ]),
  );
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(extension, "tests.cjs"),
      extensionTestsEnv: {
        SCHEDULER_REPO: repo,
        SCHEDULER_TEST_DATA: data,
        SCHEDULER_TEST_PROOF: output,
      },
      launchArgs: [
        "--user-data-dir",
        data,
        "--extensions-dir",
        path.join(root, "extensions"),
        "--enable-proposed-api",
        "local-test.scheduler-execution",
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
      ],
    });
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
