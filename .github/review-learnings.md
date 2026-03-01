# Review Learnings

## Universal（汎用 — 他プロジェクトでも使える）

### U1: Webview HTML の DOCTYPE 閉じタグ

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-23
- **Evidence**: `<!DOCTYPE html` と閉じ `>` が欠落していた。テンプレートリテラルで HTML を生成する場合に見落としやすい。
- **Action**: Webview HTML を生成する箇所では `<!DOCTYPE html>` の閉じ括弧を確認する。テンプレートリテラル内の HTML は改行位置でタグが切れやすいため、生成後に先頭行をログで確認するか、HTMLバリデーションを CI に入れる。

### U2: Webview メッセージ送信の一貫したラッパー使用

- **Tags**: `コード品質` `バグ`
- **Added**: 2026-02-23
- **Evidence**: `SchedulerWebview` の `handleMessage` 内で一部のケースが `this.panel.webview.postMessage` を直接呼び出し、`webviewReady` チェックとキューイングをバイパスしていた。初期化タイミングによってはメッセージが消失する。
- **Action**: Webview へのメッセージ送信は常にラッパー関数（ready チェック＋キュー機構）を経由させる。直接呼び出しはラッパー内部のみに限定する。

### U3: Promise チェーンのエラー伝播による後続処理ブロック

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-23
- **Evidence**: `ScheduleManager.saveTasks` が `this.saveQueue = this.saveQueue.then(...)` で直列化していたが、内部が reject すると `saveQueue` 自体が rejected Promise になり、以降の全保存呼び出しが実行されなくなった。
- **Action**: キューイングパターンで `.then()` チェーンを使う場合、`this.queue = op.catch(...)` で回復し、呼び出し元には `return op` で元のエラーを伝播させる。

### U4: エクスポートされているが未使用のシンボルの蓄積

- **Tags**: `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `cronBuilder.ts`（ファイル全体）、`types.ts` の `TaskExecutionResult`/`ExtensionConfig`、`i18n.ts` の `getAgentDisplayInfo()`、`logger.ts` の `logInfo()` がエクスポートされていたが、プロジェクト内のどこからも参照されていなかった。計4箇所、約200行のデッドコード。2回目のレビュー（同日）でも `messages.agentNone()` 等8個の i18n メッセージ、`messages.dailyExecutionCount()`、`ScheduleManager.getDailyExecInfo()` が同パターンで残存していた。大規模リファクタ後にデッドコードが残りやすい。
- **Action**: 「将来使うかもしれない」コードはエクスポートしない。必要になった時点で追加する（YAGNI）。定期的に `tsc` の `noUnusedLocals` や ESLint の `no-unused-vars` で未使用シンボルを検出する。ファイル単位で完全に未参照の場合は削除を優先する。リファクタ後は grep で削除候補の参照有無を確認する。

### U5: 起動時に nextRun を強制再計算して取りこぼさない

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: タスク読み込み時に `nextRun` を「常に現在時刻基準で再計算」すると、VS Code 再起動/拡張の再読み込みのタイミング次第で、本来実行されるはずだった直近の実行がスキップされ、ユーザーには「時間を過ぎても実行されない」ように見える。
- **Action**: 永続化されている `nextRun` は基本的に保持し、`nextRun` が欠落/不正な場合のみ補完計算する。取りこぼし防止のため、過去時刻の `nextRun` はスケジューラ側で catch-up 実行できるようにする（もしくはスキップする仕様なら UI で明示する）。

### U6: 作成/編集フォームのモードを明示して上書きを防ぐ

- **Tags**: `UI/UX` `バグ`
- **Added**: 2026-02-24
- **Evidence**: 既存アイテムのクリック先が「作成」フォームと同一だと、タブ名や送信ボタン文言が曖昧な場合に「新規作成なのか更新なのか」が判別しづらく、意図しない上書きにつながりやすい。
- **Action**: 編集モードではラベル（タブ名/ボタン文言）を明確に切り替える。編集画面から新規作成に戻る明示的な導線（フォームリセット）を用意し、状態（hidden input 等）も一貫して同期する。

### U7: パス検証は解決済みパスで統一（Windows の大小文字差も考慮）

- **Tags**: `セキュリティ` `バグ`
- **Added**: 2026-02-24
- **Evidence**: テンプレート読み込みの許可判定で、ルート内チェックに「未解決の入力パス」を使う／キャッシュ照合が厳密な文字列比較のままだと、相対パス解釈や Windows の大小文字差で誤判定（意図しない拒否・許可）を起こしうる。
- **Action**: Allowlist/ルート内判定は必ず `path.resolve()` 後の絶対パスで行い、比較は `normalize` + 末尾セパレータ除去 +（Windows では）小文字化で正規化してから実施する。

### U8: 設定スキーマと仕様（0=off）を矛盾させない

- **Tags**: `バグ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `jitterSeconds` は「0=無効」と説明されている一方、`package.json` の settings schema で `minimum` が 60 だと UI 上 0 を設定できず、実装/説明/README の間で不整合が起きる。
- **Action**: 「0=off」を許可する設定は schema の `minimum` も 0 に揃え、README/説明文も範囲（例: 0–1800）を一致させる。

### U9: timezone 指定が壊れてもスケジューラはローカル時刻にフォールバック

- **Tags**: `バグ` `回復性`
- **Added**: 2026-02-24
- **Evidence**: cron パース時に `tz` を渡すと、無効な timezone 文字列で例外になり得る。これがそのまま伝播/失敗扱いになると nextRun 計算やスケジュール実行が止まる。
- **Action**: `tz` 付きパースに失敗した場合は tz なしで再試行し、致命的に落とさずローカル時刻で継続できるようにする（必要ならログで可視化）。

### U10: Webview 初期HTMLのプレースホルダーは i18n 文字列を使う

- **Tags**: `UI/UX` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: Webview の初期レンダリング用HTMLで `-- Select Agent --` / `-- Select Model --` / `-- Select Template --` をハードコードすると、日本語UIでも初期表示だけ英語が混ざる（更新/再描画の失敗時は恒久的に混ざる）。
- **Action**: 初期HTML生成時点から `strings.*`（i18n）を使い、placeholder/空状態の文言も含めてローカライズを徹底する。

### U11: 開発用スクリプト（lint 等）は「設定欠如で即死」させない

- **Tags**: `コード品質` `非機能`
- **Added**: 2026-02-24
- **Evidence**: `npm run lint` が定義されていても ESLint 設定ファイルが無いとコマンド自体が失敗し、品質チェックが形骸化する。加えて `@typescript-eslint` は TypeScript の対応バージョン外だと警告を出し、CI/ログがノイズになる。
- **Action**: まず「lint が実行できる」最小構成（`.eslintrc.*`）を用意し、ルールは段階的に追加する。TypeScript と `@typescript-eslint/*` のバージョン整合を取るか、意図して `warnOnUnsupportedTypeScriptVersion` を制御する。

### U12: GUI のデフォルト値で設定デフォルトを潰さない

- **Tags**: `バグ` `UI/UX` `回復性`
- **Added**: 2026-02-24
- **Evidence**: Webview フォームの数値入力に固定の初期値（例: `0`）を入れて送信すると、ユーザーが設定で定義したデフォルト（例: `copilotScheduler.jitterSeconds = 600`）が適用されず、意図せず挙動が変わる/緩和策が効かない状態になり得る。
- **Action**: フォームの初期値・リセット値は設定値を反映し、実行時のフォールバック値（config の default）とも整合させる。Webview へは `initialData` として明示的に渡して同期する。

## Project-specific（このワークスペース固有）

### P1: getCronPresets() と extraPresets の重複

- **Tags**: `UI/UX` `コード品質`
- **Added**: 2026-02-23
- **Evidence**: `schedulerWebview.ts` 内の `extraPresets` 配列が `i18n.ts` の `getCronPresets()` と同一の式・名前を持つプリセットを4件重複定義していた。Webview のドロップダウンに同名項目が2つずつ表示されていた。
- **Action**: プリセットの追加は `getCronPresets()` に一元化し、Webview 側で追加定義しない。

### P2: getGlobalPromptsRoot が extension.ts と schedulerWebview.ts で重複

- **Tags**: `コード品質` `設計`
- **Added**: 2026-02-23
- **Evidence**: グローバルプロンプトのルートディレクトリ解決（設定読み取り + APPDATA フォールバック + existsSync）が2ファイルに同一ロジックとして存在していた。
- **Action**: パス解決ロジックは `promptResolver.ts` に集約する。設定値の読み取りは呼び出し元で行い、純粋な解決関数にはパラメータとして渡す（テスタビリティ向上）。

### P3: Webview の innerHTML 組み立てでエスケープが不統一

- **Tags**: `セキュリティ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `media/schedulerWebview.js` のタスクカード描画で、`cronText` や `taskName` は `escapeHtml()` 済みだが、`nextRun`（`toLocaleString()` 結果）は未エスケープだった。また、アクションボタンの `title` 属性も一部のみ `escapeAttr()` 適用で不統一だった。
- **Action**: `innerHTML` で組み立てるHTMLでは、ユーザー入力・動的値の全箇所に `escapeHtml()` / `escapeAttr()` を適用する。i18n 文字列でも属性コンテキストでは `escapeAttr()` を使う。既存コードに追加する際は、同一テンプレート内の他の値のエスケープ状況も確認する。

### P4: MarkdownString の appendMarkdown にユーザー入力を直接渡さない

- **Tags**: `セキュリティ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: `treeProvider.ts` の `createTooltip()` で `task.name`（ユーザー入力）を `appendMarkdown()` にそのまま埋め込んでおり、`#` `*` `_` 等を含む名前でツールチップのフォーマットが崩れた。`task.agent`/`task.model` も同様に未エスケープだった（カスタムエージェント名は `.agent.md` ファイル名由来で `_` 等を含みうる）。
- **Action**: `appendMarkdown()` にユーザー入力や外部由来の文字列を埋め込む場合は、マークダウン特殊文字をバックスラッシュエスケープするか、`appendText()` を使う。同一テンプレート内の全動的値を一括確認する。

### P5: duplicateTask でフィールドコピー漏れ

- **Tags**: `バグ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `scheduleManager.ts` の `duplicateTask()` で `CreateTaskInput` を組み立てる際、`jitterSeconds` がコピーされていなかった。元タスクで jitter=0（無効）に設定していても、複製先はグローバルデフォルト（600秒）になり、ユーザーの意図に反する動作になった。
- **Action**: `duplicateTask` 等の「既存オブジェクトから入力を組み立てる」パターンでは、元の型の全フィールドが反映されているかレビュー時に確認する。特に後から追加されたフィールド（`jitterSeconds` のようなオプショナルプロパティ）は漏れやすい。

### P6: コマンド追加時にテストの expectedCommands も更新する

- **Tags**: `コード品質` `非機能`
- **Added**: 2026-02-24
- **Evidence**: `enableTask`, `disableTask`, `moveToCurrentWorkspace` の3コマンドが `extension.ts` に登録されていたが、`extension.test.ts` の `expectedCommands` 配列に含まれていなかった。テストが不完全なまま通過していた。
- **Action**: 新しいコマンドを `registerXxxCommand` で追加したら、`extension.test.ts` の `expectedCommands` 配列にも追加する。PR レビュー時にコマンド数の不一致をチェックする。

### P7: Webview CSS で使用する class が定義されているか確認する

- **Tags**: `UI/UX` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `schedulerWebview.ts` の HTML 内で `<p class="note">` を使用していたが、対応する `.note` CSS ルールが `<style>` ブロックに存在しなかった。注記テキストがデフォルトスタイルで表示されていた。
- **Action**: テンプレートリテラルで HTML を生成する際、使用する CSS クラスがすべてインラインスタイルブロックに定義されているかを確認する。特に後から追加した要素のクラス名は漏れやすい。

### P8: resolveGlobalPromptsRoot のクロスプラットフォーム対応

- **Tags**: `バグ` `非機能`
- **Added**: 2026-02-24
- **Evidence**: `resolveGlobalPromptsRoot` が `APPDATA` 環境変数（Windows専用）のみをフォールバックとしていたため、macOS/Linux ではカスタムパスを設定しない限りグローバルテンプレートが一切使えなかった。
- **Action**: VS Code の設定ディレクトリはプラットフォームごとに異なる（Windows: `%APPDATA%/Code`、macOS: `~/Library/Application Support/Code`、Linux: `$XDG_CONFIG_HOME/Code` or `~/.config/Code`）。デフォルトパスのフォールバックは全対象プラットフォームをカバーする。

## Universal（汎用 — 追加分）

### U13: 二重 try-catch でエラーを再ラップしない

- **Tags**: `コード品質` `バグ`
- **Added**: 2026-02-24
- **Evidence**: `validateCronExpression` で内側の catch が `throw new Error(msg)` し、外側の catch がそれを捕まえて同じメッセージで `new Error(msg)` を再 throw していた。エラーメッセージは同じだが、元の `parseExpression` のスタックトレースが消失し、デバッグが困難になる。
- **Action**: try-catch のネストで同じエラーを再ラップしない。外側の catch が必要なのは「内側で処理しきれないケース」のみ。内側の catch 内で最終的な throw を行うなら、外側の catch は不要。

### U14: String.replace() の第2引数にユーザー由来の値を直接渡さない

- **Tags**: `バグ` `セキュリティ`
- **Added**: 2026-02-24
- **Evidence**: `applyPromptCommands` で `result.replace(/\{\{workspace\}\}/gi, workspaceName)` のように外部由来の値を直接渡していた。`$&`, `$'`, `` $` `` を含むワークスペース名やファイルパスがあると、replace の特殊置換パターンとして解釈されプロンプトテキストが破損する。
- **Action**: `String.prototype.replace()` で置換文字列に外部入力やファイルパスを使う場合は、関数 replacer `() => value` を使い特殊パターン解釈を防ぐ。安全なのは自分で組み立てたリテラル文字列のみ。

### U15: 失敗した操作のタイムスタンプを「成功」として記録しない

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: `checkAndExecuteTasks` でタスク実行の try-catch の外（つまり成功・失敗問わず）で `task.lastRun = executedAt` を設定していた。実行が失敗してもユーザーには「最終実行: XX:XX」と表示され、正常に実行されたと誤認される。
- **Action**: 成功時のみタイムスタンプを記録する（lastRun は try 内）。リトライ防止用のスケジュール進行（nextRun）は常に行う。「最終試行」と「最終成功」を区別する必要がある場合はフィールドを分ける。

### U16: i18n 文字列も HTML コンテキストに応じてエスケープする

- **Tags**: `セキュリティ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: Webview HTML テンプレート（`schedulerWebview.ts`）で `placeholder` 属性に i18n 文字列を `escapeHtmlAttr()` なしで埋め込んでいた箇所があった（`placeholderTaskName`, `placeholderPrompt`）。同テンプレート内の他の placeholder（`placeholderCron`）はエスケープ済みで不統一だった。同様に `media/schedulerWebview.js` で `strings.noTasksFound` 等のi18n文字列が `escapeHtml()` なしで `innerHTML` に注入されていた。
- **Action**: i18n 文字列は開発者管理だが、属性コンテキスト（`placeholder=`, `title=` 等）では `escapeHtmlAttr()` を、要素テキストコンテキストで `innerHTML` に挿入する場合は `escapeHtml()` を適用する。修正時は同一テンプレート内のすべての動的値のエスケープ状況を網羅チェックする（1箇所だけ修正して他を放置しない）。

### U17: ロケール変更時にキャッシュ内のローカライズ済みデータを再構築する

- **Tags**: `UI/UX` `バグ`
- **Added**: 2026-02-24
- **Evidence**: `SchedulerWebview.refreshLanguage` で Webview HTML は新言語で再生成されたが、`cachedAgents`/`cachedModels` 内のローカライズ済み名称（"なし"/"None", "デフォルト"/"Default"）が旧言語のままだった。言語切り替え後にエージェント/モデルのドロップダウンだけ旧言語で表示された。さらに、非同期でキャッシュを再取得する前に HTML を生成していたため、初期表示が旧言語になる問題が残っていた。
- **Action**: `isJapanese()` 等のロケール依存関数で組み立てたデータをキャッシュしている場合、ロケール変更イベント時にキャッシュを無効化して再構築する。初期 HTML 埋め込みデータとメッセージ送信経由データの両方が対象。**同期的に取得可能なデータ（ビルトイン一覧等）は HTML 再生成前に同期更新し、非同期データ（API 取得等）は後続の非同期更新に任せる**。これにより初期表示のフラッシュを最小化できる。

### U18: WebviewPanel は `deactivate()` で明示的に dispose する

- **Tags**: `非機能` `リソース管理`
- **Added**: 2026-02-24
- **Evidence**: `SchedulerWebview.panel` が `context.subscriptions` に push されておらず、`deactivate()` でも dispose されていなかった。extension 無効化時に panel が非機能のまま残り、ユーザーにはフリーズしたように見える可能性があった。
- **Action**: `vscode.window.createWebviewPanel()` で作成した panel は、`context.subscriptions` に追加するか、`deactivate()` から明示的に `panel.dispose()` を呼ぶ。static クラスで管理している場合は `dispose()` static メソッドを用意して `deactivate()` から呼び出す。

### U19: Webview 内の日付フォーマットもアプリのロケール設定を反映する

- **Tags**: `UI/UX` `バグ`
- **Added**: 2026-02-24
- **Evidence**: `media/schedulerWebview.js` で `toLocaleString()` をロケール引数なしで呼んでおり、拡張側の `copilotScheduler.language` 設定（ja/en/auto）が反映されなかった。VS Code の言語が en でも拡張設定が ja の場合、Tree View は日本語書式だが Webview のタスク一覧は英語書式で表示された。
- **Action**: Webview で日付や数値をフォーマットする場合、アプリのロケール設定を `initialData` 経由で渡し、`toLocaleString(locale)` のように明示的に指定する。ブラウザデフォルトに依存しない。

## Project-specific（このワークスペース固有 — 追加分）

### P9: 全タスク変更パスで Webview・TreeView の更新を統一する

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: `registerCreateTaskCommand`（CLI 経由のタスク作成）だけ `SchedulerWebview.updateTasks()` が欠落しており、Webview が開いている状態で CLI からタスクを作成してもタスク一覧に反映されなかった。他の15以上の変更パス（edit, delete, toggle, duplicate 等）ではすべて呼ばれていた。
- **Action**: タスクの CRUD 操作を行うコマンドを追加・変更したら、`SchedulerWebview.updateTasks()` と `treeProvider.refresh()` の呼び出し有無を全パスで確認する（TreeView は `notifyTasksChanged` 経由で自動更新されるが、Webview は明示呼び出しが必要）。

## Universal（汎用 — 追加分 2）

### U20: 失敗した操作を即リトライするとユーザー通知が重複する

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: `runTaskNow` が内部で `executeTask` を呼び出し失敗すると `false` を返すが、呼び出し元が即座に同じ `executeTask` をフォールバックとして再実行していた。`executePrompt` は失敗時に自身でユーザー向け warning を表示するため、リトライにより同一の警告ダイアログが2回連続表示された。さらにリトライは同一コード・同一入力のため成功する可能性がなかった。
- **Action**: ユーザー通知を含む操作のフォールバック/リトライでは、(1) 同一コードの即時再実行は避ける（原因が変わらなければ結果も同じ）、(2) エラー通知を含む関数の呼び出し回数を意識し、重複通知を防ぐ。`executePrompt` のように「自分でエラー UI を出して re-throw する」パターンの関数は、呼び出し元でリトライすると通知が倍になる。

### U21: 安全機構（免責事項・警告）は全操作経路に適用する

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: CLI タスク作成パス（`registerCreateTaskCommand`）で `maybeShowDisclaimerOnce` が欠落しており、GUI では表示される ToS リスク警告を CLI 経由で回避できた。P9（UI 更新パスの統一）と同じ根本原因で、CLI パスは GUI パスの「劣化コピー」になりやすい。
- **Action**: 安全機構（免責事項ダイアログ、レート制限チェック、警告表示）を追加する際は、CLI・GUI・TreeView すべての操作パスに適用されているか確認する。特に CLI パスは GUI パスの実装後に追加されることが多く、新しいチェックが漏れやすい。

### U22: 設定変更時にキャッシュ済み計算値を無効化・再計算する

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: `copilotScheduler.timezone` 設定を変更しても、既存タスクの `nextRun`（旧 timezone で計算済み）が再計算されなかった。ユーザーが timezone を変更しても、タスクが次に実行されるまで新しい timezone が反映されず、誤った時刻に実行される。U17（ロケール変更時のキャッシュ再構築）と同じパターンだが、対象が「表示」ではなく「実行ロジック」であるためバグの深刻度が高い。
- **Action**: 設定項目を `onDidChangeConfiguration` で監視する際、その設定に依存する計算済みデータ（`nextRun`、キャッシュ、フォーマット済みテキスト等）を洗い出し、変更時に再計算する。特に timezone やロケールのように広範囲に影響する設定は、全関連データの更新が必要。

## Project-specific（このワークスペース固有 — 追加分 2）

### P10: ファイル種別ごとにスキャン対象を正しくフィルタリングする

- **Tags**: `UI/UX` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `getPromptTemplates()` が `.md` 拡張子のみでフィルタリングしていたため、`.agent.md`（エージェント定義ファイル）もプロンプトテンプレートとして「テンプレート選択」ドロップダウンに表示されていた。同じフォルダ（`.github/prompts/` やグローバル prompts フォルダ）にプロンプトとエージェントが共存する設計のため発生しやすい。
- **Action**: 同一ディレクトリに複数種別のファイルが共存する場合、スキャン関数では「その種別に該当しないファイル」を明示的に除外する。特に `.agent.md` と `.prompt.md` など拡張子に意味を持たせる規約がある場合、`endsWith(".md")` だけでなく `endsWith(".agent.md")` 等のネガティブフィルタも追加する。

### P11: duplicateTask のコピー名サフィックスも i18n 化する

- **Tags**: `UI/UX` `i18n`
- **Added**: 2026-02-24
- **Evidence**: `scheduleManager.ts` の `duplicateTask()` でコピー名に `" (Copy)"` をハードコードしていた。日本語環境で「タスク名 (Copy)」と英語混じり表示になった。
- **Action**: タスク名やファイル名に付加するサフィックス（`(Copy)`, `(New)` 等）も `messages.*` で管理する。ハードコードは UI 文言として扱う。

### P14: コマンド追加・文言変更時は README のコマンド一覧も同期する

- **Tags**: `コード品質` `UI/UX` `非機能`
- **Added**: 2026-02-24
- **Evidence**: `package.json` / `package.nls*.json` 側でコマンドが追加・更新されても、README のコマンド表が追従せず、存在しない/名称の違うコマンドが記載されるズレが起きた。
- **Action**: コマンドを追加・改名・表示名変更（NLS）したら、(1) `extension.test.ts` の expectedCommands、(2) README/README_ja のコマンド一覧、(3) `package.nls*.json` を同じタイミングで更新する。

## Universal（汎用 — 追加分 3）

### U23: エラーを飲み込むラッパー関数は呼び出し元の成否判定を壊す

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: `executeTask()` が `executePrompt()` の例外を catch してログのみ行い re-throw しなかった。呼び出し元（`checkAndExecuteTasks`, `runTaskNow`）は成否を例外の有無で判定しているため、実行失敗時にも `lastRun` 記録・日次カウント消費が行われた（U15 の再発パターン）。
- **Action**: 「ログ＋ユーザー通知」と「成否の伝播」は分離する。wrapper 関数がエラーをログしつつも呼び出し元に成否を伝える必要がある場合、catch 後に re-throw するか、成功/失敗を示す戻り値を返す。`catch` でエラーを飲み込む場合は、呼び出し元が成否を判定しないことを前提条件として文書化する。

### U24: スケジューラ等の有効/無効トグルでもキャッシュ済み計算値を再計算する

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: `copilotScheduler.enabled` を false→true に切り替えた際、`startScheduler()` は呼ばれるが `recalculateAllNextRuns()` が呼ばれなかった。無効期間中に過去になった `nextRun` がそのまま残り、再有効化直後の最初の tick で全対象タスクが一斉実行（バースト）した。timezone 変更時には `recalculateAllNextRuns()` を呼んでいたため、同一設定クラス内での対応漏れ。U22 の派生パターン。
- **Action**: `onDidChangeConfiguration` で「動作の有効/無効」を切り替える設定を監視する際、有効化時にはそのコンポーネントが保持するキャッシュ済み計算値（`nextRun` 等）も再計算する。特に「無効期間中に時間が経過する」設定は、再有効化後のバースト実行を防ぐために再計算が必要。

### U25: 「パース失敗時のフォールバック」で現在時刻を返さない

- **Tags**: `バグ` `回復性`
- **Added**: 2026-02-24
- **Evidence**: `getNextRunForTask` が cron パース失敗時のフォールバックとして `truncateToMinute(baseTime)`（≒現在時刻）を返していた。スケジューラの tick は毎分実行されるため、パース失敗が継続する間、タスクが毎分実行される高速ループが日次上限まで続く可能性があった。
- **Action**: スケジューラの「次回実行時刻」をフォールバック計算する際は、必ず十分な未来時刻（例: +60分）を返す。「現在時刻」をフォールバックに使うと、ポーリングベースのスケジューラでは即時再実行のループになるリスクがある。同様に、リトライ間隔のフォールバックでも 0 や「即時」は避ける。

### U26: onDidChangeConfiguration で同一副作用を持つ複数ハンドラを統合する

- **Tags**: `設計` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `onDidChangeConfiguration` で `timezone` と `enabled` の各ブランチがそれぞれ独立に `recalculateAllNextRuns()` を呼んでいた。VS Code はユーザーが settings.json を直接編集した場合など、1イベントで複数設定の変更を通知する。両方が同時に変更されると `recalculateAllNextRuns()` が2回起動し、2重の保存と UI 更新が発生した。
- **Action**: `onDidChangeConfiguration` ハンドラ内で同一の高コスト操作（再計算、API 呼び出し等）を複数ブランチからトリガーする場合、フラグで統合して1回のみ実行する。各ブランチでは設定固有の軽量処理（start/stop 等）のみ行い、共通の副作用はハンドラの末尾でまとめて実行する。

### U27: Webview アクションが拡張側ロジックを必要とする場合は action callback 経由にする

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: Webview のタスクカード「コピー」ボタンが `{ type: "copyPrompt", prompt: task.prompt }` のようにローカルデータ（JS 側の `tasks[]` 配列）をそのまま送信していた。テンプレートベースのタスク（`promptSource === "local"/"global"`）では、ファイルの最新内容ではなく同期済みの古い `prompt` がコピーされ、TreeView 経由の同等操作（`resolvePromptText()` を呼ぶ）と結果が不一致になった。
- **Action**: Webview のアクションボタンが拡張側の処理（ファイル解決、バリデーション、確認ダイアログ等）を伴う場合、データをそのまま送信するのではなく `taskId` のみ送って `onTaskActionCallback` 経由で共通ハンドラに委譲する。同一操作の複数経路（Webview / TreeView / コマンドパレット）で同じコードパスを通ることを確認する。

### U28: ファイル拡張子の除去には `path.basename(file, ext)` を使う

- **Tags**: `バグ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `getPromptTemplates()` で `file.replace(".md", "")` を使ってテンプレート表示名を導出していたが、`String.replace()` は最初の一致のみ置換する。`notes.md.backup.md` のようなファイル名では `.md` がサフィックスではなく途中で除去され、誤った名前 `notes.backup.md` になる。同プロジェクト内で `getCustomAgents()` は正しく `path.basename(file.fsPath, ".agent.md")` を使用しており、不統一だった。
- **Action**: ファイル拡張子を除去して表示名を生成する場合は `path.basename(filename, ".ext")` を使う。`String.replace(".ext", "")` は最初の一致のみ置換するため、拡張子がファイル名の途中にも含まれる場合に誤動作する。代替として `filename.replace(/\.ext$/i, "")` も安全。

### U29: 重複ユーティリティ関数はエクスポートして共有する

- **Tags**: `コード品質` `設計`
- **Added**: 2026-02-24
- **Evidence**: パス正規化関数 `normalizeForCompare` が `promptResolver.ts`・`templateValidation.ts`・`scheduleManager.ts` の3ファイルに同一ロジックとして存在していた。修正時に1箇所だけ更新して他を忘れるリスクがあった。
- **Action**: 同一ロジックが2ファイル以上で重複した場合、最も適切なモジュールからエクスポートして他はインポートする。特にセキュリティ・パス検証系の関数は一箇所で管理し、修正漏れを防ぐ。

### U30: cron パターンの「固定間隔」ショートカットは cron グリッドからドリフトする

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-24
- **Evidence**: `getNextRunForTask` が `*/N * * * *` パターンを検出して `baseTime + N分` で次回実行を計算する最適化を持っていた。ジッター遅延や実行時間で `baseTime` がグリッドからずれると、次回実行もずれ、実行ごとにドリフトが蓄積した（例: `*/5` で 09:05 にジッター2分 → 09:07 → 次回が 09:12 になる。cron-parser なら 09:10）。
- **Action**: cron の次回実行時刻は常に cron-parser（グリッドアライン）で計算する。「baseTime + N」方式の固定間隔最適化は、ジッターやリトライなど baseTime がずれるケースでドリフトを引き起こすため避ける。cron-parser は `*/N` パターンにも高速に対応する。

### U31: VS Code 拡張ではファイルシステム操作に `vscode.workspace.fs` を統一する

- **Tags**: `コード品質` `非機能`
- **Added**: 2026-02-24
- **Evidence**: `getGlobalAgents()` が `fs.promises.readdir` を使用し、同機能の `getPromptTemplates()` は `vscode.workspace.fs.readDirectory` を使用していた（API 不統一）。`fs` モジュール直接使用はリモート開発（SSH / WSL / Codespaces）で仮想ファイルシステムに対応できない。
- **Action**: VS Code 拡張内のファイル読み書きは `vscode.workspace.fs`（`readFile`, `readDirectory`, `writeFile`）を優先する。Node.js `fs` は `vscode.workspace.fs` でカバーできないケース（同期読み取り、`existsSync` 等）に限定する。同一ファイル内で API が混在する場合はレビュー時に指摘する。

### P12: Tooltip や二次的 UI のハードコード i18n に注意する

- **Tags**: `i18n` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `treeProvider.ts` の `createTooltip()` で11箇所の `ja ? "..." : "..."` パターンがハードコードされていた。該当する `messages.*` 関数（`labelStatus`, `labelSchedule`, `labelAgent` 等）はすべて既に `i18n.ts` に存在していたが、tooltip 構築時には使用されていなかった。Webview や TreeView のメインラベルは i18n 移行済みだったが、tooltip のような「二次的な表示」が漏れていた。
- **Action**: tooltip、ステータスバー、プログレス通知など、メイン UI 以外の表示箇所も `messages.*` を使う。新規にラベルを追加する際は、まず既存の `messages.*` に同じ意味の関数がないか確認し、不足分のみ追加する。レビュー時は `isJapanese()` の直接使用箇所を検索し、`messages.*` で置換可能な箇所がないかチェックする。

## Universal（汎用 — 追加分 4）

### U32: 複数ソースからエンティティを収集する際は ID フォーマットを統一する

- **Tags**: `バグ` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `CopilotExecutor.getCustomAgents()` はワークスペースの `.agent.md` エージェントに `@` プレフィックスを付けた `id`（例: `@foo`）を生成していたが、`getGlobalAgents()` は同じ `.agent.md` ファイルに対してプレフィックスなしの `id`（例: `foo`）を生成していた。`getAllAgents()` の重複排除が `id` をキーに行われるため、同名エージェントがワークスペースとグローバルの両方に存在する場合、異なる `id`（`@foo` vs `foo`）として重複表示された。実行時の出力は同一（どちらも `@foo prompt` になる）だが、UI の整合性が崩れていた。
- **Action**: 複数のソース（ローカル/グローバル/API等）からエンティティを収集して重複排除する場合、すべてのソースで `id` フォーマット（プレフィックス、大小文字、正規化）を統一する。特にプレフィックス（`@`, `/`, `#` 等）は1箇所のヘルパー関数で付与し、ソースごとに異なるルールにしない。

### P13: データオブジェクト内のローカライズ文字列も messages.\* を使う

- **Tags**: `i18n` `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `copilotExecutor.ts` の `getBuiltInAgents()` / `getFallbackModels()` 等で、エージェント名・説明・モデル名を `isJapanese() ? "..." : "..."` でハードコードしていた（計13箇所）。過去に対応する `messages.*` エントリが存在したが U4 でデッドコードとして削除され、元のハードコードが残った。P12 で treeProvider は修正されたが copilotExecutor は見落とされていた。
- **Action**: デッドコード削除（U4）時に、対応する i18n メッセージが「未使用」なのか「消費側が `messages.*` を使うべきなのに `isJapanese()` 直接呼出しで参照していない」のかを区別する。後者の場合はメッセージを削除するのではなく、消費側を `messages.*` に移行する。レビュー時は `isJapanese()` を全文検索し、データオブジェクト（AgentInfo, ModelInfo 等）内のローカライズ文字列も対象に含める。

## Universal（汎用 — 追加分 5）

### U33: VS Code コマンドハンドラの async コールバックには try/catch を統一する

- **Tags**: `バグ` `回復性`
- **Added**: 2026-02-24
- **Evidence**: `extension.ts` の14コマンドハンドラのうち7つ（`deleteTask`, `toggleTask`, `enableTask`, `disableTask`, `runNow`, `copyPrompt`, `duplicateTask`）に try/catch がなかった。`saveTasks()` が file と globalState の両方で失敗した場合、ユーザーにエラーが通知されず unhandled promise rejection になった。同ファイルの `createTask` と `moveToCurrentWorkspace` は正しく try/catch があり、パターンが不統一だった。
- **Action**: `registerCommand` の async コールバックには必ず try/catch を入れ、catch 内で `notifyError(errorMessage)` 等のユーザー向け通知を行う。新規コマンド追加時は既存コマンドの catch パターンをコピーして揃える。コマンド数が多い場合は共通ラッパー関数で統一する。

## Universal（汎用 — 追加分 6）

### U34: 末尾セパレータ除去で POSIX ルート `/` を空文字にしない

- **Tags**: `バグ` `非機能` `設計`
- **Added**: 2026-02-24
- **Evidence**: Webview 側のパス比較で `replace(/\/+$/, "")` のように末尾スラッシュを削除すると、パスが `/` のとき結果が空文字になり得る。これにより「同一ワークスペース判定」などが誤り、UI 上のボタン表示や注記がズレる。
- **Action**: 正規化関数で末尾セパレータを落とす場合は、ルート相当（`/`、Windows のドライブルート等）を特別扱いし、空文字に潰さない。比較用の正規化と表示用の整形を混同しない。

### U35: MarkdownString の code fence はユーザー入力の ``` で崩れる

- **Tags**: `バグ` `UI/UX`
- **Added**: 2026-02-24
- **Evidence**: `MarkdownString.appendCodeblock()` などでユーザー入力（プロンプト等）をコードブロックとして表示すると、内容に ``` が含まれる場合にフェンスが壊れてツールチップの表示が崩れる。
- **Action**: ユーザー入力をコードブロック表示する場合は、``` を含むケースを検出してフォールバック（`appendText()` に切り替える、またはより長い fence を使う）を入れる。

### U36: 設定UIの既定パス例を実装と同期する

- **Tags**: `UI/UX` `非機能` `i18n`
- **Added**: 2026-02-25
- **Evidence**: 設定説明（`package.nls*.json`）の `globalPromptsPath` / `globalAgentsPath` で、既定パス例が `User/prompts` のサブパスや Linux の `$XDG_CONFIG_HOME` ケースを欠き、実装（`resolveGlobalPromptsRoot`）と不一致になっていた。
- **Action**: 既定パスを決める実装（`resolveGlobalPromptsRoot` 等）を変更/拡張したら、NLS/README/仕様書にある「既定パス例」も同時に更新して整合を保つ。

### U37: ユーザー向け UI に内部スタックトレースや絶対パスを出さない

- **Tags**: `セキュリティ` `UI/UX` `非機能`
- **Added**: 2026-02-25
- **Evidence**: Webview 側の操作失敗時に `error.stack` を UI に表示し得る実装だと、スタックトレース（場合によってはパス情報）が画面に露出する。加えて、テンプレート読込失敗ログに絶対パスを含めると、既定ログレベル（info）でも個人情報を含むパスが残り得る。
- **Action**: ログ出力用の詳細（stack 等）とユーザー表示用の文言（message 等）を分離する。ユーザー向け UI は最小限の情報に留め、ログも必要最小限にしてファイルパスは basename 等へ縮約する。

### U38: プラットフォーム固有語彙は無理に翻訳せず UI 文脈で使い分ける

- **Tags**: `i18n` `UI/UX` `一貫性`
- **Added**: 2026-02-28
- **Evidence**: VS Code ではエージェントピッカー等の主要 UI で固有名詞として `Agent` が表示される一方、説明文や設定説明まで同じ表記に寄せると日本語として不自然になりやすい。
- **Action**: 固有モード名・ピッカー項目など「製品 UI の呼称」は `Agent` を優先し、説明文・ヘルプ・設定説明は自然な日本語 `エージェント` を使う。語彙方針を変更したときは `src/i18n.ts`・`package.nls.ja.json`・`README_ja.md` を同時に確認する。

### U39: 拡張独自の language 設定と VS Code Display Language の影響範囲を明示する

- **Tags**: `i18n` `UI/UX` `ドキュメント`
- **Added**: 2026-03-01
- **Evidence**: `copilotScheduler.language = ja` に設定しても、設定画面の説明文（`package.nls*.json` 由来）は VS Code の Display Language で解決されるため英語のままだった。ユーザーが「日本語対応してない？」と誤認した。拡張の独自 `language` 設定は Webview/Tree 等の拡張内 UI にのみ効く。
- **Action**: 拡張が独自の language/locale 設定を持つ場合、その設定の `description` に「何に効くか（Webview/Tree）」と「何には効かないか（設定画面の NLS 文言は VS Code の Display Language に従う）」を明記する。ユーザーが設定変更しても反映されないように見える領域を事前に説明する。

### U40: 設定の description には「影響範囲」と「反映タイミング」を含める

- **Tags**: `UI/UX` `ドキュメント` `i18n`
- **Added**: 2026-03-01
- **Evidence**: `config.language` の説明が「UI言語」の3文字だけで、何に効くか・いつ反映されるかが不明だった。ユーザーが設定変更後に即時反映を期待して混乱した。`package.nls*.json` の NLS 文字列は拡張ロード時に静的バインドされるため、Display Language 変更後は Reload が必要。
- **Action**: 設定の `description`（特にユーザーが即時反映を期待しやすい項目: language, theme, path 系）には、(1) 影響範囲（どの UI に効くか）、(2) 反映タイミング（即時 / Reload 必要 / 再起動必要）を簡潔に含める。README の設定表も同じ情報を反映する。

## Prompt Session States

<!--
各プロンプトは共通の Session Log / Next Steps ではなく、
自分の START/END ブロックだけを上書きすること。
-->

<!-- START:prompt-state:code-review -->

## Prompt Session State: code-review

### Run Meta

- runId: 20260228-231556
- status: success
- startedAt: 2026-02-28T23:11:30.0000000+09:00
- endedAt: 2026-02-28T23:15:56.2680047+09:00
- nextRunHint: 30m

### Carry Over（次回優先）

- Not Done:
  - Auto Mode Hint が実チャットで期待どおりに自律実行指示として機能するかの手動確認（UI操作ベースの確認が必要なため）
  - `commandDelayFactor` の速度体感/失敗率の実測（実運用条件が必要なため）
  - 設定並び順変更後の探索性（目的設定までの到達時間）の手動確認（定量観測が未実施のため）
- Next Steps:
  - [ ] Auto Mode Hint の frontmatter有/無ケースを実チャットで手動実行し、意図した実行挙動になることを確認 `~3d`
  - [ ] `commandDelayFactor` を 0.1 / 0.5 / 1.0 / 2.0 で手動実行し、速度体感と失敗率のバランスを測定して推奨値を README に反映 `~7d`（継続理由: 実運用条件での計測が未完了）
  - [ ] 設定並び順変更後の UX を5操作で観測し、迷いが出る項目があれば説明文を補強 `~7d`

### Todo Queue

- [ ] Auto Mode Hint の手動確認ログ（frontmatter有/無）を1セット採取

### Learnings Delta

- Auto Mode の重複判定を自然言語キーワード（auto/自動）だけで行うと誤抑止が起きやすい。定型ヒント完全一致 + 行単位トークン判定の併用が安全。
- 設定表示順を変更した場合、`package.json` だけでなく README / README_ja の設定表順も同時同期しないとユーザー向け整合が崩れる。
<!-- END:prompt-state:code-review -->

<!-- START:prompt-state:code-fix-error -->

## Prompt Session State: code-fix-error

### Run Meta

- runId: <YYYYMMDD-HHmmss>
- status: success|partial|failed
- startedAt: <ISO8601>
- endedAt: <ISO8601>
- nextRunHint: 15m|30m

### Carry Over（次回優先）

- Not Done:
  - なし
- Next Steps:
  - [ ] <確認または新観点> `~7d`

### Todo Queue

- [ ] <次回の実行タスク>

### Learnings Delta

- なし
<!-- END:prompt-state:code-fix-error -->

<!-- START:prompt-state:code-hard-builder -->

## Prompt Session State: code-hard-builder

### Run Meta

- runId: <YYYYMMDD-HHmmss>
- status: success|partial|failed
- startedAt: <ISO8601>
- endedAt: <ISO8601>
- nextRunHint: 15m|30m

### Carry Over（次回優先）

- Not Done:
  - なし
- Next Steps:
  - [ ] <確認または新観点> `~7d`

### Todo Queue

- [ ] <次回の実行タスク>

### Learnings Delta

- なし
<!-- END:prompt-state:code-hard-builder -->
