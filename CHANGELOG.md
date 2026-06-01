# Changelog

All notable changes to the "Copilot Scheduler" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.50] - 2026-06-01

### Fixed

- **Edit-save stability**: Task edits now diff against the values captured when the edit session started, so changing Scheduler defaults while a task form is open no longer saves untouched fields such as jitter as explicit overrides.
- **Notification setting validation**: Invalid persisted `notificationMode` values are now normalized safely at runtime while preserving the legacy `showNotifications = false` fallback to `silentStatus`.

### Tests

- Added regression coverage for invalid `notificationMode` normalization and for unchanged edit submissions after Scheduler defaults change during an active edit session.

## [1.0.49] - 2026-05-17

### Added

- **Task-level chat session overrides**: Webview create/edit forms now let each task use the global chat-session setting, force a new chat session, or continue the existing session.

### Changed

- **Execution routing parity**: Scheduled, manual, and test execution paths now preserve the task chat-session choice alongside structured model metadata.
- **Test runner isolation**: Extension tests now launch with isolated temporary VS Code user-data and extensions directories so they can run while a normal VS Code window is open.

### Fixed

- **TreeView task details**: Task tooltips now show task-level chat-session overrides so sidebar details match the Webview task card.
- **Documentation drift**: README command tables and the local full specification were synchronized with the extension manifest, and regression tests now guard command/settings documentation drift.

### Tests

- Added coverage for chat-session persistence, reset-to-default behavior, executor precedence, Webview payloads, TreeView tooltip display, README command-table alignment, and optional full-spec alignment.

## [1.0.48] - 2026-05-15

### Added

- **Readable saved schedules**: TreeView and Webview task cards now show human-readable schedule summaries such as `Every 20 minutes`, `Every hour`, and `Weekdays at 09:00` while keeping the raw cron expression available in details.

### Changed

- **Schedule display parity**: Webview task updates now receive the same schedule summary produced by the extension-side cron formatter, reducing drift between the sidebar, task list, and create/edit preview.
- **Webview maintainability**: Friendly cron select-option generation is split into small helpers without changing the rendered UI.

### Security

- **Dependency audit cleanup**: Updated test tooling and npm overrides for `serialize-javascript` and `diff` so full `npm audit` reports zero vulnerabilities.

### Tests

- Added TreeView schedule-display coverage and Webview/extension cron-summary parity coverage.

## [1.0.47] - 2026-05-09

### Added

- **Exact friendly intervals**: The friendly cron builder now offers exact interval choices, including 40-minute, 90-minute, and multi-hour schedules, and can generate multiple cron lines when a single standard cron expression would be inaccurate.

### Changed

- **Friendly cron fields**: Hourly, daily, weekly, and monthly helper fields now use bounded select controls, with monthly day choices limited to days that exist every month by default.

## [1.0.46] - 2026-05-08

### Fixed

- **Claude Opus 4.7 internal model picker parity**: The Scheduler now keeps `Claude Opus 4.7` itself at default-only, preserves the explicit `High reasoning` / `Extra high reasoning` internal models as separate entries, and exposes `Low` / `Medium` / `High` / `Xhigh` thinking effort options on `Claude Opus 4.7 (1M context)(Internal only)` to better mirror the current Copilot Chat picker.
- **Internal model visibility**: `Internal only` Copilot models now remain visible in the default picker instead of being filtered out entirely.

### Tests

- Added regression coverage for Claude Opus 4.7 internal picker grouping and the 1M internal thinking-effort allowlist.

## [1.0.45] - 2026-05-04

### Improved

- **Allowed time window clarity**: The Scheduler form now uses an explicit `Limit execution to a time window` checkbox, so leaving the time window off clearly means the task can run all day.
- **Time window reset behavior**: Turning the time window off disables and clears the start/end time inputs before saving, while editing an existing task restores the checkbox when saved time limits are present.

### Tests

- Added webview contract coverage for the explicit allowed-time-window checkbox and its script wiring.

## [1.0.44] - 2026-04-20

### Fixed

- **Claude Opus 4.7 default-only thinking effort**: The Scheduler now keeps Claude Opus 4.7 on `Default` only, even when the runtime model catalog reports coarse metadata such as `family: claude-opus` and only the model id or display name carries the `4.7` version.
- **Reasoning effort cleanup**: Unsupported saved `modelReasoningEffort` values for Claude Opus 4.7 are now normalized away before UI restore and experimental config sync, so stale `Low` / `Medium` / `High` selections no longer leak back into execution.

### Tests

- Added regression coverage for Claude Opus 4.7 with both precise and coarse runtime metadata, and revalidated the full suite with 212 passing tests.

## [1.0.43] - 2026-04-19

### Fixed

- **Custom agent selection**: The Scheduler now resolves saved custom agent ids such as `@fact-checker` through the agent frontmatter `name:` value at execution time, so custom agents launch with the correct Copilot Chat mode instead of falling back to a generic agent.
- **Routing edge cases**: Prompt routing now avoids the latent `startsWith("")` branch bug when only a runtime agent override is available.

### Tests

- Added coverage for quoted agent frontmatter names, missing frontmatter names, saved-id to runtime-name rewriting, and runtime-override routing edge cases, and revalidated the suite with 208 passing tests.

## [1.0.42] - 2026-04-19

### Fixed

- **Agent routing parity**: The Scheduler now opens built-in and custom agents through `chat.open.mode` while keeping participant-style agents such as `@workspace`, `@terminal`, and `@vscode` on the legacy prompt-prefix path.
- **Local integration test stability**: The extension test runner now defaults to a configurable VS Code 1.115.0 target so `npm test` no longer collides with a running local VS Code 1.116.0 instance during Marketplace release validation.

### Tests

- Added routing coverage for built-in modes, custom agents, participant-style agents, and prompt-prefix stripping, and revalidated the full suite with 202 passing tests.

## [1.0.41] - 2026-04-15

### Fixed

- **Webview repaint recovery**: The Scheduler webview now triggers a lightweight layout refresh on model changes, variant changes, tab switches, resize, and initial render so the panel no longer stays black until the window is resized.

## [1.0.40] - 2026-04-10

### Improved

- **Thinking effort preview**: The Scheduler now keeps a Copilot Chat-like thought-depth picker available for supported families, including GPT-5 and Claude Opus/Sonnet preview fallbacks such as `Low` / `Medium` / `High` / `Xhigh` when runtime variants are not exposed directly.
- **Model picker wording**: The Scheduler UI now labels the selector as `Thinking Effort` / `思考の負荷` and uses shorter preview guidance with a `Default` fallback hint.

### Added

- **Model catalog diagnostics**: Added the `Copilot Scheduler: Dump Model Catalog Diagnostics` command to inspect raw `selectChatModels()` output and the normalized picker catalog when model availability differs from Copilot Chat.

### Tests

- Added coverage for max-input-token-distinct model entries, Copilot Chat diagnostic command registration, and preview thinking-effort family rules.

## [1.0.39] - 2026-04-10

### Fixed

- **Default model variant visibility**: The Quality / Variant selector now stays visible for models that currently expose only a single variant, so the Default choice no longer disappears from the Scheduler form.
- **Variant availability messaging**: The model help text now makes it explicit that additional Low/Medium/High-style variants appear only when the current VS Code API session exposes them for the selected model.

### Tests

- Extended the webview contract coverage for single-variant picker rendering and the new default-only status message.

## [1.0.38] - 2026-04-10

### Fixed

- **Model variant picker restore**: The Scheduler now keeps Low/Medium/High-style runtime variants available for Copilot-exposed model groups again, even when those variants only appear in the broader VS Code model catalog.

### Tests

- Added coverage for merging vendor-scoped and discovered model catalogs, and for keeping runtime quality variants visible in the grouped picker payload.

## [1.0.37] - 2026-04-10

### Improved

- **GitHub Actions Node 24 migration**: Updated the publish workflow to Node 24 compatible action versions and enabled `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`, removing the Node 20 deprecation warning from Marketplace release runs.

## [1.0.36] - 2026-04-10

### Fixed

- **Webview model-picker hotfix**: Removed the remaining `showAllModelsInput` references from the webview script so the create/edit form no longer throws `Uncaught ReferenceError` after the model-toggle UI was removed.

### Tests

- Added a contract check that the Webview script no longer contains stale `showAllModelsInput` references, and clarified that expanded-filter helper tests now cover internal filtering behavior only.

## [1.0.35] - 2026-04-10

### Fixed

- **Copilot-only model picker**: The Scheduler model picker now uses the GitHub Copilot model catalog only, instead of exposing a secondary toggle for additional discovered providers.
- **Quality-only variant selection**: The variant selector now focuses on runtime quality variants such as `Low`, `Medium`, `High`, `Extra High`, and date-style versions. Hidden/internal context-specific entries are no longer surfaced as confusing quality choices.
- **Saved model migration**: Startup model healing now reconciles previously saved hidden model selections against the same visible picker catalog, so existing schedules move toward currently selectable Copilot Chat models when a safe match exists.

### Tests

- Added coverage for hidden-model migration, Copilot-only picker filtering, and removal of the expanded model-toggle Webview path.

## [1.0.34] - 2026-04-10

### Improved

- **Chat-like default model picker**: The Scheduler model picker now defaults to a narrower list closer to the GitHub Copilot Chat model picker, reducing noisy provider duplicates such as extra `claude-code` entries in the default view.
- **Expanded model discovery toggle**: An in-form option now reveals additional discovered providers and model variants when you need to access entries outside the default Copilot Chat-like list.
- **Dynamic quality / variant selection**: Model selection is now split into base model plus runtime quality/variant options, so entries such as `High`, `Low`, `Extra High`, and context-specific variants can be selected when the current environment exposes them.
- **Saved model restore resilience**: Existing saved model selections continue to restore correctly across default/expanded picker modes, and hidden or no-longer-listed variants are still preserved as unavailable selections until explicitly changed.

### Tests

- Added coverage for default-vs-expanded model filtering, grouped variant picker payloads, grouped Webview model UI contracts, and dynamic variant restore behavior.

## [1.0.33] - 2026-04-10

### Fixed

- **Prompt template safety**: `.instructions.md` files are now excluded from prompt-template discovery and validation, preventing instruction files from being loaded as runnable templates.
- **Create-task disclaimer rollback**: Declining the risk disclaimer during task creation now removes or disables the just-created task consistently instead of leaving partial state behind.
- **Execution guardrails**: Corrupted daily execution counters are normalized safely, decimal daily limits are floored, and overlapping manual/automatic runs of the same task are now blocked.
- **Prompt resolution failures**: Empty prompt-template files now raise a localized error instead of silently falling back to stale stored prompt text.

### Improved

- **Webview defaults sync**: The Webview now refreshes default scope, auto mode, and jitter settings in place when configuration changes, without requiring a rebuild.
- **Prompt template refresh resilience**: Template refresh failures now preserve the previous cache and show a bounded inline error instead of clearing the picker state.
- **Template discovery labels**: Duplicate template names are disambiguated with context-aware display labels, and recursive discovery now uses URI-based traversal for workspace and global prompt roots.
- **Task management feedback**: Task quick-pick entries now include scope/workspace metadata, and manual-run or move failures refresh task state more consistently.

### Tests

- Expanded coverage for Webview defaults/template refresh flows, prompt-template discovery, execution history queue recovery, overlapping run protection, empty template resolution, and path-escape validation using directory link/junction based tests.

## [1.0.32] - 2026-04-09

### Fixed

- **Structured model execution metadata**: Prompt execution now preserves model name, vendor, family, and version fields when resolving scheduled tasks and Webview test runs, avoiding accidental loss of exact model-selection context.
- **Copilot CLI model restore safety**: Saved tasks that still reference Copilot CLI model ids now remain healable and executable because CLI-only entries are filtered from the Webview picker instead of being removed from the shared runtime model catalog.

### Improved

- **Model label derivation**: Model picker labels now recognize `Extra High` variants and version-style path segments such as `.../versions/2025-02-19`, improving disambiguation across provider catalogs.
- **Duplicate label disambiguation**: When two models still collapse to the same display label, the picker now appends the raw model id so each option remains uniquely selectable.
- **Picker-only model filtering**: Webview model selection now hides Copilot CLI-only entries without changing the runtime catalog used for startup healing and strict model matching.
- **Release operation guidance**: Repository-local instructions now require deciding before every push whether the task is a normal sync or a release-complete operation, and require matching version/changelog/tag steps when publication is expected.

## [1.0.30] - 2026-04-09

### Fixed

- **Model variant matching**: Variant identifiers such as `high`, `medium`, and `low` are now inferred from model display names as well as explicit version fields, improving exact-model selection across providers.
- **Unresolved saved models**: When a previously saved model is not in the current model list, the Webview now keeps that selection visible and preserves its metadata instead of silently dropping it on edit/save.

### Improved

- **Model picker labels**: Provider suffixes such as `Copilot` and `Copilotcli` are treated as label details rather than base-name duplicates, reducing visually confusing duplicates in the picker.
- **Model list refresh resilience**: Once a real model catalog has been loaded, temporary fallback refreshes no longer replace it with a default-only list during language changes or transient API unavailability.
- **Legacy model selection**: Legacy chat execution now tries disambiguated model labels before raw ids, improving model selection when `chat.open` cannot apply structured selectors.

## [1.0.29] - 2026-04-09

### Improved

- **Release workflow documentation**: Repository instructions now clarify that Marketplace publishing and GitHub Release creation are triggered by `vX.Y.Z` tag pushes, and that manual workflow dispatch alone does not create a GitHub Release.
- **Retrospective learnings**: Added reusable project learnings for strict release trigger handling and for distinguishing Marketplace publishing from GitHub Release creation in workflow operations.

## [1.0.28] - 2026-04-09

### Fixed

- **Strict model variant selection**: Explicit model variants such as `high` and `low` are now selected only when that exact variant is available. The scheduler no longer silently falls back to a different variant.
- **Model picker availability**: When the Language Model API cannot enumerate models, the Webview now shows only the default model option instead of static placeholder model entries that may not be selectable in the current environment.

### Improved

- **Model picker labels**: Duplicate model entries are collapsed, and same-name variants are rendered with disambiguated labels such as `GPT-4o (High)`.

## [1.0.27] - 2026-04-08

### Added

- **Marketplace release automation**: Added a GitHub Actions workflow that builds, tests, packages, and publishes the extension on `vX.Y.Z` tags or manual workflow dispatch.
- **Model selection metadata**: Task execution requests and persisted scheduled tasks now retain model name, vendor, family, and version fields to improve matching across environments.

### Improved

- **Global custom agent discovery**: Global custom agents can now be discovered from both the VS Code user prompts folder and `~/.copilot/agents`.
- **Webview task management UI**: The scheduler Webview now uses sectioned create/edit forms, task list summaries, clearer task cards, and more explicit action labels.
- **Model healing on startup**: Saved model selections are normalized and healed against the currently available model catalog to reduce stale model references.

## [1.0.24] - 2026-03-01

### Fixed

- **Disclaimer rollback safety**: Declining the risk disclaimer now immediately disables the task across all enable/create/edit paths (Webview toggle, Webview create/edit, CLI create, tree-view enable). Previously, declining left the task enabled, effectively bypassing the safety mechanism.

### Improved

- **Agent prefix normalization**: `CopilotExecutor` now auto-prefixes agents with `@` or `/` based on a known slash-command list, avoiding silent failures when the prefix is omitted.
- **Multi-root workspace awareness**: `CopilotExecutor` and `ScheduleManager` now prefer the workspace folder of the active editor when resolving workspace root, improving reliability in multi-root setups.
- **Template loading guard**: Webview submit button is disabled while a template is loading, preventing submission of stale or incomplete prompt text. Consecutive template switches resolve to the last selection only.
- **Recursive template discovery**: Prompt template picker now scans subdirectories under `.github/prompts/` and the global prompts folder, surfacing templates in nested folders.
- **Duplicate task preserves workspacePath**: `duplicateTask` now copies `workspacePath` for workspace-scoped tasks, preventing the duplicate from binding to a different workspace.

### Added

- Agent prefix normalization unit tests (`CopilotExecutor Agent Prefix Tests`).
- Template loading guard and error feedback unit tests (`SchedulerWebview`).
- RunNow detailed result / rollback / history tests (`ScheduleManager RunNow Tests`).

## [1.0.23] - 2026-03-01

### Added

- **Execution History Viewer**: New command `Copilot Scheduler: Show Execution History` displays recent task executions (name, trigger, status, timestamp) in a Quick Pick list. History limit is configurable via `copilotScheduler.executionHistoryLimit`.
- **Per-task execution limits**: New per-task fields `maxExecutionsPerDay` and `allowedTimeStart` / `allowedTimeEnd` (HH:mm) control automatic execution frequency and time window. Scheduler silently skips tasks outside their allowed window or over their daily limit.
- **Webview: time window validation**: Time-window inputs now validate hour (0–23) and minute (0–59) ranges client-side before submission, giving immediate feedback without round-trip errors.

### Improved

- **Run notification**: Success/failure notifications now include task name, result status, and confirmed next-run time (resolved from persisted state after execution rather than a pre-run estimate).
- **History persistence safety**: Execution history writes are serialized through a queue; individual save failures are logged and do not block subsequent saves or affect manual-run success/failure reporting.

## [1.0.22] - 2026-03-01

### Improved

- **Auto-keep guidance**: Clarified that AI-applied edit auto-keep is controlled by VS Code setting `chat.editing.autoAcceptDelay`, and documented the recommended initial value (`5`) in README/README_ja.

### Changed

- Updated `copilotScheduler.autoModeDefault` setting description to `markdownDescription` so the settings UI can link users directly to `#chat.editing.autoAcceptDelay#`.

## [1.0.21] - 2026-03-01

### Improved

- **Language setting description**: Added reload behavior note to `copilotScheduler.language` in settings UI, README, and README_ja so users know extension Webview/Tree updates instantly while settings descriptions may require a window reload.

## [1.0.20] - 2026-02-28

### Improved

- **Auto Mode hint detection**: Refined duplicate detection to avoid suppressing insertion on generic natural-language mentions, while still preventing duplicate instruction injection.
- **Test coverage**: Added a frontmatter-preserved scenario test to validate insertion right after the closing frontmatter fence.

### Changed

- Synced settings table order in README/README_ja with the actual VS Code settings display order.

## [1.0.19] - 2026-02-28

### Improved

- **Auto Mode Hint**: Strengthened autonomous-execution instruction and changed insertion position to the beginning of the prompt (after frontmatter, if present) instead of appending to the end.
- **Settings order**: Reorganized settings UI order by logical category (Basic → Schedule → Execution → Notification → Safety → Paths → Debug).

### Changed

- Updated i18n descriptions, package.nls, and README to reflect the new auto mode behavior.

## [1.0.15] - 2026-02-28

### Fixed

- **Webview error feedback robustness**: Hardened webview-side error rendering and fallback behavior so empty/invalid payloads reliably resolve to localized unknown text.
- **Error detail sanitization**: Expanded sanitizer handling across extension/webview boundaries to reduce path/detail leakage risks while keeping actionable messages.
- **Command registration/test alignment**: Updated command coverage checks to keep extension command registration and test expectations in sync.

### Tests

- Added shared sanitizer assertion helpers and expanded contract tests for scheduler webview error handling and sanitization parity.

## [1.0.13] - 2026-02-25

### Security

- **Error log sanitization**: Added `errorSanitizer` module to strip absolute filesystem paths from error messages before logging, preventing accidental exposure of local directory structures in logs.
- Applied path sanitization across `scheduleManager`, `extension`, `promptResolver`, `copilotExecutor`, and `schedulerWebview`.

### Tests

- Expanded unit tests for `extension`, `promptResolver`, `templateValidation`, and `schedulerWebview` modules.
- Added `schedulerWebview.test.ts` covering webview message handling and serialization edge cases.

## [1.0.12] - 2026-02-25

### Fixed

- **Template prompt execution**: When a template file is open in the editor, task execution now prefers in-memory document text (supports unsaved edits).
- **Webview validation**: For `promptSource=local/global`, saving is blocked when no template is selected, with a localized error.
- **Create task UX**: The TreeView "+" action now always starts in "create new task" mode.

## [1.0.10] - 2026-02-24

### Fixed

- **Minimum interval warning**: `checkMinimumInterval()` now falls back to local time when the configured timezone is invalid, so short-interval cron warnings still work.

### Tests

- Added unit tests covering the invalid-timezone fallback behavior.

## [1.0.11] - 2026-02-24

### Fixed

- **Template prompt refresh on execution**: Healed legacy tasks where `promptPath` existed but `promptSource` was missing/incorrect, so template edits are reflected when tasks execute.

### Tests

- Added regression tests for promptSource migration from `promptPath`.

## [1.0.9] - 2026-02-24

### Fixed

- **Command error handling**: Wrapped remaining command handlers with consistent try/catch to avoid unhandled failures.
- **Template safety**: Prevented `.agent.md` files from being treated/loaded as prompt templates.
- **Path normalization edge cases**: Preserved filesystem root handling during normalization (avoids collapsing `/` to empty) and tightened containment checks.

### Improved

- **Webview consistency**: Added case-insensitive path compare support on Windows and localized success-toast prefix.
- **Resilience**: Healed corrupted/invalid persisted Date fields to avoid JSON serialization breakage.
- **Tooltip robustness**: Avoided Markdown code fence breakage when user content contains ```.

## [1.0.8] - 2026-02-24

### Fixed

- **Config change duplicate recalculation**: Consolidated timezone / enabled recalculation to avoid duplicate `recalculateAllNextRuns()` when both change in a single event (U22/U24).
- **Agent ID normalization**: AGENTS.md agents now use `@`-prefixed IDs consistent with `.agent.md` agents (U32).
- **Log safety**: Prompt text is no longer logged; only prompt length is shown to prevent secret exposure.

### Improved

- **i18n consolidation**: Moved all hard-coded agent/model descriptions in `copilotExecutor.ts` to `i18n.ts` messages (agentNoneName, agentModeDesc, modelDefaultName, etc.).
- **Dead code removal**: Removed unused `fs` imports, redundant `openingSettings` / `agentNone` / `agentAgent` messages, and consolidated duplicate notification guards.
- **Webview lifecycle**: Added explicit `SchedulerWebview.dispose()` in `deactivate()` for clean shutdown; promptSyncInterval cleanup via disposable.
- **Task copy suffix**: Duplicate-task name suffix now uses i18n (`taskCopySuffix`).
- **Review learnings**: Updated `.github/review-learnings.md` with new entries.

## [1.0.7] - 2026-02-24

### Fixed

- **Prompt placeholder safety**: Template variables (`{{workspace}}`, `{{file}}`, `{{filepath}}`) now use function replacers to prevent `$&`/`$'`/`` $` `` patterns in workspace/file names from corrupting prompt text.
- **Last run accuracy**: `lastRun` is now recorded only on successful execution; previously it was set even on failure, misleading users into thinking the task ran normally.
- **Cross-platform NLS**: Settings descriptions for `globalPromptsPath` / `globalAgentsPath` now list default paths for Windows, macOS, and Linux (was Windows-only).

### Improved

- **Code review hardening**: Tooltip markdown escaping (P4), duplicate field copy (P5), test command coverage (P6), CSS class definitions (P7), cross-platform path resolution (P8) — all addressed per review learnings.
- **Review learnings**: Added U14 (replace special patterns) and U15 (failed operation timestamps) to `.github/review-learnings.md`.

## [1.0.6] - 2026-02-24

### Fixed

- **Webview localization**: Localized the initial HTML select placeholders (Agent/Model/Template) to avoid hard-coded English in Japanese UI.
- **Template load validation**: Normalized resolved paths during allowlist checks to avoid Windows case-sensitivity mismatches.
- **Timezone resilience**: Invalid `copilotScheduler.timezone` now falls back to local time instead of breaking cron validation/next-run calculation.

### Changed

- **Jitter setting**: `copilotScheduler.jitterSeconds` minimum is now 0 (0 = off), aligned across schema and docs.
- **Lint ergonomics**: Added a minimal ESLint config so `npm run lint` is runnable.

## [1.0.5] - 2026-02-24

### Fixed

- **Missed executions after reload**: Preserve persisted `nextRun` on startup; compute it only when missing/invalid so tasks don't appear to "not run" after a window reload.
- **Manual run rescheduling**: Manual "Run Now" updates both `lastRun` and `nextRun` so `*/N * * * *` tasks count from the manual execution time.

### Changed

- **First run delay option**: "Run first execution" now schedules the first run in 3 minutes (was 1 minute).

## [1.0.3] - 2026-02-24

### Improved

- **Dead code removal**: Removed ~400 lines of unused code — `cronBuilder.ts` (entire file), `TaskExecutionResult` / `ExtensionConfig` types, `getAgentDisplayInfo()`, and `logInfo()`.
- **Prompt resolution**: Consolidated `getGlobalPromptsRoot` logic into `promptResolver.ts`, eliminating duplication between `extension.ts` and `schedulerWebview.ts`.
- **Webview message safety**: All Webview `postMessage` calls now go through the ready-check queue wrapper.

## [1.0.4] - 2026-02-24

### Improved

- **Workspace task clarity**: Workspace-scoped tasks are grouped into "This workspace" / "Other workspaces" in the TreeView for easier scanning.
- **Safety**: Workspace-scoped tasks that belong to a different workspace can no longer be deleted from the current workspace (TreeView + Webview + command guard).

## [1.0.2] - 2026-02-23

### Added

- **Reload prompt after update**: A notification with a "Reload Now" button is shown when the extension version changes, guiding users to reload VS Code.

## [1.0.1] - 2026-02-23

### Fixed

- **VSIX contents**: Excluded dev-only `research/` artifacts from the packaged extension.

## [1.0.0] - 2026-02-23

### Improved

- **Webview performance & maintainability**: Moved the large webview script to `media/schedulerWebview.js`.
- **Webview security**: Tightened CSP and restricted `localResourceRoots` to extension `media/` and `images/` only.
- **Prompt resolution consistency**: Local prompts are now resolved consistently in multi-root workspaces, restricted to `.github/prompts/*.md`.
- **Task persistence robustness**: Centralized revision-based store selection and healing behavior.

### Added

- **Regression tests** for template load validation, prompt path resolution, and task-store selection.

## [0.9.13] - 2026-02-23

### Fixed

- **Edit navigation on Windows**: Replaced unsafe `querySelector('option[value="..."]')` with a safe option-iteration helper (`selectHasOptionValue`) so that editing tasks with Windows-style template paths no longer breaks tab switching or form population.
- **Type alignment**: Added `editTask`, `showError`, and `switchToList.successMessage` to `ExtensionToWebviewMessage` union to match the actual messages sent from the extension host.

## [0.9.12] - 2026-02-22

### Improved

- **Scope clarity (Tree/Webview)**: Workspace-scoped tasks now show their target workspace and whether they apply to the current workspace.
- **One-click move to current workspace**: Added a move action for workspace-scoped tasks (Webview + TreeView context menu + inline button).
- **Manual run safety**: Running a workspace-scoped task from a different workspace now prompts for confirmation to prevent accidental execution.

## [0.9.11] - 2026-02-22

### Improved

- **Scheduler performance**: Config is now read once per tick instead of 3× in the hot loop, eliminating variable shadowing and redundant I/O.
- **Timer resource leak**: `saveTasksToGlobalState` timeout timer is now cleared on success, preventing a 10 s resource leak per save.
- **Webview panel reveal**: Re-opening the scheduler panel no longer triggers a full background re-scan — cached data is sent instantly for snappier UX.
- **Prompt execution speed**: Hardcoded delays reduced from 600 ms to 300 ms total for faster prompt submission.
- **Dead code removal**: Unused `taskName` variable and orphan `setDefaultScope` message type removed.

### Fixed

- **Integration tests on Windows**: Tests no longer fail with "Code is currently being updated" by patching the downloaded VS Code's `product.json` to disable the Inno Setup mutex check.

## [0.9.10] - 2026-02-22

### Fixed

- **Webview save reliability (Windows paths)**: Avoid unescaped CSS selectors in option restoration and guard the message handler so errors no longer break subsequent UI updates.

## [0.9.9] - 2026-02-22

### Fixed

- **Scheduler stability**: Prevent overlapping scheduler ticks to avoid duplicate executions when a tick runs long.
- **Webview robustness**: Safely restore prompt template selection without CSS selector edge cases.
- **Webview localization**: Localize titles and placeholder strings instead of hard-coded English.
- **Multi-root workspace**: Workspace-scoped tasks now match against any open folder.
- **Extension host responsiveness**: Avoid blocking sync file I/O during agent discovery.
- **Diagnostics**: Improve error logging and show a webview error when message handling fails.

## [0.9.8] - 2026-02-22

### Fixed

- **Task persistence fallback**: Tasks are now persisted to a JSON file under the extension's `globalStorage` as a fallback, so saves still succeed even if `globalState` storage is blocked or stalls.
- **Save responsiveness**: When file persistence succeeds, the UI no longer waits on slow/blocked `globalState.update()` calls (globalState sync is done in the background).

## [0.9.7] - 2026-02-22

### Fixed

- **Edit form: agent/model/template preservation**: Editing a task no longer loses agent, model, or prompt template selections when dropdown options haven't loaded yet (pending-value mechanism).
- **Edit form: enabled state**: Editing a disabled task no longer re-enables it on save.
- **Edit form: workspacePath stability**: Editing a workspace-scoped task from a different workspace no longer overwrites the original `workspacePath`.
- **Manual run (Run Now)**: Now correctly persists `lastRun` and refreshes the tree/webview after execution, without applying jitter or daily limits.

### Added

- **Logger utility** (`src/logger.ts`): All `console.log`/`console.error` output is now gated by the `copilotScheduler.logLevel` setting (`none` / `error` / `info` / `debug`).
- **Settings hot-reload**: Changing `globalPromptsPath` or `globalAgentsPath` now refreshes the agent/model/template caches and updates the webview **without rebuilding the HTML** (preserving form state).
- **Scheduler enabled/disabled toggle**: Changing `copilotScheduler.enabled` now starts or stops the scheduler timer immediately, instead of only checking at each tick.

## [0.9.6] - 2026-02-22

### Fixed

- **Task creation reliability**: Webview task creation no longer resets the form before the extension confirms success; validation errors are shown inline.
- **Windows Server stability**: Webview no longer blocks on agent/model/template refresh; background refresh reduces UI hangs.
- **Jitter runtime error**: Fixed a potential ReferenceError during jitter delay.
- **Tooltip safety**: Prompt preview tooltip no longer uses trusted Markdown.
- **Storage hang safeguard**: Added a timeout when saving tasks to extension storage to avoid indefinite hangs.

## [0.9.5] - 2026-02-21

### Changed

- **Allow unlimited daily executions**: `maxDailyExecutions` now accepts 0 (unlimited) again, with a warning that excessive usage may risk API rate-limiting. Use at your own risk.
- **Default raised to 24**: `maxDailyExecutions` default changed from 12 to 24.
- **Hard cap raised to 100**: `maxDailyExecutions` range changed from 1–48 to 0–100 (0 = unlimited).
- **Unlimited warning**: A warning message is shown when setting `maxDailyExecutions` to 0.

## [0.9.4] - 2026-02-17

### Changed

- **Jitter max raised**: `jitterSeconds` maximum raised from 600 to 1800 (30 min), allowing users to add more randomization.

## [0.9.3] - 2026-02-17

### Changed

- **Remove unlimited bypass**: `maxDailyExecutions` no longer accepts 0 (unlimited). Enforced range: 1–48 (default: 12).
- **Hard cap raised**: `maxDailyExecutions` hard cap changed from 24 to 48 for flexibility.

## [0.9.2] - 2026-02-17

### Changed

- **Safety-first defaults**: `jitterSeconds` default changed from 0 to 600 (10 min max random delay enabled by default).
- **Jitter hard minimum**: `jitterSeconds` minimum raised from 0 to 60 seconds.
- **Daily execution limit tightened**: `maxDailyExecutions` default changed from 50 to 12, with a hard cap of 24/day.

## [0.9.1] - 2026-02-17

### Documentation

- Added primary source URLs to disclaimer sections (AUP §4, ToS §H, Copilot Additional Terms, Community Discussion #160013)

## [0.9.0] - 2026-02-17

### Added

- **Per-task jitter (random delay)**: Each task can set a max random delay (0–600s) before execution to reduce machine-like patterns. A global default is also available via `copilotScheduler.jitterSeconds`.
- **Daily execution limit**: Configurable cap on scheduled executions per day (default: 50, `copilotScheduler.maxDailyExecutions`). A one-time notification is shown when the limit is reached.
- **Minimum cron interval warning**: Warns when a cron expression runs more often than every 30 minutes. Can be toggled via `copilotScheduler.minimumIntervalWarning`.
- **Disclaimer notification**: A one-time informational message about GitHub ToS/AUP risks is shown when the first enabled task is created or activated.
- **Prompt template sync**: Tasks using local/global prompt templates now have their cached prompt text synced at startup and once daily, so UI displays stay up to date.

### Changed

- Daily execution counter now uses local date instead of UTC.
- README settings table fixed from `copilotSchedule.*` to correct `copilotScheduler.*` prefix.

### Documentation

- Added disclaimer about GitHub Acceptable Use Policies and automation risks to README (EN/JA).
- Documented new settings: `jitterSeconds`, `maxDailyExecutions`, `minimumIntervalWarning`.

## [0.1.0] - 2026-02-01

### Added

- Initial release of Copilot Scheduler
- Cron-based scheduling for Copilot prompts
- Support for built-in agents (@workspace, @terminal, @vscode, agent, ask, edit)
- Support for multiple AI models (GPT-4o, Claude Sonnet 4, etc.)
- English and Japanese localization with auto-detection
- Sidebar TreeView for task management
- Webview GUI for creating and editing tasks
- Task scoping (global vs workspace-specific)
- Prompt template support (local and global)
- Prompt placeholders ({{date}}, {{time}}, {{workspace}}, etc.)
- Commands:
  - Create task (CLI and GUI)
  - List tasks
  - Edit task
  - Delete task
  - Toggle task (enable/disable)
  - Run now
  - Copy prompt
  - Duplicate task
  - Open settings
  - Show version
- Configuration options:
  - Enable/disable scheduling
  - Notification settings
  - Log level
  - Language preference
  - Timezone settings
  - Chat session behavior
  - Default scope
  - Global prompts path

### Security

- Webview CSP with nonce for script protection
- Path traversal prevention for prompt templates
- No sensitive data stored in globalState
