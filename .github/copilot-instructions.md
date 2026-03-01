# Copilot Instructions (Repo)

このリポジトリは VS Code 拡張「Copilot Scheduler」です。Copilot は **既存の設計/実装方針を壊さず、最小の差分で**修正・改善してください。

## 優先順位

1. **安全性/回復性（スケジューラ・保存・パス検証）**
2. **ユーザー向け表示の一貫性（i18n / UI 文言 / README）**
3. **既存API/挙動の互換性維持**（破壊的変更は避ける）
4. **最小変更**（不要なリファクタ、整形、機能追加はしない）

## 必ず守ること（Do / Don’t）

### Do

- 変更前に `.github/review-learnings.md` を読み、同じ失敗を繰り返さない。
- UI 文言は **ハードコードしない**。
  - `src/i18n.ts` の `messages.*` または `package.nls*.json`（`package.json` の `%key%` 参照）で管理する。
  - Webview 初期HTML（`src/schedulerWebview.ts`）も含めて i18n 文字列に統一する。
- Webview へのメッセージ送信は `SchedulerWebview` のラッパー（ready チェック/キュー）を経由させる。
- ファイルパスの allowlist/ルート内チェックは **解決済み絶対パス**で比較し、Windows の大小文字差も考慮する。
- 設定仕様（例: `0 = off`）は **schema / 実装 / README** を必ず整合させる。
- タイムゾーンなど外部入力が壊れても落ちないように、フォールバック（例: tz なし）で継続できる設計にする。

### Don’t

- `out/` や `node_modules/` を直接編集しない。
- 依頼されていない UI/UX の追加（ページ、モーダル、アニメーション、フィルター等）を入れない。
- 新しい色・フォント・影などのデザインを勝手に導入しない（VS Code テーマ変数を優先）。
- ログに秘密情報（プロンプト全文、パスの過剰露出、トークン等）を出さない。

## i18n / ローカライズ

- `package.json` の `contributes.commands` / `configuration` / `views` / `menus` は **NLS 参照**（`%key%`）を使う。
  - 変更したら `package.nls.json` と `package.nls.ja.json` を両方更新する。
- 拡張コード内の UI 文言は `src/i18n.ts`（`messages.*`）に集約する。

## Webview（CSP / 安全）

- `src/schedulerWebview.ts` の CSP/nonce を維持する。
- Webview 初期データは `application/json` で埋め込み、シリアライズ時に `<` 等をエスケープする（既存の `serializeForWebview` を使う）。
- DOM へ挿入する文字列は必要に応じて `escapeHtmlAttr` / escape を使う。

## パス検証・テンプレート読み込み

- ローカルテンプレートは `.github/prompts/` 配下のみ許可（マルチルート対応）。
- グローバルテンプレートは `resolveGlobalPromptsRoot` の解決結果に限定。
- `path.resolve` / `path.normalize` / 末尾セパレータ除去 /（Windows）小文字化で比較してから判定する。

## スケジューラ（安全・回復性）

- cron の検証は例外で落とさず、ユーザーに分かるエラーにする。
- 無効な timezone はローカル時刻にフォールバックして継続する。
- 保存処理の直列化（キュー）では、1回の失敗が以後の保存を永久にブロックしないように chain を回復する。

## 変更時のチェック（推奨）

- まず `get_errors` をクリーンにする。
- `npm run compile`
- `npm test`
- `npm run lint`（lint を編集した場合）

## レビュー時の出力フォーマット（推奨）

- 重要度: Critical / Important / Suggestion
- 可能なら「ファイル + 行」まで示し、修正方針を 1〜2 行で書く。
