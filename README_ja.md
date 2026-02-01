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

![Copilot Scheduler Demo](images/demo-animated.gif)

## ✨ 機能

🗓️ **Cron スケジューリング** - Cron 式で特定の時刻にプロンプトを実行

🤖 **エージェント & モデル選択** - 組み込みエージェント (@workspace, @terminal) と AI モデル (GPT-4o, Claude Sonnet 4) を選択可能

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

| 式             | 説明                     |
| -------------- | ------------------------ |
| `0 9 * * 1-5`  | 平日 9:00                |
| `0 18 * * 1-5` | 平日 18:00               |
| `0 9 * * *`    | 毎日 9:00                |
| `0 9 * * 1`    | 毎週月曜日 9:00          |
| `*/30 * * * *` | 30 分ごと                |
| `0 * * * *`    | 1 時間ごと               |

## 📋 コマンド

| コマンド                                           | 説明                         |
| -------------------------------------------------- | ---------------------------- |
| `Copilot Scheduler: Create Scheduled Prompt`       | 新規タスク作成 (CLI)         |
| `Copilot Scheduler: Create Scheduled Prompt (GUI)` | 新規タスク作成 (GUI)         |
| `Copilot Scheduler: List Scheduled Tasks`          | すべてのタスクを表示         |
| `Copilot Scheduler: Edit Task`                     | タスクを編集                 |
| `Copilot Scheduler: Delete Task`                   | タスクを削除                 |
| `Copilot Scheduler: Toggle Task`                   | タスクの有効/無効を切り替え  |
| `Copilot Scheduler: Run Now`                       | タスクを即座に実行           |
| `Copilot Scheduler: Copy Prompt`                   | プロンプトをクリップボードに |

## ⚙️ 設定

| 設定                                | デフォルト  | 説明                               |
| ----------------------------------- | ----------- | ---------------------------------- |
| `copilotSchedule.enabled`           | `true`      | スケジュール実行の有効/無効        |
| `copilotSchedule.showNotifications` | `true`      | タスク実行時に通知を表示           |
| `copilotSchedule.logLevel`          | `info`      | ログレベル (none/error/info/debug) |
| `copilotSchedule.language`          | `auto`      | UI 言語 (auto/en/ja)               |
| `copilotSchedule.timezone`          | `""`        | スケジュール用タイムゾーン         |
| `copilotSchedule.chatSession`       | `new`       | チャットセッション (new/continue)  |
| `copilotSchedule.defaultScope`      | `workspace` | デフォルトスコープ                 |

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
- **グローバル**: `~/.github/prompts/*.md` または VS Code ユーザープロンプトフォルダ

## 📋 要件

- VS Code 1.80.0 以上
- GitHub Copilot 拡張機能

## ⚠️ 既知の問題

- Copilot Chat API は開発中のため、API の安定化に伴い更新が必要になる場合があります
- 一部の構成ではモデル選択が機能しない場合があります

🐛 [バグを報告](https://github.com/aktsmm/vscode-copilot-scheduler/issues)

## 📄 ライセンス

[CC-BY-NC-SA-4.0](LICENSE) © [yamapan](https://github.com/aktsmm)

---

**Copilot プロンプトのスケジュール実行をお楽しみください！** 🚀
