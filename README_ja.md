# ⏰ Copilot Scheduler

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/yamapan.copilot-scheduler?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/yamapan.copilot-scheduler?label=Installs&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)
[![License CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/aktsmm/vscode-copilot-scheduler)
[![GitHub Stars](https://img.shields.io/github/stars/aktsmm/vscode-copilot-scheduler?style=social)](https://github.com/aktsmm/vscode-copilot-scheduler)

VS Code で Cron 式を使って AI プロンプトを自動スケジュール実行

[**📥 VS Code Marketplace からインストール**](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-scheduler)

[English / 英語版はこちら](README.md)

## 🎬 デモ

![Copilot Scheduler Demo](images/demo-static.png)

## ✨ 機能

🗓️ **Cron スケジューリング** - Cron 式で特定の時刻にプロンプトを実行

🤖 **Agent & モデル選択** - 組み込みAgent (@workspace, @terminal) と AI モデル (GPT-4o, Claude Sonnet 4) を選択可能

🌐 **多言語対応** - 英語・日本語 UI を自動検出

📊 **サイドバー TreeView** - サイドバーからすべてのタスクを管理

🖥️ **Webview GUI** - タスクの作成・編集用の使いやすい GUI

📁 **プロンプトテンプレート** - ローカルまたはグローバルのテンプレートファイルを使用

## 🚀 クイックスタート

1. Copilot Scheduler サイドバーを開く（アクティビティバーの時計アイコンをクリック）
2. 「+」ボタンをクリックして新規タスクを作成
3. タスク名、プロンプト、Cron スケジュールを入力
4. スケジュールされた時刻に自動で Copilot にプロンプトが送信されます

## ⏰ Cron 式の例

| 式             | 説明            |
| -------------- | --------------- |
| `0 9 * * 1-5`  | 平日 9:00       |
| `0 18 * * 1-5` | 平日 18:00      |
| `0 9 * * *`    | 毎日 9:00       |
| `0 9 * * 1`    | 毎週月曜日 9:00 |
| `*/30 * * * *` | 30 分ごと       |
| `0 * * * *`    | 1 時間ごと      |

## 📋 コマンド

| コマンド                                            | 説明                         |
| --------------------------------------------------- | ---------------------------- |
| `Copilot Scheduler: Create Scheduled Prompt`        | 新規タスク作成 (CLI)         |
| `Copilot Scheduler: Create Scheduled Prompt (GUI)`  | 新規タスク作成 (GUI)         |
| `Copilot Scheduler: List Scheduled Tasks`           | すべてのタスクを表示         |
| `Copilot Scheduler: Edit Task`                      | タスクを編集                 |
| `Copilot Scheduler: Delete Task`                    | タスクを削除                 |
| `Copilot Scheduler: Toggle Task (Enable/Disable)`   | タスクの有効/無効を切り替え  |
| `Copilot Scheduler: Run Now`                        | タスクを即座に実行           |
| `Copilot Scheduler: Copy Prompt to Clipboard`       | プロンプトをクリップボードに |
| `Copilot Scheduler: Enable Task`                    | タスクを有効にする           |
| `Copilot Scheduler: Disable Task`                   | タスクを無効にする           |
| `Copilot Scheduler: Duplicate Task`                 | タスクを複製                 |
| `Copilot Scheduler: Move Task to Current Workspace` | タスクを現在のWSへ移動       |
| `Copilot Scheduler: Open Settings`                  | 設定を開く                   |
| `Copilot Scheduler: Show Version`                   | バージョン情報を表示         |
| `Copilot Scheduler: Show Execution History`         | 実行履歴を表示               |

## ⚙️ 設定

| 設定                                      | デフォルト  | 説明                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `copilotScheduler.enabled`                | `true`      | スケジュール実行の有効/無効                                                                                                                                                                                                                                                                |
| `copilotScheduler.defaultScope`           | `workspace` | デフォルトスコープ                                                                                                                                                                                                                                                                         |
| `copilotScheduler.language`               | `auto`      | UI 言語 (auto/en/ja)。拡張の Webview/Tree に適用。設定説明文の反映にはウィンドウ再読み込みが必要な場合があります。                                                                                                                                                                         |
| `copilotScheduler.timezone`               | `""`        | スケジュール用タイムゾーン                                                                                                                                                                                                                                                                 |
| `copilotScheduler.jitterSeconds`          | `600`       | タスク実行前に入れるランダム遅延の最大秒数 (0〜1800、0=無効、タスクごとに上書き可)                                                                                                                                                                                                         |
| `copilotScheduler.manualRunNextRunPolicy` | `advance`   | `Run Now` 後の次回実行計算: `advance`（既存 nextRun から進める）/ `fromNow`（現在時刻から再計算）                                                                                                                                                                                          |
| `copilotScheduler.chatSession`            | `new`       | チャットセッション (new/continue)。`continue` は通常より高速です。                                                                                                                                                                                                                         |
| `copilotScheduler.autoModeDefault`        | `false`     | 新規タスク作成時のオートモードヒント既定値（有効時、実行時プロンプトの先頭に自律実行の指示を自動挿入）                                                                                                                                                                                     |
| `copilotScheduler.commandDelayFactor`     | `0.8`       | Copilotコマンド実行時の待機時間倍率 (0.1〜2.0)。小さいほど高速ですが、環境によっては安定性が低下する場合があります。                                                                                                                                                                       |
| `copilotScheduler.showNotifications`      | `true`      | タスク実行時に通知を表示                                                                                                                                                                                                                                                                   |
| `copilotScheduler.notificationMode`       | `sound`     | 通知モード (sound/silentToast/silentStatus)                                                                                                                                                                                                                                                |
| `copilotScheduler.maxDailyExecutions`     | `24`        | 1日のスケジュール実行回数上限（全タスク合計、0=無制限、1〜100）。⚠️ 無制限はAPIレート制限のリスクあり                                                                                                                                                                                      |
| `copilotScheduler.minimumIntervalWarning` | `true`      | 30分未満のcron間隔を設定するときに警告表示                                                                                                                                                                                                                                                 |
| `copilotScheduler.globalPromptsPath`      | `""`        | グローバルプロンプトフォルダーのパス（未指定時: VS Code の User/prompts フォルダー。Windows: `%APPDATA%/Code/User/prompts`、macOS: `~/Library/Application Support/Code/User/prompts`、Linux: `$XDG_CONFIG_HOME/Code/User/prompts` または `~/.config/Code/User/prompts`）                   |
| `copilotScheduler.globalAgentsPath`       | `""`        | グローバルエージェントフォルダー（`*.agent.md`）のパス（未指定時: VS Code の User/prompts フォルダー。Windows: `%APPDATA%/Code/User/prompts`、macOS: `~/Library/Application Support/Code/User/prompts`、Linux: `$XDG_CONFIG_HOME/Code/User/prompts` または `~/.config/Code/User/prompts`） |
| `copilotScheduler.logLevel`               | `info`      | ログレベル (none/error/info/debug)                                                                                                                                                                                                                                                         |
| `copilotScheduler.executionHistoryLimit`  | `50`        | 実行履歴ビューに保持する件数上限（10〜500）                                                                                                                                                                                                                                                |

AI が適用した編集を遅延後に自動で保持するには、VS Code 設定 `chat.editing.autoAcceptDelay` を設定してください（`0` = 無効、`1-100` = 秒、推奨: `5`）。

タスク単位の運用制御（「上限/日」「実行許可時間帯」）は Webview の作成/編集フォームで設定できます。

実行トリガー時に重く感じる場合は、次を先に試してください:

- `copilotScheduler.chatSession = continue`
- `copilotScheduler.commandDelayFactor = 0.6`（または `0.5`）
- `copilotScheduler.notificationMode = silentStatus`
- `copilotScheduler.logLevel = error`（または `none`）

## 📝 プロンプトプレースホルダー

プロンプトで使用できるプレースホルダー:

| プレースホルダー | 説明             |
| ---------------- | ---------------- |
| `{{date}}`       | 現在の日付       |
| `{{time}}`       | 現在の時刻       |
| `{{datetime}}`   | 現在の日時       |
| `{{workspace}}`  | ワークスペース名 |
| `{{file}}`       | 現在のファイル名 |
| `{{filepath}}`   | ファイルパス     |

## 📂 タスクスコープ

- **グローバル**: すべてのワークスペースでタスクを実行
- **ワークスペース**: 作成したワークスペースでのみ実行

## 📄 プロンプトテンプレート

再利用可能なプロンプトテンプレート:

- **ローカル**: ワークスペース内の `.github/prompts/*.md`
- **グローバル**: VS Code ユーザープロンプトフォルダ（または `copilotScheduler.globalPromptsPath` で指定したフォルダ）

## 📋 要件

- VS Code 1.80.0 以上
- GitHub Copilot 拡張機能

## ⚠️ 既知の問題

- Copilot Chat API は開発中のため、API の安定化に伴い更新が必要になる場合があります
- 一部の構成ではモデル選択が機能しない場合があります

**免責:** この拡張機能は Copilot Chat を自動操作します。GitHub の [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) は「過度な自動化された一括活動」を、[利用規約 セクション H (API Terms)](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms) は API の過剰利用によるアカウント停止を明記しています。また [GitHub Copilot の追加製品規約](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) により、これらの規約は Copilot にも直接適用されます。リスクを理解した上でご利用ください。ジッターや1日上限、長めの間隔はリスク低減になりますが、アカウント制限を防ぐ保証はありません。

※ 自動化ツールを使っていなくても Copilot アクセスが制限された[事例](https://github.com/orgs/community/discussions/160013)があります。本拡張の緩和策はリスクを下げるだけで、リスクをゼロにはできません。

🐛 [バグを報告](https://github.com/aktsmm/vscode-copilot-scheduler/issues)

## 📄 ライセンス

[CC-BY-NC-SA-4.0](LICENSE) © [aktsmm](https://github.com/aktsmm)

---

**Copilot プロンプトのスケジュール実行をお楽しみください！** 🚀
