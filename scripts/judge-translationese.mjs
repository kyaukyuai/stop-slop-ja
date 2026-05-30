#!/usr/bin/env node
/**
 * judge-translationese.mjs
 *
 * 日本語テキストの「英語直訳調（translationese）」を LLM judge で検出する。
 * 語リストの列挙ではなく、references/translationese-judge.md の原理シグナル
 * (S1 動詞逐語置換 / S2 形容詞直訳 / S3 構文なぞり / S4 慣用句逐語訳) で判定する。
 *
 * 2 段構成（敵対的検証 / Ramp Inspect 方式）:
 *   Pass 1 (judge):  候補を高 recall で収集（過剰検出を許容）
 *   Pass 2 (critic): 各候補に「これは自然な日本語だ」と反証し、
 *                    反証を生き延びた候補のみを最終 flag とする（precision 回復）
 *
 * 素の 1 パス judge は false positive が極端に多い（自然な日本語まで
 * 英語に逆翻訳して flag する）。critic パスが「default to dismiss」で
 * 弁護することで、明確な直訳だけが残る。
 *
 * 使い方:
 *   node scripts/judge-translationese.mjs <file.md>
 *   cat article.md | node scripts/judge-translationese.mjs
 *   node scripts/judge-translationese.mjs article.md --provider openai --json
 *   node scripts/judge-translationese.mjs article.md --no-critic   # Pass 1 のみ
 *   node scripts/judge-translationese.mjs article.md --verbose      # 棄却も表示
 *
 * オプション:
 *   --provider gemini|openai|anthropic   既定 gemini
 *   --model <name>                        provider 既定モデルを上書き
 *   --json                                JSON のみ出力
 *   --no-critic                           Pass 2 を省略（候補をそのまま出す）
 *   --verbose                             critic が棄却した候補も表示
 *   --threshold high|medium|low           gating 閾値。既定 high
 *
 * 環境変数（provider に応じて 1 つ必要）:
 *   GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
 *
 * exit code:
 *   0 = 閾値以上の最終 flag なし（pass）
 *   1 = 閾値以上の最終 flag あり（要修正）
 *   2 = 設定エラー
 */

import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 180000;

// 非対称モデル: judge は候補収集なので軽量・高速モデル、
// critic は主観的な精査なので上位モデルで精度と安定性を確保する。
const PROVIDER_DEFAULTS = {
  gemini: { judge: 'gemini-2.5-flash', critic: 'gemini-2.5-pro', env: 'GEMINI_API_KEY' },
  openai: { judge: 'gpt-5-mini', critic: 'gpt-5', env: 'OPENAI_API_KEY' },
  anthropic: { judge: 'claude-haiku-4-5', critic: 'claude-sonnet-4-6', env: 'ANTHROPIC_API_KEY' },
};

// 決定性を上げるため judge / critic とも temperature 0 で呼ぶ。
const TEMPERATURE = 0;

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

// ── 引数パース ─────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    provider: 'gemini', model: null, criticModel: null, json: false,
    threshold: 'high', file: null, critic: true, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--critic-model') args.criticModel = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--no-critic') args.critic = false;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--threshold') args.threshold = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (!a.startsWith('-')) args.file = a;
  }
  return args;
}

function printHelp() {
  process.stdout.write(`judge-translationese.mjs ─ 英語直訳調を LLM judge（敵対的 2 段）で surface する

  これは pass/fail の自動ゲートではなく「レビュー補助」です。翻訳調の線引きは
  主観的なため、判定には揺れが残ります。high 候補を書き手に提示し、採否は
  書き手が決める前提で使ってください。

  node scripts/judge-translationese.mjs <file.md> [--provider gemini|openai|anthropic]
       [--model <judge>] [--critic-model <critic>] [--json] [--no-critic]
       [--verbose] [--threshold high|medium|low]
  cat article.md | node scripts/judge-translationese.mjs

  非対称モデル（既定）: judge=軽量モデルで候補収集 / critic=上位モデルで精査
    gemini    judge gemini-2.5-flash  / critic gemini-2.5-pro
    openai    judge gpt-5-mini        / critic gpt-5
    anthropic judge claude-haiku-4-5  / critic claude-sonnet-4-6

  env: GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
`);
}

// ── 入力読み込み + 前処理 ──────────────────────────────
function readInput(file) {
  const raw = file ? readFileSync(file, 'utf-8') : readFileSync(0, 'utf-8');
  return stripNonProse(raw);
}

function stripNonProse(text) {
  let t = text;
  t = t.replace(/^---\n[\s\S]*?\n---\n/, '');   // frontmatter
  t = t.replace(/```[\s\S]*?```/g, '');          // code fences
  t = t.replace(/^!\[.*?\]\(.*?\)$/gm, '');       // images
  return t.trim();
}

// ── Pass 1: judge（候補収集） ──────────────────────────
function buildJudgePrompt(body) {
  return `あなたは日本語の校正者です。以下のテキストから、英語からの直訳に読める可能性のある箇所を **候補として** 洗い出してください。この段階では取りこぼしを減らすことを優先し、疑わしいものは挙げてかまいません（後段で精査します）。

## 判定の原理
S1 英語動詞の逐語置換: expose→露出する / ship→出荷する / seed→種付け / land→着地する
S2 英語形容詞の直訳: hard cap→硬い上限 / live→生きている / rich→豊かな
S3 英語構文のなぞり: "X is nothing but Y"→「X に過ぎない」/ "It's worth noting"→「注目に値する」
S4 英語慣用句の逐語訳: "at the end of the day"→「一日の終わりに」/ "moving forward"→「前進して」

## 除外
固有名詞・製品名・技術 ID（OpenClaw / Hermes / Mem0 / MCP 等）、定着借用語（API / SDK / ストリーミング / キャッシュ / インデックス 等）、説明付き英語併記。

## テキスト
${body}

## 出力
各候補について excerpt（該当語句）/ signal（S1〜S4）/ english_source（推定英語原語）/ suggestion（自然な日本語案）/ confidence（high|medium|low）を返す。`;
}

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          excerpt: { type: 'STRING' },
          signal: { type: 'STRING' },
          english_source: { type: 'STRING' },
          suggestion: { type: 'STRING' },
          confidence: { type: 'STRING' },
        },
        required: ['excerpt', 'signal', 'suggestion', 'confidence'],
      },
    },
  },
  required: ['candidates'],
};

// ── Pass 2: critic（敵対的弁護） ───────────────────────
function buildCriticPrompt(body, candidates) {
  const list = candidates
    .map((c, i) => `${i + 1}. 「${c.excerpt}」 (${c.signal}, 推定原語: ${c.english_source || '?'}, 案: ${c.suggestion})`)
    .join('\n');

  return `あなたは日本語ネイティブの文章を **弁護する** 立場の校閲者です。前段の校正者が「英語直訳の疑い」として挙げた候補を、一つずつ精査してください。

## あなたの役割
あなたの初期姿勢は **「これは自然な日本語だ」** です。日本語ネイティブの書き手がその状況で普通に選ぶ表現であれば、候補を **棄却（dismiss）** してください。

候補を **支持（uphold）** してよいのは、次をすべて満たす場合のみ:
- その表現が、英語原文を逐語的になぞった結果としか考えられない
- 日本語ネイティブの書き手なら、まずその語を選ばない
- より自然で明確な日本語が明らかに存在する

判断に迷うものは **棄却** してください（疑わしきは自然な日本語とみなす）。

## 必ず棄却するもの（英語に訳せるが日本語として完全に自然）

次のような語は、英語原語を当てられても **日本語として自然なので必ず棄却** します:
- 一般動詞: 効く / 消える / 動かない / 動く / 賭けだ / 生き延びる / 生き残る / 乗る / 引き上げる / 支払う / 返してもらい / 行く / 来る / 決める / 作る / 持つ / 得る / 外す
- 慣用的な比喩動詞: 橋を渡す / 底に流れる / 線を引く / 手に残る（イディオムとして定着しているもの）
- 「〜の残りの間 / 〜の残りで」のような時間表現
- 一般的な複合語: 仕組みを作る / 機械を作る / 価値がある / 余地がある

逆に **支持すべき明確な直訳** の例:
- 「硬い上限」(hard cap)・「露出する」(expose tools)・「着地する」(land on)・「種付け」(seed)・「一日の終わりに」(at the end of the day)・「意味的意味」(semantic meaning) のように、**日本語の慣用に存在せず、英語を知らないと意味が取りにくい** もの。

迷ったら棄却。過剰検出は書き手の時間を奪うため、**precision を recall より優先** します。

## 元テキスト（文脈）
${body}

## 精査する候補
${list}

## 出力
各候補について index（番号）/ excerpt / upheld（true=直訳と確定 / false=自然な日本語として棄却）/ defense（棄却または支持の理由を 1 文）/ confidence（upheld の場合の最終確信度 high|medium|low）を返す。`;
}

const CRITIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          excerpt: { type: 'STRING' },
          upheld: { type: 'BOOLEAN' },
          defense: { type: 'STRING' },
          confidence: { type: 'STRING' },
        },
        required: ['index', 'excerpt', 'upheld', 'defense'],
      },
    },
  },
  required: ['verdicts'],
};

// ── provider 抽象（generic call） ──────────────────────
async function callLLM(provider, model, apiKey, prompt, geminiSchema) {
  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const data = await postJson(url, { 'Content-Type': 'application/json' }, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: TEMPERATURE,
        responseMimeType: 'application/json',
        responseSchema: geminiSchema,
      },
    });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty content');
    return JSON.parse(text);
  }
  if (provider === 'openai') {
    const url = 'https://api.openai.com/v1/chat/completions';
    const data = await postJson(url, {
      'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`,
    }, {
      model,
      messages: [{ role: 'user', content: prompt + '\n\nJSON オブジェクトのみを返す。' }],
      temperature: TEMPERATURE,
      response_format: { type: 'json_object' },
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty content');
    return JSON.parse(text);
  }
  // anthropic
  const url = 'https://api.anthropic.com/v1/messages';
  const data = await postJson(url, {
    'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
  }, {
    model, max_tokens: 8192, temperature: TEMPERATURE,
    messages: [{ role: 'user', content: prompt + '\n\nJSON オブジェクトのみを返してください。' }],
  });
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Anthropic returned empty content');
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`API error ${res.status}: ${t.slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── 集計 + レポート ────────────────────────────────────
function summarize(flags) {
  const s = { high: 0, medium: 0, low: 0 };
  for (const f of flags) if (s[f.confidence] != null) s[f.confidence]++;
  return s;
}

function verdictOf(summary) {
  if (summary.high > 0) return 'needs_revision';
  if (summary.medium > 0) return 'review';
  return 'pass';
}

function renderReport(result, opts) {
  const { flags, summary, verdict, dismissed } = result;
  const lines = [];
  const mark = { needs_revision: '🔴', review: '🟡', pass: '🟢' }[verdict] || '⚪';
  const criticNote = opts.critic ? '（敵対的検証済・レビュー補助）' : '（候補のみ・critic 未適用）';
  lines.push(`${mark} ${verdict} ${criticNote}  high ${summary.high} / medium ${summary.medium} / low ${summary.low}`);
  lines.push(`   ※ これはゲートではなくレビュー候補です。採否は書き手が判断してください。`);
  if (opts.critic) lines.push(`   候補 ${result.candidateCount} 件 → 検証後 ${flags.length} 件（棄却 ${result.candidateCount - flags.length} 件）`);

  const order = { high: 0, medium: 1, low: 2 };
  if (flags.length === 0) {
    lines.push('   確定した翻訳調なし。');
  } else {
    for (const f of [...flags].sort((a, b) => (order[a.confidence] ?? 9) - (order[b.confidence] ?? 9))) {
      const badge = { high: '[high]', medium: '[med ]', low: '[low ]' }[f.confidence] || '[?   ]';
      lines.push(`   ${badge} ${f.signal} ${f.excerpt}`);
      lines.push(`          ← ${f.english_source || '?'} → ${f.suggestion}`);
    }
  }
  if (opts.verbose && dismissed?.length) {
    lines.push(`   ── 棄却された候補（自然な日本語と判定）──`);
    for (const d of dismissed) lines.push(`   [dismiss] ${d.excerpt}  ─ ${d.defense}`);
  }
  return lines.join('\n');
}

// ── main ───────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const cfg = PROVIDER_DEFAULTS[args.provider];
  if (!cfg) { process.stderr.write(`未対応 provider: ${args.provider}\n`); process.exit(2); }
  const apiKey = process.env[cfg.env];
  if (!apiKey) { process.stderr.write(`${cfg.env} 未設定（provider=${args.provider}）\n`); process.exit(2); }
  const judgeModel = args.model || cfg.judge;
  const criticModel = args.criticModel || cfg.critic;

  let body;
  try { body = readInput(args.file); }
  catch (err) { process.stderr.write(`入力エラー: ${err.message}\n`); process.exit(2); }
  if (!body) { process.stderr.write('判定対象が空です。\n'); process.exit(2); }

  // Pass 1: judge
  let candidates;
  try {
    const r = await callLLM(args.provider, judgeModel, apiKey, buildJudgePrompt(body), JUDGE_SCHEMA);
    candidates = r.candidates || [];
  } catch (err) {
    process.stderr.write(`Pass 1 (judge) 失敗: ${err.message}\n`);
    process.exit(2);
  }

  let flags = candidates;
  let dismissed = [];

  // Pass 2: critic（敵対的弁護）
  if (args.critic && candidates.length > 0) {
    try {
      const r = await callLLM(args.provider, criticModel, apiKey, buildCriticPrompt(body, candidates), CRITIC_SCHEMA);
      const verdicts = r.verdicts || [];
      const byIdx = new Map(verdicts.map((v) => [v.index, v]));
      const upheld = [];
      for (let i = 0; i < candidates.length; i++) {
        const v = byIdx.get(i + 1) || verdicts.find((x) => x.excerpt === candidates[i].excerpt);
        if (v && v.upheld) {
          upheld.push({ ...candidates[i], confidence: v.confidence || candidates[i].confidence, defense: v.defense });
        } else {
          dismissed.push({ excerpt: candidates[i].excerpt, defense: v?.defense || '(critic が棄却)' });
        }
      }
      flags = upheld;
    } catch (err) {
      process.stderr.write(`Pass 2 (critic) 失敗: ${err.message}（Pass 1 候補で続行）\n`);
    }
  }

  const summary = summarize(flags);
  const verdict = verdictOf(summary);
  const result = { flags, summary, verdict, candidateCount: candidates.length, dismissed };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(result, args) + '\n');
  }

  const thr = CONFIDENCE_RANK[args.threshold] || 3;
  const hit = flags.some((f) => (CONFIDENCE_RANK[f.confidence] || 0) >= thr);
  process.exit(hit ? 1 : 0);
}

main();
