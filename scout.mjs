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

import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
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

// ── Article images (see RADAR_IMAGES_SPEC.md) ──
// Images are re-hosted on GitHub Pages (hotlinked images export blank from the
// Story Kit). IMAGES_DIR is where the files live in the repo; a dry run points
// it somewhere else so it never touches the published images.
const PAGES_BASE_URL = (process.env.PAGES_BASE_URL || 'https://dr3whubbruh.github.io/drewbrews-radar').replace(/\/+$/, '');
const IMAGES_DIR = process.env.IMAGES_DIR || join(__dirname, 'images');
const IMAGE_MIN_EDGE = 600;       // skip anything smaller on its long edge
const IMAGE_MAX_EDGE = 1500;      // resize down to this long edge
const IMAGE_JPEG_QUALITY = 82;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
// Maker (manufacturer / roaster) domains. image_license "press" is set ONLY
// when image_origin is on one of these. Keep in sync with MFR_HOSTS in
// drewbrews-trend-studio.html; add a maker here when Drew starts covering one.
const MAKER_HOSTS = ['aprilcoffeeroasters.com', 'miir.com', 'hario.com', 'option-o.com', 'fellowproducts.com'];
// Publication domains: their photographers own the images → "editorial".
// The article sites in sources.txt are added to this list at run time.
const PUBLICATION_HOSTS = ['sprudge.com', 'dailycoffeenews.com', 'perfectdailygrind.com', 'notabarista.org'];

const MODEL = process.env.MODEL || 'claude-sonnet-5';
// Sonnet 5 thinks (adaptively) by default — leave room for thinking + ~12 picks
const MAX_TOKENS = 16000;
// Picking + short copy doesn't need deep reasoning; medium keeps it quick and cheap
const EFFORT = process.env.EFFORT || 'medium';

// At most this many trends from one subreddit / site / channel
const MAX_PER_SOURCE = 4;

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

/**
 * The image a publisher attached to a feed entry (meant for syndication):
 * media:content / media:thumbnail / image enclosure, else the first <img> in
 * the entry's HTML. Returns an absolute http(s) URL or null.
 */
function feedEntryImage(inner, base) {
  const attrUrl = re => inner.match(re)?.[1];
  const html = decodeEntities((inner.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1] ||
    inner.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  const raw =
    attrUrl(/<media:content\b(?=[^>]*\b(?:medium="image"|type="image\/))[^>]*\burl="([^"]+)"/i) ||
    attrUrl(/<media:thumbnail\b[^>]*\burl="([^"]+)"/i) ||
    attrUrl(/<enclosure\b(?=[^>]*\btype="image\/)[^>]*\burl="([^"]+)"/i) ||
    html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!raw) return null;
  try {
    const url = new URL(decodeEntities(raw.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Minimal RSS/Atom parser: returns [{title, url, date, summary, image}] */
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
    if (title && link && link.startsWith('http')) items.push({ title, url: link, date, summary, image: feedEntryImage(inner, link) });
  }
  // Atom <entry> blocks (Reddit, YouTube)
  for (const block of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const inner = block[1];
    const title = feedText(tag(inner, 'title'));
    const link = inner.match(/<link[^>]*href="([^"]+)"/i)?.[1]?.trim();
    const date = (tag(inner, 'published') || tag(inner, 'updated'))?.trim();
    const summary = feedText(tag(inner, 'summary') || tag(inner, 'content') || tag(inner, 'media:description'));
    if (title && link && link.startsWith('http')) items.push({ title, url: decodeEntities(link), date, summary, image: feedEntryImage(inner, decodeEntities(link)) });
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
          // Headline-only, name-like entries (e.g. author profile pages) aren't news
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
            feedImage: entry.image, // fallback when the article page can't be read
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

/**
 * Latest uploads via the YouTube Data API (needs YOUTUBE_API_KEY).
 * Reads the channel's "uploads" playlist (UC… → UU…) with playlistItems.list,
 * which costs 1 quota unit per call (search.list costs 100) and, unlike search,
 * lists every upload rather than what the search index happens to return.
 */
async function fetchChannelApi(channelId, label, key) {
  const params = new URLSearchParams({
    part: 'snippet', maxResults: '5', playlistId: 'UU' + channelId.slice(2), key,
  });
  const res = await withRetry(
    () => fetchOk(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, { signal: AbortSignal.timeout(10000) }),
    `YouTube API ${label}`
  );
  const data = await res.json();
  return (data.items ?? [])
    .map(i => i.snippet)
    .filter(sn => sn?.resourceId?.videoId && sn.title && !/^(private|deleted) video$/i.test(sn.title))
    .map(sn => ({
      title: sn.title,
      url: `https://www.youtube.com/watch?v=${sn.resourceId.videoId}`,
      date: sn.publishedAt,
      summary: sn.description || '',
      thumbs: ['maxres', 'standard', 'high'].map(k => sn.thumbnails?.[k]?.url).filter(Boolean),
    }));
}

/** Latest uploads via the public feed (no key). Flaky from GitHub runners. */
async function fetchChannelFeed(channelId, label) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  // The feed endpoint intermittently 500s *and* 404s for valid channels
  // (seen in QA on known-good IDs) — retry both a few times
  const res = await withRetry(() => fetchOk(feedUrl, { signal: AbortSignal.timeout(10000) }), `YouTube ${label} feed`, 3, [404]);
  return parseRss(await res.text()).slice(0, 5);
}

async function fetchYouTubeVideos(channels) {
  const items = [];
  const maxAgeSec = MAX_POST_AGE_DAYS * 86400 * 1000;
  const now = Date.now();
  const key = process.env.YOUTUBE_API_KEY;
  const mode = key ? 'api' : 'feed';
  console.log(`[scout] YouTube mode: ${key ? 'Data API' : 'public feeds (no YOUTUBE_API_KEY set)'}`);

  for (const { handle, id } of channels) {
    const label = handle ? `@${handle}` : id;
    try {
      let channelId = id;
      if (!channelId) {
        channelId = await resolveChannelId(handle);
        console.log(`[scout] ${label}: resolved to ${channelId} (pin it in sources.txt to skip this lookup)`);
      }

      const entries = mode === 'api'
        ? await fetchChannelApi(channelId, label, key)
        : await fetchChannelFeed(channelId, label);

      let recent = 0;
      for (const entry of entries) {
        const ms = entry.date ? Date.parse(entry.date) : NaN;
        if (!isNaN(ms) && now - ms > maxAgeSec) continue;
        recent++;
        items.push({
          kind: 'youtube',
          source: label,
          title: entry.title,
          body: entry.summary.slice(0, 600),
          url: entry.url,
          score: null,
          comments: null,
          created: isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10),
          thumbs: entry.thumbs ?? [],
        });
      }

      console.log(`[scout] ${label}: ${recent} recent videos (of ${entries.length} fetched via ${mode})`);
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
- Set "src" to "verify" when the item makes a claim DrewBrews should double-check
  before posting (a single user's report, a rumor or leak, a health or science
  claim) and keep that buzz cautious. Otherwise: "press" = publication/news,
  "review" = gear or product review/demo, "community" = Reddit or creator chatter.

Output: your picks, best first. For each:
  "index": the item's number from the list
  "name": short trend name (≤ 80 chars)
  "buzz": 1-2 sentences describing the trend (≤ 400 chars)
  "tpl": one of "s1" "s2" "s3" "s4" "s5" "s6": which of the Studio's six Instagram
         story templates this becomes. Pick the layout that best fits the content,
         and vary templates across picks rather than reusing one for everything
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

function buildCurationPrompt(items, today, lastWeek = []) {
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
    `Order them best-first. If fewer than 12 are truly postable, return fewer — quality over quantity. ` +
    `Keep the mix varied: no more than 4 picks from any single subreddit, site, or channel.\n\n` +
    `For each pick, write fresh "buzz" and "angle" copy in DrewBrews voice. ` +
    `Set "index" to the item's number. Do NOT invent items not on this list.\n\n` +
    (lastWeek.length
      ? `LAST WEEK'S RADAR already covered these stories. Don't pick the same story again, ` +
        `even if it comes from a different outlet:\n${lastWeek.map(n => `- ${n}`).join('\n')}\n\n`
      : '') +
    `ITEMS:\n\n${numbered}\n\n` +
    `Return your picks, best first.`
  );
}

async function curateTrends(client, items, today, lastWeek = []) {
  if (items.length === 0) return [];

  const response = await withRetry(
    () => client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: PICKS_SCHEMA } },
      messages: [{ role: 'user', content: buildCurationPrompt(items, today, lastWeek) }],
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
  const perSource = new Map();
  for (const pick of picks) {
    const idx = typeof pick.index === 'number' ? pick.index - 1 : -1;
    if (idx < 0 || idx >= items.length) {
      console.warn(`[scout] curation: pick has invalid index ${pick.index} — dropping`);
      continue;
    }
    const item = items[idx];
    if (!pick.name?.trim() || !pick.buzz?.trim()) continue;
    const n = (perSource.get(item.source) ?? 0) + 1;
    if (n > MAX_PER_SOURCE) continue; // keep the radar varied
    perSource.set(item.source, n);

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

async function previousRadar() {
  try {
    const prev = JSON.parse(await readFile(join(__dirname, 'radar.json'), 'utf8'));
    const trends = prev.trends ?? [];
    return { urls: new Set(trends.map(t => t.source_url)), names: trends.map(t => t.name) };
  } catch {
    return { urls: new Set(), names: [] };
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
// Article images (RADAR_IMAGES_SPEC.md)
//   article page → og:image / twitter:image / link rel=image_src → download →
//   resize to JPEG → stage in a temp dir. Nothing is written to IMAGES_DIR
//   until the whole radar has passed validation (see publishRadar).
// ---------------------------------------------------------------------------

function matchDomain(host, domains) {
  return domains.find(d => host === d || host.endsWith('.' + d)) ?? null;
}

/** Rights come from who owns the pixels (the image_origin host), never from what the story is about. */
function imageRights(originUrl, publicationHosts) {
  const host = new URL(originUrl).hostname.toLowerCase().replace(/^www\./, '');
  const maker = matchDomain(host, MAKER_HOSTS);
  if (maker) return { license: 'press', credit: maker };
  const publication = matchDomain(host, publicationHosts);
  if (publication) return { license: 'editorial', credit: publication };
  return { license: 'unknown', credit: null };
}

function tagAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** First of og:image → twitter:image → <link rel="image_src">, resolved against the page URL. */
function extractImageUrl(html, pageUrl) {
  const end = html.search(/<\/head>/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 500_000);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(m => tagAttrs(m[0]));
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(m => tagAttrs(m[0]));
  const meta = key => metas.find(a => (a.property || a.name || '').toLowerCase() === key)?.content;
  const raw = meta('og:image') ||
    meta('twitter:image') ||
    links.find(a => (a.rel || '').toLowerCase().split(/\s+/).includes('image_src'))?.href;
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), pageUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

async function downloadImage(url) {
  const res = await fetchOk(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/*' },
  });
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
  if (Number(res.headers.get('content-length') || 0) > IMAGE_MAX_BYTES) throw new Error('image too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMAGE_MAX_BYTES) throw new Error('image too large');
  // res.url is where the pixels actually came from (after any redirects)
  return { buf, origin: res.url || url };
}

/** → JPEG ≤ 1500px long edge, or null when the source is under 600px (too small for a story frame). */
async function toStoryJpeg(buf) {
  const img = sharp(buf, { failOn: 'error', limitInputPixels: 50_000_000 }).autoOrient();
  const { width = 0, height = 0 } = await img.metadata();
  if (Math.max(width, height) < IMAGE_MIN_EDGE) return null;
  return img
    .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

function slugify(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'trend';
}

const IMAGE_ORIGIN_PATTERN = /^https?:\/\/[^/]+\.[^/]+\/[^\s]+$/; // mirrors radar.schema.json

/**
 * Adds image_url / image_origin / image_credit / image_license to article
 * trends, staging the files in stagingDir. A trend only gets image fields when
 * the whole chain succeeded AND the origin is traceable; otherwise it gets none.
 */
function youtubeVideoId(url) {
  return url.match(/(?:[?&]v=|\/shorts\/|youtu\.be\/)([\w-]{11})/)?.[1] ?? null;
}

/**
 * Ranked image candidates for a trend: [{ url, via }]. First one that downloads
 * and is big enough wins.
 *   article → the page's og:image / twitter:image / image_src (the spec's
 *             route), then the image the publisher put in its RSS feed
 *   youtube → the API's largest thumbnails, then the standard i.ytimg.com
 *             maxres/sd sizes (hqdefault is 480px: always under the floor)
 *   reddit  → none
 */
async function imageCandidates(trend, item, label) {
  const out = [];
  if (item?.kind === 'article') {
    try {
      const page = await withRetry(
        () => fetchOk(trend.source_url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': USER_AGENT } }),
        `article page (${label})`
      );
      const og = extractImageUrl(await page.text(), page.url || trend.source_url);
      if (og) out.push({ url: og, via: 'article page' });
      else console.log(`[scout] ${label}: article page has no og:image / twitter:image / image_src`);
    } catch (err) {
      console.log(`[scout] ${label}: article page unreadable (${err.message})`);
    }
    if (item.feedImage) out.push({ url: item.feedImage, via: 'RSS feed' });
  } else if (item?.kind === 'youtube') {
    for (const url of item.thumbs ?? []) out.push({ url, via: 'YouTube thumbnail' });
    const id = youtubeVideoId(trend.source_url);
    if (id) for (const size of ['maxresdefault', 'sddefault']) out.push({ url: `https://i.ytimg.com/vi/${id}/${size}.jpg`, via: 'YouTube thumbnail' });
  }
  return out.filter((c, i, all) => all.findIndex(o => o.url === c.url) === i);
}

/**
 * Adds image_url / image_origin / image_credit / image_license to article and
 * YouTube trends, staging the files in stagingDir. A trend only gets image
 * fields when a download fully succeeded AND its origin is traceable;
 * otherwise it gets none.
 */
async function attachImages(trends, itemsByUrl, stagingDir, publicationHosts) {
  const used = new Set();
  let attached = 0;
  for (const trend of trends) {
    const item = itemsByUrl.get(trend.source_url);
    if (item?.kind !== 'article' && item?.kind !== 'youtube') continue;
    const label = `image for "${trend.name}"`;
    const candidates = await imageCandidates(trend, item, label);
    if (!candidates.length) { console.log(`[scout] ${label}: no image found — none attached`); continue; }

    for (const { url, via } of candidates) {
      try {
        const { buf, origin } = await downloadImage(url);
        if (origin.length > 500 || !IMAGE_ORIGIN_PATTERN.test(origin)) {
          console.log(`[scout] ${label}: ${via} origin isn't traceable (${origin.slice(0, 80)})`);
          continue;
        }
        const jpeg = await toStoryJpeg(buf);
        if (!jpeg) { console.log(`[scout] ${label}: ${via} image under ${IMAGE_MIN_EDGE}px`); continue; }

        let file = `${slugify(trend.name)}.jpg`;
        for (let n = 2; used.has(file); n++) file = `${slugify(trend.name)}-${n}.jpg`;
        used.add(file);
        await writeFile(join(stagingDir, file), jpeg);

        const { license, credit } = imageRights(origin, publicationHosts);
        trend.image_url = `${PAGES_BASE_URL}/images/${file}`;
        trend.image_origin = origin;
        // A video thumbnail belongs to the channel that made it
        const who = credit ?? (item.kind === 'youtube' ? item.source : null);
        if (who) trend.image_credit = who;
        trend.image_license = license;
        attached++;
        console.log(`[scout] ${label}: ${file} via ${via} (${license}, from ${new URL(origin).hostname})`);
        break;
      } catch (err) {
        console.log(`[scout] ${label}: ${via} download failed (${err.message})`);
      }
    }
    if (!trend.image_url) console.log(`[scout] ${label}: none attached`);
  }
  console.log(`[scout] Images: attached to ${attached} of ${trends.length} trends`);
}

/** Rules from the spec's acceptance check that JSON Schema can't express. */
function imageRuleErrors(radar, publicationHosts) {
  const errors = [];
  radar.trends.forEach((t, i) => {
    const at = `trends[${i}] "${t.name}"`;
    if (t.image_url) {
      if (!t.image_url.startsWith(`${PAGES_BASE_URL}/images/`)) errors.push(`${at}: image_url is not under ${PAGES_BASE_URL}/images/`);
      if (!t.image_origin) errors.push(`${at}: image_url without image_origin`);
    }
    if (t.image_license === 'press') {
      const host = t.image_origin ? new URL(t.image_origin).hostname.replace(/^www\./, '') : '';
      if (!matchDomain(host, MAKER_HOSTS) || matchDomain(host, publicationHosts)) {
        errors.push(`${at}: "press" license on a non-maker origin (${host || 'none'})`);
      }
    }
  });
  return errors;
}

/**
 * Only called after validation passed: copy staged images in, write radar.json
 * atomically, then prune images the new radar no longer references.
 */
async function publishRadar(radar, stagingDir) {
  const referenced = new Set(radar.trends.filter(t => t.image_url).map(t => basename(new URL(t.image_url).pathname)));
  if (referenced.size) await mkdir(IMAGES_DIR, { recursive: true });
  for (const file of referenced) await copyFile(join(stagingDir, file), join(IMAGES_DIR, file));

  const tmp = `${OUTPUT_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(radar, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_PATH);

  let pruned = 0;
  for (const file of await readdir(IMAGES_DIR).catch(() => [])) {
    if (!referenced.has(file)) { await rm(join(IMAGES_DIR, file), { force: true }); pruned++; }
  }
  if (pruned) console.log(`[scout] Pruned ${pruned} image(s) no longer on the radar`);
}

// ---------------------------------------------------------------------------
// Source health — a whole source type going dark must be loud, not silent.
// Emits GitHub Actions ::warning:: annotations and a job-summary table.
// ---------------------------------------------------------------------------

const HEALTH_HINTS = {
  Reddit: process.env.REDDIT_CLIENT_ID ? '' : ' Known gap: Reddit API access not set up yet (see README → Known gaps).',
  YouTube: process.env.YOUTUBE_API_KEY ? ' Check the YOUTUBE_API_KEY secret and its quota.' : ' No YOUTUBE_API_KEY set, so the flaky public feeds were used (see README setup step 7).',
};

async function reportSourceHealth(rows) {
  const lines = ['### Radar source health', '', '| Source | Configured | Items collected |', '|---|---|---|'];
  for (const [name, configured, collected] of rows) {
    const ok = configured === 0 || collected > 0;
    lines.push(`| ${ok ? '✅' : '❌'} ${name} | ${configured} | ${collected} |`);
    if (!ok) console.log(`::warning title=${name} source is empty::${configured} ${name} sources configured but 0 items collected this run.${HEALTH_HINTS[name] ?? ''}`);
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

  const previous = await previousRadar();
  const allItems = dedupe([...redditPosts, ...rssArticles, ...ytVideos], previous.urls);
  const kept = kind => allItems.filter(i => i.kind === kind).length;
  console.log(`[scout] Collected ${allItems.length} items after de-duplication (${kept('reddit')} Reddit, ${kept('article')} articles, ${kept('youtube')} YouTube)`);
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
  let trends = await curateTrends(client, allItems, today, previous.names);

  if (trends.length === 0) {
    console.error('[scout] No trends selected by curation. radar.json left untouched.');
    process.exit(1);
  }

  // ── Phase 3: Article images (staged, not yet published) ────────────────────
  const publicationHosts = [...new Set([...PUBLICATION_HOSTS, ...rssHosts])];
  const stagingDir = await mkdtemp(join(tmpdir(), 'radar-images-'));
  await attachImages(trends, new Map(allItems.map(i => [i.url, i])), stagingDir, publicationHosts);

  // ── Phase 4: Validate, then publish ────────────────────────────────────────
  const radar = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    trends,
  };

  const ruleErrors = imageRuleErrors(radar, publicationHosts);
  if (!validate(radar) || ruleErrors.length) {
    console.error('[scout] Result FAILED validation. radar.json and images/ left untouched.');
    if (validate.errors) console.error('  ' + ajv.errorsText(validate.errors, { separator: '\n  ' }));
    for (const e of ruleErrors) console.error('  ' + e);
    process.exit(1);
  }

  await publishRadar(radar, stagingDir);
  await rm(stagingDir, { recursive: true, force: true });
  console.log(`[scout] ✅ Wrote ${trends.length} trends to radar.json (generatedAt ${radar.generatedAt}).`);
}

export { parseSources, parseRss, feedText, stripFeedBoilerplate, fetchChannelApi, extractImageUrl, imageRights, toStoryJpeg, slugify, imageRuleErrors, attachImages, publishRadar, feedEntryImage, youtubeVideoId };

// Run only when executed directly (importing for tests must not start a scout run)
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(err => {
  console.error('[scout] Fatal error. radar.json left untouched.');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
