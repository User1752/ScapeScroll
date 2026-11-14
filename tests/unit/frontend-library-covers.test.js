'use strict';

// The page side of the local covers (public/modules/utils.js): once the server has answered with its map, every cover that is one of the
// library's is drawn from the server's copy, whatever form it was saved in; before that, or when the server cannot answer, nothing changes.
// The real utils.js runs in a vm sandbox with a fake fetch; the key function is also compared with the server's, which must agree with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { coverUrlKey: serverKey } = require('../../server/modules/covers/service');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');

function sandbox(answer) {
  const calls = [];
  const listeners = [];
  const context = {
    console, JSON, Number, String, Object, Array, Math, Date, Map, URL, URLSearchParams,
    window: { addEventListener() {} },
    document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    fetch: async (url) => { calls.push(url); return answer(url); },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(MODULES, 'utils.js'), 'utf8'), context, { filename: 'utils.js' });
  return { ctx: context, calls, listeners };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const REMOTE = 'https://uploads.mangadex.org/covers/a/b.jpg';
// a host the browser cannot load from directly: when the server has no copy, the page asks this app's image proxy for it
const PROXIED = `/api/proxy-image?url=${encodeURIComponent(REMOTE)}`;
const LOCAL = `/api/library-cover/${'a'.repeat(24)}.jpg`;

test('before the server has answered, and when it cannot, a cover is asked of its own host as always', async () => {
  const { ctx } = sandbox(() => { throw new Error('offline'); });
  assert.equal(ctx.normalizeImageUrl(REMOTE), PROXIED);
  assert.equal(await ctx.loadLibraryCovers({ force: true }), false, 'the failure is not an error and not a change');
  assert.equal(ctx.normalizeImageUrl(REMOTE), PROXIED);
  const refused = sandbox(() => json({}, 401));
  assert.equal(await refused.ctx.loadLibraryCovers({ force: true }), false);
  assert.equal(refused.ctx.normalizeImageUrl(REMOTE), PROXIED);
});

test('after it has answered, the covers of the library come from the server, in whatever form they were saved', async () => {
  const { ctx } = sandbox(() => json({ ok: true, covers: { [REMOTE]: LOCAL, 'https://x.example/y.webp': '/not/a/cover/path', 'https://z.example/z.png': `/api/library-cover/${'b'.repeat(24)}.png` } }));
  assert.equal(await ctx.loadLibraryCovers({ force: true }), true);
  assert.equal(ctx.normalizeImageUrl(REMOTE), LOCAL);
  assert.equal(ctx.normalizeImageUrl(REMOTE.replace('https:', 'http:')), LOCAL, 'a cover saved with http');
  assert.equal(ctx.normalizeImageUrl(`/api/proxy-image?url=${encodeURIComponent(REMOTE)}&ref=x`), LOCAL, 'a cover saved as this app\'s proxy address');
  assert.equal(ctx.normalizeImageUrl(`  ${REMOTE}  `), LOCAL);
  assert.equal(ctx.normalizeImageUrl('https://x.example/y.webp'), 'https://x.example/y.webp', 'an entry that is not a path of the covers route is ignored');
  assert.equal(ctx.normalizeImageUrl('https://other.example/o.jpg'), 'https://other.example/o.jpg', 'a cover that is not the library\'s is untouched');
  assert.equal(ctx.normalizeImageUrl(''), '');
});

test('the rules that were already there still apply to what is not kept', async () => {
  const { ctx } = sandbox(() => json({ covers: { [REMOTE]: LOCAL } }));
  await ctx.loadLibraryCovers({ force: true });
  assert.equal(ctx.normalizeImageUrl('https://wp.youtube-anime.com/aln.youtube-anime.com/x/001.webp'), `/api/proxy-image?url=${encodeURIComponent('https://wp.youtube-anime.com/aln.youtube-anime.com/x/001.webp')}&ref=${encodeURIComponent('https://allmanga.to')}`);
  assert.equal(ctx.normalizeImageUrl('http://plain.example/p.jpg'), 'https://plain.example/p.jpg');
  assert.equal(ctx.normalizeImageUrl('/api/proxy-image?url=x'), '/api/proxy-image?url=x');
});

test('the map is asked for at most every 30 seconds unless forced, and "changed" is only true when the map changed', async () => {
  const body = { covers: { [REMOTE]: LOCAL } };
  const { ctx, calls } = sandbox(() => json(body));
  assert.equal(await ctx.loadLibraryCovers(), true);
  assert.equal(await ctx.loadLibraryCovers(), false, 'asked again at once: not even a request');
  assert.equal(calls.length, 1);
  assert.equal(await ctx.loadLibraryCovers({ force: true }), false, 'asked, and nothing changed');
  assert.equal(calls.length, 2);
  body.covers = {};
  assert.equal(await ctx.loadLibraryCovers({ force: true }), true, 'a cover that left the library');
  assert.equal(ctx.normalizeImageUrl(REMOTE), PROXIED);
});

test('while the server is still fetching, the page asks again every few seconds and draws the library again only when more arrived', async () => {
  const timers = [];
  const body = { covers: {}, busy: true };
  const { ctx, calls } = sandbox(() => json(body));
  ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const drawn = [];
  ctx.renderLibrary = () => drawn.push('drawn');

  assert.equal(await ctx.loadLibraryCovers({ force: true }), false);
  assert.equal(timers.length, 1, 'busy: one look is scheduled');
  assert.equal(timers[0].ms, 12000);
  await ctx.loadLibraryCovers({ force: true });
  assert.equal(timers.length, 1, 'never two waiting');

  body.covers = { [REMOTE]: LOCAL }; // a cover arrived meanwhile
  await timers[0].fn();
  assert.equal(calls.length, 3);
  assert.deepEqual(drawn, ['drawn']);
  assert.equal(ctx.normalizeImageUrl(REMOTE), LOCAL);
  assert.equal(timers.length, 2, 'still busy: it keeps asking');

  body.busy = false; // the server is done
  await timers[1].fn();
  assert.deepEqual(drawn, ['drawn'], 'nothing more arrived, so nothing is drawn again');
  assert.equal(timers.length, 2, 'and it stops asking');
});

test('a cover a browser cannot load from its host goes through the image proxy, with no copy needed (the Recommended list, search...)', () => {
  const { ctx } = sandbox(() => json({}));
  const proxied = (u) => `/api/proxy-image?url=${encodeURIComponent(u)}`;
  for (const u of ['https://uploads.mangadex.org/covers/x/y.jpg.256.jpg', 'https://cdn.readdetectiveconan.com/file/mangapill/i/2965.jpg', 'https://img-r1.2xstorage.com/thumb/a.webp', 'https://img-r2.2xstorage.com/thumb/b.webp']) {
    assert.equal(ctx.normalizeImageUrl(u), proxied(u), u);
  }
  assert.equal(ctx.normalizeImageUrl('http://uploads.mangadex.org/covers/x/y.jpg'), proxied('https://uploads.mangadex.org/covers/x/y.jpg'), 'always asked for over https');
  // what a browser can load itself is left alone, and a look-alike host is not caught
  for (const u of ['https://s4.anilist.co/file/a.jpg', 'https://uploads.mangadex.org.evil.example/x.jpg', 'https://evil-uploads.mangadex.org/x.jpg', 'https://readermc.org/images/thumbnails/x.webp', 'https://mancover.xyz/cover/x.webp']) {
    assert.equal(ctx.normalizeImageUrl(u), u, u);
  }
});

test('a safety net for pages that draw a cover themselves: a failed image of a blocked host is asked once more through the proxy', async () => {
  const { ctx, listeners } = sandbox(() => json({ covers: { [REMOTE]: LOCAL } }));
  const net = listeners.find((l) => l.type === 'error');
  assert.ok(net && net.capture === true, 'an error listener in the capture phase (image errors do not bubble)');
  const fail = (src, extra = {}) => {
    const img = { tagName: 'IMG', src, currentSrc: '', dataset: {}, ...extra };
    let stopped = false;
    net.fn({ target: img, stopImmediatePropagation: () => { stopped = true; } });
    return { img, stopped };
  };

  const blocked = fail('https://uploads.mangadex.org/covers/x/y.jpg.256.jpg');
  assert.equal(blocked.img.src, `/api/proxy-image?url=${encodeURIComponent('https://uploads.mangadex.org/covers/x/y.jpg.256.jpg')}`);
  assert.equal(blocked.img.dataset.viaProxy, '1');
  assert.equal(blocked.stopped, true, "the image's own onerror (which hides it) does not run before the retry");

  const again = fail(blocked.img.src, { dataset: { viaProxy: '1' } });
  assert.equal(again.stopped, false, "a second failure is a real one: it reaches the image's own handler");
  assert.equal(fail('https://s4.anilist.co/x.jpg').stopped, false, 'a host a browser can load from is not touched');
  assert.equal(fail('/api/proxy-image?url=x').stopped, false);
  assert.equal(fail('https://uploads.mangadex.org/x.jpg', { tagName: 'SCRIPT' }).stopped, false, 'only images');
  assert.equal(fail('https://cdn.readdetectiveconan.com/a.jpg').img.src.startsWith('/api/proxy-image'), true);

  await ctx.loadLibraryCovers({ force: true }); // with the library's own copy known, the retry uses that
  assert.equal(fail(REMOTE).img.src, LOCAL);
});

test('the pages that draw a manga cover themselves use normalizeImageUrl: the cover picker, the cover scan, the migration, search, updates', () => {
  const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
  const sites = [
    ['ui-cover-picker.js', '<img src="${escapeHtml(normalizeImageUrl(choice.cover))}"'],
    ['ui-cover-scan.js', 'src="${escapeHtml(normalizeImageUrl(candidateCover))}"'],
    ['ui-migrate.js', '<img src="${escapeHtml(normalizeImageUrl(m.cover))}"'],
    ['ui-migrate.js', '<img src="${escapeHtml(normalizeImageUrl(entry.manga.cover))}"'],
    ['ui-migrate.js', '<img src="${escapeHtml(normalizeImageUrl(c.cover))}"'],
    ['ui-search.js', '<img src="${escapeHtml(normalizeImageUrl(c.cover))}"'],
    ['ui-updates.js', '<img src="${escapeHtml(normalizeImageUrl(cover))}"'],
  ];
  for (const [file, text] of sites) assert.ok(read(file).includes(text), `${file}: ${text}`);
  assert.ok(!read('ui-cover-picker.js').includes('<img src="${escapeHtml(choice.cover)}"'), 'no image of the picker is asked for by its raw address');
});

test('the list of covers a browser cannot load is the same on the page and on the server', () => {
  const IMAGE_HOSTS = require('../../server/config/image-hosts');
  const src = fs.readFileSync(path.join(MODULES, 'utils.js'), 'utf8');
  const list = src.match(/const _BROWSER_BLOCKED_COVER_HOSTS = \[(.*)\];/)[1];
  const client = vm.runInNewContext(`[${list}]`);
  assert.equal(client.map(String).join('\n'), IMAGE_HOSTS.browserBlockedHosts.map(String).join('\n'));
});

test('the page and the server agree on the address a cover is known by', () => {
  const { ctx } = sandbox(() => json({}));
  const samples = [REMOTE, 'http://img.example/a.jpg', `/api/proxy-image?url=${encodeURIComponent(REMOTE)}&ref=https%3A%2F%2Fa.example`, '/api/proxy-image?url=',
    '/api/local/x/thumb', 'https://readermc.org/images/thumbnails/My Daughter.webp', '', '   ', 'data:image/png;base64,AAAA', 'ftp://x/y.jpg', '//host/x.png', '/\\host/x.png'];
  for (const s of samples) assert.equal(ctx.coverUrlKey(s), serverKey(s), JSON.stringify(s));
});

test('the library draws again once, and only when the server\'s covers changed; the start-up asks for them', () => {
  const lib = fs.readFileSync(path.join(MODULES, 'ui-library.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(lib, /function renderLibrary\(\) \{\n {2}const grid = \$\("library"\);\n {2}if \(!grid\) return;\n[^\n]*\n {2}if \(typeof loadLibraryCovers === 'function'\) loadLibraryCovers\(\)\.then\(\(changed\) => \{ if \(changed\) renderLibrary\(\); \}\);/);
  const init = fs.readFileSync(path.join(MODULES, 'ui-initialization.js'), 'utf8');
  assert.match(init, /loadLibraryCovers\(\{ force: true \}\)/);
});
