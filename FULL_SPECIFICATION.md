# 📋 Copilot Scheduler - 完全仕様書

> **目的**: この仕様書を元に、別のワークスペースで GitHub Copilot が同等の VS Code 拡張機能を再構築できるようにする。

---

## 1. プロジェクト概要

### 1.1 基本情報

| 項目 | 値 |
|------|-----|
| 拡張機能名 | Copilot Scheduler |
| 内部名 | `copilot-scheduler` |
| パブリッシャー | yamapan |
| バージョン | 0.1.0 |
| ライセンス | CC-BY-NC-SA-4.0 |
| 対象 VS Code | ^1.80.0 以上 |
| リポジトリ | https://github.com/aktsmm/vscode-copilot-scheduler |
| アクティベーション | `onStartupFinished` |

### 1.2 機能概要

**Copilot Scheduler** は、VS Code 上で GitHub Copilot へのプロンプト送信を **cron式** でスケジュール実行できる拡張機能。

**主要機能:**
- 🗓️ cron式による定期的なプロンプト自動実行
- 🤖 エージェント/モデル選択（@workspace, GPT-4o, Claude など）
- 🌐 英語・日本語 UI の自動切り替え
- 📊 サイドバー TreeView でタスク管理
- 🖥️ Webview による GUI タスク作成・編集
- 📁 ローカル/グローバルのプロンプトテンプレート参照

---

## 2. 技術スタック

### 2.1 言語・ビルド

| 項目 | 値 |
|------|-----|
| 言語 | TypeScript (strict mode) |
| ビルド | `tsc` (TypeScript Compiler) |
| パッケージ | `vsce` |
| Node.js | 20.x 以上推奨 |

### 2.2 依存関係

**本番依存 (dependencies):**

```json
{
  "cron-parser": "^4.9.0"
}
```

**開発依存 (devDependencies):**

```json
{
  "@types/glob": "^8.1.0",
  "@types/mocha": "^10.0.0",
  "@types/node": "^20.0.0",
  "@types/vscode": "^1.80.0",
  "@typescript-eslint/eslint-plugin": "^6.0.0",
  "@typescript-eslint/parser": "^6.0.0",
  "@vscode/test-electron": "^2.3.0",
  "eslint": "^8.0.0",
  "glob": "^10.0.0",
  "mocha": "^10.2.0",
  "typescript": "^5.0.0"
}
```

### 2.3 npm scripts

```json
{
  "vscode:prepublish": "npm run compile",
  "compile": "tsc -p ./",
  "watch": "tsc -watch -p ./",
  "pretest": "npm run compile",
  "test": "node ./out/test/runTest.js",
  "lint": "eslint src --ext ts"
}
```

---

## 3. ファイル構成

```
copilot-scheduler/
├── package.json              # 拡張機能マニフェスト
├── package.nls.json          # 英語ローカライズ
├── package.nls.ja.json       # 日本語ローカライズ
├── tsconfig.json             # TypeScript設定
├── images/
│   ├── icon.png              # 拡張機能アイコン (128x128)
│   └── sidebar-icon.svg      # サイドバーアイコン
├── src/
│   ├── extension.ts          # エントリーポイント、コマンド登録
│   ├── scheduleManager.ts    # タスクCRUD、cronスケジューリング
│   ├── copilotExecutor.ts    # Copilot Chat API連携
│   ├── schedulerWebview.ts   # GUI Webview（タスク作成/編集/一覧）
│   ├── cronWebview.ts        # Cron式設定GUI（オプション）
│   ├── treeProvider.ts       # サイドバー TreeView
│   ├── i18n.ts               # 国際化（EN/JA）
│   ├── types.ts              # 型定義
│   └── test/
│       ├── runTest.ts        # テストランナー
│       └── suite/
│           ├── index.ts      # Mocha設定
│           └── *.test.ts     # テストファイル
└── out/                      # コンパイル済みJS
```

---

## 4. データ構造（型定義）

### 4.1 types.ts

```typescript
export type TaskScope = "global" | "workspace";
export type PromptSource = "inline" | "local" | "global";

export interface ScheduledTask {
  id: string;                    // 一意識別子（例: "task_1700000000000_abc123"）
  name: string;                  // タスク名
  cronExpression: string;        // cron式（例: "0 9 * * 1-5"）
  prompt: string;                // Copilotに送信するプロンプト（inline時）
  enabled: boolean;              // 有効/無効
  agent?: string;                // エージェント（@workspace, @terminal, agent, ask, edit 等）
  model?: string;                // AIモデル（gpt-4o, claude-sonnet-4 等）
  scope: TaskScope;              // "global" = 全ワークスペース, "workspace" = 特定のみ
  workspacePath?: string;        // ワークスペースパス（scope="workspace"時）
  promptSource: PromptSource;    // "inline" | "local" | "global"
  promptPath?: string;           // プロンプトファイルパス（promptSource != "inline"時）
  lastRun?: Date;                // 前回実行日時
  nextRun?: Date;                // 次回実行日時
  createdAt: Date;               // 作成日時
  updatedAt: Date;               // 更新日時
}

export interface CreateTaskInput {
  name: string;
  cronExpression: string;
  prompt: string;
  enabled?: boolean;             // デフォルト: true
  agent?: string;
  model?: string;
  scope?: TaskScope;             // デフォルト: "workspace"
  runFirstInOneMinute?: boolean; // 1分後に初回実行するか
  promptSource?: PromptSource;   // デフォルト: "inline"
  promptPath?: string;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  executedAt: Date;
  error?: string;
  duration?: number;
}
```

---

## 5. コマンド一覧

| コマンドID | 説明 | アイコン | キーバインド |
|------------|------|----------|--------------|
| `copilotSchedule.createTask` | タスク作成（CLI形式・InputBox） | - | - |
| `copilotSchedule.createTaskGui` | タスク作成（GUI Webview） | `$(add)` | - |
| `copilotSchedule.listTasks` | タスク一覧表示（Webview） | - | - |
| `copilotSchedule.deleteTask` | タスク削除 | `$(trash)` | - |
| `copilotSchedule.toggleTask` | 有効/無効切替 | - | - |
| `copilotSchedule.runNow` | 今すぐ実行 | `$(play)` | - |
| `copilotSchedule.copyPrompt` | プロンプトをクリップボードへコピー | `$(copy)` | - |
| `copilotSchedule.editTask` | タスク編集（Webview） | `$(edit)` | - |
| `copilotSchedule.duplicateTask` | タスク複製 | - | - |
| `copilotSchedule.openSettings` | 設定画面を開く | `$(settings-gear)` | - |
| `copilotSchedule.showVersion` | バージョン情報表示 | `$(info)` | - |

---

## 6. 設定項目 (Configuration)

| 設定キー | 型 | デフォルト | 説明 |
|----------|-----|------------|------|
| `copilotSchedule.enabled` | boolean | `true` | スケジュール実行の有効/無効 |
| `copilotSchedule.showNotifications` | boolean | `true` | 実行完了時の通知表示 |
| `copilotSchedule.logLevel` | string | `"info"` | ログレベル（`none` / `error` / `info` / `debug`） |
| `copilotSchedule.language` | string | `"auto"` | 言語設定（`auto` / `en` / `ja`） |
| `copilotSchedule.timezone` | string | `""` | タイムゾーン（空=システム設定、例: `Asia/Tokyo`） |
| `copilotSchedule.chatSession` | string | `"new"` | チャットセッション（`new` = 毎回新規 / `continue` = 継続） |
| `copilotSchedule.defaultScope` | string | `"workspace"` | デフォルトスコープ（`global` / `workspace`） |
| `copilotSchedule.globalPromptsPath` | string | `""` | グローバルプロンプトのカスタムパス |

---

## 7. UI構成

### 7.1 Activity Bar (サイドバー)

```json
"viewsContainers": {
  "activitybar": [{
    "id": "copilotSchedule",
    "title": "Copilot Scheduler",
    "icon": "images/sidebar-icon.svg"
  }]
}
```

### 7.2 TreeView

- **View ID**: `copilotScheduleTasks`
- **データプロバイダ**: `ScheduledTaskTreeProvider`
- **構造**: 
  - 第1階層: スコープグループ（🌐 Global / 📁 Workspace）
  - 第2階層: 個別タスク
- **contextValue**: `enabledTask` / `disabledTask` / `scopeGroup`
- **インラインボタン**: 実行、コピー、編集、削除
- **コンテキストメニュー**: 実行、有効/無効切替、編集、複製、削除

### 7.3 Webview (SchedulerWebview)

**2タブ構成:**
1. **新規作成タブ**: タスク作成フォーム
2. **一覧タブ**: 既存タスクの表示・編集・削除

**作成フォーム項目:**
- タスク名（必須）
- プロンプト種別（自由入力 / ローカル / グローバル）
- プロンプト内容 / テンプレート選択
- スケジュール設定（プリセット or カスタム cron式）
- エージェント選択
- モデル選択
- 実行範囲（グローバル / ワークスペース）
- 1分後に初回実行オプション
- テスト実行ボタン

**プリセット:**
- 平日 9:00 (`0 9 * * 1-5`)
- 平日 18:00 (`0 18 * * 1-5`)
- 毎日 9:00 (`0 9 * * *`)
- 毎週月曜 (`0 9 * * 1`)
- 毎月1日 (`0 9 1 * *`)
- 30分ごと (`*/30 * * * *`)
- 毎時 (`0 * * * *`)

---

## 8. クラス詳細設計

### 8.1 ScheduleManager

**責務**: タスクのCRUD操作、cronスケジューリング、永続化

```typescript
class ScheduleManager {
  private tasks: Map<string, ScheduledTask>;
  private schedulerInterval: NodeJS.Timeout | undefined;
  private context: vscode.ExtensionContext;
  
  constructor(context: vscode.ExtensionContext);
  
  // タスク操作
  createTask(input: CreateTaskInput): Promise<ScheduledTask>;
  getTask(id: string): ScheduledTask | undefined;
  getAllTasks(): ScheduledTask[];
  updateTask(id: string, updates: Partial<CreateTaskInput>): Promise<ScheduledTask | undefined>;
  deleteTask(id: string): Promise<boolean>;
  toggleTask(id: string): Promise<ScheduledTask | undefined>;
  
  // cron検証
  validateCronExpression(expression: string): boolean; // throws on invalid
  
  // スケジューラ
  startScheduler(onExecute: (task: ScheduledTask) => Promise<void>): void;
  stopScheduler(): void;
  
  // ワークスペース判定
  shouldTaskRunInCurrentWorkspace(task: ScheduledTask): boolean;
  
  // コールバック
  setOnTasksChangedCallback(callback: () => void): void;
  
  // 内部メソッド
  private loadTasks(): void;           // globalStateから復元
  private saveTasks(): Promise<void>;  // globalStateへ保存
  private generateId(): string;        // task_{timestamp}_{random}
  private getNextRun(cronExpression: string, baseTime?: Date): Date | undefined;
  private getTimeZone(): string | undefined;
  private checkAndExecuteTasks(): Promise<void>;
}
```

**スケジューラロジック:**
1. `startScheduler()` で次の分境界にアラインして開始
2. 毎分 `checkAndExecuteTasks()` を実行
3. 各タスクの `nextRun` と現在時刻（分単位で切り捨て）を比較
4. 一致したら `onExecuteCallback` を実行
5. スリープ復帰などで時刻がずれた場合は実行せず `nextRun` を更新

### 8.2 CopilotExecutor

**責務**: Copilot Chat API へのプロンプト送信

```typescript
class CopilotExecutor {
  // プロンプト実行
  executePrompt(prompt: string, options?: ExecuteOptions): Promise<void>;
  executePromptViaCLI(prompt: string, options?: ExecuteOptions): Promise<void>;
  
  // エージェント/モデル取得
  static getBuiltInAgents(): Array<{id, name, description, isCustom}>;
  static getCustomAgents(): Promise<Array<{id, name, description, isCustom, filePath}>>;
  static getAllAgents(): Promise<Array<{id, name, description, isCustom}>>;
  static getAvailableModels(): Promise<Array<{id, name, description, vendor}>>;
  static getFallbackModels(): Array<{id, name, description, vendor}>;
  
  // プロンプトコマンド処理
  private applyPromptCommands(prompt: string): string;
  private delay(ms: number): Promise<void>;
  private tryCreateNewChatSession(): Promise<boolean>;
}

interface ExecuteOptions {
  agent?: string;
  model?: string;
}
```

**executePrompt フロー:**
1. `applyPromptCommands()` でプレースホルダー展開
2. エージェントプレフィックス付与（例: `@workspace prompt`）
3. `chatSession` 設定に応じて新規セッション作成
4. `workbench.panel.chat.view.copilot.focus` でパネルフォーカス
5. `workbench.action.chat.selectModel` でモデル設定（可能な場合）
6. `type` コマンドでプロンプト入力
7. `workbench.action.chat.submit` で送信
8. 失敗時はクリップボードにコピーを提案

### 8.3 SchedulerWebview

**責務**: Webview GUI の管理

```typescript
class SchedulerWebview {
  private static panel: vscode.WebviewPanel | undefined;
  private static cachedAgents: Array<...>;
  private static cachedModels: Array<...>;
  private static cachedPromptTemplates: PromptTemplate[];
  
  static show(
    extensionUri: vscode.Uri,
    tasks: ScheduledTask[],
    onTaskAction: (action: TaskAction) => void,
    onTestPrompt?: (prompt, agent, model) => void
  ): Promise<void>;
  
  static updateTasks(tasks: ScheduledTask[]): void;
  static refreshLanguage(tasks: ScheduledTask[]): void;
  static switchToList(): void;
  static focusTask(taskId: string): void;
  static waitForCreate(): Promise<TaskCreateResult | undefined>;
  
  private static getWebviewContent(...): string;
  private static getPromptTemplates(): Promise<PromptTemplate[]>;
  private static refreshAgentsAndModels(force?: boolean): Promise<void>;
  private static refreshPromptTemplates(force?: boolean): Promise<void>;
}

interface TaskAction {
  action: "run" | "toggle" | "delete" | "edit" | "copy";
  taskId: string;
  data?: {...};
}
```

**Webview メッセージング:**
- Extension → Webview: `updateTasks`, `updateAgents`, `updateModels`, `updatePromptTemplates`, `promptTemplateLoaded`
- Webview → Extension: `createTask`, `updateTask`, `testPrompt`, `copyPrompt`, `refreshAgents`, `refreshPrompts`, `runTask`, `toggleTask`, `deleteTask`, `setDefaultScope`, `loadPromptTemplate`, `webviewReady`

### 8.4 ScheduledTaskTreeProvider

**責務**: サイドバー TreeView のデータ提供

```typescript
class ScheduledTaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  constructor(scheduleManager: ScheduleManager);
  
  refresh(): void;
  getTreeItem(element: TreeNode): vscode.TreeItem;
  getChildren(element?: TreeNode): Thenable<TreeNode[]>;
}

class ScopeGroupItem extends vscode.TreeItem {
  scope: TaskScope;
}

class ScheduledTaskItem extends vscode.TreeItem {
  task: ScheduledTask;
}
```

---

## 9. 国際化 (i18n)

### 9.1 言語判定

```typescript
function isJapanese(): boolean {
  const config = vscode.workspace.getConfiguration("copilotSchedule");
  const lang = config.get<string>("language", "auto");
  if (lang === "ja") return true;
  if (lang === "en") return false;
  return vscode.env.language.startsWith("ja");
}
```

### 9.2 メッセージ構造

```typescript
export const messages = {
  extensionActive: () => isJapanese() ? "...日本語..." : "...English...",
  taskCreated: (name: string) => isJapanese() ? `...${name}...` : `...${name}...`,
  // ... 100+ メッセージ
};
```

**主要メッセージカテゴリ:**
- 一般メッセージ（起動、エラー等）
- タスク操作（作成、削除、更新、実行）
- UI ラベル（ボタン、プレースホルダー）
- Cron プリセット名
- エージェント/モデル説明
- TreeView 表示

### 9.3 package.nls ファイル

**package.nls.json** (英語):
```json
{
  "command.createTask": "Create Scheduled Prompt",
  "command.createTaskGui": "Create Scheduled Prompt (GUI)",
  ...
}
```

**package.nls.ja.json** (日本語):
```json
{
  "command.createTask": "スケジュールプロンプトを作成",
  "command.createTaskGui": "スケジュールプロンプトを作成 (GUI)",
  ...
}
```

---

## 10. プロンプトソース

### 10.1 種類

| ソース | 説明 | 保存場所 |
|--------|------|----------|
| `inline` | Webview/CLIで直接入力 | タスク内 `prompt` フィールド |
| `local` | ワークスペース内プロンプト | `.github/prompts/*.md` |
| `global` | ユーザー共通プロンプト | `%APPDATA%/Code/User/prompts` または `~/.github/prompts` |

### 10.2 パス解決ロジック

```typescript
function resolvePromptFilePath(task: ScheduledTask): string | undefined {
  if (task.promptSource === "global") {
    const globalRoot = getGlobalPromptsPath();
    return resolveAllowedPromptPath(globalRoot, task.promptPath);
  }
  if (task.promptSource === "local") {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return resolveAllowedPromptPath(workspaceRoot, task.promptPath);
  }
  return undefined;
}

function resolveAllowedPromptPath(baseDir: string, promptPath: string): string | undefined {
  // セキュリティ: baseDir 配下のみ許可
  const resolvedTarget = path.resolve(baseDir, promptPath);
  if (resolvedTarget.startsWith(`${baseDir}${path.sep}`)) {
    return resolvedTarget;
  }
  return undefined;
}
```

---

## 11. エージェント/モデル

### 11.1 ビルトインエージェント

| ID | 名前 | 説明 |
|----|------|------|
| `""` | なし | 既定（エージェントなし） |
| `agent` | Agent | ツール利用のエージェントモード |
| `ask` | Ask | コードに関する質問 |
| `edit` | Edit | AIでコード編集 |
| `@workspace` | @workspace | コードベース検索 |
| `@terminal` | @terminal | ターミナル操作 |
| `@vscode` | @vscode | VS Code設定とコマンド |

### 11.2 カスタムエージェント検出

- `**/*.agent.md` ファイルをスキャン
- `AGENTS.md` 内の `<agent>` タグをパース

### 11.3 モデル一覧

| ID | 名前 | ベンダー |
|----|------|----------|
| `""` | Default | - |
| `gpt-4o` | GPT-4o | OpenAI |
| `gpt-4o-mini` | GPT-4o Mini | OpenAI |
| `o3-mini` | o3-mini | OpenAI |
| `claude-sonnet-4` | Claude Sonnet 4 | Anthropic |
| `claude-3.5-sonnet` | Claude 3.5 Sonnet | Anthropic |
| `gemini-2.0-flash` | Gemini 2.0 Flash | Google |

**動的取得**: `vscode.lm.selectChatModels()` API で利用可能モデルを取得

---

## 12. データ永続化

### 12.1 ストレージ

- **場所**: `vscode.ExtensionContext.globalState`
- **キー**: `"scheduledTasks"`
- **形式**: `ScheduledTask[]` の JSON シリアライズ

### 12.2 Date 復元

```typescript
private loadTasks(): void {
  const savedTasks = this.context.globalState.get<ScheduledTask[]>("scheduledTasks", []);
  for (const task of savedTasks) {
    task.createdAt = new Date(task.createdAt);
    task.updatedAt = new Date(task.updatedAt);
    if (task.lastRun) task.lastRun = new Date(task.lastRun);
    if (task.nextRun) task.nextRun = new Date(task.nextRun);
    // マイグレーション
    if (!task.scope) task.scope = "global";
    if (!task.promptSource) task.promptSource = "inline";
    this.tasks.set(task.id, task);
  }
}
```

---

## 13. セキュリティ

### 13.1 Webview セキュリティ

- **nonce** を使用したインラインスクリプト保護
- `localResourceRoots` で拡張機能ディレクトリのみ許可
- ユーザー入力のサニタイズ

### 13.2 プロンプトパス制限

- `resolveAllowedPromptPath()` で許可ディレクトリ外アクセスを防止
- パストラバーサル攻撃対策

### 13.3 globalState

- 機密データ（APIキー等）は保存しない
- タスク定義のみ保存

---

## 14. 実行フロー

### 14.1 拡張機能起動

```
1. onStartupFinished イベント
   ↓
2. ScheduleManager 初期化
   - globalState からタスク読み込み
   - nextRun 時刻を更新
   ↓
3. TreeProvider 初期化
   ↓
4. CopilotExecutor 初期化
   ↓
5. コマンド登録
   ↓
6. scheduleManager.startScheduler()
   - 次の分境界まで待機
   - setInterval で毎分チェック開始
```

### 14.2 タスク実行

```
1. checkAndExecuteTasks() [毎分実行]
   ↓
2. 各タスクをループ
   - enabled チェック
   - shouldTaskRunInCurrentWorkspace() でスコープ判定
   - nextRun と現在時刻（分単位）を比較
   ↓
3. 実行対象タスク発見
   ↓
4. resolvePromptText(task)
   - inline: task.prompt を返す
   - local/global: ファイル読み込み
   ↓
5. copilotExecutor.executePrompt(text, {agent, model})
   ↓
6. task.lastRun = now
   task.nextRun = getNextRun()
   saveTasks()
```

---

## 15. Webview HTML テンプレート構造

### 15.1 基本構造

```html
<!DOCTYPE html>
<html lang="${isJa ? 'ja' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src 'unsafe-inline';
    script-src 'nonce-${nonce}';
  ">
  <style>/* CSS */</style>
</head>
<body>
  <div class="tabs">
    <button data-tab="create">${strings.tabCreate}</button>
    <button data-tab="list">${strings.tabList}</button>
  </div>
  
  <div id="create-tab">
    <!-- 作成フォーム -->
  </div>
  
  <div id="list-tab">
    <!-- タスク一覧 -->
  </div>
  
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // JavaScript
  </script>
</body>
</html>
```

### 15.2 初期データ埋め込み

```javascript
window.initialData = {
  tasks: ${JSON.stringify(tasks)},
  agents: ${JSON.stringify(agents)},
  models: ${JSON.stringify(models)},
  promptTemplates: ${JSON.stringify(promptTemplates)},
  defaultScope: "${defaultScope}",
  isJapanese: ${isJa}
};
```

---

## 16. メニュー構成

### 16.1 View Title (サイドバー上部)

```json
"view/title": [
  { "command": "copilotSchedule.createTaskGui", "group": "navigation@1" },
  { "command": "copilotSchedule.openSettings", "group": "navigation@2" },
  { "command": "copilotSchedule.showVersion", "group": "navigation@3" }
]
```

### 16.2 View Item Context (タスク右クリック)

```json
"view/item/context": [
  // インライン (アイコン)
  { "command": "copilotSchedule.runNow", "group": "inline@1" },
  { "command": "copilotSchedule.copyPrompt", "group": "inline@2" },
  { "command": "copilotSchedule.editTask", "group": "inline@3" },
  { "command": "copilotSchedule.deleteTask", "group": "inline@4" },
  
  // コンテキストメニュー
  { "command": "copilotSchedule.runNow", "group": "1_actions@1" },
  { "command": "copilotSchedule.toggleTask", "group": "1_actions@2" },
  { "command": "copilotSchedule.editTask", "group": "2_edit@1" },
  { "command": "copilotSchedule.duplicateTask", "group": "2_edit@2" },
  { "command": "copilotSchedule.deleteTask", "group": "3_delete@1" }
]
```

---

## 17. エラーハンドリング

### 17.1 Cron 式検証

```typescript
validateCronExpression(expression: string): boolean {
  if (!expression || !expression.trim()) {
    throw new Error("Invalid cron expression");
  }
  try {
    parseExpression(expression, {
      currentDate: new Date(),
      tz: this.getTimeZone(),
    });
    return true;
  } catch {
    throw new Error("Invalid cron expression");
  }
}
```

### 17.2 プロンプト実行失敗

```typescript
try {
  await copilotExecutor.executePrompt(promptText, options);
} catch (error) {
  // フォールバック: クリップボードにコピー
  const action = await vscode.window.showWarningMessage(
    messages.autoExecuteFailed(),
    messages.actionCopyPrompt(),
    messages.actionCancel()
  );
  if (action === messages.actionCopyPrompt()) {
    await vscode.env.clipboard.writeText(fullPrompt);
  }
}
```

---

## 18. テスト戦略

### 18.1 テスト構成

```typescript
// src/test/runTest.ts
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}
```

### 18.2 テストカテゴリ

1. **拡張機能アクティベーション**: コマンド登録確認
2. **ScheduleManager**: CRUD操作、cron検証
3. **i18n**: 言語切り替え
4. **TreeProvider**: ツリー構造

### 18.3 Mocha インポート注意

```typescript
// ✅ 正しい (default import)
import Mocha from "mocha";

// ❌ 間違い (namespace import - constructable ではない)
import * as Mocha from "mocha";
```

---

## 19. パッケージング・リリース

### 19.1 ビルドコマンド

```bash
# コンパイル
npm run compile

# パッケージ作成
npx vsce package --allow-missing-repository

# ローカルインストール
code --install-extension ./copilot-scheduler-0.1.0.vsix
```

### 19.2 必須ファイル

- `package.json` (マニフェスト)
- `package.nls.json`, `package.nls.ja.json` (ローカライズ)
- `out/` (コンパイル済みJS)
- `images/` (アイコン)
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

---

## 20. 今後の拡張ポイント

- [ ] タスク実行履歴の保存・表示
- [ ] 複数タスクの一括有効/無効
- [ ] タスクのインポート/エクスポート (JSON)
- [ ] Webhook通知連携
- [ ] カスタムエージェントの自動検出強化
- [ ] 実行ログのファイル出力
- [ ] タスクグループ機能

---

## 21. 実装チェックリスト

### 21.1 必須機能

- [ ] タスク作成（CLI / GUI）
- [ ] タスク一覧表示
- [ ] タスク編集
- [ ] タスク削除
- [ ] タスク複製
- [ ] 有効/無効切替
- [ ] 今すぐ実行
- [ ] プロンプトコピー
- [ ] cron スケジューリング
- [ ] エージェント選択
- [ ] モデル選択
- [ ] スコープ選択（global/workspace）
- [ ] プロンプトソース（inline/local/global）
- [ ] 日本語/英語切替
- [ ] 設定画面

### 21.2 UI

- [ ] サイドバー TreeView
- [ ] Webview（作成/一覧タブ）
- [ ] Cron プリセット
- [ ] テスト実行ボタン
- [ ] 通知メッセージ

### 21.3 セキュリティ

- [ ] Webview nonce
- [ ] プロンプトパス制限
- [ ] 入力サニタイズ

---

## 22. コード例

### 22.1 extension.ts (エントリーポイント抜粋)

```typescript
export function activate(context: vscode.ExtensionContext): void {
  // コンポーネント初期化
  scheduleManager = new ScheduleManager(context);
  copilotExecutor = new CopilotExecutor();
  treeProvider = new ScheduledTaskTreeProvider(scheduleManager);
  
  // TreeView 登録
  const treeView = vscode.window.createTreeView("copilotScheduleTasks", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  
  // コマンド登録
  const createTaskCmd = vscode.commands.registerCommand(
    "copilotSchedule.createTask",
    async () => { /* ... */ }
  );
  
  // スケジューラ開始
  scheduleManager.startScheduler(async (task) => {
    const promptText = await resolvePromptText(task);
    await copilotExecutor.executePrompt(promptText, {
      agent: task.agent,
      model: task.model,
    });
  });
  
  context.subscriptions.push(treeView, createTaskCmd, /* ... */);
}

export function deactivate(): void {
  scheduleManager?.stopScheduler();
}
```

---

この仕様書に従って実装すれば、同等の機能を持つ VS Code 拡張機能を再構築できます。
