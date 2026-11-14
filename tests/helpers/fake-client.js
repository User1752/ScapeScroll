'use strict';

// The client side of the tests of the fake FlareSolverr itself (fake-flaresolverr*.test.js): start it, post a
// command to it the way the pool would, and the made-up pages those tests ask for. Loopback only.

const { startFakeFlareSolverr } = require('./fake-flaresolverr');

const A = 'https://cf-site.example/a';
const B = 'https://cf-site.example/b';
const OTHER = 'https://other-site.example/x';
const PROXY = { url: 'http://127.0.0.1:4444' };

// A fake that is closed when the test ends (every test closes it, or node --test hangs).
async function start(t, options) {
  const fake = await startFakeFlareSolverr(options);
  t.after(() => fake.stop());
  return fake;
}

async function call(fake, payload, init = {}) {
  const res = await fetch(fake.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...init });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, body, text };
}

const create = (fake, session, proxy) => call(fake, { cmd: 'sessions.create', session, ...(proxy ? { proxy } : {}) });
const get = (fake, url, extra = {}) => call(fake, { cmd: 'request.get', url, maxTimeout: 35000, ...extra });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

module.exports = { A, B, OTHER, PROXY, start, call, create, get, sleep };
