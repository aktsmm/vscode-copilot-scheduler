const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function launchManualVerification(
  executable,
  root,
  extension,
  data,
  output,
  runId,
) {
  const repo = path.resolve(__dirname, "..");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, "package.json"), "utf8"),
  );
  manifest.displayName = "Copilot Scheduler - Manual Verification";
  manifest.main = "./manual-entry.cjs";
  manifest.enabledApiProposals = ["languageModelSystem"];
  for (const file of ["package.nls.json", "package.nls.ja.json"])
    fs.copyFileSync(path.join(repo, file), path.join(extension, file));
  for (const directory of ["media", "images"])
    fs.cpSync(path.join(repo, directory), path.join(extension, directory), {
      recursive: true,
    });
  fs.writeFileSync(
    path.join(extension, "package.json"),
    JSON.stringify(manifest),
  );
  const workspace = path.join(root, `scheduler-manual-${runId.slice(0, 8)}`);
  fs.mkdirSync(workspace, { recursive: true });
  const globalStore = path.join(
    data,
    "User/globalStorage/yamapan.copilot-scheduler",
  );
  fs.mkdirSync(globalStore, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(globalStore, "scheduledTasks.json"),
    JSON.stringify(
      [
        {
          id: require("node:crypto").randomUUID(),
          name: "Manual verification - disabled",
          cron: "0 0 1 1 *",
          enabled: false,
          prompt:
            "Do not use tools, read files or execute commands. Reply with exactly SCHEDULER_MANUAL_OK and nothing else.",
          agent: "agent",
          modelConfiguration: {},
          promptSource: "inline",
          createdAt: now,
          updatedAt: now,
        },
      ],
      null,
      2,
    ),
  );
  const session = {
    runId,
    manualVerification: true,
    temporaryRootName: path.basename(root),
    workspaceName: path.basename(workspace),
    normalProfileChanged: false,
    autoRequests: false,
    proposalDeclared: true,
    activationConfirmed: false,
  };
  fs.writeFileSync(output, JSON.stringify(session, null, 2) + "\n");
  fs.writeFileSync(
    path.join(extension, "manual-entry.cjs"),
    `const fs=require('node:fs');const vscode=require('vscode');const original=require('./out/extension.js');function mark(values){fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({...${JSON.stringify(session)},launcherStarted:true,...values},null,2)+'\\n');}exports.activate=async(context)=>{mark({entryLoaded:true});try{const result=await original.activate(context);mark({entryLoaded:true,activationConfirmed:true});await vscode.commands.executeCommand('copilotScheduler.createTaskGui');return result;}catch(error){mark({entryLoaded:true,activationError:true});throw error;}};exports.deactivate=original.deactivate;`,
  );
  const entryCode = fs.readFileSync(
    path.join(extension, "manual-entry.cjs"),
    "utf8",
  );
  let activation;
  const sandbox = {
    exports: {},
    require: (name) =>
      name === "node:fs"
        ? {
            writeFileSync: (_file, value) => {
              activation = JSON.parse(value);
            },
          }
        : name === "vscode"
          ? { commands: { executeCommand: async () => {} } }
          : { activate: async () => ({}) },
  };
  new (require("node:vm").Script)(entryCode).runInNewContext(sandbox);
  await sandbox.exports.activate({});
  if (activation?.runId !== runId || !activation.activationConfirmed)
    throw new Error("Manual entry preflight failed");
  if (process.argv.includes("--harness-check")) {
    fs.writeFileSync(
      output,
      JSON.stringify(
        { ...session, harnessValidated: true, createdWindow: false },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const bridges = fs
    .readdirSync(path.join(root, "extensions"))
    .filter((name) => name.startsWith("grikomsn.openai-oauth-copilot-chat-"));
  const development = [
    extension,
    path.join(root, "extensions", "github.copilot-chat"),
    path.join(root, "extensions", bridges[0]),
  ];
  await new Promise((resolve, reject) => {
    let watcher;
    const timer = setTimeout(() => {
      watcher?.close();
      reject(new Error("Manual environment activation was not confirmed"));
    }, 60000);
    watcher = fs.watch(path.dirname(output), () => {
      try {
        const current = JSON.parse(fs.readFileSync(output, "utf8"));
        if (current.runId === runId && current.entryLoaded) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      } catch {}
    });
    fs.writeFileSync(
      output,
      JSON.stringify({ ...session, launcherStarted: true }, null, 2) + "\n",
    );
    const child = require("node:child_process").spawn(
      process.platform === "win32" ? `"${executable}"` : executable,
      [
        "--new-window",
        "--skip-add-to-recently-opened",
        "--user-data-dir",
        data,
        "--extensions-dir",
        path.join(root, "extensions"),
        ...development.map(
          (directory) => `--extensionDevelopmentPath=${directory}`,
        ),
        "--enable-proposed-api=yamapan.copilot-scheduler",
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        workspace,
      ],
      { shell: process.platform === "win32", detached: true, stdio: "ignore" },
    );
    child.once("error", () => {
      clearTimeout(timer);
      watcher.close();
      reject(new Error("Manual environment launcher failed"));
    });
    child.unref();
  });
  console.log(
    "Manual verification environment activated; no requests sent and no auto-close enabled.",
  );
}

async function runDedicatedWindow(
  executable,
  root,
  extension,
  relayExtension,
  data,
  output,
  runId,
) {
  const environment = {
    SCHEDULER_REPO: path.resolve(__dirname, ".."),
    SCHEDULER_TEST_DATA: data,
    SCHEDULER_TEST_PROOF: output,
    SCHEDULER_TEST_RUN_ID: runId,
    SCHEDULER_LIVE_CLOUD: "true",
    SCHEDULER_REGISTRATION_ONLY: "false",
    SCHEDULER_EXISTING_PROFILE: "true",
    SCHEDULER_RELAY_ID: "yamapan.copilot-scheduler",
    SCHEDULER_NATIVE_AGENT_PROBE: String(
      process.argv.includes("--native-agent-probe"),
    ),
    SCHEDULER_NATIVE_PROBE_VENDOR:
      process.env.SCHEDULER_NATIVE_PROBE_VENDOR || "",
    SCHEDULER_NATIVE_PROBE_MODE: process.env.SCHEDULER_NATIVE_PROBE_MODE || "",
    SCHEDULER_NATIVE_CONFIG_PROBE: String(
      process.argv.includes("--native-config-probe"),
    ),
    SCHEDULER_SYNTHETIC_NATIVE_PROBE: String(
      process.argv.includes("--synthetic-native-probe"),
    ),
    SCHEDULER_MODEL_OPTION:
      process.env.SCHEDULER_MODEL_OPTION || "reasoningEffort",
    SCHEDULER_MODEL_OPTION_VALUE:
      process.env.SCHEDULER_MODEL_OPTION_VALUE || "low",
  };
  fs.writeFileSync(
    path.join(extension, "extension.cjs"),
    `Object.assign(process.env,${JSON.stringify(environment)});const path=require('node:path');const fs=require('node:fs');const vscode=require('vscode');const activate=${activate.toString()};const tests=${tests.toString()};const output=${JSON.stringify(output)};const runId=${JSON.stringify(runId)};function mark(values){let proof={runId};try{const previous=JSON.parse(fs.readFileSync(output,'utf8'));if(previous.runId===runId)proof=previous;}catch{}const temp=output+'.'+runId+'.tmp';fs.writeFileSync(temp,JSON.stringify({...proof,...values},null,2)+'\\n');fs.renameSync(temp,output);}exports.activate=(context)=>{const api=activate(context);const watcher=fs.watch(${JSON.stringify(root)},(_event,name)=>{if(String(name)==='abort.json')void vscode.commands.executeCommand('workbench.action.closeWindow');});context.subscriptions.push({dispose:()=>watcher.close()});setImmediate(async()=>{try{await tests();mark({directProbeSucceeded:true});}catch{mark({directProbeSucceeded:false,directProbeFailure:'Verification failed; no automatic retry'});}finally{await vscode.commands.executeCommand('workbench.action.closeWindow');}});return api;};exports.deactivate=()=>mark({directProbeWindowClosed:true});`,
  );
  const generated = fs.readFileSync(
    path.join(extension, "extension.cjs"),
    "utf8",
  );
  let marker;
  const module = { exports: {} };
  const fakeFs = {
    readFileSync: () => JSON.stringify({ runId }),
    writeFileSync: (_file, content) => {
      marker = JSON.parse(content);
    },
    renameSync() {},
  };
  new (require("node:vm").Script)(generated).runInNewContext({
    exports: module.exports,
    process: { env: {} },
    require: (name) =>
      name === "node:fs" ? fakeFs : name === "vscode" ? {} : require(name),
  });
  module.exports.deactivate();
  if (marker?.runId !== runId || marker.directProbeWindowClosed !== true)
    throw new Error("Generated harness did not produce valid closure evidence");
  if (process.argv.includes("--harness-check")) {
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          runId,
          harnessValidated: true,
          realNetworkInference: false,
          createdWindow: false,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const bridges = fs
    .readdirSync(path.join(root, "extensions"))
    .filter((name) => name.startsWith("grikomsn.openai-oauth-copilot-chat-"));
  const development = [
    extension,
    relayExtension,
    path.join(root, "extensions", "github.copilot-chat"),
    path.join(root, "extensions", bridges[0]),
  ];
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  if (process.argv.includes("--native-agent-probe")) {
    const agents = path.join(workspace, ".github", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, "scheduler-inheritance-probe.agent.md"),
      "---\nname: SchedulerInheritanceProbe\ndescription: Use only for inherited-model compatibility verification.\ntools: []\n---\nFor a requested verification marker, reply with CUSTOM_AGENT_CONFIRMED_ followed by that marker and nothing else. Do not use tools, read files or execute commands.\n",
    );
  }
  await new Promise((resolve, reject) => {
    let watcher;
    let deadline;
    let grace;
    const finish = (error) => {
      clearTimeout(deadline);
      clearTimeout(grace);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    watcher = fs.watch(path.dirname(output), () => {
      try {
        const proof = JSON.parse(fs.readFileSync(output, "utf8"));
        if (proof.runId === runId && proof.directProbeWindowClosed) {
          finish(
            proof.directProbeSucceeded
              ? undefined
              : new Error("Dedicated-window verification failed"),
          );
        }
      } catch {}
    });
    deadline = setTimeout(() => {
      fs.writeFileSync(
        path.join(root, "abort.json"),
        JSON.stringify({ runId }),
      );
      grace = setTimeout(
        () =>
          finish(
            new Error(
              "Dedicated test window did not finish before its deadline",
            ),
          ),
        15000,
      );
    }, 240000);
    const child = require("node:child_process").spawn(
      process.platform === "win32" ? `"${executable}"` : executable,
      [
        "--new-window",
        "--skip-add-to-recently-opened",
        "--user-data-dir",
        data,
        "--extensions-dir",
        path.join(root, "extensions"),
        ...development.map((entry) => `--extensionDevelopmentPath=${entry}`),
        "--enable-proposed-api=local-test.scheduler-execution",
        ...(process.argv.includes("--enable-system-api")
          ? ["--enable-proposed-api=yamapan.copilot-scheduler"]
          : []),
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        workspace,
      ],
      {
        shell: process.platform === "win32",
        stdio: "ignore",
        env: { ...process.env, ...environment },
      },
    );
    child.once("error", () =>
      finish(new Error("Dedicated-window launcher failed")),
    );
    child.once("exit", (code) => {
      if (code)
        finish(new Error(`Dedicated-window launcher exited with code ${code}`));
    });
  });
}

function activateRelay(context) {
  const vscode = require("vscode");
  const diagnostics = [];
  if (process.env.SCHEDULER_NATIVE_CONFIG_PROBE === "true") {
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => {
        diagnostics.push("probe_dispatch_warning");
        return undefined;
      },
    });
  }
  const provider = require("./out/configured-model-provider.js");
  const flow = {};
  let expectedProbeMarker = "";
  const flowChanged = new vscode.EventEmitter();
  context.subscriptions.push(flowChanged);
  const trace = async (phase, action) => {
    const state = (flow[phase] ||= {
      started: 0,
      completed: 0,
      failed: 0,
      active: 0,
      elapsedMs: 0,
    });
    state.started++;
    state.active++;
    const started = Date.now();
    if (state.started === 1) flowChanged.fire();
    try {
      const result = await action();
      state.completed++;
      return result;
    } catch (error) {
      state.failed++;
      throw error;
    } finally {
      state.active--;
      state.elapsedMs += Date.now() - started;
      if (state.started === 1 || state.started % 10 === 0) flowChanged.fire();
    }
  };
  if (process.env.SCHEDULER_NATIVE_CONFIG_PROBE === "true") {
    const prototype = provider.ConfiguredModelProvider.prototype;
    for (const method of [
      "provideTokenCount",
      "provideLanguageModelChatResponse",
    ]) {
      const original = prototype[method];
      prototype[method] = function (...args) {
        if (method === "provideLanguageModelChatResponse") {
          const text = args[1]
            .flatMap((message) => message.content)
            .map((part) => (typeof part.value === "string" ? part.value : ""))
            .join(" ");
          const shape = {
            messages: args[1].length,
            roles: [...new Set(args[1].map((message) => message.role))],
            tools: args[2].tools?.length || 0,
            toolMode: args[2].toolMode,
            inputContainsMarker:
              !!expectedProbeMarker && text.includes(expectedProbeMarker),
            inputCharacters: text.length,
            toolGroupSummary:
              text.includes("groupIndex") &&
              text.includes("groupName") &&
              text.includes("summary"),
            streamKinds: {},
            outputContainsMarker: false,
          };
          flow.requestShape = shape;
          (flow.requests ||= []).push(shape);
          if (flow.requests.length > 8) flow.requests.shift();
          const progress = args[3];
          let tail = "";
          args[3] = {
            report(part) {
              const kind = part.constructor?.name || "unknown";
              shape.streamKinds[kind] = (shape.streamKinds[kind] || 0) + 1;
              if (typeof part.value === "string") {
                tail = (tail + part.value).slice(-512);
                if (expectedProbeMarker && tail.includes(expectedProbeMarker))
                  shape.outputContainsMarker = true;
              }
              progress.report(part);
            },
          };
        }
        return trace(method, () => original.apply(this, args));
      };
    }
    const originalSource = prototype.source;
    prototype.source = async function (...args) {
      const source = await trace("sourcePreparation", () =>
        originalSource.apply(this, args),
      );
      return {
        ...source,
        countTokens: (...values) =>
          trace("sourceTokenCount", () => source.countTokens(...values)),
        sendRequest: (...values) =>
          trace("sourceSendRequest", () => source.sendRequest(...values)),
      };
    };
  }
  const { CopilotExecutor } = require("./out/copilotExecutor.js");
  const {
    loadModelConfigurationCatalog,
  } = require("./out/model-configuration.js");
  provider.registerConfiguredModelProvider(context);
  return {
    diagnostics: () => [...diagnostics],
    effectiveSystemDeclaration: () =>
      context.extension.packageJSON.enabledApiProposals?.includes(
        "languageModelSystem",
      ) === true,
    productSystemForwarding: provider.supportsSystemMessageForwarding,
    flowSummary: () => JSON.parse(JSON.stringify(flow)),
    setProbeMarker: (marker) => {
      expectedProbeMarker = marker;
    },
    onFlowChanged: flowChanged.event,
    resolve: provider.resolveConfiguredTaskModel,
    execute: (prompt, options) =>
      new CopilotExecutor().executePrompt(prompt, options),
    systemPermission: async (model) => {
      const selected = await vscode.lm.selectChatModels({
        vendor: model.vendor,
        id: model.id,
      });
      if (selected.length !== 1)
        throw new Error("Synthetic source is unavailable");
      try {
        const response = await selected[0].sendRequest(
          [
            new vscode.LanguageModelChatMessage(
              3,
              "Synthetic system instruction",
            ),
          ],
          {},
        );
        for await (const part of response.stream) void part;
        return "allowed";
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("languageModelSystem")
        )
          return "requires_languageModelSystem";
        throw error;
      }
    },
    catalog: async (vendor) =>
      loadModelConfigurationCatalog(
        (await vscode.lm.selectChatModels({ vendor })).map((model) => ({
          id: model.id,
          vendor: model.vendor,
          name: model.name,
          family: model.family,
          version: model.version,
          maxInputTokens: model.maxInputTokens,
          description: "",
        })),
      ),
    request: async (model, prompt, token) => {
      const selected = await vscode.lm.selectChatModels({
        vendor: model.vendor,
        id: model.id,
      });
      if (
        selected.length !== 1 ||
        selected[0].id !== model.id ||
        selected[0].vendor !== model.vendor
      ) {
        throw new Error("Probe model identity changed");
      }
      return selected[0].sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token,
      );
    },
  };
}

function activate(context) {
  const vscode = require("vscode");
  const observed = [];
  const selectedModels = [];
  const completion = new vscode.EventEmitter();
  context.subscriptions.push(completion);
  const modelChanged = new vscode.EventEmitter();
  context.subscriptions.push(modelChanged);
  let syntheticReply = "DYNAMIC_EXECUTION_OK";
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("scheduler-test-source", {
      onDidChangeLanguageModelChatInformation: modelChanged.event,
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
      provideLanguageModelChatResponse(model, messages, options, progress) {
        let responseText = syntheticReply;
        if (process.env.SCHEDULER_SYNTHETIC_NATIVE_PROBE === "true") {
          const text = messages
            .flatMap((message) => message.content)
            .map((part) => (typeof part.value === "string" ? part.value : ""))
            .join(" ");
          if (
            text.includes("groupIndex") &&
            text.includes("groupName") &&
            text.includes("summary")
          ) {
            const indices = [...text.matchAll(/<group index="(\d+)">/gu)].map(
              (match) => Number(match[1]),
            );
            const groups = [...new Set(indices)].map((index) => ({
              groupIndex: index,
              groupName: `probe_group_${index}`,
              summary: "Synthetic tool group",
            }));
            responseText = "```json\n" + JSON.stringify(groups) + "\n```";
          }
        }
        observed.push({
          sourceModel: model.id,
          roles: messages.map((message) => message.role),
          configuration: options.modelConfiguration,
          response: responseText,
        });
        progress.report(new vscode.LanguageModelTextPart(responseText));
      },
      provideTokenCount() {
        return 1;
      },
    }),
  );
  if (process.env.SCHEDULER_NATIVE_AGENT_PROBE !== "true")
    context.subscriptions.push(
      vscode.chat.createChatParticipant(
        "local-test.scheduler-execution.assistant",
        async (request, _history, stream, token) => {
          selectedModels.push(request.model.id);
          let text = "";
          let ok = false;
          try {
            const relay = vscode.extensions.getExtension(
              process.env.SCHEDULER_RELAY_ID || "local-test.configured-relay",
            ).exports;
            const response = await relay.request(
              request.model,
              request.prompt,
              token,
            );
            for await (const fragment of response.text) {
              text += fragment;
              stream.markdown(fragment);
            }
            ok = true;
          } finally {
            completion.fire({
              modelId: request.model.id,
              ok,
              exactResponse: text.trim() === "SCHEDULER_LIVE_OK",
            });
          }
        },
      ),
    );
  return {
    observed,
    selectedModels,
    setSyntheticReply: (value) => {
      syntheticReply = value;
    },
    refreshSyntheticModels: () => modelChanged.fire(),
    onDidComplete: completion.event,
    addDisposable: (disposable) => context.subscriptions.push(disposable),
    storageRoot: context.storageUri
      ? require("node:path").dirname(context.storageUri.fsPath)
      : undefined,
  };
}

async function tests() {
  function selectLiveModel(models) {
    const luna = models.filter((model) => /luna/iu.test(model.id));
    const candidates = luna.length ? luna : models;
    const generation = (model) => {
      const match = /gpt-(\d+)(?:\.(\d+))?/iu.exec(model.id);
      return match ? [Number(match[1]), Number(match[2] || 0)] : [0, 0];
    };
    return [...candidates].sort((left, right) => {
      const previous = generation(left);
      const next = generation(right);
      return next[0] - previous[0] || next[1] - previous[1];
    })[0];
  }
  async function verifyNativeAgents(relay, api, proof, save) {
    assert.ok(
      api.storageRoot,
      "The dedicated probe workspace must have storage",
    );
    const readRequests = () => {
      const directory = path.join(api.storageRoot, "chatSessions");
      if (!fs.existsSync(directory)) return [];
      const requests = [];
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(directory, name);
        if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
        let state;
        for (const line of fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/u)
          .filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.kind === 0) state = record.v;
          else if (state && Array.isArray(record.k)) {
            let target = state;
            for (const key of record.k.slice(0, -1)) target = target[key];
            const key = record.k.at(-1);
            if (record.kind === 1) target[key] = record.v;
            else if (record.kind === 2 && Array.isArray(target[key]))
              target[key].push(
                ...(Array.isArray(record.v) ? record.v : [record.v]),
              );
            else if (record.kind === 2 && typeof target[key] === "string")
              target[key] += record.v;
          }
        }
        requests.push(...(state?.requests || []));
      }
      return requests;
    };
    const candidateVendors =
      process.env.SCHEDULER_SYNTHETIC_NATIVE_PROBE === "true"
        ? ["scheduler-test-source"]
        : ["copilot", "openai-codex"];
    const vendors = candidateVendors.filter(
      (vendor) =>
        !process.env.SCHEDULER_NATIVE_PROBE_VENDOR ||
        process.env.SCHEDULER_NATIVE_PROBE_VENDOR === vendor,
    );
    const modes = [false, true].filter(
      (custom) =>
        !process.env.SCHEDULER_NATIVE_PROBE_MODE ||
        process.env.SCHEDULER_NATIVE_PROBE_MODE ===
          (custom ? "custom" : "agent"),
    );
    assert.ok(
      vendors.length && modes.length,
      "The native probe filter must identify an approved vendor and mode",
    );
    for (const vendor of vendors) {
      if (vendor === "scheduler-test-source") {
        await new Promise((resolve) => {
          let timer;
          const subscription = vscode.lm.onDidChangeChatModels(() => {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
          });
          timer = setTimeout(() => {
            subscription.dispose();
            resolve();
          }, 3000);
          api.refreshSyntheticModels();
        });
      }
      const model = selectLiveModel(await relay.catalog(vendor));
      assert.ok(model, `The ${vendor} catalog must be available`);
      const explicit = process.env.SCHEDULER_NATIVE_CONFIG_PROBE === "true";
      const configuration = {};
      if (explicit) {
        const key = process.env.SCHEDULER_MODEL_OPTION;
        const descriptor = model.configurationOptions?.find(
          (option) => option.key === key,
        );
        const choice = descriptor?.choices.find(
          (entry) =>
            String(entry.value) === process.env.SCHEDULER_MODEL_OPTION_VALUE,
        );
        if (!choice) {
          proof.liveCloud.push({
            vendor,
            modelId: model.id,
            status: "unsupported",
            reason: "Requested option is not advertised; no inference sent",
            option: key,
          });
          save();
          continue;
        }
        configuration[key] = choice.value;
      }
      for (const custom of modes) {
        const marker = `INHERITANCE_${process.env.SCHEDULER_TEST_RUN_ID.replace(/-/gu, "")}_${vendor.replace(/-/gu, "_")}_${custom ? "CUSTOM" : "AGENT"}`;
        const expected = custom ? `CUSTOM_AGENT_CONFIRMED_${marker}` : marker;
        relay.setProbeMarker(marker);
        if (vendor === "scheduler-test-source") api.setSyntheticReply(expected);
        const result = {
          vendor,
          modelId: model.id,
          agent: custom ? "SchedulerInheritanceProbe" : "agent",
          configuration,
          status: "pending",
          route: "Scheduler -> native Chat agent -> source provider",
          syntheticSource: vendor === "scheduler-test-source",
          systemProposalEnabled: explicit,
        };
        const bridge = vscode.extensions.getExtension(
          "grikomsn.openai-oauth-copilot-chat",
        );
        const traceBefore = bridge?.exports?.requestTrace?.().length || 0;
        proof.liveCloud.push(result);
        save();
        let watcher;
        let timer;
        const completed = new Promise((resolve) => {
          const scan = () => {
            try {
              const request = readRequests().find((entry) =>
                entry.message?.text?.includes(marker),
              );
              if (
                !request ||
                typeof request.elapsedMs !== "number" ||
                !Object.hasOwn(request, "result")
              )
                return;
              const text = (request.response || [])
                .map((part) =>
                  typeof part.value === "string" ? part.value : "",
                )
                .join("")
                .trim();
              if (!text && !request.result?.errorDetails) return;
              const modelPreserved = explicit
                ? String(request.modelId).startsWith(
                    "copilot-scheduler-configured/",
                  )
                : request.modelId === model.id ||
                  (String(request.modelId).startsWith(`${vendor}/`) &&
                    String(request.modelId).endsWith(`/${model.id}`));
              const modePreserved =
                request.modeInfo?.kind === "agent" &&
                request.modeInfo?.isBuiltin === !custom;
              const nativeParticipant = !String(
                request.agent?.id || "",
              ).includes("executionprobe");
              const noToolCalls = !(request.response || []).some((part) =>
                /toolInvocation/iu.test(String(part.kind || "")),
              );
              resolve({
                exactResponse: text === expected,
                modelPreserved,
                modePreserved,
                nativeParticipant,
                noToolCalls,
                errorDetailsPresent: !!request.result?.errorDetails,
              });
            } catch {}
          };
          watcher = fs.watch(api.storageRoot, { recursive: true }, scan);
          timer = setTimeout(() => resolve({ timeout: true }), 90000);
        });
        try {
          const dispatched = relay.execute(
            custom
              ? `Return the verification marker ${marker}. Do not use tools.`
              : `Reply with exactly ${marker} and nothing else. Do not use tools.`,
            {
              agent: custom ? "@SchedulerInheritanceProbe" : "agent",
              model: model.id,
              modelVendor: vendor,
              modelConfiguration: configuration,
              chatSession: "new",
            },
          );
          const outcome = await Promise.race([
            completed,
            dispatched.then(() => completed),
          ]);
          result.outcome = outcome;
          result.status =
            outcome.exactResponse &&
            outcome.modelPreserved &&
            outcome.modePreserved &&
            outcome.nativeParticipant &&
            outcome.noToolCalls &&
            !outcome.errorDetailsPresent
              ? "passed"
              : "blocked";
          if (vendor === "openai-codex" && bridge?.exports?.requestTrace) {
            result.providerRequestTrace = bridge.exports
              .requestTrace()
              .slice(traceBefore);
            if (result.providerRequestTrace.length > 0 && explicit) {
              for (const trace of result.providerRequestTrace) {
                if (configuration.reasoningEffort !== undefined)
                  assert.equal(trace.effort, configuration.reasoningEffort);
                if (configuration.speedMode !== undefined)
                  assert.equal(trace.speed, configuration.speedMode);
              }
              result.providerRequestLogEntries =
                result.providerRequestTrace.length;
              result.effectiveOptionValues = "observed in provider request log";
            }
          }
        } catch {
          result.status = "blocked";
          result.reason = "Native agent dispatch failed; no retry";
          result.diagnostics = relay.diagnostics();
        } finally {
          watcher?.close();
          clearTimeout(timer);
          save();
        }
        if (result.status !== "passed") return;
      }
    }
    assert.equal(
      api.selectedModels.length,
      0,
      "The probe participant must not handle native requests",
    );
  }
  const vscode = require("vscode");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  if (process.env.SCHEDULER_PERMISSION_PROBE === "true") {
    const relay = await vscode.extensions
      .getExtension("local-test.configured-relay")
      .activate();
    const sourceExtension = await vscode.extensions
      .getExtension("local-test.scheduler-execution")
      .activate();
    const [source] = await vscode.lm.selectChatModels({
      vendor: "scheduler-test-source",
      id: "synthetic",
    });
    assert.ok(source);
    const before = sourceExtension.observed.length;
    const permission = await relay.systemPermission(source);
    const allowed = process.env.SCHEDULER_PERMISSION_EXPECTED === "allowed";
    assert.equal(
      permission,
      allowed ? "allowed" : "requires_languageModelSystem",
    );
    assert.equal(sourceExtension.observed.length - before, allowed ? 1 : 0);
    fs.writeFileSync(
      process.env.SCHEDULER_TEST_PROOF,
      JSON.stringify(
        {
          runId: process.env.SCHEDULER_TEST_RUN_ID,
          vscodeVersion: vscode.version,
          permissionProbe: true,
          proposalDeclared: process.env.SCHEDULER_PROPOSAL_DECLARED === "true",
          effectiveSystemDeclaration: relay.effectiveSystemDeclaration(),
          productSystemForwarding: relay.productSystemForwarding(),
          permission,
          syntheticSourceCalls: sourceExtension.observed.length - before,
          realNetworkInference: false,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (process.env.SCHEDULER_REGISTRATION_ONLY === "true") {
    fs.writeFileSync(
      process.env.SCHEDULER_TEST_PROOF,
      JSON.stringify(
        {
          runId: process.env.SCHEDULER_TEST_RUN_ID,
          vscodeVersion: vscode.version,
          registrationOnly: true,
          authenticationSnapshotUsed: false,
          providerRegistry: vscode.extensions.all
            .filter((extension) => /copilot|openai-oauth/iu.test(extension.id))
            .map((extension) => ({
              id: extension.id,
              version: extension.packageJSON.version,
            })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const relay = await vscode.extensions
    .getExtension(
      process.env.SCHEDULER_RELAY_ID || "local-test.configured-relay",
    )
    .activate();
  const api = await vscode.extensions
    .getExtension("local-test.scheduler-execution")
    .activate();
  const configFile = path.join(
    process.env.SCHEDULER_TEST_DATA,
    "User/chatLanguageModels.json",
  );
  const original = fs.readFileSync(configFile, "utf8");
  const results = [];
  const existingProfile = process.env.SCHEDULER_EXISTING_PROFILE === "true";
  let nativePermission;
  const preflight = [];
  if (!existingProfile) {
    for (const scenario of [
      { configuration: { mode: "normal:low", contextSize: "auto" } },
      { configuration: { mode: "fast:high", contextSize: 4096 } },
      { configuration: { mode: "normal:low", contextSize: "auto" } },
      { configuration: { reasoningEffort: "high" }, legacyEffort: "high" },
    ]) {
      const configuration = scenario.configuration;
      const before = api.observed.length;
      await relay.execute("@executionprobe Reply DYNAMIC_EXECUTION_OK", {
        model: "synthetic",
        modelVendor: "scheduler-test-source",
        agent: "ask",
        chatSession: "new",
        ...(scenario.legacyEffort
          ? { modelReasoningEffort: scenario.legacyEffort }
          : { modelConfiguration: configuration }),
      });
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
    const messages = [
      new vscode.LanguageModelChatMessage(3, "Synthetic system instruction"),
      vscode.LanguageModelChatMessage.User("Synthetic user request"),
      vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelToolCallPart("probe-call", "inspect", {}),
      ]),
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart("probe-call", [
          new vscode.LanguageModelTextPart("Synthetic tool result"),
        ]),
      ]),
    ];
    const [source] = await vscode.lm.selectChatModels({
      vendor: "scheduler-test-source",
      id: "synthetic",
    });
    assert.ok(source);
    const directBefore = api.observed.length;
    const direct = await source.sendRequest(messages, {});
    for await (const part of direct.stream) assert.ok(part);
    assert.equal(api.observed.length, directBefore + 1);
    assert.deepEqual(api.observed.at(-1).roles, [3, 1, 2, 1]);
    nativePermission = await relay.systemPermission(source);
    assert.equal(nativePermission, "requires_languageModelSystem");
    assert.equal(api.observed.length, directBefore + 1);
    const configured = await relay.resolve(
      {
        id: source.id,
        vendor: source.vendor,
        name: source.name,
        family: source.family,
        version: source.version,
        description: "",
        maxInputTokens: source.maxInputTokens,
        configurationStatus: "available",
        configurationOptions: [
          {
            key: "reasoningEffort",
            label: "Reasoning",
            choices: [{ value: "high", label: "High" }],
          },
        ],
      },
      { reasoningEffort: "high" },
    );
    const [configuredModel] = await vscode.lm.selectChatModels({
      vendor: configured.vendor,
      id: configured.id,
    });
    assert.ok(configuredModel);
    const relayBefore = api.observed.length;
    await assert.rejects(
      async () => {
        const response = await configuredModel.sendRequest(messages, {});
        for await (const part of response.stream) assert.ok(part);
      },
      (error) => error.code === "Blocked",
    );
    assert.equal(api.observed.length, relayBefore);
    const compatible = await configuredModel.sendRequest(messages.slice(1), {});
    for await (const part of compatible.stream) assert.ok(part);
    assert.equal(api.observed.length, relayBefore + 1);
    assert.deepEqual(api.observed.at(-1).roles, [1, 2, 1]);
    assert.equal(api.observed.at(-1).configuration.reasoningEffort, "high");
    for (const agent of [
      undefined,
      "ask",
      "agent",
      "edit",
      "@custom-agent",
      "@workspace",
    ]) {
      const before = api.observed.length;
      await assert.rejects(
        () =>
          relay.execute("Synthetic request", {
            model: source.id,
            modelVendor: source.vendor,
            agent,
            chatSession: "new",
            modelConfiguration: { reasoningEffort: "high" },
          }),
        (error) =>
          error.copilotSchedulerPromptBlocked ===
          "modelConfigurationUnavailable",
      );
      assert.equal(api.observed.length, before);
      preflight.push({
        agent: agent ?? "default",
        sourceCalls: 0,
        status: "blocked",
      });
    }
    assert.equal(fs.readFileSync(configFile, "utf8"), original);
  }
  const proof = existingProfile
    ? {
        runId: process.env.SCHEDULER_TEST_RUN_ID,
        vscodeVersion: vscode.version,
        existingProfile: true,
        realNetworkInference: false,
        sharedSettingsUnchanged: true,
        route: "Dedicated test window using existing profile authentication",
      }
    : {
        runId: process.env.SCHEDULER_TEST_RUN_ID,
        vscodeVersion: vscode.version,
        route:
          "CopilotExecutor -> actual Chat -> production configured relay -> synthetic source",
        realNetworkInference: false,
        sharedSettingsUnchanged: true,
        bindingReuseVerified: true,
        relayExtensionHasProposals: false,
        nativeSystemForwarding: nativePermission,
        systemForwarding: {
          directSourceCalls: 1,
          relayedSourceCalls: 0,
          errorCode: "Blocked",
          guardedBeforeSource: true,
          roles: [3, 1, 2, 1],
        },
        compatibleToolMessageRoles: api.observed.at(-1).roles,
        preflight,
        selectedModels: api.selectedModels,
        results,
      };
  if (process.env.SCHEDULER_LIVE_CLOUD === "true") {
    proof.liveCloud = [];
    proof.liveProviderActivation = [];
    proof.providerRegistry = vscode.extensions.all
      .filter((extension) => /copilot|openai-oauth/iu.test(extension.id))
      .map((extension) => ({
        id: extension.id,
        version: extension.packageJSON.version,
        requiredVSCode: extension.packageJSON.engines?.vscode,
      }));
    const save = () =>
      fs.writeFileSync(
        process.env.SCHEDULER_TEST_PROOF,
        JSON.stringify(proof, null, 2) + "\n",
      );
    if (relay.onFlowChanged)
      api.addDisposable(
        relay.onFlowChanged(() => {
          proof.flowSummary = relay.flowSummary();
          save();
        }),
      );
    for (const id of [
      "github.copilot-chat",
      "grikomsn.openai-oauth-copilot-chat",
    ]) {
      const extension = vscode.extensions.all.find(
        (entry) => entry.id.toLowerCase() === id,
      );
      const state = {
        id,
        installed: !!extension,
        version: extension?.packageJSON.version,
        activated: false,
      };
      proof.liveProviderActivation.push(state);
      if (extension) {
        try {
          await extension.activate();
          state.activated = extension.isActive;
        } catch {
          state.blocked = "Extension activation failed";
        }
      }
      save();
    }
    proof.authenticationPresence = {};
    try {
      proof.authenticationPresence.github =
        !!(await vscode.authentication.getSession(
          "github",
          ["read:user", "user:email", "repo", "workflow"],
          { silent: true },
        ));
    } catch {
      proof.authenticationPresence.github = false;
    }
    const bridge = vscode.extensions.getExtension(
      "grikomsn.openai-oauth-copilot-chat",
    );
    proof.authenticationPresence.codex = bridge?.exports?.hasExistingSession
      ? await bridge.exports.hasExistingSession()
      : null;
    save();
    if (process.env.SCHEDULER_NATIVE_CONFIG_PROBE === "true") {
      const [synthetic] = await vscode.lm.selectChatModels({
        vendor: "scheduler-test-source",
        id: "synthetic",
      });
      assert.ok(synthetic);
      proof.runtimeSystemPermission = await relay.systemPermission(synthetic);
      save();
      assert.equal(
        proof.runtimeSystemPermission,
        "allowed",
        "Experimental System permission must be effective before any real-model request",
      );
    }
    if (process.env.SCHEDULER_NATIVE_AGENT_PROBE === "true") {
      await verifyNativeAgents(relay, api, proof, save);
    } else {
      cloudProviders: for (const vendor of ["copilot", "openai-codex"]) {
        const models = await relay.catalog(vendor);
        const model = selectLiveModel(models);
        if (!model) {
          proof.liveCloud.push({
            vendor,
            status: "blocked",
            reason: "No models exposed in isolated profile",
          });
          save();
          continue;
        }
        const reasoning = model.configurationOptions?.find(
          (entry) => entry.key === "reasoningEffort",
        );
        const choice =
          reasoning?.choices.find((entry) => entry.value === "low") ||
          reasoning?.choices[0];
        const configurations = [{}];
        if (choice) configurations.push({ reasoningEffort: choice.value });
        for (const configuration of configurations) {
          const traceBefore = bridge?.exports?.requestTrace?.().length || 0;
          const result = {
            vendor,
            modelId: model.id,
            providerVersion: vscode.extensions.getExtension(
              vendor === "copilot"
                ? "github.copilot-chat"
                : "grikomsn.openai-oauth-copilot-chat",
            )?.packageJSON.version,
            configuration,
            status: "pending",
            route:
              "Scheduler -> actual Chat -> controlled User-only participant -> source provider",
            effectiveOptionValues: "not independently observed",
          };
          proof.liveCloud.push(result);
          save();
          let subscription;
          let deadline;
          const completed = new Promise((resolve) => {
            subscription = api.onDidComplete(resolve);
          });
          const timedOut = new Promise((resolve) => {
            deadline = setTimeout(
              () => resolve({ ok: false, exactResponse: false, timeout: true }),
              90000,
            );
          });
          try {
            const outcome = await Promise.race([
              Promise.all([
                relay.execute(
                  "@executionprobe Reply with exactly SCHEDULER_LIVE_OK and nothing else. Do not use tools.",
                  {
                    model: model.id,
                    modelVendor: vendor,
                    modelConfiguration: configuration,
                    agent: "ask",
                    chatSession: "new",
                  },
                ),
                completed,
              ]).then(([, response]) => response),
              timedOut,
            ]);
            Object.assign(result, {
              status:
                outcome.ok && outcome.exactResponse ? "passed" : "blocked",
              outcome,
            });
            if (vendor === "openai-codex" && bridge?.exports?.requestTrace) {
              result.providerRequestTrace = bridge.exports
                .requestTrace()
                .slice(traceBefore);
              if (result.providerRequestTrace.length === 1)
                result.effectiveOptionValues =
                  "observed in provider request log";
            }
          } catch {
            result.status = "blocked";
            result.reason =
              "Provider or Chat request failed; no automatic retry";
          } finally {
            clearTimeout(deadline);
            subscription?.dispose();
            save();
          }
          if (result.outcome?.timeout) break cloudProviders;
          if (result.status !== "passed") break;
        }
      }
    }
    assert.equal(fs.readFileSync(configFile, "utf8"), original);
    proof.realNetworkInference = proof.liveCloud.some(
      (result) =>
        result.vendor !== "scheduler-test-source" &&
        (result.status === "passed" ||
          (result.providerRequestTrace?.length || 0) > 0),
    );
  }
  fs.writeFileSync(
    process.env.SCHEDULER_TEST_PROOF,
    JSON.stringify(proof, null, 2) + "\n",
  );
  if (!existingProfile)
    console.log(
      "Dynamic execution PASS: User-only options preserved; System forwarding rejected for unprivileged relay before source invocation; shared settings unchanged",
    );
  if (proof.liveCloud) {
    console.log(
      `Live provider results: ${proof.liveCloud.map((result) => `${result.vendor}=${result.status}`).join(", ")}`,
    );
  }
}

async function main() {
  const repo = path.resolve(__dirname, "..");
  let executable =
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
  const groups = [
    { name: "Synthetic", vendor: "scheduler-test-source", configuration: {} },
  ];
  const liveCloud = process.argv.includes("--live-cloud");
  const manualSession = process.argv.includes("--manual-session");
  const registrationOnly = process.argv.includes("--registration-only");
  const permissionProbe = process.argv.includes("--permission-probe");
  const proposalDeclared = process.argv.includes("--declare-system-api");
  const proposalEnabled = process.argv.includes("--enable-system-api");
  if (proposalEnabled && !proposalDeclared)
    throw new Error(
      "The permission probe requires a declared proposal before enabling it",
    );
  if (permissionProbe && liveCloud)
    throw new Error(
      "The permission probe cannot use cloud providers or credentials",
    );
  const existingProfile = process.argv.includes("--existing-profile");
  const nativeAgentProbe = process.argv.includes("--native-agent-probe");
  const nativeConfigProbe = process.argv.includes("--native-config-probe");
  if (nativeConfigProbe && (!nativeAgentProbe || !proposalEnabled))
    throw new Error(
      "The experimental native configuration probe requires native-agent mode and explicit System permission",
    );
  if (nativeAgentProbe && !existingProfile && !manualSession)
    throw new Error(
      "Native agent verification requires the approved dedicated existing-profile window",
    );
  if (existingProfile && (!liveCloud || registrationOnly)) {
    throw new Error(
      "Existing profile use requires --live-cloud and excludes registration-only mode",
    );
  }
  if (liveCloud && !process.argv.includes("--reuse-auth")) {
    throw new Error(
      "Live cloud verification requires explicit --reuse-auth authorization",
    );
  }
  if (liveCloud)
    groups.push({
      name: "Scheduler Codex Probe",
      vendor: "openai-codex",
      profile: "default",
    });
  if (manualSession) groups.shift();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "scheduler-fixed-request-"),
  );
  const runId = require("node:crypto").randomUUID();
  try {
    if (process.argv.includes("--isolate-installed-host")) {
      const host = path.join(root, "host");
      fs.cpSync(path.dirname(path.resolve(executable)), host, {
        recursive: true,
        dereference: true,
        filter: (source) => !path.basename(source).startsWith("unins"),
      });
      for (const appRoot of [
        host,
        ...fs
          .readdirSync(host, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(host, entry.name)),
      ]) {
        const productPath = path.join(appRoot, "resources/app/product.json");
        if (!fs.existsSync(productPath)) continue;
        const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
        product.win32VersionedUpdate = false;
        fs.writeFileSync(productPath, JSON.stringify(product));
      }
      executable = path.join(host, path.basename(executable));
    }
    const extension = path.join(root, "extension");
    const relayExtension = path.join(root, "relay");
    const data = existingProfile
      ? path.join(process.env.APPDATA || "", "Code")
      : path.join(root, "user-data");
    fs.mkdirSync(extension, { recursive: true });
    fs.mkdirSync(relayExtension, { recursive: true });
    fs.cpSync(path.join(repo, "out"), path.join(relayExtension, "out"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(repo, "node_modules"),
      path.join(relayExtension, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      path.join(relayExtension, "package.json"),
      JSON.stringify({
        name: liveCloud ? "copilot-scheduler" : "configured-relay",
        publisher: liveCloud ? "yamapan" : "local-test",
        version: "0.0.1",
        engines: { vscode: "^1.141.0" },
        main: "extension.cjs",
        activationEvents: ["onStartupFinished"],
        ...(proposalDeclared
          ? { enabledApiProposals: ["languageModelSystem"] }
          : {}),
        contributes: {
          languageModelChatProviders: [
            {
              vendor: "copilot-scheduler-configured",
              displayName: "Configured",
            },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(relayExtension, "extension.cjs"),
      `exports.activate=${activateRelay.toString()};`,
    );
    fs.mkdirSync(path.join(data, "User"), { recursive: true });
    if (liveCloud) {
      const { DatabaseSync } = require("node:sqlite");
      const normalData = path.join(process.env.APPDATA || "", "Code");
      const storage = path.join(data, "User/globalStorage");
      fs.mkdirSync(storage, { recursive: true });
      if (!registrationOnly && !existingProfile && !manualSession) {
        const database = new DatabaseSync(
          path.join(normalData, "User/globalStorage/state.vscdb"),
          { readOnly: true },
        );
        try {
          database.exec("PRAGMA busy_timeout = 5000");
          database
            .prepare("VACUUM INTO ?")
            .run(path.join(storage, "state.vscdb"));
        } finally {
          database.close();
        }
        for (const relative of ["Local State", "machineid"]) {
          if (fs.existsSync(path.join(normalData, relative)))
            fs.copyFileSync(
              path.join(normalData, relative),
              path.join(data, relative),
            );
        }
      }
      const installed = path.join(os.homedir(), ".vscode/extensions");
      const bridges = fs
        .readdirSync(installed)
        .filter((entry) =>
          entry.startsWith("grikomsn.openai-oauth-copilot-chat-"),
        );
      if (bridges.length !== 1)
        throw new Error(
          "Expected one installed Codex Bridge; refusing ambiguous extension selection",
        );
      fs.cpSync(
        path.join(installed, bridges[0]),
        path.join(root, "extensions", bridges[0]),
        { recursive: true },
      );
      const bridgeRoot = path.join(root, "extensions", bridges[0]);
      const bridgeManifestPath = path.join(bridgeRoot, "package.json");
      const bridgeManifest = JSON.parse(
        fs.readFileSync(bridgeManifestPath, "utf8"),
      );
      const originalMain = bridgeManifest.main;
      if (nativeConfigProbe) {
        const providerFile = path.join(bridgeRoot, "out/provider.js");
        const providerCode = fs.readFileSync(providerFile, "utf8");
        const debugGuard =
          'if (configuration().get("debugLogging", false)) {\n            this.output.appendLine(`[request]';
        if (providerCode.split(debugGuard).length - 1 !== 1)
          throw new Error("The copied provider debug guard is ambiguous");
        fs.writeFileSync(
          providerFile,
          providerCode.replace(
            debugGuard,
            "if (true) {\n            this.output.appendLine(`[request]",
          ),
        );
      }
      bridgeManifest.main = "./scheduler-probe.cjs";
      fs.writeFileSync(
        path.join(bridgeRoot, "scheduler-probe.cjs"),
        `const original=require(${JSON.stringify(originalMain)});const {OpenAIOAuth}=require('./out/auth/auth.js');const providers=require('./out/provider.js');const Base=providers.OpenAICodexProvider;const trace=[];providers.OpenAICodexProvider=class extends Base{constructor(...args){const output=args[1];args[1]=new Proxy(output,{get(target,key){if(key==='appendLine')return(line)=>{const match=String(line).match(/^\\[request\\] model=([A-Za-z0-9._:-]+) speed=(normal|fast) effort=(none|low|medium|high|xhigh|max)\\b/u);if(match)trace.push({model:match[1],speed:match[2],effort:match[3]});return target.appendLine(line);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});super(...args);}};exports.activate=async(context)=>{const result=await original.activate(context);const auth=new OpenAIOAuth(context.secrets);return {...result,hasExistingSession:()=>auth.hasSession('default'),requestTrace:()=>trace.map(entry=>({...entry}))};};`,
      );
      fs.writeFileSync(bridgeManifestPath, JSON.stringify(bridgeManifest));
      const copilot = process.env.SCHEDULER_COPILOT_EXTENSION;
      if (!copilot || !fs.existsSync(path.join(copilot, "package.json"))) {
        throw new Error(
          "Set SCHEDULER_COPILOT_EXTENSION to the installed Copilot Chat code directory",
        );
      }
      const manifest = JSON.parse(
        fs.readFileSync(path.join(copilot, "package.json"), "utf8"),
      );
      if (
        `${manifest.publisher}.${manifest.name}`.toLowerCase() !==
        "github.copilot-chat"
      ) {
        throw new Error("Refusing an unexpected Copilot extension identity");
      }
      fs.cpSync(copilot, path.join(root, "extensions", "github.copilot-chat"), {
        recursive: true,
      });
    }
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
        enabledApiProposals: [
          "chatParticipantPrivate",
          "defaultChatParticipant",
          "languageModelSystem",
        ],
        contributes: {
          languageModelChatProviders: [
            { vendor: "scheduler-test-source", displayName: "Synthetic" },
          ],
          chatParticipants: nativeAgentProbe
            ? []
            : [
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
    if (!existingProfile) {
      fs.writeFileSync(
        path.join(data, "User/settings.json"),
        JSON.stringify({
          "telemetry.telemetryLevel": "off",
          "security.workspace.trust.enabled": false,
        }),
      );
      fs.writeFileSync(
        path.join(data, "User/chatLanguageModels.json"),
        JSON.stringify(groups),
      );
    }
    if (manualSession) {
      await launchManualVerification(
        executable,
        root,
        relayExtension,
        data,
        output,
        runId,
      );
      return;
    }
    if (existingProfile) {
      await runDedicatedWindow(
        executable,
        root,
        extension,
        relayExtension,
        data,
        output,
        runId,
      );
    } else {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: [
          extension,
          relayExtension,
          ...(liveCloud
            ? [path.join(root, "extensions", "github.copilot-chat")]
            : []),
          ...(liveCloud
            ? [
                path.join(
                  root,
                  "extensions",
                  fs
                    .readdirSync(path.join(root, "extensions"))
                    .find((name) =>
                      name.startsWith("grikomsn.openai-oauth-copilot-chat-"),
                    ),
                ),
              ]
            : []),
        ],
        extensionTestsPath: path.join(extension, "tests.cjs"),
        extensionTestsEnv: {
          SCHEDULER_REPO: repo,
          SCHEDULER_TEST_DATA: data,
          SCHEDULER_TEST_PROOF: output,
          SCHEDULER_TEST_RUN_ID: runId,
          SCHEDULER_PERMISSION_PROBE: String(permissionProbe),
          SCHEDULER_PROPOSAL_DECLARED: String(proposalDeclared),
          SCHEDULER_PERMISSION_EXPECTED: proposalEnabled
            ? "allowed"
            : "requires_languageModelSystem",
          SCHEDULER_LIVE_CLOUD: String(liveCloud),
          SCHEDULER_REGISTRATION_ONLY: String(registrationOnly),
          SCHEDULER_EXISTING_PROFILE: String(existingProfile),
          SCHEDULER_RELAY_ID: liveCloud
            ? "yamapan.copilot-scheduler"
            : "local-test.configured-relay",
        },
        launchArgs: [
          ...(existingProfile
            ? ["--new-window", "--skip-add-to-recently-opened"]
            : []),
          ...(liveCloud ? ["--log", "trace"] : []),
          "--user-data-dir",
          data,
          "--extensions-dir",
          path.join(root, "extensions"),
          "--enable-proposed-api",
          "local-test.scheduler-execution",
          ...(proposalEnabled
            ? ["--enable-proposed-api=local-test.configured-relay"]
            : []),
          "--disable-updates",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-workspace-trust",
        ],
      });
    }
    if (
      !fs.existsSync(output) ||
      JSON.parse(fs.readFileSync(output, "utf8")).runId !== runId
    ) {
      throw new Error(
        "The current verification did not execute; refusing stale evidence",
      );
    }
  } finally {
    if (
      manualSession &&
      fs.existsSync(output) &&
      JSON.parse(fs.readFileSync(output, "utf8")).runId === runId &&
      JSON.parse(fs.readFileSync(output, "utf8")).launcherStarted
    ) {
      console.log(
        "Manual environment retained for user operation; cleanup after its window is closed.",
      );
    } else {
      if (liveCloud && fs.existsSync(output)) {
        const proof = JSON.parse(fs.readFileSync(output, "utf8"));
        if (proof.runId === runId) {
          const logRoot = path.join(root, "user-data", "logs");
          const lines = [];
          const visit = (directory) => {
            if (!fs.existsSync(directory)) return;
            for (const entry of fs.readdirSync(directory, {
              withFileTypes: true,
            })) {
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) visit(file);
              else if (entry.name.endsWith(".log")) {
                for (const line of fs
                  .readFileSync(file, "utf8")
                  .split(/\r?\n/u)) {
                  if (
                    /decrypt/iu.test(line) &&
                    /error|fail|unable|could not/iu.test(line)
                  ) {
                    lines.push("native_secret_decryption_failed");
                  } else if (
                    /secretstorage|secret storage|encryption/iu.test(line) &&
                    /error|fail|unavailable/iu.test(line)
                  ) {
                    lines.push("native_secret_storage_error");
                  } else if (
                    /Skipping extension.*copilot-chat.*in favour of.*(?:system|builtin) extension/iu.test(
                      line,
                    )
                  ) {
                    lines.push("copilot_user_copy_shadowed_by_builtin");
                  } else if (
                    /copilot-chat/iu.test(line) &&
                    /not compatible|invalid extension|unable to scan|cannot load/iu.test(
                      line,
                    )
                  ) {
                    lines.push("copilot_registration_validation_error");
                  }
                }
              }
            }
          };
          visit(logRoot);
          proof.registrationDiagnostics = [...new Set(lines)].slice(0, 20);
          fs.writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
        }
      }
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      if (fs.existsSync(root))
        throw new Error("Owned test environment was not removed");
      if (fs.existsSync(output)) {
        const proof = JSON.parse(fs.readFileSync(output, "utf8"));
        if (proof.runId === runId) {
          proof.ownedTemporaryEnvironmentRemoved = true;
          proof.authenticationSnapshotRemoved =
            liveCloud &&
            !registrationOnly &&
            !existingProfile &&
            !manualSession;
          fs.writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
        }
      }
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
