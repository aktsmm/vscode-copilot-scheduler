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
- **Evidence**: `cronBuilder.ts`（ファイル全体）、`types.ts` の `TaskExecutionResult`/`ExtensionConfig`、`i18n.ts` の `getAgentDisplayInfo()`、`logger.ts` の `logInfo()` がエクスポートされていたが、プロジェクト内のどこからも参照されていなかった。計4箇所、約200行のデッドコード。
- **Action**: 「将来使うかもしれない」コードはエクスポートしない。必要になった時点で追加する（YAGNI）。定期的に `tsc` の `noUnusedLocals` や ESLint の `no-unused-vars` で未使用シンボルを検出する。ファイル単位で完全に未参照の場合は削除を優先する。

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
