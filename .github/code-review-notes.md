# Review Learnings

## Universal（汎用 — 他プロジェクトでも使える）

### U1: ユーザー向けエラー詳細のパス露出は「引用符＋スペース」で漏れやすい

- **Tags**: `セキュリティ` `UI/UX`
- **Added**: 2026-02-25
- **Evidence**: Node.js の典型的なエラーメッセージ（例: `open '...path...'`）は、絶対パスが引用符で囲まれ、かつスペースを含みうる。単純な「空白まで」regex だと basename 置換が部分一致になり、絶対パスが UI に露出し続ける。
- **Action**: ユーザー向け表示に載せるエラー詳細は、(1) 引用符で囲まれた Windows/posix 絶対パス、(2) 非引用符の Windows 絶対パス、をそれぞれ basename に短縮してから表示する。回帰テストで Windows/posix の代表ケース（スペース含む）を押さえる。

### U2: パスの basename 化は OS 非依存にする（win32/posix を明示）

- **Tags**: `セキュリティ` `バグ`
- **Added**: 2026-02-25
- **Evidence**: エラーメッセージに Windows パス（`C:\...`）が含まれる場合、実行環境が macOS/Linux だと `path.basename()` は `\` を区切りと認識せず、ディレクトリ部分を削れない（= 絶対パスが露出し続ける）可能性がある。
- **Action**: 正規表現で Windows/posix のパス種別を判定しているなら、basename 化も `path.win32.basename` / `path.posix.basename` を使い分ける。クロスOSを想定した回帰テスト（Windows文字列をposix環境でも通す）を追加する。

### U3: サニタイズは UI 境界で必ず適用する（呼び出し元依存にしない）

- **Tags**: `セキュリティ` `UI/UX` `設計`
- **Added**: 2026-02-25
- **Evidence**: `notifyError()` 側でサニタイズしていても、Webview の `showError()` や `window.onunhandledrejection` が生の `Error`（`ENOENT: open 'C:\\...'` 等）をそのまま表示すると、絶対パスが UI に露出し得る。
- **Action**: ユーザー表示の入口（Webview の `showError()` / グローバルハンドラ等）で必ずサニタイズを適用し、呼び出し元が生の `error.message` を渡しても漏れないようにする。境界の回帰テストも追加する。

## Project-specific（このワークスペース固有）

## Session Log

<!-- 2026-02-25 -->

### Done

- `notifyError()` が `notificationMode = silentToast` のとき静かなトースト経路で表示されるよう修正
- `resolvePromptText()` の `readFile` 失敗ログで生の `error.message` を出さず、サニタイズ済み文字列へ統一
- `media/schedulerWebview.js` の unquoted POSIX パス用サニタイズ正規表現を拡張側実装と整合
- `get_errors` / `npm run compile` / `npm test` / `runSubagent` を実施し、回帰なし（35 passing, 2 pending）を確認

### Not Done

- なし

## Next Steps

### 確認（今回やったことが効いているか）

- [ ] 通知確認: `copilotScheduler.notificationMode = silentToast` 時にエラーがモーダルではなくトースト通知で表示される `~3d`
- [ ] ログ確認: テンプレート読み込み失敗時の `resolvePromptText` デバッグログに絶対パスが含まれない `~3d`

### 新観点（今回は手を付けなかった品質改善）

- [ ] テスト戦略: `notifyError` の通知モード分岐（sound/silentToast/silentStatus）をユニットテストで固定化する `~7d`
- [ ] 設計: `src/errorSanitizer.ts` と `media/schedulerWebview.js` のサニタイズ差分を防ぐ共通テストベクトル運用を検討する `~30d`
