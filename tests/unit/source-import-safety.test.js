'use strict';

// Safety of what comes from a live site and of what is imported from it: the risks the Check reports in a source file (a file
// copied from a hostile page looks obfuscated, browser-shaped, or names an ad network), the way a page is READ without being
// written to disk (site-peek.js), and how one chapter page delivers its images (site-chapter.js, with the placeholder rule it
// shares with the live Test). Pages here are written by hand: no copy of a live page is ever stored.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeSourceCode, RISK_IDS, SERIOUS_RISK_IDS } = require('../../server/modules/source-import/static-report');
const { adNetworksIn, firstAdNetworkIndex, AD_NETWORKS } = require('../../server/modules/source-import/ad-networks');
const { isPlaceholderAddress } = require('../../server/modules/source-import/placeholder');
const { analyzeChapterPage, chapterLinksFrom } = require('../../server/modules/source-import/site-chapter');
const { peekPage, clean } = require('../../server/modules/source-import/site-peek');
const signatures = require('../../server/modules/source-import/site-signatures');

const risksOf = (code) => analyzeSourceCode(code).risks.map((r) => r.id);
const GOOD = "'use strict';\nconst cheerio = require('cheerio');\nexports.meta = { id: 'x', name: 'X', version: '1.0.0' };\nconst m = /a(b)/.exec('ab');\nexports.search = async () => ({ results: [] });\n";

// ── What a source file copied from a hostile page looks like ──────────────

test('a plain source has no risks, and a regular expression\'s .exec( is not a child process', () => {
  assert.deepEqual(risksOf(GOOD), []);
  assert.deepEqual(risksOf("const { exec } = require('child_process');"), ['child-process']);
  assert.deepEqual(risksOf("exec('calc');"), ['child-process']);
  assert.deepEqual(risksOf('const r = /x/.exec(text); const q = obj.spawn(1);'), []);
});

test('obfuscation is reported: runs of escaped characters, _0x names, long fromCharCode, atob and unescape', () => {
  assert.ok(risksOf(`var a = "${'\\x41'.repeat(14)}";`).includes('obfuscated'));
  assert.ok(risksOf(`var a = "${'\\u0041'.repeat(14)}";`).includes('obfuscated'));
  assert.ok(risksOf('var _0x4f2a = [1]; function _0x1b3c(){}').includes('obfuscated'));
  assert.ok(risksOf('String.fromCharCode(104,116,116,112,115,58,47,47,120)').includes('obfuscated'));
  assert.ok(risksOf('var s = atob("aGVsbG8=");').includes('obfuscated'));
  assert.ok(risksOf('unescape("%41")').includes('obfuscated'));
  assert.equal(risksOf('String.fromCharCode(65)').includes('obfuscated'), false, 'one character is not obfuscation');
  assert.equal(risksOf('var label = "\\x41\\x42";').includes('obfuscated'), false, 'a couple of escapes is not obfuscation');
});

test('a very long encoded string, browser code and a named ad network are reported', () => {
  assert.ok(risksOf(`var blob = "${'A1b2'.repeat(120)}";`).includes('encoded-blob'));
  assert.equal(risksOf(`var spaced = "${'word '.repeat(200)}";`).includes('encoded-blob'), false, 'prose is not an encoded blob');
  for (const code of ['document.write("x")', 'document.cookie = "a=b"', 'window.open("http://x")', 'var s = "<script src=a.js></script>";']) assert.ok(risksOf(code).includes('browser-code'), code);
  assert.ok(risksOf('fetch("https://a.exoclick.com/x.js")').includes('ad-network'));
  assert.ok(risksOf("const BASE = 'https://platform.pubadx.one/v2/tag.js';").includes('ad-network'));
});

test('a comment that talks about these is not the code doing them', () => {
  const code = `// the site loads popads.net and document.write and ${'\\x41'.repeat(14)}\n/* atob( _0x1234ab */\nexports.meta = { id: 'x' };\n`;
  assert.deepEqual(risksOf(code), []);
});

test('the report says on which line a new risk is, and every serious id is a risk the Check can report and the card has a sentence for', () => {
  const found = analyzeSourceCode('exports.meta = {};\n\ndocument.write(1);\n').risks.find((r) => r.id === 'browser-code');
  assert.equal(found.line, 3);
  const ad = analyzeSourceCode('a\nb\nconst u = "https://popads.net/x";\n').risks.find((r) => r.id === 'ad-network');
  assert.equal(ad.line, 3);
  for (const id of SERIOUS_RISK_IDS) assert.ok(RISK_IDS.includes(id), id);
  assert.ok(!SERIOUS_RISK_IDS.includes('filesystem') && !SERIOUS_RISK_IDS.includes('process-control'), 'what a legitimate source may do stays a note, not a refusal');
});

test('the ad network list is one: the Check and the probe read pages and files with the same names', () => {
  assert.deepEqual(adNetworksIn('<script src="https://a.exoclick.com/x.js">'), ['ExoClick']);
  assert.deepEqual(adNetworksIn('nothing here'), []);
  assert.equal(firstAdNetworkIndex('abc popads.net'), 4);
  assert.equal(firstAdNetworkIndex('abc'), -1);
  assert.ok(AD_NETWORKS.length > 20);
  assert.deepEqual(signatures.readSignals({ status: 200, headers: {}, body: '<html><script src="https://x.exosrv.com/a.js"></script></html>', url: 'https://s.example/' }).adNetworks, ['ExoClick']);
});

// ── Reading a live page without writing it ────────────────────────────────

const PAGE = `<html><head><title>  A Site \u0007\u202e title </title></head><body>
  <a href="/m/one">One</a><a href="/m/two">Two</a><script src="/a.js"></script><script>var secret = "token-123";</script>
  <div class="item"><h3><a href="/m/one" data-x="1">Title\u001b[31m One</a></h3></div><div class="item"><h3><a href="/m/two">Title Two</a></h3></div></body></html>`;
const fakeFetch = (body = PAGE, status = 200) => async () => new Response(body, { status, headers: { 'content-type': 'text/html' } });

test('peek answers a question about a page with small plain text, and never prints control or bidi characters', async () => {
  const deps = { fetchImpl: fakeFetch(), userAgent: 'test' };
  const summary = await peekPage('https://site.example/', {}, deps);
  assert.equal(summary.status, 200);
  assert.match(summary.lines.join('\n'), /title: A Site title/);
  assert.match(summary.lines.join('\n'), /scripts: 1 external, 1 inline/);
  const selected = await peekPage('https://site.example/', { select: '.item h3 a' }, deps);
  assert.deepEqual(selected.lines, ['1. Title[31m One', '2. Title Two'], 'the escape character is dropped, the rest is plain text');
  const attr = await peekPage('https://site.example/', { select: '.item h3 a', attr: 'href' }, deps);
  assert.deepEqual(attr.lines, ['1. /m/one', '2. /m/two']);
  const grep = await peekPage('https://site.example/', { grep: 'token-\\d+' }, deps);
  assert.match(grep.lines[0], /token-123/);
  // eslint-disable-next-line no-control-regex
  for (const line of [...summary.lines, ...selected.lines, ...grep.lines]) assert.doesNotMatch(line, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
});

test('peek says "no match" / "no element" for what is not there, and a bad pattern or selector is an answer, not a crash', async () => {
  const deps = { fetchImpl: fakeFetch() };
  assert.deepEqual((await peekPage('https://site.example/', { grep: 'zzz-not-there' }, deps)).lines, ['no match']);
  assert.deepEqual((await peekPage('https://site.example/', { select: '.nothing' }, deps)).lines, ['no element']);
  assert.deepEqual((await peekPage('https://site.example/', { grep: '(' }, deps)).lines, ['that is not a valid pattern']);
  assert.deepEqual((await peekPage('https://site.example/', { select: '[[[' }, deps)).lines, ['that is not a valid selector']);
});

test('peek caps what it prints: matches, items and total characters', async () => {
  const many = `<html><body>${Array.from({ length: 300 }, (_, i) => `<p class="r">row ${i} ${'x'.repeat(50)}</p>`).join('')}</body></html>`;
  const deps = { fetchImpl: fakeFetch(many) };
  const items = await peekPage('https://site.example/', { select: '.r', limit: 1000 }, deps);
  assert.ok(items.lines.length <= 42, 'at most 40 items and a note');
  assert.ok(items.lines.join('\n').length <= 6100);
  const matches = await peekPage('https://site.example/', { grep: 'row' }, deps);
  assert.ok(matches.lines.length <= 21 && /more matches/.test(matches.lines[matches.lines.length - 1]));
  assert.equal(clean('a'.repeat(1000)).length, 240);
});

test('peek refuses what is not a plain public web address, and POST is only the method, never a body', async () => {
  await assert.rejects(peekPage('ftp://site.example/'), /plain http/);
  await assert.rejects(peekPage('https://user:pw@site.example/'), /plain http/);
  await assert.rejects(peekPage('http://127.0.0.1:4000/'), /Blocked unsafe URL/);
  await assert.rejects(peekPage('http://169.254.169.254/latest'), /Blocked unsafe URL/);
  let seen;
  await peekPage('https://site.example/x', { method: 'post' }, { fetchImpl: async (url, init) => { seen = init; return new Response('{}', { status: 200 }); } });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, undefined);
  await peekPage('https://site.example/x', { method: 'DELETE' }, { fetchImpl: async (url, init) => { seen = init; return new Response('{}'); } });
  assert.equal(seen.method, 'GET', 'any other method is a GET');
});

test('the code that reads live pages never writes a file', () => {
  const dir = path.join(__dirname, '..', '..', 'server', 'modules', 'source-import');
  for (const file of ['site-peek.js', 'site-probe.js', 'site-signatures.js', 'site-verdict.js', 'site-chapter.js', 'generator/discover.js']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(text, /writeFile|createWriteStream|appendFile|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]/, `${file} must not touch the filesystem`);
  }
});

test('the generator only READS its template: it writes nothing (the command line writes the generated file, which is code it made, not a page)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'modules', 'source-import', 'generator', 'index.js'), 'utf8');
  assert.doesNotMatch(text, /writeFile|createWriteStream|appendFile/);
});

// ── The placeholder rule and the chapter page ─────────────────────────────

test('a loading picture is a placeholder; a title that only contains the letters is not', () => {
  for (const yes of ['/themes/x/images/Loading/Loading.gif', 'https://cdn.example/img/placeholder.png', '/a/lazy-1.gif', 'data:image/gif;base64,R0lGOD', '/spinner.svg?x=1']) assert.equal(isPlaceholderAddress(yes), true, yes);
  for (const no of ['https://cdn.example/2026/10/12-reloading-title.webp', '/a/b/01.jpg', '', null, 'https://cdn.example/blankets.jpg']) assert.equal(isPlaceholderAddress(no), false, String(no));
  assert.equal(isPlaceholderAddress('https://cdn.example/page.jpg?loading=1'), false, 'the query string is not looked at');
});

const chapter = (images, extra = '') => `<html><body class="reader"><div class="reading-content">${images}</div>${extra}</body></html>`;
const img = (attrs) => `<div class="page-chapter"><img ${attrs}></div>`;

test('images in the HTML: plain src, and a lazy attribute that holds the real address behind a placeholder src', () => {
  const plain = analyzeChapterPage(chapter([1, 2, 3].map((i) => img(`src="/p/${i}.webp"`)).join('')), 'https://s.example/m/c1');
  assert.equal(plain.kind, 'inline');
  assert.equal(plain.real, 3);
  assert.equal(plain.placeholders, 0);
  assert.equal(plain.sample, 'https://s.example/p/1.webp');
  const lazy = analyzeChapterPage(chapter([1, 2, 3].map((i) => img(`src="/img/Loading.gif" data-src="https://cdn.example/${i}.webp"`)).join('')), 'https://s.example/m/c1');
  assert.equal(lazy.kind, 'inline');
  assert.equal(lazy.lazyAttr, 'data-src');
  assert.equal(lazy.distinct, 3);
});

test('only placeholders in the HTML and a request in a script: ajax, with the endpoint and the chapter id the page keeps', () => {
  const html = chapter(
    [0, 1, 2].map(() => img('src="/themes/x/images/Loading/Loading.gif"')).join(''),
    '<script>const CHAPTER_ID = 61636;\n$.post("/ajax/image/list/chap/" + CHAPTER_ID, function (e) { $("#c").html(e.html); });</script>',
  );
  const found = analyzeChapterPage(html, 'https://s.example/m/c1');
  assert.equal(found.kind, 'ajax');
  assert.equal(found.real, 0);
  assert.equal(found.placeholders, 3);
  assert.equal(found.chapterId, '61636');
  assert.ok(found.endpoints.includes('/ajax/image/list/chap/'), JSON.stringify(found.endpoints));
  assert.ok(!found.endpoints.some((e) => /\.(css|js)$/.test(e)), 'a script or style file is not an endpoint');
});

test('images listed in a script are found as such, and a page with nothing is "none"', () => {
  const urls = [1, 2, 3, 4].map((i) => `"https:\\/\\/cdn.example\\/ch\\/${i}.jpg"`).join(',');
  const script = analyzeChapterPage(`<html><body><div id="readerarea"></div><script>ts_reader.run({"sources":[{"images":[${urls}]}]});</script></body></html>`, 'https://s.example/c');
  assert.equal(script.kind, 'script');
  assert.equal(script.scriptImages, 4);
  assert.equal(script.sample, 'https://cdn.example/ch/1.jpg');
  assert.equal(analyzeChapterPage('<html><body><p>Nothing here</p></body></html>', 'https://s.example/').kind, 'none');
  assert.equal(analyzeChapterPage('', 'https://s.example/').kind, 'none');
  assert.equal(analyzeChapterPage(null, 'https://s.example/').kind, 'none');
});

test('the chapter links of a title page are the first and the last chapter link of its own site', () => {
  const html = `<html><body><a href="/m/t/chapter-9">9</a><a href="/m/t/chapter-8">8</a><a href="https://other.example/chapter-1">x</a><a href="/m/t/chapter-1">1</a><a href="/tag/action">t</a></body></html>`;
  assert.deepEqual(chapterLinksFrom(html, 'https://s.example/m/t'), ['https://s.example/m/t/chapter-9', 'https://s.example/m/t/chapter-1']);
  assert.deepEqual(chapterLinksFrom('<a href="/m/t/chapter-1">1</a>', 'https://s.example/m/t'), ['https://s.example/m/t/chapter-1']);
  assert.deepEqual(chapterLinksFrom('<a href="/about">about</a>', 'https://s.example/'), []);
});

// ── Sites the security software flagged ───────────────────────────────────

const { blockedReason, parseDenylist, BUILT_IN } = require('../../server/modules/source-import/site-denylist');
const { probeSite } = require('../../server/modules/source-import/site-probe');

test('a flagged site, its www and its subdomains are on the list; a look-alike name and any other site are not', () => {
  for (const [domain] of BUILT_IN) {
    assert.match(blockedReason(`https://${domain}/`), new RegExp(domain.replace('.', '\\.')));
    assert.ok(blockedReason(`https://www.${domain}/x?y=1`));
    assert.ok(blockedReason(`http://cdn.${domain}/a.jpg`));
    assert.equal(blockedReason(`https://not-${domain}/`), '', 'a different name that ends the same way');
    assert.equal(blockedReason(`https://${domain}.example.org/`), '');
  }
  assert.equal(blockedReason('https://manhuaplus.top/'), '');
  assert.equal(blockedReason('not a url'), '');
  assert.match(blockedReason('https://my-bad.example/', ['my-bad.example']), /own list/);
});

test('the list in data/site-denylist.txt: one domain a line, comments and anything that is not a domain ignored', () => {
  assert.deepEqual(parseDenylist('# flagged 2026\nBad.Example # why\n\nnot a domain\nhttp://x.example/\nother.example\n'), ['bad.example', 'other.example']);
  assert.deepEqual(parseDenylist(''), []);
  assert.deepEqual(parseDenylist(null), []);
});

test('the probe asks a listed site for nothing: not the page, and not a redirect to it either', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (new URL(url).hostname === 'old.example') return new Response('', { status: 301, headers: { location: 'https://sushiscan.fr/' } });
    return new Response('ok', { status: 200 });
  };
  const direct = await probeSite('https://snowscans.com/', { fetchImpl, userAgent: 'ua', sleep: async () => {} });
  assert.equal(direct.verdict, 'unreachable');
  assert.match(direct.reasons[0].text, /list of dangerous sites/);
  assert.deepEqual(asked, [], 'no request was made');
  const redirected = await probeSite('https://old.example/', { fetchImpl, userAgent: 'ua', sleep: async () => {} });
  assert.equal(redirected.verdict, 'unreachable');
  assert.deepEqual(asked, ['https://old.example/'], 'only the first hop was asked for; the listed one never');
  const extra = await probeSite('https://mine.example/', { fetchImpl, userAgent: 'ua', sleep: async () => {}, denylist: ['mine.example'] });
  assert.equal(extra.verdict, 'unreachable');
});

test('peek refuses a listed site before any request', async () => {
  let asked = 0;
  await assert.rejects(peekPage('https://sushiscan.fr/', {}, { fetchImpl: async () => { asked += 1; return new Response('x'); } }), /dangerous sites/);
  await assert.rejects(peekPage('https://x.example/', {}, { denylist: ['x.example'], fetchImpl: async () => { asked += 1; return new Response('x'); } }), /dangerous sites/);
  assert.equal(asked, 0);
});

test('a connection that is reset says why that can matter: a security product may have cut it', async () => {
  const reset = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  const result = await probeSite('https://flaky.example/', { fetchImpl: reset, userAgent: 'ua', sleep: async () => {} });
  assert.match(result.reasons[0].text, /security software warned/);
});

// ── Readers that have none of the known containers, htmx, and which links are chapters (calibrated on the sources already in use) ──

test('a reader with no known container: its pages are the biggest group of pictures in one folder, not the logo or the cover', () => {
  const pictures = [1, 2, 3, 4].map((i) => `<img src="https://cdn.example/chapters/slug/1/h${i}.webp">`).join('');
  const html = `<html><body><img src="/images/logo.webp"><img src="https://cdn.example/covers/slug.webp">${pictures}</body></html>`;
  const found = analyzeChapterPage(html, 'https://s.example/comics/slug/chapter/1');
  assert.equal(found.kind, 'inline');
  assert.equal(found.real, 4);
  assert.match(found.selector, /largest group/);
  assert.equal(analyzeChapterPage('<html><body><img src="/a.webp"><img src="/b/c.webp"></body></html>', 'https://s.example/x').kind, 'none', 'two pictures in different folders are not a chapter');
});

test('a page with no picture that asks for a fragment of images with htmx is "ajax"', () => {
  const html = '<html><body><div hx-get="/chapters/ABC123/images?style=strip" hx-trigger="load"></div></body></html>';
  const found = analyzeChapterPage(html, 'https://s.example/chapters/ABC123');
  assert.equal(found.kind, 'ajax');
  assert.deepEqual(found.endpoints, ['/chapters/ABC123/images?style=strip']);
});

test('chapter links: a chapter, in the forms sites really use; never the list of chapters or a page about one', () => {
  const links = (hrefs) => chapterLinksFrom(hrefs.map((h) => `<a href="${h}">x</a>`).join(''), 'https://s.example/manga/t');
  assert.deepEqual(links(['/chapters', '/chapters/700921/report', '/chapters/700921-10001000/title-chapter-1']), ['https://s.example/chapters/700921-10001000/title-chapter-1']);
  assert.deepEqual(links(['/chaptered.php?manga=308&chapter=1', '/chaptered.php?manga=308&chapter=185']), ['https://s.example/chaptered.php?manga=308&chapter=1', 'https://s.example/chaptered.php?manga=308&chapter=185']);
  assert.deepEqual(links(['/manga/t/c000/1.html', '/manga/t/c258/1.html']), ['https://s.example/manga/t/c000/1.html', 'https://s.example/manga/t/c258/1.html']);
  assert.deepEqual(links(['/chapters/01M5V7R4TXQE639XVJKZ04BD7X', '/chapters/01JW12YTPQ5STYVKZ026JS51NK']).length, 2);
  assert.deepEqual(links(['/manga/t/comments', '/chapters/', '/about', '/manga/t/chapter-3/comments']), []);
});

// ── The two WordPress theme families, as their markup is documented (hand-written, nothing copied from a live page) ──

const { detectEngine } = require('../../server/modules/source-import/site-engines');
const { chapterListRequest } = require('../../server/modules/source-import/site-chapter');

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('Madara: a chapter whose src is a tiny inline picture and whose real address is in data-src is read as inline, lazy', () => {
  const pages = [1, 2, 3, 4, 5].map((i) => `<div class="page-break no-gaps"><img id="image-${i}" class="wp-manga-chapter-img" src="${GIF}" data-src="https://cdn.example/WP-manga/data/manga_x/abc/0${i}.jpg"></div>`).join('');
  const html = `<html><head><link rel="stylesheet" href="/wp-content/themes/madara/style.css"></head><body class="wp-manga"><div class="reading-content">${pages}</div></body></html>`;
  const found = analyzeChapterPage(html, 'https://s.example/manga/x/chapter-1/');
  assert.equal(found.kind, 'inline');
  assert.equal(found.real, 5);
  assert.equal(found.lazyAttr, 'data-src');
  assert.equal(found.placeholders, 0);
  assert.equal(detectEngine(html).id, 'madara');
});

test('Madara: a title page with no chapter links but the chapter-list call is told how to ask for it', () => {
  const html = '<html><body class="wp-manga"><div class="wp-manga-chapter"></div><script>jQuery.post(ajaxurl, {action: "manga_get_chapters", manga: 4411});</script></body></html>';
  const request = chapterListRequest(html);
  assert.equal(request.kind, 'madara');
  assert.match(request.hint, /manga_get_chapters/);
  assert.equal(chapterListRequest('<script>jQuery.post(url + "/ajax/chapters/")</script>').endpoint, '/ajax/chapters/');
  assert.equal(chapterListRequest('<html><body>no list call</body></html>'), null);
  assert.equal(chapterListRequest(null), null);
});

test('Mangastream: the chapter\'s pages in a ts_reader JSON (escaped slashes, several servers) are read as a script, from the first server', () => {
  const server = (n) => `{"source":"Server ${n}","images":[${[1, 2, 3, 4].map((i) => `"https:\\/\\/cdn${n}.example\\/ch\\/${i}.webp"`).join(',')}]}`;
  const html = `<html><body><div id="readerarea"><noscript><img src="https://cdn1.example/ch/1.webp"></noscript></div><script>ts_reader.run({"post_id":9,"sources":[${server(1)},${server(2)}],"defaultSource":"Server 1"});</script></body></html>`;
  const found = analyzeChapterPage(html, 'https://s.example/title-chapter-1/');
  assert.equal(found.kind, 'script');
  assert.equal(found.scriptImages, 8);
  assert.equal(found.sample, 'https://cdn1.example/ch/1.webp');
  assert.equal(detectEngine(html).id, 'mangathemesia');
});

test('a Cloudflare "JavaScript detections" snippet on a bundled single-page shell is a shell, not a challenge (a real challenge page is told by its own path)', () => {
  const shell = '<html><head><title>A Site - Read Manga Online</title><script type="module" src="/build/assets/main-abc.js"></script></head><body><div id="app"></div><script>var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";</script></body></html>';
  const signals = require('../../server/modules/source-import/site-signatures').readSignals({ status: 200, headers: { server: 'cloudflare', 'cf-ray': 'x' }, body: shell, url: 'https://s.example/' });
  assert.equal(signals.challenge, 'none');
  assert.equal(signals.spa, true);
  const real = require('../../server/modules/source-import/site-signatures').readSignals({ status: 403, headers: { server: 'cloudflare' }, body: '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>', url: 'https://s.example/' });
  assert.equal(real.challenge, 'js');
});

test('readPageText gives code in this process the text of a page, with the same refusals as peek', async () => {
  const { readPageText } = require('../../server/modules/source-import/site-peek');
  const body = await readPageText('https://site.example/x', { fetchImpl: async () => new Response('<html>ok</html>', { status: 200 }) });
  assert.equal(body, '<html>ok</html>');
  await assert.rejects(readPageText('https://site.example/x', { fetchImpl: async () => new Response('no', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(readPageText('https://sushiscan.fr/', { fetchImpl: async () => new Response('x') }), /dangerous sites/);
  await assert.rejects(readPageText('http://127.0.0.1:4000/'), /Blocked unsafe URL/);
  await assert.rejects(readPageText('ftp://x.example/'), /plain http/);
});

test('the look-alike of Cloudflare\'s CAPTCHA address is on the list, and the real one never is', () => {
  assert.match(blockedReason('https://ca2.cloudflarecaptcha.com/'), /cloudflarecaptcha\.com/);
  assert.match(blockedReason('https://cloudflarecaptcha.com/verify'), /revoked certificate/);
  for (const real of ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://www.cloudflare.com/', 'https://cloudflare.com/cdn-cgi/trace']) {
    assert.equal(blockedReason(real), '', real);
  }
});
