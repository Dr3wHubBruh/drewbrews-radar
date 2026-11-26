import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPicks, isRecent, emptySources, alertSources, MAX_PER_KIND, MAX_PER_SOURCE, ARTICLE_MAX_AGE_DAYS } from '../scout.mjs';

// --- Per-platform cap -------------------------------------------------------
// Nov 18 2026: 9 of 12 trends were YouTube, because the cap only counted each
// channel. The cap must also hold per platform (reddit / youtube / article).

const yt = (n, ch) => ({ kind: 'youtube', source: `@ch${ch}`, url: `https://www.youtube.com/watch?v=vid${n}`, title: `v${n}` });
const art = (n) => ({ kind: 'article', source: 'sprudge.com', url: `https://sprudge.com/story-${n}`, title: `a${n}` });
const pick = (index) => ({ index, name: `pick ${index}`, buzz: 'buzz', tpl: 's1', src: 'review', angle: 'angle' });

test('no more than MAX_PER_KIND picks from one platform', () => {
  // 9 videos from 9 different channels: the old per-channel cap let all through.
  const items = Array.from({ length: 9 }, (_, i) => yt(i, i));
  const trends = mapPicks(items.map((_, i) => pick(i + 1)), items);
  assert.equal(trends.length, MAX_PER_KIND);
});

test('platform cap does not starve other platforms', () => {
  const items = [...Array.from({ length: 8 }, (_, i) => yt(i, i)), art(1), art(2)];
  const trends = mapPicks(items.map((_, i) => pick(i + 1)), items);
  assert.equal(trends.filter(t => t.source_url.includes('youtube')).length, MAX_PER_KIND);
  assert.equal(trends.filter(t => t.source_url.includes('sprudge')).length, 2);
});

test('per-source cap still applies', () => {
  const items = Array.from({ length: 6 }, (_, i) => yt(i, 0)); // all one channel
  const trends = mapPicks(items.map((_, i) => pick(i + 1)), items);
  assert.equal(trends.length, MAX_PER_SOURCE);
});

test('source_url always comes from the collected item, never the pick', () => {
  const items = [yt(1, 1)];
  const trends = mapPicks([{ ...pick(1), source_url: 'https://evil.example/x' }], items);
  assert.equal(trends[0].source_url, 'https://www.youtube.com/watch?v=vid1');
});

test('invalid index is dropped', () => {
  assert.equal(mapPicks([pick(0), pick(5)], [yt(1, 1)]).length, 0);
});

// --- Article recency --------------------------------------------------------
const DAY = 86400 * 1000;
const now = Date.parse('2026-11-25T12:00:00Z');

test('article within the window is recent', () => {
  assert.equal(isRecent(now - 3 * DAY, now, ARTICLE_MAX_AGE_DAYS), true);
});
test('article older than the window is not recent', () => {
  assert.equal(isRecent(now - (ARTICLE_MAX_AGE_DAYS + 1) * DAY, now, ARTICLE_MAX_AGE_DAYS), false);
});
test('undated entry is kept (feeds without dates must not go dark)', () => {
  assert.equal(isRecent(NaN, now, ARTICLE_MAX_AGE_DAYS), true);
});
test('article window is about two weeks', () => {
  assert.ok(ARTICLE_MAX_AGE_DAYS >= 7 && ARTICLE_MAX_AGE_DAYS <= 21);
});

// --- Empty-source alert -----------------------------------------------------
test('emptySources names each configured source type that collected nothing', () => {
  assert.deepEqual(emptySources([['Reddit', 5, 0], ['Articles', 3, 12], ['YouTube', 8, 0]]), ['Reddit', 'YouTube']);
});
test('a source type with nothing configured is never "empty"', () => {
  assert.deepEqual(emptySources([['Reddit', 0, 0], ['YouTube', 8, 4]]), []);
});

// --- Muting a known-dark source from the alert ------------------------------
test('alertSources leaves out types named in the ignore list (case-insensitive)', () => {
  assert.deepEqual(alertSources(['Reddit', 'YouTube'], 'reddit'), ['YouTube']);
  assert.deepEqual(alertSources(['Reddit'], ' Reddit , Articles '), []);
});
test('alertSources with no ignore list alerts on everything empty', () => {
  assert.deepEqual(alertSources(['Reddit', 'Articles'], undefined), ['Reddit', 'Articles']);
  assert.deepEqual(alertSources(['Reddit'], ''), ['Reddit']);
});
