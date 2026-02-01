# Prompt Pilot

Schedule automatic AI prompts with cron expressions in VS Code.

## Features

🗓️ **Cron Scheduling** - Schedule prompts to run at specific times using cron expressions

🤖 **Agent & Model Selection** - Choose from built-in agents (@workspace, @terminal) and AI models (GPT-4o, Claude Sonnet 4)

🌐 **Multi-language Support** - English and Japanese UI with auto-detection

📊 **Sidebar TreeView** - Manage all your scheduled tasks from the sidebar

🖥️ **Webview GUI** - Easy-to-use graphical interface for creating and editing tasks

📁 **Prompt Templates** - Use local or global prompt template files

## Quick Start

1. Open the Prompt Pilot sidebar (click the clock icon in the Activity Bar)
2. Click the "+" button to create a new scheduled task
3. Enter a task name, prompt, and cron schedule
4. Your prompt will be automatically sent to Copilot at the scheduled time

## Cron Expression Examples

| Expression     | Description             |
| -------------- | ----------------------- |
| `0 9 * * 1-5`  | Weekdays at 9:00 AM     |
| `0 18 * * 1-5` | Weekdays at 6:00 PM     |
| `0 9 * * *`    | Every day at 9:00 AM    |
| `0 9 * * 1`    | Every Monday at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes        |
| `0 * * * *`    | Every hour              |

## Commands

| Command                                            | Description                |
| -------------------------------------------------- | -------------------------- |
| `Copilot Scheduler: Create Scheduled Prompt`       | Create a new task (CLI)    |
| `Copilot Scheduler: Create Scheduled Prompt (GUI)` | Create a new task (GUI)    |
| `Copilot Scheduler: List Scheduled Tasks`          | View all tasks             |
| `Copilot Scheduler: Edit Task`                     | Edit an existing task      |
| `Copilot Scheduler: Delete Task`                   | Delete a task              |
| `Copilot Scheduler: Toggle Task`                   | Enable/disable a task      |
| `Copilot Scheduler: Run Now`                       | Execute a task immediately |
| `Copilot Scheduler: Copy Prompt`                   | Copy prompt to clipboard   |

## Settings

| Setting                             | Default     | Description                          |
| ----------------------------------- | ----------- | ------------------------------------ |
| `copilotSchedule.enabled`           | `true`      | Enable/disable scheduled execution   |
| `copilotSchedule.showNotifications` | `true`      | Show notifications on task execution |
| `copilotSchedule.logLevel`          | `info`      | Log level (none/error/info/debug)    |
| `copilotSchedule.language`          | `auto`      | UI language (auto/en/ja)             |
| `copilotSchedule.timezone`          | `""`        | Timezone for scheduling              |
| `copilotSchedule.chatSession`       | `new`       | Chat session behavior (new/continue) |
| `copilotSchedule.defaultScope`      | `workspace` | Default scope (global/workspace)     |

## Prompt Placeholders

Use these placeholders in your prompts:

| Placeholder     | Description           |
| --------------- | --------------------- |
| `{{date}}`      | Current date          |
| `{{time}}`      | Current time          |
| `{{datetime}}`  | Current date and time |
| `{{workspace}}` | Workspace name        |
| `{{file}}`      | Current file name     |
| `{{filepath}}`  | Current file path     |

## Task Scope

- **Global**: Task runs in all workspaces
- **Workspace**: Task runs only in the specific workspace where it was created

## Prompt Templates

Store prompt templates for reuse:

- **Local**: `.github/prompts/*.md` in your workspace
- **Global**: `~/.github/prompts/*.md` or VS Code user prompts folder

## Requirements

- VS Code 1.80.0 or higher
- GitHub Copilot extension

## Known Issues

- Copilot Chat API is still evolving; some features may require updates as the API stabilizes
- Model selection may not work in all configurations

## Release Notes

### 0.1.0

Initial release:

- Cron-based task scheduling
- Agent and model selection
- English/Japanese localization
- Sidebar TreeView
- Webview GUI for task management
- Prompt template support

## License

CC-BY-NC-SA-4.0

---

**Enjoy scheduling your Copilot prompts!** 🚀
