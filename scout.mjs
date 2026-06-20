// scout.mjs — DrewBrews Trend Radar scout
// -----------------------------------------------------------------------------
// Once a week (via GitHub Actions), this script asks Claude — with the web search
// tool enabled — to find the most postable specialty-coffee trends, then writes a
// schema-valid radar.json. The DrewBrews Trend Studio fetches that file and
// refreshes its radar automatically.
//
// Durability rule (critical): a bad week must NEVER blank the radar. If the model
// returns nothing usable or the result fails schema validation, this script logs,
// exits non-zero, and leaves the existing radar.json untouched.
// -----------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'radar.schema.json');
const SOURCES_PATH = join(__dirname, 'sources.txt');
const OUTPUT_PATH = join(__dirname, 'radar.json');

// --- The model name lives in exactly ONE place. A future rename is a one-liner.
// Sonnet 4.5 handles the multi-step web research + synthesis well; override with
// the MODEL env var if you want a cheaper (Haiku) or smarter (Opus) weekly run.
const MODEL = process.env.MODEL || 'claude-sonnet-4-5';

// Cap web-search calls to keep the weekly cost to a few cents (10 ≈ ~10–15¢).
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 10);
// Safety net so a server-tool loop can't spin forever.
const MAX_CONTINUATIONS = 6;

const VALID_TPL = new Set(['s1', 's2', 's3', 's4', 's5', 's6']);
const VALID_SRC = new Set(['press', 'review', 'community', 'verify']);

// -----------------------------------------------------------------------------
// Brand voice / scout brief.
// -----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the DrewBrews Trend Scout.

Brand voice: playful, expert, inclusive, anti-gatekeeping — "same team, no ego."
You make specialty coffee feel welcoming, never snobby.

Priorities:
- Pour-over brewers and gear come first; then grinders, kettles, scales, beans, methods.
- Favor trends a beginner could act on or be excited by.
- Frame everything inclusively. No gatekeeping, no "you're doing it wrong."

Honesty rules:
- NEVER fabricate products, quotes, links, or events.
- If something is buzzy but you could not verify it from a real source, set its
  "src" to "verify" and keep the buzz cautious.
- Every source_url must be a real URL you actually encountered while searching.

Use the web search tool to ground your picks in this week's real chatter
(Reddit threads, YouTube videos, press, blogs).

Output format (this is critical):
You output ONLY a JSON array — never prose, never a refusal, never an apology,
never markdown fences. Your output is parsed by a machine; any non-JSON text
breaks it. If a given week looks thin, do NOT explain or decline — instead
broaden to notable gear/trends from roughly the last 1–3 months and mark
anything you can't fully confirm as "verify". Always return exactly 6 items.
Never return zero.`;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Read sources.txt and return the non-comment, non-blank lines as a single block. */
async function readSources() {
  const raw = await readFile(SOURCES_PATH, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join('\n');
}

/** Retry a function once on transient (network / 5xx / 429) errors. */
async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.status;
    const transient =
      status === 429 || (typeof status === 'number' && status >= 500) || status === undefined;
    if (!transient) throw err;
    console.warn(`[scout] ${label} failed (${status ?? 'network'}). Retrying once in 5s…`);
    await new Promise((r) => setTimeout(r, 5000));
    return await fn();
  }
}

/**
 * Tolerantly extract the JSON array of trends from the model's reply.
 * Mirrors the Studio's parseTrends: strip prose / markdown fences, then grab the
 * first balanced [...] (or a { "trends": [...] } wrapper). Returns [] on failure.
 */
function parseTrends(text) {
  if (!text) return [];

  // Strip ```json … ``` fences if present.
  let t = text.replace(/```(?:json)?/gi, '').trim();

  // Try a direct parse first (handles a clean array or a wrapping object).
  const direct = tryParse(t);
  if (direct) return normalizeParsed(direct);

  // Otherwise slice from the first '[' to the last ']'.
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const arr = tryParse(t.slice(start, end + 1));
    if (arr) return normalizeParsed(arr);
  }

  // Last resort: a { … "trends": [...] … } object anywhere in the text.
  const objStart = t.indexOf('{');
  const objEnd = t.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    const obj = tryParse(t.slice(objStart, objEnd + 1));
    if (obj) return normalizeParsed(obj);
  }

  return [];
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeParsed(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.trends)) return parsed.trends;
  return [];
}

/**
 * Clean each trend the same way the Studio does, BEFORE validating:
 * - drop items missing name or buzz
 * - coerce an out-of-range tpl to "s5"
 * - coerce an unknown src to "verify"
 * - cap to the schema's 12-item ceiling
 */
function coerceTrends(trends) {
  return trends
    .filter((t) => t && typeof t.name === 'string' && t.name.trim() && typeof t.buzz === 'string' && t.buzz.trim())
    .slice(0, 12)
    .map((t) => {
      const out = {
        name: String(t.name).trim().slice(0, 80),
        buzz: String(t.buzz).trim().slice(0, 400),
        tpl: VALID_TPL.has(t.tpl) ? t.tpl : 's5',
        src: VALID_SRC.has(t.src) ? t.src : 'verify',
      };
      if (typeof t.angle === 'string' && t.angle.trim()) out.angle = t.angle.trim().slice(0, 400);
      if (typeof t.source_url === 'string' && t.source_url.trim()) out.source_url = t.source_url.trim();
      return out;
    });
}

/** Pull all text blocks out of a Messages API response and join them. */
function collectText(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Build the user prompt. When `strict`, prepend a hard correction for the retry. */
function buildUserMessage(sources, today, strict) {
  const base =
    `Find this week's 6 most postable specialty-coffee trends. ` +
    `Prioritize these sources and similar ones:\n\n${sources}\n\n` +
    `Today is ${today}.\n\n` +
    `If this exact week is thin, include notable gear/trends from roughly the ` +
    `last 1–3 months, and mark anything you can't fully confirm as ` +
    `src: "verify". Always return 6 items. Never return zero.\n\n` +
    `Reply with ONLY a JSON array of 6 objects, each:\n` +
    `{ "name": string, "src": "press"|"review"|"community"|"verify", ` +
    `"buzz": string (1-2 sentences), "tpl": "s1".."s6", ` +
    `"angle": string (how DrewBrews should frame it — inclusive, no gatekeeping), ` +
    `"source_url": a real link }\n` +
    `No prose, no markdown fences — just the array.`;

  if (!strict) return base;

  return (
    `CRITICAL: your previous reply could not be parsed as JSON. ` +
    `Output the JSON array ONLY — start with "[" and end with "]". ` +
    `No prose, no apology, no explanation, no code fences.\n\n` +
    base
  );
}

/**
 * Send one prompt to the model with web search enabled and return its text.
 * Handles the server-side tool's pause_turn loop (re-send to continue).
 */
async function askModel(client, userMessage, tools, label) {
  const messages = [{ role: 'user', content: userMessage }];
  let response = await withRetry(
    () => client.messages.create({ model: MODEL, max_tokens: 4096, system: SYSTEM_PROMPT, tools, messages }),
    label
  );

  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: 'assistant', content: response.content });
    response = await withRetry(
      () => client.messages.create({ model: MODEL, max_tokens: 4096, system: SYSTEM_PROMPT, tools, messages }),
      `${label} (continuation ${continuations + 1})`
    );
    continuations++;
  }

  return collectText(response);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[scout] ANTHROPIC_API_KEY is not set. Refusing to run; radar.json left untouched.');
    process.exit(1);
  }

  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv); // teaches ajv the "date-time" format (also silences its warning)
  const validate = ajv.compile(schema);

  const sources = await readSources();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  console.log(`[scout] Model: ${MODEL}  |  max searches: ${MAX_SEARCHES}  |  date: ${today}`);

  // --- Web search tool. We use the basic web_search_20250305 variant, which
  // works on every model (including the Sonnet 4.5 default). If you switch MODEL
  // to an Opus 4.6+/Sonnet 4.6 model you may upgrade this to web_search_20260209
  // for better dynamic filtering.
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }];

  // First attempt.
  let text = await askModel(client, buildUserMessage(sources, today, false), tools, 'initial request');
  let trends = coerceTrends(parseTrends(text));
  console.log(`[scout] Attempt 1: ${trends.length} usable item(s) after cleaning.`);

  // Fallback: if we parsed nothing usable (e.g. the model returned prose or a
  // refusal), try once more with a stricter "JSON array only" instruction.
  if (trends.length === 0) {
    console.warn('[scout] 0 items parsed — retrying once with a stricter JSON-only instruction…');
    text = await askModel(client, buildUserMessage(sources, today, true), tools, 'strict retry');
    trends = coerceTrends(parseTrends(text));
    console.log(`[scout] Attempt 2: ${trends.length} usable item(s) after cleaning.`);
  }

  const radar = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(), // run time, so the Studio sees a newer file
    trends,
  };

  if (!validate(radar)) {
    console.error('[scout] Result FAILED schema validation. radar.json left untouched.');
    console.error(ajv.errorsText(validate.errors, { separator: '\n  ' }));
    if (text) console.error('[scout] Model reply was:\n' + text.slice(0, 1500));
    process.exit(1);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(radar, null, 2) + '\n', 'utf8');
  console.log(`[scout] ✅ Wrote ${trends.length} trends to radar.json (generatedAt ${radar.generatedAt}).`);
}

main().catch((err) => {
  console.error('[scout] Fatal error. radar.json left untouched.');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
