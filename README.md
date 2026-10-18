# ⏰ Copilot Scheduler

[![Channels](https://badgen.net/badge/Channels/Stable%20%2B%20Pre-release/blue)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![VS Marketplace](https://badgen.net/vs-marketplace/v/yamapan.copilot-scheduler)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![Installs](https://badgen.net/vs-marketplace/i/yamapan.copilot-scheduler)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![License](https://badgen.net/badge/License/CC%20BY-NC-SA%204.0/gray)](LICENSE)
[![GitHub](https://badgen.net/badge/GitHub/Source/black)](https://github.com/aktsmm/vscode-copilot-scheduler)
[![Stars](https://badgen.net/github/stars/aktsmm/vscode-copilot-scheduler)](https://github.com/aktsmm/vscode-copilot-scheduler)

Schedule recurring or one-time AI prompts in VS Code.

## Stable And Pre-release

Copilot Scheduler is published on two Marketplace channels with the same extension ID (`yamapan.copilot-scheduler`) and the same task storage.

| Channel     | What it offers                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stable      | Agent and model selection. Detailed model options and new legacy thinking-effort choices are not offered; saved task values are retained.                                      |
| Pre-release | Stable plus experimental detailed model options on supported hosts (VS Code 1.141 or later). Needs a one-time runtime-arguments setup and a full VS Code restart (see below). |

To switch channels, open this extension's details page in VS Code (the task form's channel button opens it) and choose **Switch to Pre-Release Version** or **Switch to Release Version**. Switching replaces the extension in that profile and both channels share the same saved tasks, so a separate test profile is recommended. From the command line, `code --install-extension yamapan.copilot-scheduler --pre-release --force` installs the Pre-release version and `code --install-extension yamapan.copilot-scheduler --force` returns to Stable. Saved detailed overrides are not cleared when you return to Stable; they stay read-only until you explicitly choose to inherit shared settings.

Stable mutation tools reject new explicit detailed overrides before model resolution or persistence. Echoing the same saved map with unchanged model binding is a no-op; changing its values or binding requires the Pre-release version. Unrelated edits preserve existing overrides; an explicit empty override map clears only task overrides and inherits shared settings. The Pre-release version still accepts detailed selections.

For detailed model options, the Pre-release version adds Scheduler to `enable-proposed-api` in `argv.json` at startup (setting `copilotScheduler.autoEnableProposedApi`, on by default). Then **fully quit and restart VS Code**; reloading the window is not enough. Installing the Pre-release version does not grant permission by itself, and provider-model consent is separate. Details are in Dynamic Model Options below.

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

Codex Bridge 1.0.0 GPT 6 Luna (`openai-codex`, `<profile>::gpt-6-luna`) has experimental per-task `Default` / `Low` / `High` choices. The public API does not expose live reasoning capabilities, so this is a scoped compatibility rule, not automatic support for other models. Unmigrated explicit legacy choices update Chat's shared per-model settings while preserving speed, context options and other profiles. `Default` removes the task's reasoning override and inherits current shared settings without clearing or resetting them. A missing/ambiguous profile, unknown setting format or failed settings write blocks dispatch. Configure other models/providers through their own controls. On 2026-10-09, the candidate on isolated VS Code 1.141.0 verified real Low/High responses and Bridge request logs in Ask mode at normal speed. Live Default/Fast inference, other models and other environments remain unverified.

#### Dynamic Model Options (Experimental)

The task form and `scheduler_query kind=list_models` discover per-model enum values and labels from VS Code's internal `vscode://schemas/language-models` document. Recognized properties are `mode`, `reasoningEffort`, `speedMode`, and `contextSize`; numeric values remain numbers. Fast and context choices appear only when the selected model advertises them. Unsupported or unavailable schemas do not produce guessed options, and unavailable saved choices remain visible. This internal schema contract may change with VS Code updates.

In the Pre-release version, detailed inputs require host support (VS Code 1.141 or later), effective System API permission and advertised options; task options appear directly without an enable checkbox, and each unset option inherits the current shared Chat setting. Without effective permission, detailed inputs are not editable and saved overrides remain read-only with explicit repair. Stable hides new detailed and legacy reasoning choices and retains saved overrides read-only. Legacy shared-setting compatibility is separate from native overrides; unsupported explicit values are never silently reset. A reasoning-preview notice appears only for available legacy choices.

On VS Code 1.141 or later, model-catalog healing, saves and execution migrate legacy selections when the schema confirms equivalence. An unset legacy effort becomes inherited settings. An explicit effort becomes the identical advertised `reasoningEffort` only with effective System API permission; without it, the saved legacy choice remains unchanged instead of becoming an unusable native override. Existing explicit maps remain unchanged. Compound `mode` values are not guessed from an effort alone, and unmatched legacy settings or older hosts retain the legacy path. Startup healing persists successful migrations through the normal task-store write path.

New tasks use `modelConfiguration: {}` to inherit current shared Chat settings without changing them. Omission on update preserves the task's map; `{}` clears only task overrides, not settings left by the user or the legacy shared-setting path. **VS Code 1.141 or later is necessary but not sufficient for explicit dynamic execution.** Agent system instructions require effective `languageModelSystem` API permission for Scheduler. The picker enables detailed editing only when the host supports dynamic execution and that permission is effective; saved overrides remain visible and are not cleared automatically. Without effective System permission, native Chat/Agent overrides stop before dispatch while model selection with inherited settings remains available.

The Stable manifest does not declare `languageModelSystem`; changing runtime arguments alone cannot enable detailed options in Stable. The Pre-release manifest declares it, but declaration and installation alone do not grant permission. The Pre-release version requires the runtime-arguments entry described below, a full VS Code restart and separate provider-model consent.

For models advertising detailed options, the task form explains missing prerequisites in a few lines. On a supported, declared but unenabled build, **Add Automatically** adds `yamapan.copilot-scheduler` to `enable-proposed-api` in `argv.json` after a confirmation (existing entries and comments are kept; the file is created if missing), **Open Runtime Arguments** opens VS Code's runtime-arguments editor without writing anything, and **Learn more** opens the `copilotScheduler.autoEnableProposedApi` setting. Pre-release builds do the same at startup unless that setting is off. Either way, fully quit and restart VS Code; reloading the window does not apply the change. Undeclared builds and unsupported hosts show their respective limitations instead of an activation button. Existing task overrides are retained.

The System-role proposal originated in [Language model access API #206265](https://github.com/microsoft/vscode/issues/206265), opened by Johannes Rieken (`jrieken`), and was split into its own proposal in [PR #212082](https://github.com/microsoft/vscode/pull/212082) on May 6, 2024. The stated reasons were API design and Responsible AI considerations; model-access consent is a separate mechanism.

If the selected model's option schema is unavailable or invalid, the reason remains visible even after API activation, but no guessed inputs are added. Activation instructions appear only when the API is not enabled. A valid schema confirming no options hides the unnecessary setup action. Enabling the API does not guarantee that a model advertises detailed options.

Before Marketplace publication, run `node scripts/verify-vsix-contents.js <candidate.vsix> --verify-marketplace`. For Stable, the release workflow checks the packaged manifest and rejects any proposed API declaration before publishing. Pre-release publication adds `--allow-proposed-apis languageModelSystem`, the only approved exception; it does not grant runtime permission. Local proposed-API candidates can still use `--verify-build`; that check alone does not establish Marketplace eligibility.

API permission and provider-model access approval are different. A first-use dialog asking whether Scheduler may access GitHub Copilot or another provider must be approved for the requested access. This model-access approval does not grant proposed API permission. Scheduler cannot grant itself VS Code API permission: a compatible build and legitimate host authorization are required, and a launch flag alone does not add an API declaration missing from the extension. Proposed API use also has [distribution restrictions](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).

VS Code or provider API changes can make detailed options unavailable even in an environment that previously worked. In that case only model selection and current-setting inheritance may be available. Explicit saved options are retained and blocked with an explanation instead of silently inherited, reset or sent using another model. Supported options remain fixed per request without rewriting shared settings.

Compatible Chat routes use immutable task-configured models with User/Assistant messages, tool calls/results, streamed responses and cancellation. System is forwarded unchanged only when effective API permission is present; unsupported roles are rejected before source lookup, request forwarding or token counting. No System instruction is removed or converted to User text. Runtime authorization does not certify every provider, option or native agent harness. Missing models, changed/invalid options, failed authorization and rejected dispatch stop without default-model fallback or automatic resend. Legacy selections that migrate into nonempty dynamic maps are subject to the same execution restrictions.

Configuration maps survive ordinary edits, duplication and reload. Changing the model clears its dynamic overrides. Do not save these tasks in older Scheduler versions: unknown fields may be lost. Selected fields are fixed per request; unselected fields still inherit source-model settings. The schema URI and request-configuration adapter are internal VS Code compatibility contracts; older hosts reject explicit dynamic execution while retaining legacy/inherited behavior. The internal configured models are hidden from task selection. An isolated VS Code 1.141.1 test with an unprivileged relay reproduced System-role rejection before source invocation, while User/Assistant/tool forwarding preserved fixed options without shared-setting changes. Schema discovery, saved settings, successful dispatch, completed responses and independently observed provider options are separate verification outcomes. This synthetic result does not certify real-provider inference or option effectiveness.

#### Model selection and session types

Observed on VS Code 1.142 (Windows):

- In a **Local** session, a specific model chosen for a task (for example Claude Haiku 5.5) was applied.
- In a **Copilot (Agent Host)** session, the model chosen for a task was ignored and the session ran on the organization default model. This was seen with a specific model and with Auto.
- **Auto** and **HydraFusion** have not been confirmed to work in either session type. HydraFusion is a routing tier of Auto in Agent Host sessions and is not listed as a separate model for extensions.

Scheduler reports a dispatch as sent, not as run on the chosen model. VS Code decides the session type for new chats; Scheduler does not change it.

#### Model fallback (opt-in)

Tick **Fall back to another model if the selected model is unavailable** on a task to let it run when its saved model is missing from the model list. The first model in `copilotScheduler.modelFallbackChain` (default: HydraFusion, then Auto) that is in the model list is used instead; HydraFusion is skipped unless the list includes it. It is off by default, so existing tasks still stop instead of running on a different model. Only a missing model triggers it: a rejected dispatch is never retried, an unreadable catalog never triggers it, and detailed model options and legacy thinking effort are not carried over. The substitution is shown in a notification and recorded in the execution history. Whether the replacement is applied depends on the session type (see above). `scheduler_create_task` / `scheduler_update_task` accept `modelFallback`.

#### Additional Provider Verification

Execution is strict for explicitly selected models and task options. Unset options inherit existing shared settings; unsupported explicit options stop with an explanation and remain saved. Scheduler does not automatically replace them with inherited settings. An explicit model is dispatched once with its selected identity. Rejected dispatch stops rather than removing legacy reasoning effort, retrying without the selector or using legacy text commands. No parameter-dropping fallback is provided.

Scheduler verifies the returned model identity as well as the lookup selector. A different provider, model ID, or explicitly pinned version stops before source dispatch or token calculation. Unversioned source models remain usable after fresh schema validation; the internally registered configured model is matched against its own declared identity. Preparing request overrides does not mutate the caller's configuration or tool array.

Cancellation and provider disposal stop pending source/schema preparation, request dispatch, stream waits and token counting. Late preparation cannot send a new request or report progress after disposal, and caller cancellation detaches promptly without cancelling another caller's shared token preparation. Provider replacement during model resolution is rejected rather than binding against a different provider generation. Fixed-request bindings remain immutable; Scheduler does not retry a cancelled or failed configured request using different settings.

Reselecting the same model ID and provider preserves the task's dynamic options. Changing either identity component clears inherited task overrides unless new options are explicitly supplied and validated. An empty `model` clears the saved ID, name, provider, family, version and option map so old display metadata cannot resolve the cleared selection again.

Invalid stored option values are retained unchanged in the task editor rather than converted into empty overrides. The form disables those choices and offers an explicit **Use inherited model settings** repair action. A failed catalog refresh invalidates cached dynamic options while retaining model identities. Schema properties explicitly marked secret or password are not exposed as task choices.

An empty catalog or unavailable saved model also removes stale editable choices and preview notices without deleting saved overrides. Restoring the model restores advertised choices and the saved typed value. Legacy variant changes resolve the selected effort before rendering instead of silently reverting to inheritance. Before option controls are rebuilt or hidden, keyboard focus returns to the model selector. The optional `python -B scripts/verify-model-options-browser.py` check requires a Python environment with Playwright and Microsoft Edge; it exercises production functions with a synthetic catalog at desktop and narrow viewport sizes, not the full VS Code host or screen-reader behavior.

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
| `copilotScheduler.sessionHarness`             | `auto`            | Which kind of chat session new runs start in (only when a run starts a new session). `auto` leaves it to VS Code; `local` (experimental) starts a Local session via `workbench.action.chat.newLocalChat` and does not send the task if that fails. Scheduler never changes VS Code settings and cannot force a Copilot (Agent Host) session. |
| `copilotScheduler.autoModeDefault`            | `false`           | Default value for new tasks' auto-mode hint (inserts an autonomous-execution instruction at the beginning of the runtime prompt).                                                                                                                              |
| `copilotScheduler.modelFallbackChain`         | `["hydrafusion","auto"]` | Fallback model order for tasks that opt in to model fallback; matched by id, name or family against the live catalog (max 5 entries, `[]` disables). |
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

### Installed VSIX Smoke Check

Verify package contents/build identity and the installed extension's permission-none tool contract without extension-development mode:

```powershell
node scripts/verify-vsix-contents.js artifacts/vsix/copilot-scheduler-allfix-lifecycle-candidate.vsix --verify-build --verify-installed --vscode-executable .vscode-test/vscode-win32-x64-archive-1.141.1/Code.exe
```

Use an existing compatible VS Code executable. The verifier installs the selected VSIX and a local probe VSIX into a fresh temporary profile, uses the archive's own identity/version, and invokes only the read-only `scheduler_query list_models` contract. No model inference or task operation is invoked by the probe. It launches without development/test/proposal flags, checks Production mode and the installed target location, verifies runtime System permission is absent, waits for its window and process to exit, and removes its owned temporary environment. Startup environment hooks are removed; space-containing paths are supported. On an incomplete shutdown, the owned root is retained for explicit cleanup rather than stopping normal/shared VS Code processes. This verifies the installed permission-none case, not provider sign-in, full UI/AT, permission-enabled native execution or Marketplace publication.

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
