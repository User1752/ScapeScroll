'use strict';

// What the tests of the live test (source-import-livetest*.test.js) share: a fake source that does everything right and can be
// broken one thing at a time, a runner over it, and readers of a result.

const { withTimeout } = require('../../server/modules/common/async-utils');
const { createLiveTest } = require('../../server/modules/source-import/live-test');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const refused = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const sleep = async () => {};

// A source that is fine, and a way to break one thing at a time.
function fakeSource(overrides = {}) {
  const list = (prefix, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `Title Number ${i}`, cover: '/c.png', genres: ['Action'], ...extra }));
  const base = {
    search: async (query, page, orderBy = '', filters = {}) => {
      if (page >= 99999) return { results: [], hasNextPage: false };
      const key = `${orderBy}|${JSON.stringify(filters)}`;
      const prefix = key === '|{}' ? 'a' : `k${[...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7)}_`;
      return { results: list(page === 2 ? `${prefix}p2_` : prefix, 10), hasNextPage: page < 3 };
    },
    mangaDetails: async (id) => {
      if (String(id).includes('..')) throw refused('invalid id', 400);
      if (String(id).startsWith('definitely-not')) throw refused('not found', 404);
      return { id, title: 'Title Number 0', status: 'ongoing', genres: ['Action'], description: 'text' };
    },
    chapters: async (id) => {
      if (String(id).includes('..')) throw refused('invalid id', 400);
      return { chapters: [5, 4, 3, 2, 1].map((n) => ({ id: `c${n}`, name: `Chapter ${n}`, chapter: String(n), publishAt: `2025-0${n}-10T00:00:00.000Z`, pages: [] })) };
    },
    pages: async (id) => {
      if (String(id).includes('..')) throw refused('invalid id', 400);
      return { pages: [0, 1, 2, 3].map((i) => ({ index: i, img: `https://img.example/${i}.jpg` })) };
    },
    byGenres: async (genres) => {
      if (/loli|shota/i.test(String(genres[0]))) return { results: [], hasNextPage: false };
      return { results: list('g', 5, { genres: [genres[0]] }), hasNextPage: false };
    },
  };
  return { ...base, ...overrides };
}

function runner(mod, { fetchImage = async () => JPEG, limits = {}, id = 'fake' } = {}) {
  const run = createLiveTest({
    loadSourceFromFile: () => mod,
    resolvePageUrl: (page) => (page && page.img ? { url: page.img, referer: '' } : null),
    fetchImage,
    sleep,
    withTimeout,
    limits,
  });
  return (depth = 'basic') => run({ id, depth });
}

const statusOf = (result, id) => (result.checks.find((c) => c.id === id) || {}).status;
const detailOf = (result, id) => (result.checks.find((c) => c.id === id) || {}).detail;

module.exports = { JPEG, refused, sleep, fakeSource, runner, statusOf, detailOf };
