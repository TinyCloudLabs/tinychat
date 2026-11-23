import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextWhenReady } from '../release/lib.mjs';

// Cloudflare Pages promotes a deployment before its unique URL answers: the first request can be a 404 or a failed
// connection, and the deploy must not fail on that alone.
const COMMIT = 'b'.repeat(40);
const URL_ = 'https://db3fc2e2.tinychat.pages.dev/';
const noSleep = async () => {};

test('a 404 and then a connection error are retried until the page answers', async () => {
  const answers = [new Response('missing', { status: 404 }), new Error('connect ECONNREFUSED'), new Response('<html>ok</html>', { status: 200 })];
  const seen = [];
  const fetchImpl = async url => {
    seen.push(String(url));
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const retries = [];
  const text = await fetchTextWhenReady(URL_, COMMIT, { fetchImpl, attempts: 5, sleepImpl: noSleep, onRetry: (error, attempt) => retries.push([error.message, attempt]) });
  assert.equal(text, '<html>ok</html>');
  assert.equal(seen.length, 3);
  assert.ok(seen.every(url => url === `${URL_}?deploy=${COMMIT}`));
  assert.deepEqual(retries, [[`GET ${URL_}?deploy=${COMMIT} -> 404`, 1], ['connect ECONNREFUSED', 2]]);
});

test('a page that never answers fails with the last error after the last attempt', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('gone', { status: 503 });
  };
  await assert.rejects(fetchTextWhenReady(URL_, COMMIT, { fetchImpl, attempts: 3, sleepImpl: noSleep }), /-> 503/);
  assert.equal(calls, 3);
});

test('a page that answers at once is fetched once and does not sleep', async () => {
  let slept = 0;
  const text = await fetchTextWhenReady(URL_, COMMIT, { fetchImpl: async () => new Response('first', { status: 200 }), attempts: 3, sleepImpl: async () => { slept += 1; } });
  assert.equal(text, 'first');
  assert.equal(slept, 0);
});
