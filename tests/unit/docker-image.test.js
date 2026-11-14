'use strict';

// What the Docker image has to carry, found the hard way on a CasaOS box (System Health in the container): see docker/Dockerfile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'docker', 'Dockerfile'), 'utf8');
const instructions = dockerfile.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));

test('the image has curl, which node:alpine does not ship and MangaHub asks its site through', () => {
  assert.ok(instructions.some((line) => /^RUN\s+apk add\b.*\bcurl\b/.test(line)), 'RUN apk add --no-cache curl');
});

test('the image asks Node for IPv4 addresses first: a home-network container has no IPv6 route and ETIMEDOUT followed', () => {
  assert.ok(instructions.includes('ENV NODE_OPTIONS=--dns-result-order=ipv4first'));
});

test('the image still listens on every interface and starts the server, as the compose files assume', () => {
  assert.ok(instructions.includes('ENV HOST=0.0.0.0'));
  assert.ok(instructions.includes('CMD ["node", "server.js"]'));
});

// ── The optional FlareSolverr container (docker/docker-compose.yml) ─────────────────────────────────────────────────────────────────────

const { FLARESOLVERR_VERIFIED_VERSION } = require('../../server/config/solver');

const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker', 'docker-compose.yml'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const serviceBlock = (name) => {
  const start = compose.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return [];
  const rest = compose.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) && !line.startsWith('  #'));
  return rest.slice(0, end < 0 ? rest.length : end).filter((line) => !line.trim().startsWith('#'));
};

test('the compose file offers FlareSolverr as an opt-in container, pinned to the version the app was checked against, with no published port', () => {
  const block = serviceBlock('flaresolverr');
  assert.ok(block.length > 3, 'a flaresolverr service exists');
  assert.ok(block.some((l) => l.trim() === `image: ghcr.io/flaresolverr/flaresolverr:v${FLARESOLVERR_VERIFIED_VERSION}`), 'pinned, never "latest"');
  assert.ok(block.some((l) => /profiles:\s*\["flaresolverr"\]/.test(l)), 'not started by a plain `docker compose up`');
  assert.ok(!block.some((l) => /^\s*ports:/.test(l)), 'FlareSolverr has no password: nothing is published');
});

test('the app container takes the address of FlareSolverr from the environment, empty unless the person starts it', () => {
  const block = serviceBlock('scrollscape');
  assert.ok(block.some((l) => l.trim() === '- FLARESOLVERR_URL=${FLARESOLVERR_URL:-}'));
});
