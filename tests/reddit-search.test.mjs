import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exaToRedditItems, exaSearchBody } from '../scout.mjs';

// Reddit fallback via Exa search: thread URLs come only from Exa's results,
// then are filtered to real /comments/ threads in vetted subreddits.

const SUBS = ['pourover', 'espresso', 'JamesHoffmann'];
const NOW = Date.parse('2026-11-26T12:00:00Z');
const r = (url, title, publishedDate, text) => ({ id: url, url, title, publishedDate, text });

test('keeps a vetted-sub thread and canonicalizes its URL', () => {
  const items = exaToRedditItems([
    r('https://old.reddit.com/r/PourOver/comments/1abc23/my_new_kettle/?utm_source=share#top', 'My new kettle : r/pourover', '2026-11-24T10:00:00.000Z', 'Finally upgraded to a gooseneck.'),
  ], SUBS, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.reddit.com/r/pourover/comments/1abc23/my_new_kettle/');
  assert.equal(items[0].source, 'r/pourover');
  assert.equal(items[0].kind, 'reddit');
  assert.equal(items[0].via, 'exa');
  assert.equal(items[0].title, 'My new kettle'); // " : r/pourover" suffix stripped
  assert.equal(items[0].body, 'Finally upgraded to a gooseneck.');
  assert.equal(items[0].created, '2026-11-24');
});

test('drops subreddit roots, off-list subs, user pages and look-alike hosts', () => {
  const items = exaToRedditItems([
    r('https://www.reddit.com/r/pourover/', 'r/pourover'),
    r('https://www.reddit.com/r/randomsub/comments/9zz/hello/', 'Hello'),
    r('https://evil-reddit.com/r/pourover/comments/1x/bad/', 'Bad'),
    r('https://www.reddit.com/user/someone/comments/1y/post/', 'User post'),
  ], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('de-duplicates the same thread found twice', () => {
  const items = exaToRedditItems([
    r('https://www.reddit.com/r/espresso/comments/1q2w3e/grinder/', 'Grinder'),
    r('https://reddit.com/r/espresso/comments/1q2w3e/grinder/?share=1', 'Grinder'),
  ], SUBS, NOW);
  assert.equal(items.length, 1);
});

test('drops threads older than 90 days, keeps undated ones', () => {
  const items = exaToRedditItems([
    r('https://www.reddit.com/r/espresso/comments/1old/old/', 'Old', '2026-01-03T00:00:00.000Z'),
    r('https://www.reddit.com/r/espresso/comments/1new/new/', 'New', '2026-11-20T00:00:00.000Z'),
    r('https://www.reddit.com/r/espresso/comments/1und/undated/', 'Undated'),
  ], SUBS, NOW);
  assert.deepEqual(items.map(i => i.title).sort(), ['New', 'Undated']);
});

test('drops recurring mod threads', () => {
  const items = exaToRedditItems([
    r('https://www.reddit.com/r/pourover/comments/1w/weekly_questions_thread/', 'Weekly Questions Thread'),
  ], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('tolerates a missing or malformed results list', () => {
  assert.deepEqual(exaToRedditItems(undefined, SUBS, NOW), []);
  assert.deepEqual(exaToRedditItems([null, {}, { url: 42 }], SUBS, NOW), []);
});

test('search body limits Exa to one subreddit and the last week', () => {
  const body = exaSearchBody('pourover', NOW);
  assert.deepEqual(body.includeDomains, ['reddit.com/r/pourover']);
  assert.equal(body.startPublishedDate, '2026-11-18T12:00:00.000Z'); // 8 days back
  assert.ok(body.numResults <= 10); // base price covers up to 10 results
  assert.ok(body.contents.text.maxCharacters <= 1000);
});
