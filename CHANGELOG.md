# Changelog

All notable changes to the "Prompt Pilot" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-01

### Added

- Initial release of Prompt Pilot
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
