# Stop Slop JA

日本語の文章から AI の書き癖を排除し、技術文書としての論証を締めるスキル。

二系統の規範を統合している。

- **表現の規範（slop 除去）**: [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop)（MIT、Hardik Pandya）の日本語派生。本家のコアルールに日本語固有の AI 癖を追加し、Claude / ChatGPT / Gemini が書いた日本語を「人間が書いた」と感じさせる文章に矯正する。
- **論証と構成の規範**: [k16shikano / japanese-tech-writing](https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d) を統合。パラグラフライティング、論証の厳密さ、見出しの付け方、読者への誠実さを規範化した。

## これは何か

AI が日本語で書いた文章には固有のパターンがある。

- 「実は」「結局」「単に」のような副詞の濫用
- 「ひとつめ」「ふたつめ」のような口語的並列
- 「議論が深まる」「市場が報いる」のような無生物主語＋人間動詞
- 「本質的に重要」「構造的な問題」のような曖昧な断定
- 「両輪が揃った」「象徴する」「物語る」のような安直なまとめ
- 「中心命題」「具体手順」「位置付けられる」のような翻訳調 AI 語
- 「正面から扱う」「多角的に」「掘り下げる」のような中身のない空句

表現だけでなく、論証にも AI 特有の緩みが出る。

- 推量・推定を機械的に断定へ変える（「〜かもしれない」→「〜だ」）
- 別々の決定・原因・問題を「同じ」とまとめる
- 複数の要因がある事象を単一の原因に還元する
- 「A だと B になる」と書いて、なぜそうなるか（機構）を省く
- 「必ず検出できる」のように無条件で言い切る

これらを Claude（または任意の LLM）が検出し、修正する。

## 構造

```
stop-slop-ja/
├── SKILL.md                        # NEVER 27 + 論証と構成の規範 + クイックチェック 23 + 5 軸スコアリング
├── references/
│   ├── phrases.md                  # 削除すべきフレーズ + LLM っぽい空句
│   ├── structures.md               # 避けるべき構造パターン + 整形パターン
│   ├── argumentation.md            # 論証と構成の規範（パラグラフライティング・論証の厳密さ・見出し・誠実さ）
│   ├── examples.md                 # Before/After 変換例
│   └── translationese-judge.md     # 翻訳調 LLM judge ルーブリック（原理ベース）
├── scripts/
│   └── judge-translationese.mjs    # 翻訳調を LLM judge（敵対的 2 段）で surface する
├── README.md
└── LICENSE
```

## 使い方

### Claude Code

このフォルダをスキルとして追加する。

```bash
# Claude Code のスキルディレクトリにシンボリックリンク
ln -s $(pwd) ~/.claude/skills/stop-slop-ja
```

### Claude Projects

`SKILL.md` と `references/` ファイルをプロジェクトナレッジにアップロードする。

### Custom instructions

`SKILL.md` のコアルールを system prompt に貼り付ける。

### API 呼び出し

`SKILL.md` を system prompt に含める。`references/` は必要時にロードする。

## 何を検出するか

### 削除すべきフレーズ
- 前置きの咳払い、強調の松葉杖、副詞、メタコメント、怠惰な極論
- 詳細: [references/phrases.md](references/phrases.md)

### 構造パターン
- 二項対立、否定の列挙、演出的断片化、修辞的お膳立て、無生物主語＋人間動詞、傍観者視点、受動態、Wh-スターター
- 詳細: [references/structures.md](references/structures.md)

### 日本語固有のパターン
- 「〜的」の濫用、「〜という」「することができる」「することが重要だ」
- 口語的並列「ひとつめ / ふたつめ / みっつめ / よっつめ」
- 安直なまとめ表現（陳腐な比喩 / 偶然の必然化 / 過剰意味付け / メタコメント型）

### 翻訳調（translationese）─ LLM judge で検出
英語からの直訳調は **無限に新パターンが生まれる**ため、語リストの列挙では追いつかない。原理ベースの LLM judge で「この文は英語の直訳に読めるか」を文ごとに判定する。

- S1 英語動詞の逐語置換（expose→露出する / ship→出荷する / land→着地する）
- S2 英語形容詞の直訳（hard cap→硬い上限 / live→生きている）
- S3 英語構文のなぞり（"X is nothing but Y"→「X に過ぎない」）
- S4 英語慣用句の逐語訳（"at the end of the day"→「一日の終わりに」）

```bash
# 翻訳調を surface する（レビュー補助。pass/fail ゲートではない）
node scripts/judge-translationese.mjs article.md
node scripts/judge-translationese.mjs article.md --provider openai --json
```

**重要**: 素の LLM judge は「効く / 消える / 賭けだ」のような自然な日本語まで英語に逆翻訳して flag する（false positive 多発）。そのため judge（候補収集）→ critic（敵対的弁護で自然な日本語を棄却）の **敵対的 2 段構成**で precision を回復する。判定には主観的な揺れが残るため、**自動ゲートではなくレビュー補助**として使う。詳細: [references/translationese-judge.md](references/translationese-judge.md)

### 論証と構成 ─ 必須チェック

表現を整えても論理にツッコミどころが残れば技術文書として失格になる。スコアではなく pass/fail で点検する。

- 推量を機械的に断定化していないか
- 別物を「同じ」とまとめていないか／単一原因に還元していないか
- 因果に機構（なぜ）が一文添えられているか
- 「必ず」と無条件に言い切っていないか
- 見出しが内容を特定する句になっているか（手順だけ・結論のセリフでないか）

詳細: [references/argumentation.md](references/argumentation.md)

## スコアリング

各軸 1-10 でレート、合計 35/50 未満は再リライト。

| 軸 | 問い |
|:---|:---|
| Directness（直接性） | 断定しているか、告知に留まっていないか |
| Rhythm（律動） | 文の長さに変化があるか、メトロノーム的でないか |
| Trust（信頼） | 読者の知性を尊重しているか、過剰説明していないか |
| Authenticity（自然さ） | 人間が書いたと感じるか、AI 的か |
| Density（密度） | 削れる箇所はないか、密度が高いか |

## 本家との違い

| 項目 | hardikpandya/stop-slop | stop-slop-ja |
|:---|:---|:---|
| 対象言語 | 英語 | 日本語 |
| Adverbs | -ly words（really / just / literally 等）| とても / まさに / 実は / 結局 等 |
| Wh-starters | What / When / Why 等 | 〜とは何か / なぜ〜なのか 等 |
| Em-dashes | 全面禁止 | 全面禁止（同じ） |
| 日本語固有追加 | - | 〜的の濫用 / 〜という / 口語的並列 / 安直なまとめ / 翻訳調 AI 語 |
| 論証規範 | - | パラグラフライティング / 論証の厳密さ / 見出し / 誠実さ（k16shikano 由来） |
| ルール数 | NEVER 8 + クイックチェック 12 + 5 軸 | NEVER 27 + 論証チェック + クイックチェック 23 + 5 軸 |

## 派生元

- [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) by Hardik Pandya（MIT ライセンス）— 表現の規範
- [k16shikano / japanese-tech-writing](https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d) — 論証と構成の規範

本リポジトリは hardikpandya/stop-slop の派生作品です。本家のルール構造（コアルール + references/ + スコアリング）と Before/After 例の手法を継承し、日本語向けに翻案・拡張しています。論証と構成の規範は k16shikano 氏の japanese-tech-writing を統合したものです。

## ライセンス

MIT License. 自由に利用・共有・派生してください。

---

# Stop Slop JA (English Summary)

Combines two sources: [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) (MIT, Hardik Pandya) for expression-level slop removal, and [k16shikano / japanese-tech-writing](https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d) for argumentation and structure.

This skill teaches Claude (or any LLM) to detect and remove AI writing tells specific to Japanese:
- Adverb overuse (とても, まさに, 実は)
- Conversational ordinal lists (ひとつめ, ふたつめ, みっつめ, よっつめ)
- False agency with inanimate subjects (議論が深まる, 市場が報いる)
- Vague declaratives (本質的に重要, 構造的な問題)
- Cliched closures (両輪が揃った, 象徴する, 物語る)
- Translation-style AI vocabulary (中心命題, 具体手順, 位置付けられる)
- Empty LLM phrasing (正面から扱う, 多角的に, 掘り下げる)

It also tightens argumentation: no mechanical conversion of hedges into assertions, no collapsing distinct things into "the same," no reduction of multi-cause events to a single cause, requiring the mechanism behind any causal claim, and headings that name the topic rather than spoil the conclusion.

27 NEVER rules + argumentation checks + 23 quick checks + 5-axis scoring. MIT licensed.
