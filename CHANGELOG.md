# Changelog

All notable changes to the "Copilot Scheduler" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
