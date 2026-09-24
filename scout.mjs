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

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'radar.schema.json');
const SOURCES_PATH = join(__dirname, 'sources.txt');
// OUTPUT_PATH / COLLECTED_PATH overrides let a QA run write somewhere other
// than the live radar.json (and dump everything collected for review).
const OUTPUT_PATH = process.env.OUTPUT_PATH || join(__dirname, 'radar.json');
const COLLECTED_PATH = process.env.COLLECTED_PATH || null;

const MODEL = process.env.MODEL || 'claude-sonnet-5';
// Sonnet 5 thinks (adaptively) by default — leave room for thinking + ~12 picks
const MAX_TOKENS = 16000;
// Picking + short copy doesn't need deep reasoning; medium keeps it quick and cheap
const EFFORT = process.env.EFFORT || 'medium';

const VALID_TPL = new Set(['s1', 's2', 's3', 's4', 's5', 's6']);
const VALID_SRC = new Set(['press', 'review', 'community', 'verify']);

const USER_AGENT = 'DrewBrews-Radar/2.0 (weekly coffee trend scout; contact via GitHub)';

// How many posts to pull per subreddit (top-of-the-week listing)
const REDDIT_POST_LIMIT = 25;
// Minimum score to include a post (API mode only — RSS carries no scores)
const REDDIT_MIN_SCORE = 10;
// Recurring mod threads that are never a "trend" (RSS can't see the stickied flag)
const REDDIT_MOD_THREAD = /\b(weekly|daily|monthly)\b.*\b(thread|discussion|questions?)\b|megathread|\brules\b|\bama\b/i;
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

    // YouTube: "…/channel/UC…" (preferred — no lookup) or "…/@handle",
    // optionally both on one line: "https://www.youtube.com/@handle UCxxxx"
    if (/youtube\.com\//i.test(line)) {
      const handle = line.match(/youtube\.com\/@([a-z0-9_.-]+)/i)?.[1] ?? null;
      const id = line.match(/\b(UC[a-zA-Z0-9_-]{22})\b/)?.[1] ?? null;
      if (handle || id) ytChannels.push({ handle, id });
      continue;
    }

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

async function withRetry(fn, label, attempts = 2, extraRetryStatuses = []) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      const transient = status === 429 || (typeof status === 'number' && status >= 500) ||
        status === undefined || extraRetryStatuses.includes(status);
      if (!transient || i === attempts - 1) throw err;
      const delay = (i + 1) * 5000;
      console.warn(`[scout] ${label} failed (${status ?? 'network'}). Retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/** fetch that throws on non-2xx (with .status), so withRetry can retry 429/5xx. */
async function fetchOk(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
}

// ---------------------------------------------------------------------------
// Phase 1a: Reddit collection
//   • With REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET: official OAuth API
//     (scores, comment counts, stickied flag — the good signal).
//   • Without them: public RSS feed (titles + post text, but no scores).
//   Unauthenticated JSON (reddit.com/…/hot.json) is 403'd from GitHub runners.
// ---------------------------------------------------------------------------

async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      console.warn(`[scout] Reddit OAuth: HTTP ${res.status} — falling back to RSS`);
      return null;
    }
    return (await res.json()).access_token ?? null;
  } catch (err) {
    console.warn(`[scout] Reddit OAuth failed (${err.message}) — falling back to RSS`);
    return null;
  }
}

async function fetchRedditApi(sub, token) {
  const url = `https://oauth.reddit.com/r/${sub}/top?t=week&limit=${REDDIT_POST_LIMIT}&raw_json=1`;
  const res = await withRetry(
    () => fetchOk(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT },
    }),
    `Reddit API r/${sub}`
  );
  const data = await res.json();
  return (data?.data?.children ?? [])
    .map(c => c?.data)
    .filter(p => p && !p.stickied && !p.over_18 && (p.score ?? 0) >= REDDIT_MIN_SCORE)
    .map(p => ({
      title: p.title,
      body: p.selftext || '',
      url: `https://www.reddit.com${p.permalink}`,
      score: p.score,
      comments: p.num_comments,
      flair: p.link_flair_text || null,
      createdMs: p.created_utc * 1000,
    }));
}

async function fetchRedditRss(sub) {
  const url = `https://www.reddit.com/r/${sub}/top/.rss?t=week&limit=${REDDIT_POST_LIMIT}`;
  const res = await withRetry(
    () => fetchOk(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': USER_AGENT } }),
    `Reddit RSS r/${sub}`
  );
  return parseRss(await res.text()).map(e => ({
    title: e.title,
    // Reddit appends "submitted by /u/x [link] [comments]" to every entry
    body: e.summary.replace(/\s*submitted by\s+\/u\/\S+[\s\S]*$/i, ''),
    url: e.url,
    score: null,
    comments: null,
    flair: null,
    createdMs: e.date ? Date.parse(e.date) : NaN,
  }));
}

async function fetchRedditPosts(subreddits) {
  const now = Date.now();
  const minAgeMs = MIN_POST_AGE_HOURS * 3600 * 1000;
  const maxAgeMs = MAX_POST_AGE_DAYS * 86400 * 1000;
  const token = await getRedditToken();
  const mode = token ? 'api' : 'rss';
  console.log(`[scout] Reddit mode: ${mode === 'api' ? 'OAuth API' : 'RSS (no REDDIT_CLIENT_ID/SECRET set)'}`);
  const items = [];

  for (const sub of subreddits) {
    let posts;
    try {
      posts = mode === 'api' ? await fetchRedditApi(sub, token) : await fetchRedditRss(sub);
    } catch (err) {
      console.warn(`[scout] r/${sub}: ${err.message} — skipping`);
      continue;
    }

    let kept = 0;
    for (const p of posts) {
      if (!p.title?.trim() || REDDIT_MOD_THREAD.test(p.title)) continue;
      // Only real discussion threads — never a bare subreddit or off-site link
      if (!/^https:\/\/www\.reddit\.com\/r\/[^/]+\/comments\//i.test(p.url)) continue;
      const age = now - p.createdMs;
      if (!isNaN(age) && (age < minAgeMs || age > maxAgeMs)) continue;

      items.push({
        kind: 'reddit',
        source: `r/${sub}`,
        via: mode,
        title: p.title.trim(),
        body: p.body.trim().slice(0, 600),
        url: p.url,
        score: p.score,
        comments: p.comments,
        flair: p.flair,
        created: isNaN(p.createdMs) ? null : new Date(p.createdMs).toISOString().slice(0, 10),
      });
      kept++;
    }
    console.log(`[scout] r/${sub}: kept ${kept} posts (of ${posts.length} fetched via ${mode})`);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Phase 1b: RSS collection from vetted publication sites
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Feed field → plain text: unwrap CDATA, decode entities, strip any HTML inside. */
function feedText(raw) {
  if (!raw) return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);            // escaped HTML (&lt;p&gt;) → real tags
  s = s.replace(/<[^>]+>/g, ' ');   // strip tags
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function tag(inner, name) {
  return inner.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
}

/** Minimal RSS/Atom parser: returns [{title, url, date, summary}] */
function parseRss(xml) {
  const items = [];
  // RSS <item> blocks
  for (const block of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const inner = block[1];
    const title = feedText(tag(inner, 'title'));
    const link = feedText(tag(inner, 'link')) ||
      inner.match(/<guid[^>]*isPermaLink="true"[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim();
    const date = tag(inner, 'pubDate')?.trim();
    const summary = feedText(tag(inner, 'description') || tag(inner, 'content:encoded'));
    if (title && link && link.startsWith('http')) items.push({ title, url: link, date, summary });
  }
  // Atom <entry> blocks (Reddit, YouTube)
  for (const block of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const inner = block[1];
    const title = feedText(tag(inner, 'title'));
    const link = inner.match(/<link[^>]*href="([^"]+)"/i)?.[1]?.trim();
    const date = (tag(inner, 'published') || tag(inner, 'updated'))?.trim();
    const summary = feedText(tag(inner, 'summary') || tag(inner, 'content') || tag(inner, 'media:description'));
    if (title && link && link.startsWith('http')) items.push({ title, url: decodeEntities(link), date, summary });
  }
  return items;
}

// Publisher footers that carry no information about the story
const FEED_BOILERPLATE = [
  /This article is from the coffee website Sprudge at \S+ \. This is the RSS feed version\.\s*/gi,
  /The post .{1,200}? appeared first on .{1,80}?\.\s*$/i,
];

function stripFeedBoilerplate(text) {
  return FEED_BOILERPLATE.reduce((t, re) => t.replace(re, ''), text).trim();
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
          entry.summary = stripFeedBoilerplate(entry.summary);
          // Headline-only, name-like entries (e.g. notabarista.org profile pages) aren't news
          if (!entry.summary && entry.title.split(/\s+/).length <= 4) continue;
          items.push({
            kind: 'article',
            source: host,
            title: entry.title,
            body: entry.summary.slice(0, 600),
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

/** @handle → UC… channel ID by reading the channel page (oEmbed only works for videos). */
async function resolveChannelId(handle) {
  const res = await fetch(`https://www.youtube.com/@${handle}`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DrewBrews-Radar/2.0)', 'Accept-Language': 'en', 'Cookie': 'CONSENT=YES+1' },
  });
  if (!res.ok) throw new Error(`channel page HTTP ${res.status}`);
  const html = await res.text();
  const id = html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/)?.[1] ||
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/)?.[1];
  if (!id) throw new Error('channel ID not found on page');
  return id;
}

async function fetchYouTubeVideos(channels) {
  const items = [];
  const maxAgeSec = MAX_POST_AGE_DAYS * 86400 * 1000;
  const now = Date.now();

  for (const { handle, id } of channels) {
    const label = handle ? `@${handle}` : id;
    try {
      let channelId = id;
      if (!channelId) {
        channelId = await resolveChannelId(handle);
        console.log(`[scout] ${label}: resolved to ${channelId} (pin it in sources.txt to skip this lookup)`);
      }

      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      // YouTube's feed endpoint intermittently 500s *and* 404s for valid
      // channels (seen in QA on known-good IDs) — retry both a few times
      const rRes = await withRetry(() => fetchOk(feedUrl, { signal: AbortSignal.timeout(10000) }), `YouTube ${label} feed`, 3, [404]);
      const xml = await rRes.text();
      const entries = parseRss(xml).slice(0, 5);

      for (const entry of entries) {
        const ms = entry.date ? Date.parse(entry.date) : NaN;
        if (!isNaN(ms) && now - ms > maxAgeSec) continue;
        items.push({
          kind: 'youtube',
          source: label,
          title: entry.title,
          body: entry.summary.slice(0, 600),
          url: entry.url,
          score: null,
          comments: null,
          created: isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10),
        });
      }

      console.log(`[scout] ${label}: ${entries.length} videos`);
    } catch (err) {
      console.warn(`[scout] ${label}: ${err.message} — skipping`);
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
- "buzz" may only state facts found in that item's title or text. If an item is
  just a headline, keep the buzz to what the headline says — never add details
  (prices, dates, teams, sales, "selling fast") that aren't in front of you,
  never name products or brands the item doesn't name, and don't claim
  something is "everywhere" or "blowing up" from a single post.
- Skip items that are off-topic for coffee, ads/promotions, or too vague to post.

Output: your picks, best first. For each:
  "index": the item's number from the list
  "name": short trend name (≤ 80 chars)
  "buzz": 1-2 sentences describing the trend (≤ 400 chars)
  "tpl": one of "s1" "s2" "s3" "s4" "s5" "s6" (pick based on content type)
  "src": "press" | "review" | "community" | "verify"
  "angle": how DrewBrews should frame it — inclusive, no gatekeeping (≤ 400 chars)`;

// Structured output: the API guarantees the reply matches this schema, so a
// stray quote in a post title can't break parsing (the old "[" prefill could).
const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Item number from the list' },
          name: { type: 'string' },
          buzz: { type: 'string' },
          tpl: { type: 'string', enum: [...VALID_TPL] },
          src: { type: 'string', enum: [...VALID_SRC] },
          angle: { type: 'string' },
        },
        required: ['index', 'name', 'buzz', 'tpl', 'src', 'angle'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

function buildCurationPrompt(items, today) {
  const numbered = items
    .map((item, i) => {
      const parts = [`[${i + 1}] ${item.kind.toUpperCase()} from ${item.source}`];
      parts.push(`Title: ${item.title}`);
      if (item.flair) parts.push(`Flair: ${item.flair}`);
      if (item.body) parts.push(`Text: ${item.body.slice(0, 400)}`);
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
    `Return your picks, best first.`
  );
}

async function curateTrends(client, items, today) {
  if (items.length === 0) return [];

  const response = await withRetry(
    () => client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: PICKS_SCHEMA } },
      messages: [{ role: 'user', content: buildCurationPrompt(items, today) }],
    }),
    'curation request'
  );

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    console.warn(`[scout] curation: stopped early (${response.stop_reason}) — no usable picks.`);
    return [];
  }
  let picks = [];
  try {
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    picks = JSON.parse(text).picks ?? [];
  } catch (err) {
    console.warn(`[scout] curation: reply wasn't valid JSON (${err.message}).`);
  }
  if (picks.length === 0) {
    console.warn(`[scout] curation: 0 picks (stop_reason: ${response.stop_reason}).`);
    return [];
  }
  console.log(`[scout] curation usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);

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
      src: VALID_SRC.has(pick.src) ? pick.src : (item.kind === 'article' ? 'press' : item.kind === 'youtube' ? 'review' : 'community'),
      ...(pick.angle?.trim() ? { angle: String(pick.angle).trim().slice(0, 400) } : {}),
      source_url: item.url, // ← REAL URL from our collection, never from the model
    });
  }

  console.log(`[scout] curation: ${trends.length} trends from ${picks.length} picks`);
  return trends.slice(0, 12);
}

// ---------------------------------------------------------------------------
// De-duplication — drop re-uploads (same title) and anything already on last
// week's radar, so each refresh is actually fresh.
// ---------------------------------------------------------------------------

async function previousUrls() {
  try {
    const prev = JSON.parse(await readFile(join(__dirname, 'radar.json'), 'utf8'));
    return new Set((prev.trends ?? []).map(t => t.source_url));
  } catch {
    return new Set();
  }
}

function dedupe(items, skipUrls) {
  const seenTitles = new Set();
  const out = [];
  let repeats = 0;
  for (const item of items) {
    if (skipUrls.has(item.url)) { repeats++; continue; }
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    out.push(item);
  }
  if (repeats) console.log(`[scout] Skipped ${repeats} items already on last week's radar`);
  return out;
}

// ---------------------------------------------------------------------------
// Source health — a whole source type going dark must be loud, not silent.
// Emits GitHub Actions ::warning:: annotations and a job-summary table.
// ---------------------------------------------------------------------------

async function reportSourceHealth(rows) {
  const lines = ['### Radar source health', '', '| Source | Configured | Items collected |', '|---|---|---|'];
  for (const [name, configured, collected] of rows) {
    const ok = configured === 0 || collected > 0;
    lines.push(`| ${ok ? '✅' : '❌'} ${name} | ${configured} | ${collected} |`);
    if (!ok) console.log(`::warning title=${name} source is empty::${configured} ${name} sources configured but 0 items collected this run.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
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
  console.log(`[scout] Model: ${MODEL} (effort ${EFFORT}) | date: ${today}`);

  // ── Phase 1: Collect real content ──────────────────────────────────────────
  const [redditPosts, rssArticles, ytVideos] = await Promise.all([
    fetchRedditPosts(subs),
    fetchRssArticles(rssHosts),
    fetchYouTubeVideos(ytChannels),
  ]);

  const allItems = dedupe([...redditPosts, ...rssArticles, ...ytVideos], await previousUrls());
  console.log(`[scout] Collected ${allItems.length} items total (${redditPosts.length} Reddit, ${rssArticles.length} articles, ${ytVideos.length} YouTube)`);
  await reportSourceHealth([
    ['Reddit', subs.length, redditPosts.length],
    ['Articles', rssHosts.length, rssArticles.length],
    ['YouTube', ytChannels.length, ytVideos.length],
  ]);
  if (COLLECTED_PATH) await writeFile(COLLECTED_PATH, JSON.stringify(allItems, null, 2) + '\n', 'utf8');

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

export { parseSources, parseRss, feedText, stripFeedBoilerplate };

// Run only when executed directly (importing for tests must not start a scout run)
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(err => {
  console.error('[scout] Fatal error. radar.json left untouched.');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
