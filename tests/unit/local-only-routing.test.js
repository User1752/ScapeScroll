'use strict';

// Differential test for the local-only guard: the guard decides by comparing
// text, Express decides which handler runs, and the two must agree. Unit tests
// of isPrivilegedRoute alone passed while `GET /API/SETTINGS` and
// `GET http://host/api/settings` reached the real handlers, so this sends
// raw, deliberately odd request lines to a real Express app and requires that
// NONE of them reaches a privileged handler from a remote client (no password
// set, Host header that is not this machine). Loopback only, deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const express = require('express');
const { createAuthGate } = require('../../server/middleware/auth-gate');
const { PRIVILEGED_ROUTES } = require('../../server/middleware/local-only');

const BS = String.fromCharCode(92);
const AUTHORITIES = ['http://h', 'http://', 'http:///', 'ws:///', 'HTTP://H', 'http://h:80', 'http://u@h', 'https://h', 'http:/', '//h', '///', 'http://[::1]', 'http://localhost'];
const SUFFIXES = ['', '/', '//', '?x=1', '/?x=1', '#f', ';a=b', '.', '%20', '%00', '/.', '/%2e', BS, '%5c', '?'];
const METHODS = ['GET', 'POST', 'DELETE', 'HEAD', 'OPTIONS', 'PUT', 'PATCH'];
// Backslash, tab, space, no-break space, byte-order mark: characters url.parse() or the
// WHATWG parser treat as (or strip around) a separator.
const ODD_CHARS = [BS, String.fromCharCode(9), ' ', String.fromCharCode(0xa0), String.fromCharCode(0xfeff), '%5c', '%09'];

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function variantsOf(route, rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const mixCase = (text) => [...text].map((c) => (rnd() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
  const percentEncode = (text) => [...text].map((c) => (/[a-z]/i.test(c) && rnd() < 0.25 ? '%' + c.charCodeAt(0).toString(16) : c)).join('');
  const out = new Set([route.path]);
  for (let i = 0; i < 30; i++) {
    let path = route.path;
    const roll = rnd();
    if (roll < 0.25) path = mixCase(path);
    else if (roll < 0.4) path = percentEncode(path);
    else if (roll < 0.55) path = path.replace(/\//g, pick(['//', '/./', BS, '%2f', '/;/', '/../api/']));
    else if (roll < 0.7) path = path.replace(/^\/api/, pick(['/api/.', '/api/x/..', '/./api', '//api', '/%61pi']));
    // One inner slash swapped for a backslash or an odd character while the path
    // still starts with "/": the shape that fell through to Express's legacy
    // url.parse (which turns backslashes into slashes) once a '#' was present.
    else if (roll < 0.9) {
      const slashes = [...path].map((c, i) => (c === '/' && i > 0 ? i : -1)).filter((i) => i > 0);
      const at = slashes[Math.floor(rnd() * slashes.length)];
      path = path.slice(0, at) + pick(ODD_CHARS) + path.slice(at + 1);
    }
    if (rnd() < 0.4) path = pick(AUTHORITIES) + (path.startsWith('/') ? '' : '/') + path;
    out.add(path + pick(SUFFIXES));
  }
  return [...out];
}

function rawRequest(port, method, target, host) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    let received = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', (chunk) => { received += chunk; });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
  });
}

test('no spelling of a privileged route reaches its handler from a remote client', async () => {
  const app = express();
  app.use('/api', createAuthGate({ isGateEnabled: async () => false, isValidSession: () => false }));
  for (const route of PRIVILEGED_ROUTES) {
    app[route.method.toLowerCase()](route.path, (req, res) => res.json({ REACHED: `${route.method} ${route.path}` }));
  }
  app.get('/api/library', (req, res) => res.json({ public: true }));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const port = server.address().port;
    const rnd = makeRandom(20261020);
    const hosts = ['evil.example', 'evil.example:4000', '192.168.1.149:4000'];
    const leaks = [];
    let sent = 0;
    for (const route of PRIVILEGED_ROUTES) {
      for (const target of variantsOf(route, rnd)) {
        for (const method of METHODS) {
          const host = hosts[Math.floor(rnd() * hosts.length)];
          const response = await rawRequest(port, method, target, host);
          sent++;
          if (response.includes('"REACHED"')) leaks.push(`${method} ${JSON.stringify(target)} Host=${host}`);
        }
      }
    }
    assert.ok(sent > 1500, `expected a broad sweep, sent ${sent}`);
    assert.deepEqual(leaks, []);

    // The guard must not have turned into a blanket refusal.
    assert.match(await rawRequest(port, 'GET', '/api/settings', 'localhost:4000'), /"REACHED"/);
    assert.match(await rawRequest(port, 'GET', '/api/library', 'evil.example'), /"public":true/);
    assert.match(await rawRequest(port, 'HEAD', '/api/library', 'evil.example'), /^HTTP\/1\.1 200/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
