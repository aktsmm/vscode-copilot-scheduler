# ⏰ Copilot Scheduler

[![Status](https://badgen.net/badge/Status/Stable/green)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![VS Marketplace](https://badgen.net/vs-marketplace/v/yamapan.copilot-scheduler)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![Installs](https://badgen.net/vs-marketplace/i/yamapan.copilot-scheduler)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![License](https://badgen.net/badge/License/CC%20BY-NC-SA%204.0/gray)](LICENSE)
[![GitHub](https://badgen.net/badge/GitHub/Source/black)](https://github.com/aktsmm/vscode-copilot-scheduler)
[![Stars](https://badgen.net/github/stars/aktsmm/vscode-copilot-scheduler)](https://github.com/aktsmm/vscode-copilot-scheduler)

Schedule recurring or one-time AI prompts in VS Code.

[**📥 Install from VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)

[Japanese / 日本語版はこちら](README_ja.md)

## 🎬 Demo

![Copilot Scheduler Demo](images/demo-static.png)

## ✨ Features

🗓️ **Cron and One-Time Scheduling** - Run recurring prompts with cron or dispatch a task once at a specified date and time

🤖 **Agent & Model Selection** - Choose from built-in agents (@workspace, @terminal) and AI models (GPT-4o, Claude Sonnet 4), including runtime quality or experimental quality variants when available

🌐 **Multi-language Support** - English and Japanese UI with auto-detection

📊 **Sidebar TreeView** - Manage all scheduled tasks with human-readable schedule summaries

🖥️ **Webview GUI** - Easy-to-use graphical interface for creating and editing tasks

🛠️ **Copilot Chat Tools** - Query, create, update, delete, enable/disable, and run scheduled tasks once from agent mode using Language Model Tools

📎 **Attachments** - Attach instructions, prompts, skills, or any workspace file to a task so they are sent with the prompt

In the task panel, Tab focuses the selected tab. Left/Right arrows switch tabs, Home/End select the first/last tab, and Tab moves into the selected panel. Enter/Space retain normal button activation.

## ⏰ Cron Expression Examples

| Expression     | Description             |
| -------------- | ----------------------- |
| `0 9 * * 1-5`  | Weekdays at 9:00 AM     |
| `0 18 * * 1-5` | Weekdays at 6:00 PM     |
| `0 9 * * *`    | Every day at 9:00 AM    |
| `0 9 * * 1`    | Every Monday at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes        |
| `0 * * * *`    | Every hour              |

The friendly cron builder applies your selected frequency, interval, time, weekday, or day-of-month to the cron expression as soon as you change the helper controls. The **Generate** button remains available as an explicit re-apply action, but you do not need to press it before saving.

For a single execution, select **Run once at** in the task form and choose a date and time. The task is disabled after dispatch by default; choose **Delete task (keep history)** to remove it after its history is saved. Missed one-time schedules follow the configured catch-up/skip policy. A completed disabled task must be assigned a new `runAt` before it can be enabled again.

The friendly cron builder only offers interval choices that can be represented exactly with standard cron. Intervals such as 40 or 90 minutes are generated as multiple cron lines instead of inaccurate expressions like `*/40 * * * *`. All generated lines belong to the same task, and the scheduler runs the task at the earliest matching next time across those lines.

Monthly friendly schedules default to days 1-28 so the task can run every month. Use a custom cron expression if you intentionally want a schedule such as the 31st that only runs in months where that day exists.

## 📋 Commands

| Command                                             | Description                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Copilot Scheduler: Create Scheduled Prompt`        | Create a new task (CLI)                                                                                           |
| `Copilot Scheduler: Create Scheduled Prompt (GUI)`  | Create a new task (GUI)                                                                                           |
| `Copilot Scheduler: List Scheduled Tasks`           | View all tasks                                                                                                    |
| `Copilot Scheduler: Edit Task`                      | Edit an existing task                                                                                             |
| `Copilot Scheduler: Delete Task`                    | Delete a task                                                                                                     |
| `Copilot Scheduler: Toggle Task (Enable/Disable)`   | Enable/disable a task                                                                                             |
| `Copilot Scheduler: Enable Task`                    | Enable a task                                                                                                     |
| `Copilot Scheduler: Disable Task`                   | Disable a task                                                                                                    |
| `Copilot Scheduler: Run Now`                        | Execute a task immediately                                                                                        |
| `Copilot Scheduler: Copy Prompt to Clipboard`       | Copy prompt to clipboard                                                                                          |
| `Copilot Scheduler: Duplicate Task`                 | Duplicate a task                                                                                                  |
| `Copilot Scheduler: Move Task to Current Workspace` | Move a workspace task here                                                                                        |
| `Copilot Scheduler: Open Settings`                  | Open extension settings                                                                                           |
| `Copilot Scheduler: Show Version`                   | Show extension version                                                                                            |
| `Copilot Scheduler: Show Execution History`         | View recent run history, including prompt source, path, hash, resolution time, and fallback reason when available |
| `Copilot Scheduler: Dump Model Catalog Diagnostics` | Dump model diagnostics                                                                                            |

Execution history shows scheduled time, delay, attachment count, prompt source, path, hash, resolution time, and fallback reason when available. A successful entry is labeled **Dispatched** because it confirms that the prompt was sent to Chat, not that the model finished producing a response.

## 🛠️ Copilot Chat Tools

In Copilot Chat agent mode, use the scheduler tools with `#` references:

| Tool                          | Description                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#scheduler_query`            | Read-only query. Use `kind=list`, `kind=get`, `kind=history`, `kind=preview_cron`, `kind=list_models`, or `kind=list_agents`.                      |
| `#scheduler_create_task`      | Create a scheduled task, including its model, agent, and execution controls.                                                                       |
| `#scheduler_update_task`      | Update task fields, including `model`, `agent`, `scope`, and the execution controls. Use `#scheduler_set_task_enabled` for enable/disable changes. |
| `#scheduler_delete_task`      | Delete a task after a strong confirmation that shows its name, scope, and workspace.                                                               |
| `#scheduler_set_task_enabled` | Enable or disable a task.                                                                                                                          |
| `#scheduler_run_task`         | Run a task immediately. Recurring tasks keep their enabled state; one-time tasks apply their after-run action.                                     |

For a one-time manual run, the tool reports `enabledStateChanged` and `taskDeleted` after dispatch. A completed one-time task returns `oneTimeCompleted` with instructions to set a new run time; no second dispatch is attempted.

For `kind=history`, the response includes `total`, returned `count`, `hasMore`, `statusSemantics`, and newest-first `entries`. `status: "success"` confirms prompt dispatch rather than model response completion. Legacy malformed timestamps are preserved or omitted without inventing audit times and are marked with `executedAtInvalid` / `nextRunAtInvalid` when applicable.

Create a one-time task by sending `runAt` as an ISO 8601 date-time with an explicit offset (for example, `2030-09-26T21:00:00+09:00`) instead of `cronExpression`, and optionally `afterRun: "disable" | "delete"`. Update accepts the same fields; to switch back to a recurring schedule, set `runAt: ""` and provide `cronExpression`. `kind=list` / `kind=get` return these settings, and `kind=history` retains the task name and `runAt` even after automatic deletion. The Webview time picker uses the machine's local timezone; tools can specify any explicit offset.

`kind=list` returns task metadata with a short `promptPreview` and `promptLength` instead of the prompt body, because a `local` or `global` task stores a snapshot of the whole prompt file. The write tools return the same shape in their success payloads. Use `kind=get` when the full prompt is needed; a preview must never be written back to a task.

`kind=list_models` returns the selectable model `id`s together with `supportedReasoningEfforts`, and `kind=list_agents` returns the selectable agent ids without exposing file paths. The model list is the same one the Copilot Scheduler view offers, so Chat can never pin a model you cannot see or change in the UI. Create/update accept `model` (plus optional `modelReasoningEffort`), `agent`, and the execution controls `autoMode`, `jitterSeconds`, `maxExecutionsPerDay`, `allowedTimeStart`, and `allowedTimeEnd`. A `model` id that is not in that list is rejected with the list of valid ids instead of silently falling back to the default model; passing an empty `model` clears the selection and returns the task to the default model. When the Language Model API is unavailable and only the built-in fallback catalog is known, the requested model is saved with a warning instead of being rejected.

`Auto` and internal utility model ids remain selectable but do not inherit reasoning-effort options from the model named in their metadata.

Models registered with VS Code Chat by additional providers, including Codex Bridge, BYOK and local LLM providers, are available alongside Copilot models. The model picker groups models by provider, then offers their quality variants separately. `kind=list_models` returns each model's `vendor`; create/update accept `modelVendor` to disambiguate identical model ids across providers. Exact ids are preferred over normalized aliases; ambiguous id, alias or name matches across providers require `modelVendor`. Saved provider identities are preserved during model resolution. A failed Copilot-only catalog lookup does not prevent discovery of other providers, and a failed full-catalog lookup retains successfully discovered Copilot models.

For an explicitly selected additional provider, an unavailable model or a rejected Chat dispatch blocks the run rather than retrying with the default model or another provider. Provider authentication, connectivity and support for the selected Chat/Agent mode are still required. A successful dispatch does not prove that the provider completed its response. Native Claude/Codex agent-harness scheduling is not part of this integration.

Codex Bridge 1.0.0 GPT 6 Luna (`openai-codex`, `<profile>::gpt-6-luna`) has experimental per-task `Default` / `Low` / `High` choices. The public API does not expose live reasoning capabilities, so this is a scoped compatibility rule, not automatic support for other models. Selections update Chat's shared per-model settings while preserving speed, context options and other profiles. `Default` clears the reasoning override and returns to Bridge's default or workspace fallback. A missing/ambiguous profile, unknown setting format or failed settings write blocks dispatch. Configure other models/providers through their own controls. On 2026-10-09, the candidate on isolated VS Code 1.141.0 verified real Low/High responses and Bridge request logs in Ask mode at normal speed. Live Default/Fast inference, other models and other environments remain unverified.

#### Dynamic Model Options (Experimental)

The task form and `scheduler_query kind=list_models` discover per-model enum values and labels from VS Code's internal `vscode://schemas/language-models` document. Recognized properties are `mode`, `reasoningEffort`, `speedMode`, and `contextSize`; numeric values remain numbers. Fast and context choices appear only when the selected model advertises them. Unsupported or unavailable schemas do not produce guessed options, and unavailable saved choices remain visible. This internal schema contract may change with VS Code updates.

New tasks use `modelConfiguration: {}` to inherit current shared Chat settings without changing them. Omission on update preserves the task's map; `{}` clears only task overrides. **Explicit dynamic options execute on VS Code 1.141 or later.** Scheduler creates an immutable task-configured model that forwards the existing Chat/Agent request to the original model with selected options fixed on that request. It does not rewrite shared model settings, copy credentials, or require a provider fork. Tools, streamed responses and cancellation are forwarded. The original model/provider remains persisted on the task. Missing models, changed/invalid options, failed authorization and rejected dispatch stop without default-model fallback or automatic resend. Native source-model access approval may be required on first use. Existing legacy `modelReasoningEffort` behavior remains available and cannot be combined with the new map.

Configuration maps survive ordinary edits, duplication and reload. Changing the model clears its dynamic overrides. Do not save these tasks in older Scheduler versions: unknown fields may be lost. Selected fields are fixed per request; unselected fields still inherit source-model settings. The schema URI and request-configuration adapter are internal VS Code compatibility contracts, verified on 1.141.0; older hosts reject explicit dynamic execution while retaining legacy/inherited behavior. The internal configured models are hidden from task selection. A real isolated Chat test through Scheduler verified Low/Auto and High Fast/numeric context on a synthetic provider without shared-setting changes; this is not a claim of network inference certification for every provider or proposed-only message type.

#### Additional Provider Verification

Scheduler verifies the returned model identity as well as the lookup selector. A different provider, model ID, or explicitly pinned version stops before source dispatch or token calculation. Unversioned source models remain usable after fresh schema validation; the internally registered configured model is matched against its own declared identity. Preparing request overrides does not mutate the caller's configuration or tool array.

Cancellation is rechecked after asynchronous source/schema preparation and response/token-count completion. A cancellation during preparation does not send or count tokens; a cancellation during an empty response stream or completed token calculation is not returned as success. Fixed-request bindings remain immutable; Scheduler does not retry a cancelled or failed configured request using different settings.

Reselecting the same model ID and provider preserves the task's dynamic options. Changing either identity component clears inherited task overrides unless new options are explicitly supplied and validated. An empty `model` clears the saved ID, name, provider, family, version and option map so old display metadata cannot resolve the cleared selection again.

Invalid stored option values are retained unchanged in the task editor rather than converted into empty overrides. The form disables those choices and offers an explicit **Use inherited model settings** repair action. A failed catalog refresh invalidates cached dynamic options while retaining model identities. Schema properties explicitly marked secret or password are not exposed as task choices.

Automated discovery/selection/dispatch tests use synthetic providers; they do not certify provider authentication, inference or host UI behavior. Verify a provider in an empty isolated VS Code profile with separate storage, without importing saved tasks:

1. Install the candidate Scheduler package and the provider, and complete authentication directly in the provider UI. Compare its picker entry with `scheduler_query` using `kind=list_models` (`id` and `vendor`).
2. Create one disposable **disabled workspace** task with that `model` and `modelVendor`, no attachments, and a harmless prompt such as `Reply exactly PROVIDER_SMOKE_OK`. Read it back and confirm the same provider.
3. Run only that task once. Verify the selected provider in Chat and its actual response separately from the tool's dispatch result; the task must remain disabled.
4. Make that provider unavailable in the isolated profile, then run the same task. Expect a blocked dispatch, not a switch to Copilot or another provider. Restore the provider and confirm the saved selection is retained after a catalog refresh.
5. Delete only the disposable task and owned isolated profile/storage. Do not test against real saved tasks or export credentials.

Create/update also accept `attachments`: up to 10 entries of `{ source: "local" | "global", path }`, where the path is relative to the task's workspace folder or to the global prompts folder. Absolute paths, `..`, NUL characters, denied files, and `local` attachments on a global task are rejected instead of being saved.

In agent mode, Copilot can also choose these tools from natural-language requests. Examples:

- "Schedule a workspace task every weekday at 9:00 to summarize this repository."
- "Change the daily summary task to run at 10:30."
- "Use Claude Sonnet for the daily summary task."
- "Pause the release reminder task until I turn it back on."
- "Run the disabled release reminder task once now without enabling it."
- "Show my scheduled Copilot tasks before changing anything."

If multiple tasks could match the same name across scopes, ask Copilot to show the scheduled tasks first so it can confirm the exact task before updating, disabling, or deleting it.

`scheduler_run_task` accepts only `{ "id": "..." }` and reuses **Run Now**, including prompt/attachment resolution and history. Disabled tasks stay disabled; enabled tasks advance `nextRun` according to `manualRunNextRunPolicy`. Like Run Now, it bypasses jitter, allowed time windows and daily limits. A workspace task must belong to the current workspace.

`ok: true` with `executionSemantics: "prompt_dispatched"` confirms dispatch, not model response completion. `saveFailed` also reports `prompt_dispatched` and `retrySafe: false`: only bookkeeping failed, so do not retry automatically. Unexpected failures report `executionSemantics: "unknown"` and `retrySafe: false`; check Chat and history first. Cancellation is checked before execution starts, not during dispatch, and cannot undo a sent prompt. Every invocation is a new manual request, not an idempotent operation; duplicate requests are rejected while dispatch and history recording are in progress in the current window.

Write tools are enabled by default and require a trusted workspace. Set `copilotScheduler.lmTools.enableWriteTools` to `false` to block create/update/delete/enable-disable/run operations. They remain visible, but only read-only tools can be used.

`copilotScheduler.lmTools.confirmationMode` controls only the extension-provided custom confirmation messages for write tools. VS Code or Copilot Chat may still show a generic approval dialog for extension tools, and users can use the built-in Always Allow flow when available.

Task snapshots and revision metadata are written through same-directory temporary files and atomically replaced. Empty/corrupt files and meta-less revision-zero `[]` snapshots do not override valid legacy global-state tasks, while revision-backed empty arrays remain valid deletes. Foreground saves and mirrors share one queue per destination. An atomic directory lock with heartbeat/stale recovery (via MIT-licensed `proper-lockfile`) plus a revision recheck prevents stale VS Code windows from overwriting newer tasks; stale windows reload the winning snapshot and ask the user to retry. Payload/mirror writes complete before metadata advances or the lock is released.

## ⚙️ Settings

| Setting                                       | Default           | Description                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilotScheduler.enabled`                    | `true`            | Enable/disable scheduled execution                                                                                                                                                                                                                             |
| `copilotScheduler.defaultScope`               | `workspace`       | Default scope                                                                                                                                                                                                                                                  |
| `copilotScheduler.language`                   | `auto`            | UI language (auto/en/ja). Applies to extension Webview/Tree UI; settings-description updates may require window reload.                                                                                                                                        |
| `copilotScheduler.timezone`                   | `""`              | Timezone for scheduling, the allowed time window and the daily run counters                                                                                                                                                                                    |
| `copilotScheduler.jitterSeconds`              | `600`             | Max random delay (seconds) before execution (0–1800, 0 = off). Each task can override it.                                                                                                                                                                      |
| `copilotScheduler.manualRunNextRunPolicy`     | `fromNow`         | Next-run calculation after `Run Now`: `fromNow` (next cron occurrence after the current time) / `advance` (advance past an existing future next run; otherwise use current time). Explicit selections are preserved.                                           |
| `copilotScheduler.missedRunPolicy`            | `runOnce`         | Tasks due before scheduler startup: `runOnce` runs each overdue task once; `skip` advances each task without running it. Available as a dropdown in VS Code Settings.                                                                                          |
| `copilotScheduler.maxConcurrentAutomaticRuns` | `1`               | Maximum concurrent automatic prompt dispatches in this window, including jitter (1–10). Does not wait for model response completion. `Run Now` is not limited.                                                                                                 |
| `copilotScheduler.chatSession`                | `new`             | Default chat session behavior (new/continue). Tasks can override this in the Webview form. `continue` is usually faster.                                                                                                                                       |
| `copilotScheduler.autoModeDefault`            | `false`           | Default value for new tasks' auto-mode hint (inserts an autonomous-execution instruction at the beginning of the runtime prompt).                                                                                                                              |
| `copilotScheduler.commandDelayFactor`         | `0.8`             | Delay multiplier for Copilot command sequencing (0.1–2.0). Lower is faster, but may be less stable in some environments.                                                                                                                                       |
| `copilotScheduler.showNotifications`          | `true`            | Show notifications when tasks are executed                                                                                                                                                                                                                     |
| `copilotScheduler.notificationMode`           | `sound`           | Notification mode (sound/silentToast/silentStatus)                                                                                                                                                                                                             |
| `copilotScheduler.maxDailyExecutions`         | `24`              | Daily execution limit across all tasks (0 = unlimited, 1–100). ⚠️ Unlimited may risk API rate-limiting.                                                                                                                                                        |
| `copilotScheduler.minimumIntervalWarning`     | `true`            | Warn when cron interval is shorter than 30 minutes                                                                                                                                                                                                             |
| `copilotScheduler.globalPromptsPath`          | `""`              | Custom global prompts folder path (default: VS Code's User/prompts folder — Windows: `%APPDATA%/Code/User/prompts`, macOS: `~/Library/Application Support/Code/User/prompts`, Linux: `$XDG_CONFIG_HOME/Code/User/prompts` or `~/.config/Code/User/prompts`)    |
| `copilotScheduler.globalAgentsPath`           | `""`              | Custom global agents folder path (`*.agent.md`) (default: auto-detect VS Code's User/prompts folder and `~/.copilot/agents`; setting this overrides the default discovery roots)                                                                               |
| `copilotScheduler.promptFileFallback`         | `"snapshot"`      | What to do when a local/global prompt file cannot be read at execution time: `snapshot` (run the saved snapshot), `blockWhenResolvable` (block when the path resolves but the file is unreadable), `blockAlways` (always block). Inline prompts are unaffected |
| `copilotScheduler.logLevel`                   | `info`            | Log level (none/error/info/debug)                                                                                                                                                                                                                              |
| `copilotScheduler.executionHistoryLimit`      | `50`              | Max number of execution history entries kept per task for the history view (10–500)                                                                                                                                                                            |
| `copilotScheduler.lmTools.enableWriteTools`   | `true`            | Allow Copilot Chat tools to create, update, delete, enable/disable and run scheduler tasks. When `false`, write tools remain visible but are blocked.                                                                                                          |
| `copilotScheduler.lmTools.confirmationMode`   | `destructiveOnly` | Controls extension-provided custom confirmation messages for write tools: `always`, `destructiveOnly`, or `minimal`. VS Code/Copilot generic approval may still appear.                                                                                        |

To automatically keep AI-applied edits after review delay, configure VS Code setting `chat.editing.autoAcceptDelay` (`0` = off, `1-100` = seconds, recommended: `5`).

Missed-run policy uses the exact scheduler start/restart time: only an earlier `nextRun` is missed. `skip` advances it without an execution history entry or a daily-count increment; it cannot restore skipped occurrences later. A sleep delay after startup is not a missed startup run. Settings apply on the next check; active dispatches are not cancelled. Waiting tasks are selected oldest-due-first on a later tick, subject to time windows and daily limits. A daily slot reserved by an unfinished dispatch remains unavailable until that dispatch succeeds or fails. The default concurrency is now 1 (previously unrestricted); model responses may still overlap and other VS Code windows have independent dispatch limits.

Task-level controls (`Chat Session`, `Max Runs/Day`, `Allowed Time Window`) are configured per task in the Webview create/edit form. `Max Runs/Day` and `Allowed Time Window` are evaluated on the same clock as the schedule: `copilotScheduler.timezone` when it is set, otherwise the machine's local time.

The Webview previews Copilot Chat-like thinking effort options for supported model families. If it fails, choose `Default`.

> Claude Opus/Sonnet are adaptive-thinking models. The extension writes the selected effort to the same per-model setting Copilot itself uses, but Copilot Chat governs Claude's effective thinking through adaptive thinking and may still apply `Medium`. GPT-5 family models honor the selected effort directly.

> The selected custom agent is passed through the `mode` field of VS Code's `workbench.action.chat.open`, and reasoning effort is applied by writing Copilot Chat's per-model settings — both are sent identically for every model. Whether a Claude model actually honors the custom agent and reasoning depth is decided by VS Code / Copilot Chat. If they do not seem to take effect, set `copilotScheduler.logLevel` to `debug` and open the "Copilot Scheduler" output channel: when the `Agent set:` and `Experimental model quality sync:` lines show the expected `mode` and `effective` values, the scheduler did its part and the gap is on the Copilot Chat side.

If execution feels sluggish when a task is triggered, try:

- `copilotScheduler.chatSession = continue`
- `copilotScheduler.commandDelayFactor = 0.6` (or `0.5`)
- `copilotScheduler.notificationMode = silentStatus`
- `copilotScheduler.logLevel = error` (or `none`)

## 📝 Prompt Placeholders

Use these placeholders in your prompts:

| Placeholder     | Description           |
| --------------- | --------------------- |
| `{{date}}`      | Current date          |
| `{{time}}`      | Current time          |
| `{{datetime}}`  | Current date and time |
| `{{workspace}}` | Workspace name        |
| `{{file}}`      | Current file name     |
| `{{filepath}}`  | Current file path     |

## 📂 Task Scope

- **Global**: Task runs in all workspaces
- **Workspace**: Task runs only in the specific workspace where it was created

## 📄 Prompt Templates

Store prompt templates for reuse:

- **Local**: `.github/prompts/*.md` in your workspace
- **Global**: VS Code user prompts folder (or the folder set in `copilotScheduler.globalPromptsPath`)
- The edit form shows the selected file and **Open prompt file** action while `Local`/`Global` is selected; the prompt body is hidden. Use that action to edit the source file. Switch the source to **Inline** to show and edit the text on the task itself. Changing the model or other task settings preserves the file reference.
- The panel preview reads saved disk content only. At execution time, an open editor buffer is preferred; otherwise the latest saved file is read.
- A task only becomes **Inline** when you select the Inline source. Selecting a template keeps the task following that file.
- Task creation/updates, template loading and prompt path resolution reject paths containing NUL characters, even when a path is cached or lexically inside an allowed root.

Global custom agents are auto-discovered from the VS Code user prompts/customization folder and `~/.copilot/agents` when `copilotScheduler.globalAgentsPath` is empty.

This follows current Copilot custom agent and Copilot CLI file locations, but this extension only discovers agent files. Prompt templates still use the VS Code user prompts folder or `copilotScheduler.globalPromptsPath`, not `~/.copilot/prompts`, and the extension does not manage Copilot CLI sessions.

Agent definitions are refreshed automatically when you create, edit, or delete workspace `*.agent.md` / `AGENTS.md` files (or the global agent files). You can also reload them on demand with the refresh button next to the agent picker.

Only user-invocable agents appear in the picker. Agents with `user-invocable: false` in their frontmatter are subagent-only — they cannot be selected as a chat mode, so they are intentionally hidden. Agents without the field stay listed.

## 📎 Attachments

A task can carry up to 10 attachment files that are sent with the prompt, so instructions, prompt files, skills, or any other workspace file can be attached explicitly instead of being mentioned inside the prompt text.

- **Add attachment** opens a quick pick with a **Recommended** group (`AGENTS.md`, `.github/copilot-instructions.md`, `.github/prompts/`, `.github/instructions/`, `.github/skills/`) followed by the rest of the workspace. **Browse...** opens the regular file dialog.
- Attachments are stored relative to the workspace folder (`local`) or to the global prompts folder (`global`), never as absolute paths.
- **Only workspace-scoped tasks can attach workspace files.** A global task runs in any window, where the same relative path could point at a different file, so workspace attachments are rejected for them.
- Files such as `.env*`, `*.pem`, `*.key`, `id_rsa*` and anything under `secrets/` or `.ssh/` are never attached.
- **If an attachment cannot be found when the task runs, the task is skipped instead of running without it.** The run is recorded as `blocked` in the execution history and reported once per attachment set, so a renamed file does not silently stop the schedule and changing the attachments makes the next failure visible again.
- **Trust boundary**: the checks above are a path boundary, not a content-provenance boundary. Anything that can write inside the workspace folder can also place or link a file there, and the file is read at run time, so it is the content at that moment that is sent. Attach files only from workspaces you trust, the same way you would trust a prompt file that runs unattended.

## 📋 Requirements

- VS Code 1.95.0 or higher for existing scheduling/legacy execution. Per-task dynamic model options require VS Code 1.141.0 or higher and source-model access authorization; older hosts retain legacy/inherited execution but reject explicit dynamic overrides.
- GitHub Copilot extension

## Development Tests

`npm test` compiles and runs the complete suite in an isolated VS Code profile. No Copilot sign-in is required. To select tests by their full suite/test title, pass a JavaScript regular expression with `--grep` (or `-g`). On Windows PowerShell, use `npm.cmd` to preserve option forwarding:

```powershell
npm.cmd test -- --grep "Test Runner Arguments"
```

For shell-sensitive expressions (for example, alternation with `|`), compile first and invoke Node directly:

```powershell
npm.cmd run pretest
node ./out/test/runTest.js --grep 'tabs|claim'
```

Patterns are preserved verbatim. Unknown arguments, empty/invalid patterns and zero matching tests fail the run. Without arguments the full suite runs even if a filter environment variable was inherited. A focused test pass is not a substitute for `npm test` before release.

## 🛠️ Release Automation

Maintainers can publish from GitHub Actions instead of running `vsce publish` locally.

- Push a tag in the form `vX.Y.Z` after updating `package.json` to the same version.
- GitHub Actions runs `npm ci`, `npm run compile`, `npm test`, packages a `.vsix`, publishes to VS Code Marketplace, and attaches the `.vsix` to the GitHub release.
- For a pre-release dry run, dispatch `Publish Extension` on the branch with `publish=false` (the default). Wait for all gates to pass before pushing the version tag. Runs are serialized across branches and tags. Explicit `publish=true` publishes to Marketplace only; a matching tag is required for the GitHub Release.
- Add the repository secret `VSCE_PAT` before using the workflow.

## ⚠️ Known Issues

- Copilot Chat API is still evolving; some features may require updates as the API stabilizes
- Model selection may not work in all configurations
- Experimental model quality relies on evolving VS Code/Copilot internals and may not work in all configurations

**Disclaimer:** This extension automates Copilot Chat. GitHub's [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) prohibit "excessive automated bulk activity", the [Terms of Service § H (API Terms)](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms) allow account suspension for excessive API usage, and the [GitHub Copilot Additional Product Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) apply these policies directly to Copilot. Use at your own risk; your account could be rate-limited or restricted. Configure jitter/daily limits/longer intervals to reduce risk, but there is no guarantee.

Note: There are [reports](https://github.com/orgs/community/discussions/160013) of Copilot access being restricted even without using automation tools. These mitigations reduce obvious automation patterns but cannot eliminate that risk.

🐛 [Report a bug](https://github.com/aktsmm/vscode-copilot-scheduler/issues)

## 📦 Release Notes

### 0.1.0

Initial release:

- Cron-based task scheduling
- Agent and model selection
- English/Japanese localization
- Sidebar TreeView
- Webview GUI for task management
- Prompt template support

## 📄 License

[CC-BY-NC-SA-4.0](LICENSE) © [aktsmm](https://github.com/aktsmm)

---

**Enjoy scheduling your Copilot prompts!** 🚀
