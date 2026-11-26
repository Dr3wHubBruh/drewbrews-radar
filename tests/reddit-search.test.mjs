import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harvestRedditResults } from '../scout.mjs';

// Reddit search fallback: thread URLs are taken ONLY from the web_search tool's
// own result blocks (never from text Claude writes), then filtered to real
// /comments/ threads in vetted subreddits.

const SUBS = ['pourover', 'espresso', 'JamesHoffmann'];
const NOW = Date.parse('2026-11-26T12:00:00Z');

const result = (url, title, page_age = null) => ({ type: 'web_search_result', url, title, page_age, encrypted_content: 'x' });
const searchBlock = (...results) => ({ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results });

test('keeps a vetted-sub thread and canonicalizes its URL', () => {
  const items = harvestRedditResults([searchBlock(
    result('https://old.reddit.com/r/PourOver/comments/1abc23/my_new_kettle/?utm_source=share#top', 'My new kettle : r/pourover'),
  )], SUBS, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.reddit.com/r/pourover/comments/1abc23/my_new_kettle/');
  assert.equal(items[0].source, 'r/pourover');
  assert.equal(items[0].kind, 'reddit');
  assert.equal(items[0].via, 'search');
  assert.equal(items[0].title, 'My new kettle'); // " : r/pourover" suffix stripped
});

test('drops subreddit roots, off-list subs and non-reddit hosts', () => {
  const items = harvestRedditResults([searchBlock(
    result('https://www.reddit.com/r/pourover/', 'r/pourover'),
    result('https://www.reddit.com/r/randomsub/comments/9zz/hello/', 'Hello'),
    result('https://evil-reddit.com/r/pourover/comments/1x/bad/', 'Bad'),
    result('https://www.reddit.com/user/someone/comments/1y/post/', 'User post'),
  )], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('ignores URLs that appear only in text Claude wrote', () => {
  const items = harvestRedditResults([
    { type: 'text', text: 'See https://www.reddit.com/r/pourover/comments/1fake/made_up/' },
  ], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('de-duplicates the same thread found by two searches', () => {
  const items = harvestRedditResults([
    searchBlock(result('https://www.reddit.com/r/espresso/comments/1q2w3e/grinder/', 'Grinder')),
    searchBlock(result('https://reddit.com/r/espresso/comments/1q2w3e/grinder/?share=1', 'Grinder')),
  ], SUBS, NOW);
  assert.equal(items.length, 1);
});

test('drops threads older than 90 days, keeps undated ones', () => {
  const items = harvestRedditResults([searchBlock(
    result('https://www.reddit.com/r/espresso/comments/1old/old/', 'Old', 'January 3, 2026'),
    result('https://www.reddit.com/r/espresso/comments/1new/new/', 'New', 'November 20, 2026'),
    result('https://www.reddit.com/r/espresso/comments/1und/undated/', 'Undated'),
  )], SUBS, NOW);
  assert.deepEqual(items.map(i => i.title).sort(), ['New', 'Undated']);
  assert.equal(items.find(i => i.title === 'New').created, '2026-11-20');
});

test('drops recurring mod threads', () => {
  const items = harvestRedditResults([searchBlock(
    result('https://www.reddit.com/r/pourover/comments/1w/weekly_questions_thread/', 'Weekly Questions Thread'),
  )], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('error result blocks (content is an object, not a list) are skipped', () => {
  const items = harvestRedditResults([
    { type: 'web_search_tool_result', tool_use_id: 'srv_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  ], SUBS, NOW);
  assert.equal(items.length, 0);
});

test('attaches quoted page text from citations as the body', () => {
  const url = 'https://www.reddit.com/r/pourover/comments/1abc23/my_new_kettle/';
  const items = harvestRedditResults([
    searchBlock(result(url, 'My new kettle')),
    { type: 'text', text: 'done', citations: [{ type: 'web_search_result_location', url, title: 'My new kettle', cited_text: 'Finally upgraded to a gooseneck kettle.' }] },
  ], SUBS, NOW);
  assert.equal(items[0].body, 'Finally upgraded to a gooseneck kettle.');
});
