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

### U4: ファイル拡張子の除去は `path.extname()` を組み合わせて大小文字差を吸収する

- **Tags**: `UI/UX` `バグ` `コード品質`
- **Added**: 2026-02-26
- **Evidence**: テンプレート名生成で `path.basename(file, ".md")` を使うと、`DailyPlan.MD` のような大文字拡張子で `.MD` が残り、ドロップダウン表示名が崩れる。
- **Action**: 拡張子除去は `path.basename(file, path.extname(file))` か `/\.md$/i` を使い、拡張子の大小文字差を吸収する。回帰テストに `.MD` ケースを含める。

### U5: 絶対パスのサニタイズは「未引用＋空白」も別ルールで処理する

- **Tags**: `セキュリティ` `UI/UX` `回復性`
- **Added**: 2026-02-26
- **Evidence**: `open C:/Users/me/secret folder/a b.md` のような未引用かつ空白を含む絶対パスは、no-space 向け正規表現だけでは `secret folder/a b.md` のようにディレクトリ情報が残存し得る。拡張側と Webview 側で同型のサニタイズを持つ場合、どちらか一方だけ修正すると再発する。
- **Action**: サニタイズでは (1) quoted、(2) unquoted-no-space、(3) unquoted-with-spaces を分けて処理し、Extension と Webview の両実装に同じ修正を反映する。回帰テストは Windows/POSIX の未引用+空白ケースを追加する。

### U6: UI自動操作の固定待機はモード別に最小化する

- **Tags**: `UI/UX` `非機能` `回復性`
- **Added**: 2026-02-27
- **Evidence**: Copilot Chat 自動実行で、`new`/`continue` の違いに関係なく同一待機時間を入れると、軽い経路（continue）でも毎回固定遅延が積み上がって体感ラグになりやすい。
- **Action**: 実行モードごとに待機時間を分け、重い経路（新規セッション作成）だけ十分な待機を確保する。互換性のためコマンド順序は維持しつつ、軽い経路は最小待機にする。

### U7: 通知モード分岐の前でエラーログを1回記録する

- **Tags**: `非機能` `ログ` `回復性`
- **Added**: 2026-02-27
- **Evidence**: `notifyError()` が通知モードごとに分岐している場合、特定モード（例: sound）だけ `logError` が呼ばれない実装だと、障害時の追跡ログが環境依存で欠落する。
- **Action**: `notifyError()` ではサニタイズ済みメッセージを分岐前に1回だけログ出力し、UI表示（status/toast/modal）はその後に分岐させる。重複ログは分岐内で出さない。

### U8: マイグレーションで補完した既定値は永続化フラグを立てる

- **Tags**: `バグ` `回復性` `設計`
- **Added**: 2026-02-27
- **Evidence**: 読み込み時マイグレーションで `task.scope` の欠落を `"global"` に補完しても `needsSave` を立てないと、同一revisionで両ストアが存在する経路では保存が発生せず、次回起動でも毎回同じ補完が繰り返される。
- **Action**: 既定値補完・型正規化・不整合修復など「状態を変更するマイグレーション」は、必ず永続化フラグ（`needsSave`）を立てる。修復保存がヒーリング分岐に依存しないよう、補完ロジックと保存条件をセットでレビューする。

## Project-specific（このワークスペース固有）

## Session Log

<!-- 2026-02-27 -->

### Done

- `src/schedulerWebview.ts` でテンプレート読み込み失敗時の重複通知を解消（Webview内エラー表示は維持し、拡張側の追加通知は削除）
- `src/schedulerWebview.ts` の未使用 import（`notifyError`）を削除し、差分を最小化
- `get_errors` / `npm run compile` / `npm test` / `runSubagent` を実施し、回帰なし（PASS）を確認

### Not Done

- `src/errorSanitizer.ts` / `media/schedulerWebview.js` の「未引用・空白あり・拡張子なし」絶対パス短縮: 現状の再現ケース優先で今回は未対応（誤検知リスクがあり、追加テスト設計を先行するため）

## Next Steps

### 確認（今回やったことが効いているか）

- [ ] Webview確認: テンプレート読み込み失敗時にフォーム内エラーのみ表示され、重複した拡張通知が出ないことを確認する `~3d`
- [ ] 回帰確認: テンプレート読み込み成功時のフォーム遷移（選択→内容反映）が従来どおり動作することを確認する `~3d`

### 新観点（今回は手を付けなかった品質改善）

- [ ] セキュリティ: `src/errorSanitizer.ts` と `media/schedulerWebview.js` に「未引用・空白あり・拡張子なし」パスの短縮ルールと回帰テストを追加する `~7d`
- [ ] テスト安定性: `src/test/suite/scheduleManager.test.ts` の scope 永続化ポーリング待機を低速環境でフレーキー化しにくい方式へ改善する `~30d`
