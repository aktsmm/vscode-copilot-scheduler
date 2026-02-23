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

## Project-specific（このワークスペース固有）

### P1: getCronPresets() と extraPresets の重複

- **Tags**: `UI/UX` `コード品質`
- **Added**: 2026-02-23
- **Evidence**: `schedulerWebview.ts` 内の `extraPresets` 配列が `i18n.ts` の `getCronPresets()` と同一の式・名前を持つプリセットを4件重複定義していた。Webview のドロップダウンに同名項目が2つずつ表示されていた。
- **Action**: プリセットの追加は `getCronPresets()` に一元化し、Webview 側で追加定義しない。

### U3: Promise チェーンのエラー伝播による後続処理ブロック

- **Tags**: `バグ` `設計`
- **Added**: 2026-02-23
- **Evidence**: `ScheduleManager.saveTasks` が `this.saveQueue = this.saveQueue.then(...)` で直列化していたが、内部が reject すると `saveQueue` 自体が rejected Promise になり、以降の全保存呼び出しが実行されなくなった。
- **Action**: キューイングパターンで `.then()` チェーンを使う場合、`this.queue = op.catch(...)` で回復し、呼び出し元には `return op` で元のエラーを伝播させる。

## Project-specific（このワークスペース固有）

### P2: getGlobalPromptsRoot が extension.ts と schedulerWebview.ts で重複

- **Tags**: `コード品質` `設計`
- **Added**: 2026-02-23
- **Evidence**: グローバルプロンプトのルートディレクトリ解決（設定読み取り + APPDATA フォールバック + existsSync）が2ファイルに同一ロジックとして存在していた。
- **Action**: パス解決ロジックは `promptResolver.ts` に集約する。設定値の読み取りは呼び出し元で行い、純粋な解決関数にはパラメータとして渡す（テスタビリティ向上）。

### U4: エクスポートされているが未使用のシンボルの蓄積

- **Tags**: `コード品質`
- **Added**: 2026-02-24
- **Evidence**: `cronBuilder.ts`（ファイル全体）、`types.ts` の `TaskExecutionResult`/`ExtensionConfig`、`i18n.ts` の `getAgentDisplayInfo()`、`logger.ts` の `logInfo()` がエクスポートされていたが、プロジェクト内のどこからも参照されていなかった。計4箇所、約200行のデッドコード。
- **Action**: 「将来使うかもしれない」コードはエクスポートしない。必要になった時点で追加する（YAGNI）。定期的に `tsc` の `noUnusedLocals` や ESLint の `no-unused-vars` で未使用シンボルを検出する。ファイル単位で完全に未参照の場合は削除を優先する。
