import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainUnservedHost, hostServesCommit } from '../release/lib.mjs';

// The other web hosts of the product are checked WITHOUT following redirects, so a host that sends visitors to the
// production site is reported as redirecting, never as serving the production site's commit.
const COMMIT = 'a'.repeat(40);
const OPTIONS = { productionHost: 'tinycloud.one' };
const redirect = (status, location) => async () => new Response(null, { status, headers: location === undefined ? {} : { location } });

test('a host that redirects to the production host is accepted and says it redirected', async () => {
  for (const status of [301, 302, 307, 308]) {
    const result = await hostServesCommit('tinycloud.chat', COMMIT, redirect(status, `https://tinycloud.one/version.json?deploy=${COMMIT}`), OPTIONS);
    assert.deepEqual(result, { ok: true, served: `a ${status} redirect to tinycloud.one`, redirectedTo: 'tinycloud.one' });
  }
  const relative = await hostServesCommit('tinycloud.one', COMMIT, redirect(302, '/version.json'), { productionHost: 'tinycloud.one' });
  assert.equal(relative.redirectedTo, 'tinycloud.one');
});

test('a redirect elsewhere, to a lookalike, to plain http or without a Location is not accepted', async () => {
  for (const location of ['https://example.com/', 'https://tinycloud.one.evil.example/', 'https://www.tinycloud.one/', 'https://tinycloud.one:8443/', 'http://tinycloud.one/']) {
    const result = await hostServesCommit('tinycloud.chat', COMMIT, redirect(302, location), OPTIONS);
    assert.equal(result.ok, false, location);
    assert.equal(result.redirectedTo, undefined);
    assert.match(result.served, /^a 302 redirect to .*, not tinycloud\.one$/);
  }
  const none = await hostServesCommit('tinycloud.chat', COMMIT, redirect(302), OPTIONS);
  assert.equal(none.ok, false);
  assert.match(none.served, /no valid Location/);
  assert.match(explainUnservedHost('tinycloud.chat', none.served, COMMIT), /^tinycloud\.chat answered a 302 redirect to no valid Location.*somewhere other than the production site/);
});

test('with a production host the redirect is not followed; a host serving the commit still passes without redirectedTo', async () => {
  let init;
  const serving = async (_url, requestInit) => {
    init = requestInit;
    return new Response(JSON.stringify({ commit: COMMIT }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  assert.deepEqual(await hostServesCommit('home.tinycloud.xyz', COMMIT, serving, OPTIONS), { ok: true, served: COMMIT });
  assert.equal(init.redirect, 'manual');
  const stale = await hostServesCommit('home.tinycloud.xyz', COMMIT, async () => new Response(JSON.stringify({ commit: 'b'.repeat(40) }), { status: 200, headers: { 'content-type': 'application/json' } }), OPTIONS);
  assert.deepEqual(stale, { ok: false, served: 'b'.repeat(40) });
});

test('without a production host redirects are still followed, as for the production URL itself', async () => {
  let init;
  await hostServesCommit('tinycloud.one', COMMIT, async (_url, requestInit) => { init = requestInit; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); });
  assert.equal(init.redirect, undefined);
});
