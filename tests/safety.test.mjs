import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAllowlist, gate, isAllowedSourceUrl, itemReason } from '../safety.mjs';
import { parseSources } from '../scout.mjs';

const allow = buildAllowlist(parseSources(readFileSync(new URL('../sources.txt', import.meta.url), 'utf8')));
const ok = u => isAllowedSourceUrl(u, allow);

// Brief §7: the eight required cases.
test('off-list domain is dropped', () => assert.equal(ok('https://www.randomcoffeeblog.net/2026/10/best-grinders'), false));
test('subreddit root is dropped', () => {
  assert.equal(ok('https://www.reddit.com/r/pourover'), false);
  assert.equal(ok('https://www.reddit.com/r/pourover/'), false);
});
test('channel root is dropped', () => {
  assert.equal(ok('https://www.youtube.com/@LanceHedrick'), false);
  assert.equal(ok('https://m.youtube.com/@LanceHedrick/videos'), false);
  assert.equal(ok('https://www.youtube.com/channel/UCMb0O2CdPBNi-QqPk5T3gsQ'), false);
});
test('homepage is dropped', () => {
  assert.equal(ok('https://sprudge.com/'), false);
  assert.equal(ok('https://www.hario.com'), false);
});
test('NSFW-style random domain is dropped', () => assert.equal(ok('https://hot-singles-xxx.example/coffee/v60-review'), false));
test('valid thread is kept', () => assert.equal(ok('https://www.reddit.com/r/pourover/comments/1x14t91/best_thrift_find_ever/'), true));
test('valid video is kept', () => {
  assert.equal(ok('https://www.youtube.com/watch?v=gAUYvSB0fdU'), true);
  assert.equal(ok('https://youtu.be/gAUYvSB0fdU'), true);
});
test('valid article is kept', () => assert.equal(ok('https://dailycoffeenews.com/2026/09/30/breville-enters-the-automated-pourover-stream-with-the-spiral-luxe-brewer/'), true));

test('tricks are dropped', () => {
  for (const u of ['https://sprudge.com.evil.example/2026/x-article', 'https://evilsprudge.com/2026/x-article', 'https://sprudge.com@evil.example/2026/x',
    'https://user:pw@sprudge.com/2026/x-article', 'javascript:alert(1)', 'https://www.youtube.com/watch?v=', 'https://www.youtube.com/results?search_query=v60',
    'https://www.reddit.com/r/randomsub/comments/1abc/x/', 'https://redd.it/1abcde', 'not a url', '', undefined]) {
    assert.equal(ok(u), false, u);
  }
});

test('sources.txt comment lines are not read as sites', () => {
  assert.ok(!allow.hosts.includes('scout.mjs'));
  assert.ok(!allow.hosts.some(h => h.includes('youtube') || h.includes('reddit')));
});

// Handoff acceptance: "a deliberately-injected off-allowlist URL is dropped".
test('gate drops injected bad items and says why', () => {
  const items = [
    { kind: 'article', source: 'sprudge.com', feedHost: 'sprudge.com', title: 'Real article', url: 'https://sprudge.com/la-marzocco-and-rains-collaborate-1409605.html' },
    { kind: 'article', source: 'sprudge.com', feedHost: 'sprudge.com', title: 'Sponsored link in the feed', url: 'https://dailycoffeenews.com/2026/10/01/sponsored-thing/' },
    { kind: 'article', source: 'sprudge.com', feedHost: 'sprudge.com', title: 'Injected', url: 'https://hot-singles-xxx.example/coffee/v60' },
    { kind: 'reddit', source: 'r/pourover', title: 'Thread', url: 'https://www.reddit.com/r/pourover/comments/1x2fu5h/rule/' },
    { kind: 'youtube', source: '@LanceHedrick', title: 'Channel page', url: 'https://www.youtube.com/@LanceHedrick' },
  ];
  const { safe, dropped } = gate(items, allow);
  assert.deepEqual(safe.map(i => i.title), ['Real article', 'Thread']);
  assert.deepEqual(dropped.map(d => d.title), ['Sponsored link in the feed', 'Injected', 'Channel page']);
  assert.match(dropped[0].reason, /leaves its feed's site/);
  assert.match(dropped[1].reason, /not on the allowlist/);
  assert.match(dropped[2].reason, /not a single video/);
});

test('every link on the current published radar passes', () => {
  const radar = JSON.parse(readFileSync(new URL('../radar.json', import.meta.url), 'utf8'));
  for (const t of radar.trends) assert.equal(itemReason({ url: t.source_url }, allow), null, t.source_url);
});

test('Shorts from vetted channels are published as standard video links', async () => {
  const { canonicalVideoUrl } = await import('../scout.mjs');
  assert.equal(canonicalVideoUrl('https://www.youtube.com/shorts/C2GPgal4RUM'), 'https://www.youtube.com/watch?v=C2GPgal4RUM');
  assert.equal(ok(canonicalVideoUrl('https://www.youtube.com/shorts/C2GPgal4RUM')), true);
  assert.equal(canonicalVideoUrl('https://www.youtube.com/watch?v=gAUYvSB0fdU&t=3'), 'https://www.youtube.com/watch?v=gAUYvSB0fdU');
  assert.equal(canonicalVideoUrl('https://www.youtube.com/@LanceHedrick'), 'https://www.youtube.com/@LanceHedrick');
  assert.equal(ok(canonicalVideoUrl('https://www.youtube.com/@LanceHedrick')), false);
});
