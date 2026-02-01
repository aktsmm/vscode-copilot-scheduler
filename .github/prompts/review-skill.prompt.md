# Prompt: Skill Review

スキルの品質をレビューし、改善提案を行う。

## When to Use

- 外部から取り込んだスキルの品質確認
- 新規スキル作成後のセルフレビュー
- 公開前の最終チェック

## Input

- レビュー対象のスキルパス（例: `.github/skills/browser`）

## Review Checklist

### 1. 構造チェック

| 項目         | 確認内容                                       |
| ------------ | ---------------------------------------------- |
| SKILL.md     | 存在するか、YAML frontmatter は正しいか        |
| name         | 必須フィールド、kebab-case 推奨                |
| description  | トリガー条件を含むか（"Use when" パターン）    |
| license      | 明記されているか（外部由来は元ライセンス維持） |
| 不要ファイル | README.md, CHANGELOG.md 等が含まれていないか   |

### 2. 内容チェック

| 項目        | 確認内容                                |
| ----------- | --------------------------------------- |
| 簡潔さ      | 冗長な説明がないか（Claude は賢い前提） |
| 具体例      | 抽象的な説明より具体例があるか          |
| When to Use | 使用タイミングが明確か                  |
| 重複        | 同じ内容が繰り返されていないか          |

### 3. スキル設計原則

| 原則                   | 確認内容                              |
| ---------------------- | ------------------------------------- |
| Progressive Disclosure | 詳細は references/ に分離されているか |
| 自由度の適切さ         | 手順の厳密さがタスクに合っているか    |
| トークン効率           | 500 行以下か、不要な情報がないか      |

### 4. 言語・フォーマット

| 項目           | 確認内容                                  |
| -------------- | ----------------------------------------- |
| 英語           | SKILL.md は英語で記述（日本語コメント可） |
| Markdown       | 正しくフォーマットされているか            |
| コードブロック | 言語指定があるか                          |

## Output Format

````markdown
# Skill Review: {skill-name}

## Summary

[1-2 行の総評]

## Score: ⭐⭐⭐☆☆ (3/5)

## ✅ Good Points

- [良い点 1]
- [良い点 2]

## ⚠️ Issues Found

### Issue 1: [タイトル]

- **Severity**: 🔴 Critical / 🟡 Warning / 🟢 Minor
- **Location**: [該当箇所]
- **Problem**: [問題の説明]
- **Suggestion**: [改善案]

## 📝 Recommended Changes

### Change 1: [タイトル]

```diff
- 古い内容
+ 新しい内容
```
````

## Verdict

- [ ] Ready to use as-is
- [ ] Minor fixes recommended
- [ ] Major revision needed

```

## After Review

レビュー結果に基づき：

1. **Ready to use**: そのまま使用可能
2. **Minor fixes**: 提案された修正を適用
3. **Major revision**: 大幅な書き直しが必要

修正後は再度このプロンプトでレビューすること。
```
