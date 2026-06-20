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
anything you can't fully confirm as "verify". Return up to 12 items, ordered
best/most-postable first. Never return zero.`;

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
 * (The 12-item cap is applied later, after the specific-source filter + de-dupe.)
 */
function coerceTrends(trends) {
  return trends
    .filter((t) => t && typeof t.name === 'string' && t.name.trim() && typeof t.buzz === 'string' && t.buzz.trim())
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

/**
 * Every published trend must cite a SPECIFIC page — not a homepage, channel,
 * profile, or subreddit root. This is the gate that keeps the radar's links
 * clickable-to-the-actual-thing.
 */
function isSpecificSourceUrl(u) {
  if (typeof u !== 'string') return false;
  let url;
  try { url = new URL(u.trim()); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, ''); // drop trailing slash
  const seg = path.split('/').filter(Boolean);
  // Reddit: must be an actual comments thread
  if (host.endsWith('reddit.com')) return /\/comments\//.test(url.pathname);
  // YouTube: must be a specific video
  if (host.endsWith('youtube.com')) return url.searchParams.has('v');
  if (host === 'youtu.be') return seg.length >= 1;
  // Reject obvious channel/profile/tag roots
  if (seg.length === 1 && /^[@]/.test(seg[0])) return false;
  // Everything else (articles): need a real path with a slug-like segment
  return seg.length >= 1 && seg.join('/').length >= 6;
}

/** Pull all text blocks out of a Messages API response and join them. */
function collectText(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Build the user prompt. When `retry`, prepend a hard push for verifiable links. */
function buildUserMessage(sources, today, retry) {
  const base =
    `Find this week's most postable specialty-coffee trends — up to 12, ordered ` +
    `best/most-postable first. ` +
    `Use the web_search tool and base each pick on a real result you actually found.\n\n` +
    `Look here and at similar places — this list is ONLY where to look; never ` +
    `cite these root URLs themselves:\n\n${sources}\n\n` +
    `Today is ${today}.\n\n` +
    `Return up to 12 items, ordered best-first. If this week is thin, include ` +
    `notable gear/trends from the last ~3 months. Mark anything not fully ` +
    `confirmed as src: "verify". ` +
    `Do not explain, apologize, or refuse — output the array only.\n\n` +
    `Each object: { "name": string, "src": "press"|"review"|"community"|"verify", ` +
    `"buzz": string (1-2 sentences), "tpl": "s1".."s6", ` +
    `"angle": string (how DrewBrews should frame it — inclusive, no gatekeeping), ` +
    `"source_url": copy the EXACT full URL of the specific search result you used ` +
    `— a Reddit /comments/ thread, a YouTube watch?v= video, or a specific article ` +
    `page with a real slug. NEVER a homepage, channel, @profile, or subreddit ` +
    `root, and never a URL from the list above. ` +
    `Good: https://www.reddit.com/r/pourover/comments/1abc23/title/  ` +
    `Bad: https://www.reddit.com/r/pourover/ . ` +
    `If you don't have a specific result URL for an item, omit that item. }`;

  if (!retry) return base;

  return (
    `CRITICAL: your previous result had too few items with specific, verifiable ` +
    `source links. For each item, copy the EXACT full URL of a real web_search ` +
    `result — a Reddit /comments/ thread, a YouTube watch?v= video, or a specific ` +
    `article page. Do NOT use subreddit roots, channel/@profile pages, homepages, ` +
    `or any URL from the source list. Omit any item you cannot back with such a ` +
    `link. Output the array only.\n\n` +
    base
  );
}

// Assistant prefill: by ending the request on an assistant turn whose content is
// just "[", the model can only *continue* a JSON array — a prose refusal or
// apology becomes structurally impossible. The API returns only the text it
// generates AFTER the prefill, so we re-attach the "[" before parsing.
// NOTE: prefill is supported on Sonnet 4.5; it returns 400 on the 4.6 family /
// Opus 4.6+. If you ever set MODEL to one of those, remove this prefill.
const PREFILL = '[';

// max_tokens: comfortably above the ~2500 needed so a 6-item array can't be
// truncated mid-JSON.
const MAX_TOKENS = 4096;

/**
 * Send one prompt to the model (web search enabled, JSON-array prefilled) and
 * return its reply with the prefill re-attached. Handles the server-side tool's
 * pause_turn loop (re-send to continue) and accumulates text across pauses.
 */
async function askModel(client, userMessage, tools, label) {
  const messages = [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: PREFILL },
  ];

  const create = (lbl) =>
    withRetry(
      () => client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, tools, messages }),
      lbl
    );

  let response = await create(label);
  let assembled = collectText(response);

  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: 'assistant', content: response.content });
    response = await create(`${label} (continuation ${continuations + 1})`);
    assembled += collectText(response);
    continuations++;
  }

  return PREFILL + assembled;
}

/**
 * One round trip: ask the model, parse, clean, then KEEP ONLY items whose
 * source_url points at a specific page. Bad-link items are dropped (not fatal),
 * so the good ones still publish.
 */
async function getTrends(client, userMessage, tools, label) {
  const text = await askModel(client, userMessage, tools, label);
  const cleaned = coerceTrends(parseTrends(text));
  const specific = cleaned.filter((t) => isSpecificSourceUrl(t.source_url));
  const dropped = cleaned.length - specific.length;
  if (dropped > 0) console.log(`[scout] ${label}: dropped ${dropped} item(s) without a specific source link.`);
  return specific;
}

/** Merge attempts: de-dupe by name OR source_url, keep order, cap at 12. */
function dedupeTrends(trends) {
  const seen = new Set();
  const out = [];
  for (const t of trends) {
    const nameKey = 'n:' + (t.name || '').toLowerCase().trim();
    const urlKey = 'u:' + (t.source_url || '').trim();
    if (seen.has(nameKey) || seen.has(urlKey)) continue;
    seen.add(nameKey);
    seen.add(urlKey);
    out.push(t);
  }
  return out.slice(0, 12); // the schema's 12-item ceiling
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

  const MIN_ITEMS = 4;

  // First attempt — only items with a specific source link survive.
  let trends = await getTrends(client, buildUserMessage(sources, today, false), tools, 'initial request');
  console.log(`[scout] Attempt 1: ${trends.length} item(s) with a specific source link.`);

  // If too few survive the link filter, retry once for verifiable direct links,
  // then merge + de-dupe so the good items from both attempts publish together.
  if (trends.length < MIN_ITEMS) {
    console.warn(`[scout] Fewer than ${MIN_ITEMS} items with specific links — retrying once for verifiable direct links…`);
    const more = await getTrends(client, buildUserMessage(sources, today, true), tools, 'links retry');
    trends = [...trends, ...more];
  }

  trends = dedupeTrends(trends); // de-dupe + cap to 12
  console.log(`[scout] Final: ${trends.length} item(s) after de-dupe.`);

  const radar = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(), // run time, so the Studio sees a newer file
    trends,
  };

  if (!validate(radar)) {
    console.error('[scout] Result FAILED schema validation. radar.json left untouched.');
    console.error(ajv.errorsText(validate.errors, { separator: '\n  ' }));
    console.error('[scout] Trends we tried to write:\n' + JSON.stringify(trends, null, 2).slice(0, 2000));
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
