// scout.mjs — DrewBrews Trend Radar scout
// -----------------------------------------------------------------------------
// Architecture: two-phase pipeline so Claude never invents URLs.
//
//   Phase 1 — COLLECT (programmatic, no LLM)
//     • Reddit hot posts from vetted subreddits via public JSON API
//     • Recent articles from vetted publications via RSS
//     • YouTube recent videos from vetted channels via RSS feed
//
//   Phase 2 — CURATE (LLM, no URL generation)
//     • Claude receives a numbered list of real collected items
//     • Claude picks the best ones and writes buzz + angle copy
//     • source_url comes from our collected data — Claude never invents one
//
// Durability rule (critical): a bad week must NEVER blank the radar. If the
// model returns nothing usable or the result fails schema validation, this
// script logs, exits non-zero, and leaves the existing radar.json untouched.
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

const MODEL = process.env.MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = 8192;
const MAX_CONTINUATIONS = 6;

const VALID_TPL = new Set(['s1', 's2', 's3', 's4', 's5', 's6']);
const VALID_SRC = new Set(['press', 'review', 'community', 'verify']);

// How many posts to pull per subreddit (hot listing)
const REDDIT_POST_LIMIT = 30;
// Minimum score to include a post (filters out very new/low-signal posts)
const REDDIT_MIN_SCORE = 10;
// How many articles per RSS feed
const RSS_ARTICLE_LIMIT = 10;
// Minimum age: skip posts newer than 2 hours (avoid very fresh/unvetted content)
const MIN_POST_AGE_HOURS = 2;
// Max age: don't pull posts older than 90 days
const MAX_POST_AGE_DAYS = 90;

// ---------------------------------------------------------------------------
// Parse sources.txt
// ---------------------------------------------------------------------------

function parseSources(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const subs = [];
  const rssHosts = [];
  const ytChannels = [];

  for (const line of lines) {
    const redditMatch = line.match(/reddit\.com\/r\/([a-z0-9_]+)\/?$/i);
    if (redditMatch) { subs.push(redditMatch[1]); continue; }

    const ytMatch = line.match(/youtube\.com\/@([a-z0-9_-]+)\/?$/i);
    if (ytMatch) { ytChannels.push(ytMatch[1]); continue; }

    try {
      const host = new URL(line).hostname.replace(/^www\./, '');
      if (host && !host.includes('reddit') && !host.includes('youtube')) {
        rssHosts.push(host);
      }
    } catch { /* skip malformed lines */ }
  }

  return { subs, rssHosts, ytChannels };
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry(fn, label, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      const transient = status === 429 || (typeof status === 'number' && status >= 500) || status === undefined;
      if (!transient || i === attempts - 1) throw err;
      const delay = (i + 1) * 5000;
      console.warn(`[scout] ${label} failed (${status ?? 'network'}). Retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 1a: Reddit collection via public JSON API
// ---------------------------------------------------------------------------

async function fetchRedditPosts(subreddits) {
  const now = Date.now() / 1000; // Unix seconds
  const minAge = MIN_POST_AGE_HOURS * 3600;
  const maxAge = MAX_POST_AGE_DAYS * 86400;
  const items = [];

  for (const sub of subreddits) {
    const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${REDDIT_POST_LIMIT}&raw_json=1`;
    console.log(`[scout] Fetching r/${sub}…`);

    let data;
    try {
      const res = await withRetry(
        () => fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'DrewBrews-Radar/2.0 (weekly coffee trend scout; contact via GitHub)',
            'Accept': 'application/json',
          },
        }),
        `Reddit r/${sub}`
      );
      if (!res.ok) {
        console.warn(`[scout] r/${sub}: HTTP ${res.status} — skipping`);
        continue;
      }
      data = await res.json();
    } catch (err) {
      console.warn(`[scout] r/${sub}: fetch failed (${err.message}) — skipping`);
      continue;
    }

    const posts = data?.data?.children ?? [];
    let kept = 0;
    for (const child of posts) {
      const p = child?.data;
      if (!p || p.stickied || p.is_video) continue;
      const age = now - p.created_utc;
      if (age < minAge || age > maxAge) continue;
      if ((p.score ?? 0) < REDDIT_MIN_SCORE) continue;
      if (!p.title?.trim()) continue;

      items.push({
        kind: 'reddit',
        source: `r/${sub}`,
        title: p.title.trim(),
        body: (p.selftext || '').trim().slice(0, 600),
        url: `https://www.reddit.com${p.permalink}`,
        score: p.score,
        comments: p.num_comments,
        created: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
      });
      kept++;
    }
    console.log(`[scout] r/${sub}: kept ${kept} posts (of ${posts.length} fetched)`);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Phase 1b: RSS collection from vetted publication sites
// ---------------------------------------------------------------------------

/** Minimal RSS/Atom parser: returns [{title, url, date}] */
function parseRss(xml) {
  const items = [];
  // RSS <item> blocks
  for (const block of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const inner = block[1];
    const title = inner.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = (
      inner.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ||
      inner.match(/<guid[^>]*isPermaLink="true"[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim()
    );
    const date = inner.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    if (title && link && link.startsWith('http')) items.push({ title, url: link, date });
  }
  // Atom <entry> blocks
  for (const block of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const inner = block[1];
    const title = inner.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = inner.match(/<link[^>]*href="([^"]+)"/i)?.[1]?.trim();
    const date = inner.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)?.[1]?.trim();
    if (title && link && link.startsWith('http')) items.push({ title, url: link, date });
  }
  return items;
}

async function fetchRssArticles(hosts) {
  const maxAgeSec = MAX_POST_AGE_DAYS * 86400 * 1000; // ms
  const now = Date.now();
  const items = [];

  for (const host of hosts) {
    for (const feedPath of ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml']) {
      const feedUrl = `https://${host}${feedPath}`;
      try {
        const res = await fetch(feedUrl, {
          signal: AbortSignal.timeout(12000),
          headers: { 'User-Agent': 'DrewBrews-Radar/2.0', 'Accept': 'application/rss+xml, application/atom+xml, text/xml, */*' },
        });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('xml') && !ct.includes('rss') && !ct.includes('atom') && !ct.includes('text')) continue;

        const xml = await res.text();
        const parsed = parseRss(xml).slice(0, RSS_ARTICLE_LIMIT);

        for (const entry of parsed) {
          const ms = entry.date ? Date.parse(entry.date) : NaN;
          if (!isNaN(ms) && now - ms > maxAgeSec) continue; // too old
          items.push({
            kind: 'article',
            source: host,
            title: entry.title,
            body: '',
            url: entry.url,
            score: null,
            comments: null,
            created: isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10),
          });
        }

        if (parsed.length > 0) {
          console.log(`[scout] ${host}: ${parsed.length} articles via ${feedPath}`);
          break; // found working feed — no need to try other paths
        }
      } catch { /* try next path */ }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Phase 1c: YouTube RSS (no API key needed — YouTube exposes per-channel RSS)
// ---------------------------------------------------------------------------

async function fetchYouTubeVideos(channelHandles) {
  const items = [];
  const maxAgeSec = MAX_POST_AGE_DAYS * 86400 * 1000;
  const now = Date.now();

  for (const handle of channelHandles) {
    // Resolve @handle → channel ID via oEmbed, then fetch the channel RSS
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/@${handle}`)}&format=json`;
      const oRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000) });
      if (!oRes.ok) continue;
      const oembed = await oRes.json();
      // author_url is like https://www.youtube.com/channel/UCxxxx
      const channelId = oembed?.author_url?.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/)?.[1];
      if (!channelId) continue;

      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const rRes = await fetch(feedUrl, { signal: AbortSignal.timeout(10000) });
      if (!rRes.ok) continue;
      const xml = await rRes.text();
      const entries = parseRss(xml).slice(0, 5);

      for (const entry of entries) {
        const ms = entry.date ? Date.parse(entry.date) : NaN;
        if (!isNaN(ms) && now - ms > maxAgeSec) continue;
        items.push({
          kind: 'youtube',
          source: `@${handle}`,
          title: entry.title,
          body: '',
          url: entry.url,
          score: null,
          comments: null,
          created: isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10),
        });
      }

      if (entries.length > 0) console.log(`[scout] @${handle}: ${entries.length} videos`);
    } catch (err) {
      console.warn(`[scout] @${handle}: ${err.message} — skipping`);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Phase 2: Claude curates from real items (no URL generation)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the DrewBrews Trend Scout.

Brand voice: playful, expert, inclusive, anti-gatekeeping — "same team, no ego."
You make specialty coffee feel welcoming, never snobby.

Priorities:
- Pour-over brewers and gear come first; then grinders, kettles, scales, beans, methods.
- Favor trends a beginner could act on or be excited by.
- Frame everything inclusively. No gatekeeping, no "you're doing it wrong."

Honesty rules:
- NEVER fabricate products, quotes, links, or events.
- You are given a numbered list of REAL posts and articles. Pick the best ones.
- Do NOT invent items that aren't on the list.

Output format (critical):
Output ONLY a JSON array. Each object must have:
  "index": the number of the item you picked (integer, from the list)
  "name": short trend name (≤ 80 chars)
  "buzz": 1-2 sentences describing the trend (≤ 400 chars)
  "tpl": one of "s1" "s2" "s3" "s4" "s5" "s6" (pick based on content type)
  "src": "press" | "review" | "community" | "verify"
  "angle": how DrewBrews should frame it — inclusive, no gatekeeping (≤ 400 chars)

Never output prose, apologies, or markdown fences. Output only the JSON array.`;

function buildCurationPrompt(items, today) {
  const numbered = items
    .map((item, i) => {
      const parts = [`[${i + 1}] ${item.kind.toUpperCase()} from ${item.source}`];
      parts.push(`Title: ${item.title}`);
      if (item.body) parts.push(`Body excerpt: ${item.body.slice(0, 200)}`);
      if (item.score != null) parts.push(`Score: ${item.score}, Comments: ${item.comments}`);
      if (item.created) parts.push(`Date: ${item.created}`);
      return parts.join('\n');
    })
    .join('\n\n---\n\n');

  return (
    `Today is ${today}. Pick up to 12 of the most postable specialty-coffee trends ` +
    `from the list below — the ones a DrewBrews audience would find exciting, useful, or interesting. ` +
    `Order them best-first. If fewer than 12 are truly postable, return fewer — quality over quantity.\n\n` +
    `For each pick, write fresh "buzz" and "angle" copy in DrewBrews voice. ` +
    `Set "index" to the item's number. Do NOT invent items not on this list.\n\n` +
    `ITEMS:\n\n${numbered}\n\n` +
    `Output only the JSON array.`
  );
}

/** Pull text blocks from a Messages API response. */
function collectText(message) {
  return (message.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function parsePicks(text) {
  if (!text) return [];
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const direct = tryParse(t);
  if (Array.isArray(direct)) return direct;
  const start = t.indexOf('['); const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const arr = tryParse(t.slice(start, end + 1));
    if (Array.isArray(arr)) return arr;
  }
  return [];
}

async function curateTrends(client, items, today) {
  if (items.length === 0) return [];

  const userMessage = buildCurationPrompt(items, today);
  const messages = [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: '[' },
  ];

  const create = () => withRetry(
    () => client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages }),
    'curation request'
  );

  let response = await create();
  let assembled = collectText(response);

  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: 'assistant', content: response.content });
    response = await create();
    assembled += collectText(response);
    continuations++;
  }

  const stripped = assembled.replace(/```(?:json)?/gi, '').trim();
  const text = stripped.startsWith('[') ? stripped : '[' + stripped;

  const picks = parsePicks(text);
  if (picks.length === 0) {
    console.warn(`[scout] curation: parsed 0 picks. Reply tail: ${JSON.stringify(text.slice(-300))}`);
    return [];
  }

  // Map picks back to real collected items
  const trends = [];
  for (const pick of picks) {
    const idx = typeof pick.index === 'number' ? pick.index - 1 : -1;
    if (idx < 0 || idx >= items.length) {
      console.warn(`[scout] curation: pick has invalid index ${pick.index} — dropping`);
      continue;
    }
    const item = items[idx];
    if (!pick.name?.trim() || !pick.buzz?.trim()) continue;

    trends.push({
      name: String(pick.name).trim().slice(0, 80),
      buzz: String(pick.buzz).trim().slice(0, 400),
      tpl: VALID_TPL.has(pick.tpl) ? pick.tpl : 's5',
      src: VALID_SRC.has(pick.src) ? pick.src : (item.kind === 'article' || item.kind === 'press' ? 'press' : 'community'),
      ...(pick.angle?.trim() ? { angle: String(pick.angle).trim().slice(0, 400) } : {}),
      source_url: item.url, // ← REAL URL from our collection, never from the model
    });
  }

  console.log(`[scout] curation: ${trends.length} trends from ${picks.length} picks`);
  return trends.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[scout] ANTHROPIC_API_KEY is not set. Refusing to run; radar.json left untouched.');
    process.exit(1);
  }

  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const sourcesText = await readFile(SOURCES_PATH, 'utf8');
  const { subs, rssHosts, ytChannels } = parseSources(sourcesText);
  console.log(`[scout] Sources — subreddits: ${subs.join(', ')} | sites: ${rssHosts.join(', ')} | yt: ${ytChannels.length} channels`);

  const today = new Date().toISOString().slice(0, 10);
  console.log(`[scout] Model: ${MODEL} | date: ${today}`);

  // ── Phase 1: Collect real content ──────────────────────────────────────────
  const [redditPosts, rssArticles, ytVideos] = await Promise.all([
    fetchRedditPosts(subs),
    fetchRssArticles(rssHosts),
    fetchYouTubeVideos(ytChannels),
  ]);

  const allItems = [...redditPosts, ...rssArticles, ...ytVideos];
  console.log(`[scout] Collected ${allItems.length} items total (${redditPosts.length} Reddit, ${rssArticles.length} articles, ${ytVideos.length} YouTube)`);

  if (allItems.length === 0) {
    console.error('[scout] No items collected — all sources failed. radar.json left untouched.');
    process.exit(1);
  }

  // ── Phase 2: Claude curates ──────────────────────────────────────────────
  const client = new Anthropic();
  let trends = await curateTrends(client, allItems, today);

  if (trends.length === 0) {
    console.error('[scout] No trends selected by curation. radar.json left untouched.');
    process.exit(1);
  }

  // ── Phase 3: Validate and write ───────────────────────────────────────────
  const radar = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    trends,
  };

  if (!validate(radar)) {
    console.error('[scout] Result FAILED schema validation. radar.json left untouched.');
    console.error(ajv.errorsText(validate.errors, { separator: '\n  ' }));
    process.exit(1);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(radar, null, 2) + '\n', 'utf8');
  console.log(`[scout] ✅ Wrote ${trends.length} trends to radar.json (generatedAt ${radar.generatedAt}).`);
}

main().catch(err => {
  console.error('[scout] Fatal error. radar.json left untouched.');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
