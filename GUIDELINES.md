# ScrollScape — Code and Organization Guidelines

This document defines the code organization, implementation, and maintenance rules for **ScrollScape**.

The goal is to keep the project organized, predictable, secure, easy to modify, and ready to grow without becoming difficult to maintain.

These guidelines must be followed across the whole project.

---

## 1. Core Principles

ScrollScape code should be:

- organized;
- modular;
- readable;
- predictable;
- easy to change;
- easy to test;
- secure by default;
- free from unnecessary hardcoded values;
- separated by responsibility;
- consistent with the existing architecture.

When choosing between a simple solution and an unnecessarily complex solution, prefer the simple one, as long as it remains safe and maintainable.

---

## 2. General Project Structure

The main structure should remain clear:

```txt
server.js
server/
public/
data/
docker/
tools/
brain/
sources-repo/
```

### Responsibility of each area

```txt
server.js
```

Should act only as the application entry point and thin orchestrator.

It may contain:

- initial configuration;
- global path constants;
- module configuration;
- Express application setup;
- global middleware registration;
- route registration;
- server startup.

It should not contain heavy business logic.

---

```txt
server/
```

Contains the backend logic of the application.

Recommended structure:

```txt
server/
  helpers.js
  store.js
  sourceLoader.js
  middleware/
  modules/
  routes/
```

---

```txt
server/modules/
```

Contains reusable domain logic.

Examples:

```txt
server/modules/store/
server/modules/source-loader/
server/modules/network/
server/modules/common/
server/modules/local/
server/modules/calendar/
server/modules/downloads/
```

Rule:

> If the logic is reusable, complex, or domain-specific, it should live in `server/modules/`.

---

```txt
server/routes/
```

Contains only the HTTP layer.

Routes should:

- validate input;
- call services/modules;
- return HTTP responses;
- handle errors clearly.

Routes should not contain extensive business logic.

---

```txt
public/
```

Contains the frontend of the application.

Recommended structure:

```txt
public/
  index.html
  styles.css
  app.js
  modules/
```

The `public/modules/` folder should contain frontend modules separated by responsibility, such as API, state, navigation, reader, settings, analytics, i18n, and debug.

---

```txt
data/
```

Contains local and persistent user data.

Examples:

```txt
data/store.json
data/sources/
data/source-staging/
data/cache/
data/local/
data/tmp/
data/theme-presets/
```

Never assume these files or folders already exist. The application should create required directories and files during startup.

---

```txt
sources-repo/
```

Tracked, installable sources ScrollScape ships officially — unlike `data/sources/`
(gitignored, not bundled: "anyone who wants a given source just needs that one .js file"),
these are meant to live in the repo because they're project features, not third-party
scrapers (the folder holds no source today; the mechanism stays). `repo.json` here is a normal
`jsrepo` manifest; it is a normal `jsrepo` repository (the Settings card that listed such repositories was removed in 3.5.x; the routes `/api/repos` and the loader remain) —
no special-casing in `sourceLoader.js` for this directory.

---

## 3. Keep `server.js` Small

`server.js` should remain a thin orchestrator.

Allowed in `server.js`:

- global path constants;
- module configuration;
- Express setup;
- global middleware;
- very simple global routes;
- server startup;
- initial directory creation.

Avoid in `server.js`:

- library logic;
- download logic;
- source logic;
- analytics logic;
- achievements logic;
- scraping;
- complex data manipulation;
- domain-specific validation;
- long functions that belong in modules.

Start-up checks that decide whether the app may boot at all (which data folder, is another copy
running, can the library be read) live in `server/modules/common/startup-guard.js` and
`server/modules/common/app-root.js`, with their timings in `server/config/startup.js`; `server.js`
only calls them. They take their console, exit and file system as arguments so the refusal paths
are unit-tested without stopping the test runner.

If a function in `server.js` starts growing, move it to:

```txt
server/modules/
```

or:

```txt
server/routes/
```

depending on its responsibility.

---

## 4. Separate Routes, Services, and Helpers

Use this rule:

```txt
routes/   -> HTTP, req, res, status codes
modules/  -> business/domain logic
helpers/  -> generic reusable utilities
config/   -> configurable values
```

Example:

```txt
server/routes/downloads.js
```

should call:

```txt
server/modules/downloads/service.js
```

and should not contain the full CBZ generation logic directly inside the route.

---

## 5. Avoid Hardcoded Values

Avoid fixed values scattered throughout the code.

Do not hardcode:

- URLs;
- paths;
- ports;
- filenames;
- upload limits;
- timeouts;
- UI text;
- error messages;
- colors;
- sizes;
- allowed extensions;
- rate limits;
- directory names;
- storage keys;
- event names;
- configuration values.

### Avoid

```js
const upload = multer({ dest: "data/tmp", limits: { fileSize: 500 * 1024 * 1024 } });
```

### Prefer

```js
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: limits.maxUploadSizeBytes }
});
```

### Create configuration files when needed

Suggested structure:

```txt
server/config/
  paths.js
  limits.js
  cache.js
  security.js
  defaults.js
```

Example:

```js
// server/config/limits.js
'use strict';

module.exports = {
  jsonBodyLimit: '5mb',
  maxUploadSizeBytes: 500 * 1024 * 1024,
  apiRateLimitWindowMs: 600_000,
  apiRateLimitMaxRequests: 6000,
  fetchTimeoutMs: 10_000,
  sourceCallTimeoutMs: 30_000,
  repoCacheTtlMs: 3_600_000
};
```

### A limit has a name, a reason and one place

A number that bounds behaviour (a cap, a window, a retry delay, a length) is a named constant with the
reason beside it: in `server/config/` when more than one file needs it or a test pins it, otherwise at
the top of the one module that owns it. Added with the browser-session work: `limits.disabledSourceIdsMax`
(the most ids the Disabled sources list holds), `POOL.passThroughSiteLimit`, `POOL.solverLineMaxChars` and
`POOL.downAfterWedgeMs` (`config/solver.js`), `RECOVERED_SOURCE_ERROR_AFTER_MS` and
`PROBE_COVERED_SOURCE_METHODS` (`config/system-health.js`), the anime probe's `HEALTH_CHECK_TIMEOUT_MS`
(`anime-health.js`, 30 s) and the retry delays of a store write (`store/persistence.js`). A browser file
that has to know the same number says so in a comment and is checked against the server's by a test
(section 18).

---

## 6. Paths and Directories

All important paths should be centralized.

Examples of global path constants:

```txt
DATA_DIR
SOURCES_DIR
SNAP_SOURCES_DIR
STORE_PATH
CACHE_DIR
LOCAL_DIR
TMP_DIR
THEME_PRESETS_DIR
```

Rule:

> Never build sensitive paths directly inside routes or services when the path can come from configuration.

Always use:

```js
path.join(...)
```

Avoid manual concatenation:

```js
const filePath = DATA_DIR + "/store.json";
```

Prefer:

```js
const filePath = path.join(DATA_DIR, 'store.json');
```

---

## 7. Configurable Modules

Modules that depend on paths or external options should expose a `configure()` function.

Keep this pattern for modules such as:

```txt
store.js
sourceLoader.js
local routes
theme preset routes
```

Recommended pattern:

```js
function configure(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Invalid options provided.');
  }

  service.configure(options);
}
```

Rules:

- validate received options;
- fail early if required configuration is missing;
- do not access files before `configure()` has been called;
- do not hide global paths inside modules.

---

## 8. Helpers

`helpers.js` should remain a thin export layer for shared utilities.

It may centralize functions such as:

```txt
safeId
safeManga
sha1Short
isSafeUrl
fetchJson
fetchText
fetchImageBuffer
resolvePageUrl
safeName
```

Rules:

- helpers should be generic;
- helpers should not depend on routes;
- helpers should not contain feature-specific business logic;
- helpers should not mutate global state;
- helpers should be easy to test in isolation.

If a helper becomes tied to a specific feature, move it to:

```txt
server/modules/<domain>/
```

---

## 9. Store and Persistence

Persistence should remain centralized in:

```txt
server/store.js
server/modules/store/
```

Rules:

- never write directly to `data/store.json` outside the store module;
- always use `readStore()` and `writeStore()`;
- normalize the store after reading data;
- handle invalid JSON safely;
- ensure safe writes;
- avoid data corruption during power loss or process interruption;
- keep defaults centralized;
- do not spread the internal store schema across unrelated files.

Avoid:

```js
fs.writeFileSync('data/store.json', JSON.stringify(store));
```

Use:

```js
const store = await readStore();
store.history.push(entry);
await writeStore(store);
```

### A write the system refuses for a moment is not a lost write

`server/modules/store/persistence.js` retries a store write that Windows refuses (`EPERM`, `EBUSY`,
`EACCES`: an antivirus or a sync client holding `store.json` just as the temporary file is renamed over
it; seen live as `EPERM rename store.json.tmp -> store.json` on a mapped network drive):

- the debounced async write waits 100, 300, 800 and 2000 ms between its tries (a wait that blocks nothing);
  the flush at exit, which has nothing left to wait for, blocks 50, 150 and 400 ms between its tries;
  `flushNow()` (a route that wants the change on disk before it answers) makes one synchronous attempt and
  never sleeps on the event loop, so a locked file cannot freeze every other request: a retryable refusal is
  handed to the asynchronous retries. Each list is a named constant of the file;
- asynchronous flushes run one after the other, never two at once, and a flush that fails in a way nobody
  planned does not end the chain. The synchronous writes (`flushNow()`, the flush at exit) are not part of
  that chain, so they use a temporary file of their own (`store.json.sync.tmp`) and count themselves: an
  asynchronous write serialises the store again for every try and drops itself, without renaming, when a
  synchronous write reached the disk while it was running, so it can never put older data back;
- a flush that is still refused is tried again after 10 s, up to 5 times, because the debounce only writes
  when something changes and nothing may change for a long while; a new change starts the allowance over;
- any other error (a full disk, a missing folder) is reported once and not repeated;
- the data stays in memory throughout and `writeStore()` stays the only door (`tests/unit/store-persistence-retry.test.js`).

### Adding a setting

A new `store.settings` key has one default and one repair, in `server/modules/store/schema.js`
(`normaliseStore`): junk from an import or a hand edit is removed or emptied so the default applies, it
is never clamped to the nearest bound. The key reaches the store through `server/modules/common/settings-fields.js`, a
`[key, type]` table whose types are `'string'`, `'boolean'` and `'idList'` (a list of source ids judged
**all or nothing**: one bad entry, a non-array or a list over its cap refuses the whole key, `[]` clears
it, repeats are stored once, and the length is judged before the list is walked). Only the keys of the
table are copied from a request, so a request cannot choose a key. A setting that needs a judgement of
its own (the pool's three, `solver-settings.js`) is refused whole with `400` before anything is read or
written. Its cap or bound is a named constant in `server/config/` (`limits.disabledSourceIdsMax`), and
the browser's mirror of it is covered by a drift test (section 18). A default that may change later is
applied when the setting is read (`normalizeSolverSettings()` for the pool) and is never written into the
store: `normaliseStore` only removes junk (`repairSolverSettings()`), so a stored value is always a
choice and a changed default reaches every library that never set the key. Writing the default into the
store on first start would freeze it for every library that ever ran that build, which is why the pool's
keys do not (`tests/unit/store-init.test.js`, "a library with no settings stores NO pool key"). The older
plain settings (`flaresolverrUrl` and the like) do store their empty default.

**Where a setting is shown.** Settings has twelve tabs (Reading, Library, Anime, Theme & Appearance, Tracking, Sources, Filters, Network & Anti-Bot, Accounts, Security, Data & Backup, Advanced). Each card is ONE builder function, `settingsCard<Name>()`, in `public/modules/ui-settings-cards-*.js` (by topic), and `SETTINGS_TABS` in `ui-settings-modal-html.js` says which tab shows which cards, in which order. A new setting goes into the card it belongs with; a new card is a new builder plus a line in `SETTINGS_TABS` (a builder that is not defined is skipped, which is how a light edition leaves a card out). Two cards are added after the markup is injected ("Protected sites" after the first card of Network & Anti-Bot, "Import a source" after the Anime Sources card, both by tab id; the Advanced tab holds the Source catalog card first, in a slot the catalog block draws itself into), so the first card of a tab is not moved casually. A place that opens a tab by id (`.settings-nav-item[data-tab="..."]`) has to name a tab of `SETTINGS_TABS`: `tests/unit/frontend-settings-tabs.test.js` checks the map, the builders and these ids. Keep every file under 450 lines. **A text setting is saved when it is typed, not only when the field is left:** a `change` event fires for a field that is LEFT, and closing Settings with the cursor still in it (a pasted ID) could lose the value, so a text field saves after a short pause in typing, on `change`, and when the window closes (only if the person touched it: an empty box whose stored value has not arrived yet must never wipe it), and a call that saves a setting says when the server refused it (a toast with the reason) instead of being fire-and-forget. The Discord Client ID is the example (`frontend-discord-settings-save.test.js`).

---

## 10. Source Loader and External Sources

Source loading should remain isolated in:

```txt
sourceLoader.js
server/modules/source-loader/
```

To add a source, follow `docs/adicionar-source-completo.md` (short version: `docs/adicionar-source-simples.md`): the
site investigation, the code template, the `meta.ui` declaration (the id-keyed tables are only for the repository's own
sources) and the done-checklist live there, and the rules
below are the ones it relies on. Change that guide in the same commit as any change to how a source is added.

Mandatory rules for sources:

- always validate `id` with `safeId`;
- confine paths before accessing the filesystem;
- validate the exported source interface;
- clear cache when a source is updated or removed;
- never trust external code without validation;
- apply timeouts to source calls;
- keep safe fallback behavior when a repository fails;
- do not let a broken source crash the whole application;
- **before a new source is considered done, verify every Advanced Search
  filter category against it — see "Advanced Search filter verification"
  below. A source that only implements the 4 required functions but was
  never checked against real filter/sort/format combinations is not
  finished, even if search/details/chapters/pages all work.**
- **`chapters()` must attempt a real per-chapter `publishAt` whenever the
  site actually exposes one, not hardcode `null` by default.** Check the
  raw chapter-list HTML/API response for a date field before assuming it
  doesn't exist — it is easy to read only the chapter-name element and
  miss a sibling element/attribute carrying the date (this happened for
  real: MangaFox's chapter rows have the date in a second `<p>` right next
  to the one being read; WeebCentral's chapter list carries a real
  `time[datetime]` attribute), or to have the data already fetched for
  `mangaDetails()` and never reused in `chapters()` (a gallery site's
  `upload_date`, already available through an existing cached lookup, sat
  unused). `publishAt: null` is only correct once you've actually looked at
  the raw response and confirmed no date is present anywhere in it — see
  BatCave's chapter parsing for what that confirmation should look like in
  a code comment (JSON-LD's `ComicIssue` node genuinely has no date field,
  verified live, documented inline). Never fall back to `new Date()`/"now"
  for a missing date — that mislabels "unknown" as "just published," which
  is worse than leaving it null.

Each source must export (the dispatcher calls them with **positional** arguments, see
`server/modules/sources/dispatch-service.js`; an earlier version of this section showed object arguments and
`meta.baseUrl` / `meta.lang`, which no code reads):

```js
exports.meta = {
  id: 'source-id',     // the same text as the file name and the id it is installed as
  name: 'Source Name',
  version: '1.0.0'     // optional but shown; author, icon, beta and the supports* flags are optional too
};

exports.search = async (query, page = 1, orderBy = '', filters = {}) => {};
exports.mangaDetails = async (mangaId) => {};
exports.chapters = async (mangaId) => {};
exports.pages = async (chapterId) => {};
```

`server/modules/source-import/contract.js` is the one place that says what a *new* source has to meet
(`checkSourceContract()`: meta.id valid and equal to the install id, a name, the four calls, every optional call
a function). The loader keeps its older, shallower load-time check (a truthy `meta.id` and the four functions)
so that a source that works today keeps loading.

A source whose `pages()` is expensive on a long chapter (one request per page, behind a
throttle) should also export the optional `firstPage(chapterId)`, returning the same
`{ pages: [{ img }] }` shape for the first page only. The System Health image-quality probe
measures nothing but the first image and prefers `firstPage()` over `pages()` when it
exists; `withTimeout()` cannot cancel the abandoned `pages()` call, so a slow one keeps
draining the source's shared request queue and stalls its next call too. It is probe-only:
keep it out of the dispatch whitelist (`ALLOWED_METHODS`) and never call it from the
reader.

### Importing a source file

The Settings card *Import a source* (`routes/source-import.js`, `modules/source-import/`) is the tool for a source
file the person supplies (a repository install also writes to `data/sources/`, by another route). Its parts, one
responsibility per file: `static-report.js` (parse without running, requires/hosts/risky calls, SHA-256),
`contract.js`, `ids.js` (id rules, the id a file names for itself, whether an id is free), `input.js`,
`staging.js`, `placement.js` (put the file in place, undo), `failure.js` (errors and path scrubbing),
`preview.js` ("Check"), `install.js` ("Install") and `service.js` (wires them to their dependencies). Rules it
keeps, and any change to it must keep:

- a source is arbitrary code in the server process, so the tool **never claims to make a file safe**: it
  parses the text without running it (`vm.compileFunction`, the same way Node's loader reads a CommonJS file),
  lists what the file contains (requires, hosts, risky calls, SHA-256) and the person decides;
- the two steps are separate requests: `preview` stages the text under its SHA-256 in `data/source-staging/`
  (which must sit as deep as `data/sources/`, because a source's relative requires are resolved from where it
  really is); `install` takes **only the fingerprint** (never new text), re-reads the staged file, refuses it if
  its hash changed or it is older than an hour, runs **that verified text** (passed to
  `loadCandidateFromFile()`, so what runs is not whatever the file holds a moment later; nothing is cached or
  left in `require.cache`), judges the exports, and only then writes it to `data/sources/` (temporary file +
  rename, retried through `common/fs-retry.js` when the system refuses for a moment; `.bak` of the previous
  file when replacing). Anything that fails after the file is in place (the final load, the store write) puts the
  previous file and store entry back, and the error says "rolled back" **only when the undo worked**, otherwise
  it names what to do by hand (delete the file for a new source, restore the `.bak` for a replacement). A file an
  install is working on is never pruned from the staging folder, and the staging folder gets the same retry of a
  passing refusal as the sources folder;
- the id is the person's choice and is validated, never used as a path before that: `safeId()`, not the
  reserved `local`, not a Windows device name (`con`, `nul`, `com1`, …: `con.js` is the console, not a file),
  not a name every object already has (`constructor`, `__proto__`: the store is a plain object), and it must
  not differ from an installed id only in letter case (`safeId()` is case-insensitive and two names would reach
  one file on Windows). The id a file names for itself is read only from its `meta` object. An id already used by a
  bundled source, a repository source or a file on disk is refused; only an id imported earlier with this tool can
  be replaced, and only with an explicit `replace: true`;
- both routes are in `PRIVILEGED_ROUTES` **and** behind `requireThisComputer` (the check of
  `requireLocalRequest` with a refusal that does not offer a password): they stay on this computer even when an
  Access Password is set. (With no password set, the auth gate answers a remote request first, with its ordinary
  text, which does mention a password; only a request that got past the gate sees the refusal of
  `requireThisComputer`. The Settings card shows its own sentence for both.) They are rate limited, and the request
  body (which is the whole source text) is replaced by a short summary before the shared async handler can log it;
- no message that reaches the person carries a path of this computer (`failure.js`: drive, UNC, POSIX and the
  staging folder are replaced, URLs are kept); a disk fault is a logged 500 with a path-free message, a refusal is
  an expected 4xx;
- installs are serialised (one at a time), and the `installedVia` of the entry is `'imported'`, which is what
  lets `uninstallById()` remove it, with its `.bak` (it accepts `'repo'` and `'imported'` and refuses
  everything else);
- `disabled` and `beta` are **not** a quarantine: the loader still runs a disabled source. Do not describe them
  as one.

### Writing a source from a link (no AI)

The card's "Add from a link" block and `tools/source-lab.js generate` write a source **without an AI**, from a template of the
site's engine (`modules/source-import/generator/`: `madara.template.txt`, `mangathemesia.template.txt`, `fit.js`, `discover.js`,
`index.js`, `origin.js`). `generator/from-link.js` is the whole flow (probe, engine, does-the-template-fit, name and genres, fill)
and is the **only** place that decides it: the command line and the route both call it, so they cannot disagree. Rules it keeps, and
any change to it must keep:

- it **writes nothing and installs nothing**. The route (`POST /api/sources/import/link`) returns the text; the card puts it in its
  box and runs its own Check, so a written source passes the same gate, and needs the same confirmation, as a pasted one. The route is
  local-only like the rest of the import routes, rate limited (4 a minute: each asks a third-party site for pages), reads
  `data/site-denylist.txt` on each request, and never logs the address as anything but a short summary;
- every value that comes from a site (name, genres, slugs) is validated and enters the file as a **JSON literal**: a hostile page
  cannot put code in it. The name is cut down to letters, digits and a few marks;
- **the folder a site keeps its titles in** (`/manga/` on most installs, `/series/`, `/komik/`... on others) is a measured fact like the name: it is read
  from the first part of the address of the title page the probe found (`discover.js`, `titleFolderFrom`), is put in as a JSON literal
  (`__SUBPATH__`, only a plain word of up to 30 characters, else `manga`) and built into the template's addresses and patterns. The fit
  check then looks for the list cards **in that folder**, so a wrong reading is refused, not written. No address of a template may name `/manga/`
  directly (a test pins it);
- **extension repositories the person adds** (`source-catalog/repo-url.js`, `repos.js`; `settings.catalogRepos`, routes `/api/sources/catalog/repos`, local-only and
  limited): the address is judged strictly BEFORE anything is asked (https, no login, no port, no query, a name with a dot that is not an IP number or a local
  name; a form is only accepted if the list of extensions is really there), at most 8 are kept, and what is stored is read back as strictly as it was
  accepted. The sites of an added repository have no theme to read (the project that builds the default one does not cover them): they are offered as `check`
  and the generator judges the site itself, so no address of a repository ever decides a template. The content cap of the edition applies to them like to the
  default list. The default repository is listed like the others and can be removed (`settings.catalogDefaultOff`; pasting its address again puts it back,
  and it is not held back by the cap of 8): the catalog is then only what the person added, empty when there is none, and the extension engine has nothing
  to serve. The extension engine (Suwayomi) is only for the default repository for now;
- **chapter dates** are read by `chapter-dates.js` (shared by the written sources and by the generator's measurement): a relative time counts only for
  seconds to days (a week or a month ago is **not** a day: null), a numeric date is read in the order the generator measured on the site (`__DATE_ORDER__`,
  from a day above 12, else the page's language), and a date it cannot read, that does not exist or is in the future is null, **never invented**. The Madara
  fit check also requires a **readable chapter list** (in the title page or in the answer of the theme's own call): a site whose chapters a script of its own
  fills in is refused at generation instead of written to fail in the live Test;
- **an engine told by its API or by one page** (`api-engines.js`, today Iken, the first version of Keyoapp and VineTheme; the shared RSC reader is `rsc-reader.js`). **The robots.txt of a host is read before any path of it is asked**, even to find out what the site is: when the page names no engine that has a template, the site's API is asked once, the way
  its own page asks (the site as `Origin` and `Referer`, JSON as the answer; an `api.` host first, then the site), and the engine is named by the SHAPE of the
  answer (fields of the right type), never by a word on a page. The API is read by a robot, so **the robots.txt of the host the requests go to decides**: an
  `api.` host has its own, and the site's rule about its own `/api/` is not about it; a path the source asks that it forbids is a refusal (and an API on the
  site itself is judged by the site's robots.txt). A host the person's list of dangerous sites names is never asked. There is no markup to fit, so the shape
  of the answer is the check, and the live Test is still the gate;
  The newer versions of a theme that this app cannot read (Keyoapp V2) are **named and refused** with a sentence, never mistaken for the old one; a value a
  site gives for a picture (`uid`) is only joined to the host the page's own script names when it is a plain path with no `..`;
  The VineTheme template reads React Server Components answers (the page asked with the `rsc` header): rows `<hex id>:<value>`, long strings as
  `T<hex byte length>,` rows (read by BYTES) and `$<id>` references; the data is found by the names of its fields and what it holds is plain text. A chapter
  whose pages the site marks as hidden, encrypted or cut into tiles, strips or fragments is **refused (403)**, never shown as a picture;
- the template is read as LF whatever the checkout did to it, so the file (and its fingerprint) is the same on every computer;
- the titles of the genres the app never lists (rule 1.6) are read from the site's own genre pages and kept out of **every** list,
  search and detail page of the written source, and the source refuses to list at all if such a page cannot be read (never lists
  without the exclusion). A site that presents itself as adult is declared `adultOnly`;
- **Regenerate**: a written source carries one line, `// scrollscape-generated engine=… base=… on=…` (`origin.js`, which reads
  only that exact shape). `regenerate.js` offers it only for an **imported** source whose file still has the sha256 the store holds
  (a file edited by hand is the person's) and takes the address **from the installed file**, never from the request. Nothing is
  replaced by the button: the new text goes through the Check and the confirmed replacement;
- the templates are in `package.json` `pkg.assets`: without that a packaged exe has no templates and the feature does nothing on a
  fresh install. Tests and comments name **example hosts**, never a site the general edition does not ship (the generator is generic and
  goes to both editions; site names stay off `main`).

### The source catalog (a Mihon-compatible repository's list)

`modules/source-catalog/` and `routes/source-catalog.js` list the sites a public repository of Mihon-compatible extensions names, and
hand a chosen one to the generator above. It does **not** run those extensions (Android programs: no sandbox here, no JVM) and an
extension is never downloaded. Rules any change must keep:

- it **installs nothing and writes no source**: a row is written through `POST /api/sources/import/link` with `{ catalog: { key } }`,
  so the text goes through the same Check and the same confirmation as a pasted link. The key is `package#position`; the server looks
  the address up in the repository's list (`catalog.siteOf`) and **never takes an address from the browser**;
- every value of the repository's list is third-party text: `index-format.js` keeps only short plain strings, drops a site that is not
  plain https, and drops an extension whose package is not shaped like one (the package is later put in an address). Never put a value
  of the list in an address, a path or markup unchecked; the screen builds markup only through `escapeHtml`;
- a card's **logo** is the one value of the list the browser loads as an image, so it is held to the strictest rule: `iconOf()` keeps
  it only as a plain https address with no login, port, query or fragment, on a host of `iconHosts` (the repository's public CDN),
  and the screen checks the same shape again before it writes an `<img>` (`no-referrer`, lazy). Anything else leaves the initial; a
  logo is never taken from a site's own address;
- **the content an edition offers is a server-side cap** (`allowedWarnings` in `server/config/catalog.js`): the browser can ask for
  less (Hide NSFW asks for SAFE only), never for more, and `siteOf` refuses an entry the edition does not offer. The general edition
  (`main`) allows SAFE only;
- what is asked of the network is fixed and small: the list, the build file of each extension, Cloudflare's published ranges and
  the DNS for the **name** of a site that can be added. Never the site itself, and never in bulk: the background work runs a few
  at a time with a pause, one job per key, and a breaker stops it after repeated failures (see `work-queue.js`). A site on
  the person's list of dangerous sites (`data/site-denylist.txt`) is shown as blocked and its name is never looked up;
- "behind Cloudflare" is a label and a filter, never a verdict: many such sites open normally. The theme comes from the extension's
  `build.gradle.kts` (`theme = "..."`) on GitHub because the list does not carry it; an extension with no such line is a scraper of its
  own site (`custom`) and no template can write it;
- nothing is asked of the network before the person opens the block (the block is a `<details>`), and the list is asked again only
  while the server says it is still working, a bounded number of times;
- the routes of the import tool, the catalog and the engine are all behind `requireThisComputer` and on `PRIVILEGED_ROUTES` (a test pins both), so ONE
  switch governs them: `SCROLLSCAPE_ALLOW_REMOTE_IMPORT` (opt-in; only an unmistakable "on" counts; `SCROLLSCAPE_ADMIN_LOCAL_ONLY` wins). With it on, a remote request
  passes only if `req.scrollscapeSession === true`, which the auth gate sets AFTER it checked the session cookie (a route must never read the login itself), and never
  if a browser marks it cross-site. With no password the gate refuses a remote request to these paths before the route runs. A new route of the tool uses
  `requireThisComputer` and goes on the list: a route that checks "local" its own way would silently ignore the switch (or, worse, ignore the gate);
- **the extension engine** (`routes/source-engine.js`, `modules/source-catalog/engine/`) is the one place that installs a third party's
  program, and it does so in the PERSON'S OWN Suwayomi-Server, never in this process. Rules: the body is a catalog key and
  `acknowledge: true` (the screen asks first, in words that say what is installed and where), never a package, an id or an address; the
  package and the source id are the repository's (`catalog.engineSiteOf`), checked against `allowedWarnings` and the denylist BEFORE the
  server is asked; the source ids are text (19 digits do not fit a number); the route is local-only, rate limited and logs only a summary.
  The written source is self-contained (a source in `data/sources/` cannot require `server/`), reads the Suwayomi settings through the
  app's own loopback, and keeps rule 1.6 as far as the extension gives genres (documented limit). It goes through the same Check and
  confirmation as every other file, and `config.extensionEngine` switches the whole thing off for a build that does not offer it.
  The extension's own filters (genres, status, sort) reach the written file only as a PLAN (`engine/filter-plan.js`): the server's list of
  filters is third-party data, so `planFilters` keeps only the shapes it understands, `normalizePlan` rebuilds the plan from scratch with
  every limit before the builder uses it, names are plain text in the shapes `meta.ui` accepts (never a markup character, never a name
  that `NEVER_LISTED_RE` matches: rule 1.6 holds for the genres offered too), and the plan enters the file as a JSON literal, never as code.
  The written source only ever sends a change the plan has. A tag the person types (`meta.ui.customTags`) is the one value that comes from the
  browser: it must be plain words (no comma, no leading dash, at most 40 characters, at most 5), never a category rule 1.6 forbids, is checked again
  by the written source, and is built into the screen with DOM calls, never as markup.
  The one setting of an extension this app changes in the person's server is the switch that joins single pictures into long chapters
  (`engine/preferences.js`: a boolean named like "merge chapters", by its position, best effort, and told in the notes); never another setting.
  The Windows setup (`tools/windows/Setup-Suwayomi.cmd`, a batch file followed by a PowerShell script) is the one place this project downloads a program:
  it pins ONE version with the SHA-256 GitHub lists for it, refuses a file that differs, asks before it changes anything, listens only on this computer
  with a generated login (long and random by default, never a preset: a known password on a local port can be tried by any web page), and is plain
  ASCII with CR LF line ends (a test pins both). It installs into a `Suwayomi` folder inside the library folder: the app fills that folder into the
  script it hands out (`bakeSetupScript`, only when the folder is safe in a batch line). `POST /api/suwayomi/connect-local` reads the file it writes,
  at a fixed place, and accepts only an address of this computer; the password is never in an answer.
  The same set-up is also made by the app itself (`server/modules/suwayomi/local-server.js`, `local-firewall.js`, frozen constants in
  `server/config/suwayomi-local.js` that a test pins to the script's): it is "install and use", so the rules are the script's and more. Nothing is downloaded without
  `acknowledge: true`; the file is checked against the pinned SHA-256 and size before anything is unpacked (a mismatch deletes it), the unpack refuses a name
  that leaves its folder and a package over the entry and size caps, and the only program ever started is the `javaw.exe` found in that unpacked package. The
  routes (`/api/suwayomi/local/*`) are local-only with no remote opt-in, because they start, stop and delete programs of this computer; uninstall deletes only
  the `Suwayomi` folder inside an absolute library path. The firewall script gets program paths as quoted text only (quotes doubled) and its own path through
  the environment; Windows' prompt grants the rights, and a refusal is an answer, not an error. The server starts with the app (unless `suwayomiLocalAutoStart` is
  false) in the background and is stopped when the app exits. Nothing a request carries (address, path, name) reaches the download, the folder or the command.
  The updates routes (`/api/sources/engine/updates`, `/update`) follow the same rules: the package is looked up from the id of an installed source in the
  repository's list (`catalog.engineSiteOfSourceId`: edition cap and dangerous list apply), never taken from the browser; an update needs the same
  confirmation as an install; the changelog is third-party text kept as plain text and shown only as text, and the "what changed" link can only be
  the history of the extension's folder in the project that builds them.

### Studying a live site: in memory, only sites the user knows, never to disk

A page of a manga site can carry malicious JavaScript, and scan-site clones are a common place for malvertising and phishing (the
antivirus has blocked two while a tool was probing). So, for the tools that look at sites (`tools/source-lab.js`, `server/modules/source-import/site-*.js`):

- a page is read **in memory** (`peek`, `probe`) and only a small plain-text answer is printed or kept; a page is never written to a
  file (no `curl -o`, no "samples"), and the modules that read pages must not touch the filesystem (a test asserts it);
- only sites the user gave, or the sites of sources already in use, are studied: never sites chosen by a web search, and never by an agent
  that was told to "find sites";
- a site that a security product flagged goes into `site-denylist.js` (or `data/site-denylist.txt`) and is never asked for anything,
  not even through a redirect;
- a source file copied from a hostile page is recognised by the Check (obfuscation, encoded blobs, browser code, ad networks) and
  the command line refuses those unless the risk is named with `--allow-risk`;
- the path the DATA comes from is asked for too (`probe --data "/api/..."`, once): a site can open its pages to a plain request and keep
  its data behind a protection of its own, and a page-only look calls it `open`. A refused data path is `data-protected` (not viable):
  the protection is the site's way of keeping the data for its own page, and this project does not imitate a browser to get past it. The
  message FlareSolverr gives for any Cloudflare block ("probably your IP is banned") is a guess: check the pages with a plain request
  before believing it;
- the names of sites that do not ship with the app stay out of the repository (code, tests, comments, commits, docs): examples use
  `*.example` hosts.

### A probe never opens a source the user switched off

The user's **Disabled sources** list lives in the browser and, as a copy, on the server
(`store.settings.disabledSourceIds`, `server/modules/sources/disabled-sources.js`; the browser keeps it
in step, section 18). Every unattended check reads the server's copy and leaves a disabled source alone:
the live source test (`sources/health-check.js`), the image-quality check
(`system-health/image-quality-health.js`) and the error-log history that System Health counts
(`system-health/service.js`, through `enabledSourceIdsOf()`). A probe of a Cloudflare-protected source
opens FlareSolverr's hidden browser and can wedge it, and a source whose pages are full of ads can trip
antivirus web protection, so "nobody uses this source" has to mean "nothing opens it". The helper never
throws: a missing or unreadable list is an empty one, so a probe never fails because of it.

A new unattended probe uses the same helper. What has to keep seeing every installed source does not:
the contract check of the installed files, loading modules at start, the Tachiyomi/Mihon import, the OPDS
feed, and anything that acts on a title already in the library, because a disabled source only leaves
the pickers.

### Anime sources: the registry, the contract, the relay

Anime providers are not wired in by hand: every one goes through the registry (`server/modules/anime-sources/`), and the contract a
source follows is `docs/contrato-source-anime.md`.

- **One place.** The routes (`routes/anime.js`), the player's list, the System Health probe and the relay all ask the registry. A new
  `if (provider === ...)` in any of them is a bug. The client keeps a copy of the list (`ANIME_PROVIDERS` in `ui-anime-test.js`) for when
  the server is unreachable, and a test fails when it differs from what the server registers (warnings included).
- **The contract is judged without running the module** (`checkAnimeSource`). A source declares `keyedBy`, the `features` it understands
  (what it does not declare never reaches it), an optional `warning` (a risk, or "may simply not work here"), and either its own
  `fetchHlsResource` (only the sources that ship with the app) or `meta.stream`.
- **An imported source cannot bring its own relay.** It declares the hosts its video lives on (`meta.stream.hosts`, names, https only) and
  the app relays only those: the host is re-checked on every request and on every redirect, only public addresses are fetched
  (`safeFetch`), a playlist is capped at 2 MB and any other resource at 64 MB, and the cap is enforced while reading (`readCapped`), not
  after buffering. What reaches the player carries the untrusted-content headers (media types only, `nosniff`, a sandboxing CSP).
- **Registering costs nothing.** `bundled.js` and `relay.js` `require` the providers and `fetch-utils` lazily, on first use: a provider
  nobody asks for is never loaded, and tests that replace the solver modules keep working. Do not add a top-level `require` of them.
- **An unknown provider is a 404**, never a silent fallback to another provider.
- **Installing is the manga import's flow**: Check without running the code, staging by sha256, install of that exact file, local-only
  routes (`PRIVILEGED_ROUTES` + `requireThisComputer`), a request body replaced by a summary before anything can log it. The sources
  that ship with the app are never replaced or removed.
- **The live Test plays nothing.** It runs only when the person asks, with a budget and a time limit, follows the stream through the
  app's own relay, never solves a challenge, never logs in, and never produces sound. A route that can take minutes extends the blanket
  30 s `/api` timeout for itself, and the background probes stand aside while it runs (`common/quiet-mode.js`).

### Advanced Search filter verification (mandatory for every new source)

Advanced Search exposes generic controls — sort/`orderBy`, `publicationStatus`,
`contentRating`, `format`, `genres` — on top of every installed source, gated
per-source by what the source declares in `meta.ui.filters` (server/modules/common/source-ui.js), then by the capability matrix in
`public/modules/ui-advanced-search.js` (`ADV_SOURCE_CAPABILITIES`, `CUSTOM_ORDER_BY_OPTIONS`, kept for the repository's own
sources). A source that declares nothing and is not listed there falls back to `default` (`orderBy: true, publicationStatus: true,
contentRating: false, format: true, genres: true`) — meaning every one of
those controls is shown and assumed to work **the moment a source is
installed**, whether or not the source's own code actually does anything with
the values it receives.

Before approving a new source as finished:

1. **Test every filter category against the real site**, not just against
   your own source code — a query param the site silently ignores looks
   identical to one that "works" until you compare two different values and
   check whether the results actually differ. For each of orderBy, format,
   publicationStatus, contentRating, and a sample of genres: fetch the site
   directly (or via FlareSolverr) with two different values and diff the
   results. Identical results for different values means the filter is
   decorative, not supported.
2. **For anything genuinely supported**, wire it into `search()`/`byGenres()`
   and declare it explicitly in `meta.ui.filters` (for a source bundled with the repository: an entry in
   `ADV_SOURCE_CAPABILITIES`) — don't rely on
   `default`, even if the values happen to match — an explicit entry
   documents that this was actually checked, not assumed).
3. **For anything with no real equivalent on the site**, either set that
   capability to `false` (hides the whole control, when nothing in that
   category works — see `asurascans`/`comichubfree`/`vortexscans`) or, when
   only some values within a category work (e.g. 3 of 5 `format` values),
   keep the capability enabled and make the source return a clean empty
   result for the unsupported values — never guess/return unrelated content
   tagged as if it matched.
4. **If a source's search results don't carry per-item genre/status/format**
   (common — listing pages are usually lighter than detail pages), tag
   results with whatever filter criteria the server call already scoped them
   to before returning. Advanced Search re-filters every server response
   client-side on top of the server-side filtering
   (`_applyAdvFilters` in `ui-advanced-search.js`) — untagged results get
   silently rejected by that second pass even when the server-side filter
   worked correctly. This exact gap made every filtered MangaFox search
   return zero results despite the server-side filter being correct — see
   `manual-tecnico/04-sistema-de-sources.md`'s MangaFox section for the full
   incident and fix.
5. **If `orderBy` only partially works**, add a reduced custom list to
   `CUSTOM_ORDER_BY_OPTIONS` (see `BATCAVE_ORDER_BY_OPTIONS`,
   `WEEBCENTRAL_ORDER_BY_OPTIONS`, `MANGAFOX_ORDER_BY_OPTIONS`) instead of
   leaving the full generic dropdown in place — a sort value with no
   backing should never appear selectable.

---

## 11. Security

Security must be treated as part of the architecture, not as a later patch.

Mandatory rules:

- validate all IDs;
- sanitize objects received from the client;
- block private, loopback, and link-local URLs;
- prevent path traversal;
- do not trust data from external sources;
- do not expose internal paths in client-facing errors;
- do not store tokens in code;
- do not log sensitive data;
- validate content types in proxies — and never relay a third party's bytes under its own
  `Content-Type` from the app's origin: use `server/modules/http/untrusted-content.js`
  (media/image allow-list, everything else becomes `application/octet-stream`, plus
  `nosniff` and a CSP `sandbox`). A relay that echoes `text/html` turns "open this link" into
  script running as the app, and from there into every `/api` route the victim can reach;
- a route that installs or executes code, changes operator settings/credentials, imports a
  backup, or hands back stored credentials (settings, the backup export) must be listed in
  `server/middleware/local-only.js` (`PRIVILEGED_ROUTES`, lower-case paths), so that with no
  Access Password set it only answers requests from the machine itself (the source import routes also
  carry `requireThisComputer`, so they stay local even with a password; see section 10). A guard that matches
  paths by string must agree with Express about which handler a request reaches — case, `HEAD`
  and absolute-form targets all differ from a naive comparison — so after changing it, fuzz it
  against a real Express app (the unit tests alone passed while `/API/SETTINGS` was open);
- fetch a URL that a client or a third-party server chose with `safeFetch()`
  (`server/modules/network/safe-fetch.js`), never a bare `fetch()` behind an `isSafeUrl()`
  check: `isSafeUrl()` only judges the first URL, the built-in fetch then follows redirects on
  its own, and a redirect to `127.0.0.1` arrives from loopback, which the local-only guard
  trusts;
- never interpolate a path, URL or id into PowerShell script text: pass it as an environment
  variable (`$env:SS_*`, via `runPs`/`runPsAsync` in `flaresolverr-lifecycle.js`). The quoting
  helper that used to do this lost its `\u` escapes and doubled digits instead of quotes, and
  no quoting rule can be trusted with a path like `C:\Users\O'Brien\Vault 1.0`. Windows
  PowerShell 5.1 also reads `Invoke-WebRequest -OutFile` paths as wildcards (`[ ]`): use
  `WebClient.DownloadFile` / `-LiteralPath`;
- anything that downloads, starts or kills a process is gated on a saved or explicit yes
  (`resolveFlaresolverrChoice`, `FLARESOLVERR_AUTO_INSTALL`), is injectable (`io` argument for
  fs, exec, spawn, netstat, clock) and has tests for the refusal paths — an unreadable
  `data/setup.json` fails closed (stays OFF), never open;
- a library that cannot be read right now is never replaced by an empty one: `server/modules/store/loader.js` treats ENOENT as
  first run and every other read error as "stop and say so" (`STORE_UNREADABLE`), keeps an unparsable file as
  `store.json.corrupt-<timestamp>` (copy, never move) and `StorageService` refuses every write after a failed load; the blank
  file is created with `flag: 'wx'`;
- do not build an inline handler (`onclick="fn('${value}')"`) from data: use `inlineJsArg(value)` (JSON.stringify + escapeHtml),
  and give ids that end up in attributes a server-side allow-list (letters, digits, `_` and `-` only); `tests/unit/frontend-inline-handlers.test.js`
  fails on a new offender;
- user data is never moved or hidden by a choice of folder: `app-root.js` only decides where to
  look, treats every stat error other than ENOENT as "a library is here", and refuses to start
  when two libraries both hold data rather than guessing;
- never take a version, URL or path to act on from the request when the server can derive it
  itself (the updater resolves the target version from the npm registry; a client-supplied
  version is only a downgrade vector);
- a route that saves settings copies only the keys of a fixed `[key, type]` table
  (`server/modules/common/settings-fields.js`) and judges a list of ids all or nothing, with its length
  checked before it is walked: a request never chooses the key it writes, and a body with a `__proto__`
  key must change nothing (`tests/unit/disabled-sources-route.test.js` posts one);
- text that reaches a user from a third-party tool (FlareSolverr's error messages) loses addresses,
  credentials and local paths first (`describeSolverMessage()`, section 12);
- use rate limiting on API endpoints;
- apply timeouts to network calls.

Never use user input directly in:

```js
require(...)
fs.readFile(...)
fs.writeFile(...)
path.join(...)
fetch(...)
```

without prior validation.

---

## 12. Network, Fetch, and Timeouts

All external requests should go through shared utilities.

**A network failure says why.** Node's `fetch` fails with a bare "fetch failed" and the reason (`ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`...) in `err.cause`. `server/modules/network/fetch-cause.js` (installed first thing in `server.js`) adds the code to the message of the same error ("fetch failed (ETIMEDOUT)"), so System Health and the error log say what happened. Code that looks for a failed fetch matches `/fetch failed/`, never the whole message; show a reason code, never an address. In Docker the image asks for IPv4 first (`NODE_OPTIONS=--dns-result-order=ipv4first`, `docker/Dockerfile`) because a container on a home network usually has no IPv6 route.

**Each address of a site gets 2 s, not 250 ms.** Node tries the addresses of a site one after another and, by default, waits only 250 ms for each; on a busy connection (a home server running all the health probes at once) every attempt is slower than that and the call fails at once with `fetch failed (ETIMEDOUT)` although the site is up. `server/modules/network/connect-patience.js` raises it (`connectAttemptTimeoutMs` in `server/config/limits.js`) at start-up, unless the person set `--network-family-autoselection-attempt-timeout` themselves.

Use:

```txt
fetchJson()
fetchText()
fetchImageBuffer()
resolvePageUrl()
```

Avoid direct `fetch()` calls scattered across the project.

Rules:

- every request must have a timeout;
- validate URLs before requesting them;
- handle network errors;
- return useful errors;
- do not block the process;
- avoid infinite retries;
- use cache when appropriate.

### Rate limiting for external services

Applies whenever code calls out to the same external host repeatedly —
a loop over many items, a fallback chain trying several queries for the
same request, or a bulk job (downloads, migrate, health checks). A burst
like that can trip a real rate limit on the other end; once that happens,
retrying immediately just extends the block instead of clearing it
(confirmed live: Brave Search's image search 429'd this project's own IP
after a burst of automated cover searches, and stayed blocked for hours).

Whenever this pattern is genuinely present — not for a single one-off
request — implement basic rate-limit protection:

- detect a 429 (or provider-specific rate-limit signal) explicitly, and
  stop the current operation from making further requests to that host
  instead of quietly treating it as "0 results" and moving on to the next
  item/candidate;
- set a cooldown for that host once a rate limit is actually observed, so
  subsequent calls skip straight to failing until it passes, rather than
  adding to the block;
- add a short result cache for repeat requests (the same query/URL asked
  again soon after) so they don't cost a new outbound request at all;
- pace consecutive requests to the same host apart by a small minimum
  delay — rate limits are often triggered by burstiness, not just total
  volume.

Reference implementation: `server/modules/cover-search/index.js`'s
`_hostState` (per-hostname cooldown + request spacing) and `_resultCache`
(short-lived query cache) — copy this pattern rather than inventing a new
one per module. Don't add this defensively to every single external call;
it's for the specific shape above (repeated/bursty calls to the same
host), not a blanket requirement.

### Browser calls: the FlareSolverr session pool

Cloudflare-protected sources are solved by FlareSolverr's hidden Chrome, and every call to it goes
through one place, `executeFlareSolverr()` in `fetch-utils.js` (built from `solver-call.js` over the
pool in `solver-pool.js`; sources reach it through `fetchText()` / `resolveViaSolver()`). The rules on
sessions, cookies and the proxy exist because each one is a trap in FlareSolverr 3.5.2 that no answer
from it reveals (read from its source; `manual-tecnico/18-sessoes-do-flaresolverr.md` says which of
them were also seen live); the others keep the pool testable and predictable:

- **One door.** Nothing else POSTs to FlareSolverr's `/v1`: only `solver/transport.js` does, and
  `solver/passthrough.js` (the pool-off path) through the same `post`. Reading its status page with a
  plain `GET /` (`solverStatusUrl()`, used by System Health) and starting or stopping the process
  (`flaresolverr-lifecycle.js`) are not browser calls. A new feature that needs the browser calls
  `fetchText()` / `resolveViaSolver()`; it never builds its own `request.get`.
- **Identical means the same site, the same exact URL, the same cookies and the same kind of browser.**
  Calls are de-duplicated with that key (`flightKey()` in `solver-call.js`, `single-flight.js`), never
  by domain alone: the per-domain lock it replaced handed the page of the first caller to every caller
  for the domain. The kind is the `oneOff` flag (below): a call that asked for a browser of its own never
  joins a run that did not. The SSRF check (`assertPublicUrl`) runs before the solver is asked.
- **Which site a host belongs to is decided in one place, `hostKeyOf()` (`common/host-utils.js`).**
  Spacing, cool-down, de-duplication and saved cookies all use it; nothing takes "the last two labels"
  on its own. A two-level suffix is either listed (`TWO_LEVEL_SUFFIXES`, which holds the shared hosts a
  shape cannot tell) or has the shape of a country-code pair (at most three letters, then two: `co.th`,
  `com.pl`), so a registry nobody listed cannot make two sites one. The price is stated in the code: a
  real site shaped like a pair is read as a site of its own, which is the safe way to be wrong.
- **Callers declare their patience through `solver-context.js`; they do not invent a wait.** A new
  caller that is not a person waiting for the page (a health probe, an enrichment, a cover search; the
  source and anime probes, cover search and the comic lookup do this today) wraps its call in
  `runWithSolverContext()` with `priority: 'background'` and a `deadlineAt` a little before its
  own timeout (`backgroundProbeContext(timeoutMs)` is the probe version), so the pool drops a job that
  is still waiting in the queue instead of the caller's timeout firing on a job that never started. A
  deadline only bounds the wait; it never cuts a navigation that has started. `boundSolve: true` does
  cut one, and is only for a caller whose page is never a Cloudflare challenge: cutting a cold challenge
  short means its cookie is never warmed. No production caller sets it today (cover search bounds
  itself with its own timeout and the deadline), so a new user of it writes the reason next to the call.
  An undeclared call is interactive; the image proxy's cookie refresh declares itself interactive with a
  deadline, because a person is waiting for that image.
- **A caller whose page depends on cookies the site sets from earlier requests declares `oneOff: true`.**
  Cover search is the user: the image engines keep SafeSearch in cookies, and a shared session could
  carry the cookie of a search made with Hide NSFW off into the next one that asked for the filter. The
  pool then gives the call a browser of its own even while a healthy session is open (`job.mode:
  'stateless'`, `solver/intake.js`), never answers it from a saved cookie (the preflight only applies to
  session jobs, `solver/scheduler.js`), and nothing the caller calls can take the declaration back
  (`solver-context.js`: only `true` survives a merge).
- **A refused connection is not a wedged solver.** `solver/transport-failure.js` tells the two apart. A
  timeout or abort (the solver took the call and never answered) opens the fail-fast window
  (`POOL.downAfterWedgeMs`). A refused or unroutable connection (FlareSolverr off, not installed, not up
  yet) opens nothing: each call fails by itself at once with `MESSAGES.unreachable` and keeps 3.1.2's
  retry for a blip, because a window would replace those words with "not answering" for as long as the
  user's own choice lasts. The pool only remembers the refusal (`state.solverRefused`) so System Health
  can say it; a user who switched FlareSolverr off on purpose (`ports.isOffByChoice`) hears nothing in
  the console.
- **A `request.get` is never sent for a session id the pool has not confirmed in the current
  FlareSolverr process.** FlareSolverr answers a request for an id it does not know by silently creating
  a session (seen live; that this session has no proxy is read from its source, not observed). An id
  counts only after a `sessions.create` or `sessions.list` answer of this
  process, never while it is being destroyed, and the request goes out through
  `transport.requestInSession()` only. Every `sessions.create` uses a new id. Only `sessions.create`
  carries `proxy`, and `session_ttl_minutes` is never sent (read from FlareSolverr's source: a recreated
  session loses the proxy; not observed live). The guarantee holds by construction: `transport.js`
  hands the pool's parts `createSession`, `listSessions`, `destroySession`, `requestInSession` and
  `requestStateless` and nothing else, so its raw `callSolver` is not reachable from them
  (`tests/unit/solver-transport.test.js` asserts the exact list).
- **Cookies are never put on a shared session.** A call that carries cookies runs in a one-off browser
  (`job.mode: 'stateless'`); cookies in a session payload would stay for every later caller.
- **The user's proxy is never skipped.** Once a proxy has been read, a setting that then cannot be
  read fails the job (`createUserProxyProvider()`, with the pool off as well); it is never sent
  without it. A job that goes through the proxy gets no plain-request preflight, since that request
  would leave from the app's own address.
- **The pool-off path stays plain.** With the setting or `SCROLLSCAPE_SOLVER_SESSIONS_DISABLED` off,
  the app sends the pre-pool payload and nothing else. A fix that must hold with the pool off belongs
  in the call layer (`solver-call.js`, `fetch-utils.js`), not in the pool, and is listed in the README.
  The one thing this path adds is a cap, `POOL.passThroughSiteLimit` different pages of one site in
  flight at a time (`solver/site-limit.js`, used by `solver/passthrough.js`), the rest waiting in line:
  since identical calls are de-duplicated by exact URL, going back to 3.1.2 would otherwise start twenty
  Chromes for twenty different pages of one site. The line is bounded the way the pool's queue is: a call
  waits only as long as its caller declared (or the queue's patience for its priority), an interactive
  call goes before a background one, and at most `POOL.queue.maxQueued` wait for one site (the next is
  refused as busy); a call that gives up leaves the line and never reaches FlareSolverr. The wait comes
  before the call, never out of its time, and the payload is untouched. Anything else added to this path needs the same
  argument and an entry under "Switching it off" in the README.
- **What a user may see of a FlareSolverr error is bounded and cleaned first.** `describeSolverMessage()`
  (`solver/classify.js`) keeps the first line only, looks at no more than `POOL.solverLineMaxChars` of it
  before its patterns run (they are quadratic on a long unbroken run, and a cut inside a word drops the
  whole word, so half of a credential is never what is left), removes addresses of any scheme,
  credentials without a scheme (`user:pass@host`) and paths (a drive letter, `\\server\share`, an
  absolute Unix path with at least one folder), and then cuts to `POOL.solverTextMaxChars`. A new
  pattern gets a test for the text it must leave alone as well as for the text it must remove.
- **One responsibility per module.** The pool's parts live in `server/modules/network/solver/`, one
  responsibility per file. They share one state object (`solver/pool-state.js`, whose header says who
  writes what: update it when a part starts writing a new field) and injected ports (`solver/ports.js`:
  clock, timers, log, error registry, hooks). Nothing starts at `require()` time and every effect is
  injected, so the pool is tested against `tests/helpers/fake-flaresolverr.js` with fake clocks. A new
  concern gets a module of its own, wired in `solver-pool.js`. Per-site spacing and block cooldown for the
  browser live in `solver/host-gate.js`: do not add a second one.
- **Timers.** Every pool timer is created through `ports.startTimer()` (which unref()s it) and exists
  only while there is something to wait for: the idle timer while a session exists, the scheduler's wake
  while a job waits for a time, the restart watchdog during a restart. A test asserts that none is left
  once the pool has no work.
- **Tunables, texts and codes.** The tunables, the settings' defaults and bounds and every user-facing
  text of the pool live in `server/config/solver.js` (`POOL`, `SETTINGS_DEFAULTS`, `SETTINGS_BOUNDS`,
  `MESSAGES`, `CALLER_PATIENCE` for how long the callers that declare their patience give the browser,
  `TWO_LEVEL_SUFFIXES`). A limit added since follows the same rule and is named there, with the reason
  beside it: `POOL.passThroughSiteLimit`, `POOL.solverLineMaxChars`, `POOL.downAfterWedgeMs`. A plain
  message names no host and avoids the substrings that steer `classifySourceError` (`api`,
  `http 500`, `maintenance`, `temporarily unavailable`); a test runs every
  one through the real classifier. The `err.code` of the pool's own refusals (`SOLVER_*`) is defined in
  `solver/errors.js`; what is worth remembering in `data/error-log.json` uses a code from the central
  registry (below).
- **A FlareSolverr that hangs is never restarted in a loop.** Three limits, independent of the pool (they hold with it on and off):
  the restart brake (`flaresolverr-restart-brake.js`: at most 3 automatic recoveries in 15 minutes and 30 s apart, said once on the
  console; only `recoverFromHang` is braked, the start-up check and the idle restart are not), the memory of a site that keeps leaving
  the solver without an answer (`solver/wedge-memory.js`, used by `solver-call.js`: the second stall in 30 minutes pauses that site for
  20, a call to it is refused before FlareSolverr is touched; a stall close behind another site's is not counted against the second),
  and the quiet mode (`common/quiet-mode.js`: the System Health probes stand aside while a live Test runs, and the quiet stretch expires
  by itself). A new source of automatic restarts goes through the brake, and a new long-running test begins a quiet stretch. The numbers
  are named in `server/config/solver.js` (`RECOVERY_BRAKE`, `WEDGE_PAUSE`) and are choices, not measurements.

---

## 13. Logging and Debugging

Avoid loose `console.log` statements in production code.

Rules:

- remove temporary logs before finishing a task;
- permanent logs must include clear context;
- errors should identify where the failure happened;
- do not log tokens, passwords, or sensitive data;
- use consistent categories;
- in the frontend, prefer the existing debug system;
- in the backend, create or use a centralized logger as the project grows;
- tests must never write to the real `data/` directory. `server/modules/error-logger.js`
  defaults to `data/error-log.json`, so a test that makes `createAsyncHandler` (or anything
  else that calls `recordError`) hit a 500 would pollute the owner's real log — under
  `node --test` an unconfigured logger now refuses to write, and a test that wants real
  writes calls `configure(<temp dir>)` first.

Acceptable:

```js
logger.error('Failed to load source module', {
  sourceId,
  error: error.message
});
```

Avoid:

```js
console.log(error);
console.log(data);
console.log('test');
```

---

## 14. Comments

Comments should explain why a decision exists.

Acceptable:

```js
// Static files are registered last to avoid shadowing API routes.
```

Avoid:

```js
// Create app
const app = express();
```

Rules:

- comment important decisions;
- comment security rules;
- comment special cases;
- do not comment the obvious;
- update comments when the code changes;
- remove outdated or misleading comments.

---

## 15. Naming Conventions

### JavaScript

Use `camelCase` for variables and functions:

```js
const activeSourceId = safeId(sourceId);
```

Use `PascalCase` for classes:

```js
class StorageService {}
```

Use `UPPER_SNAKE_CASE` for true global constants:

```js
const DATA_DIR = path.join(USER_ROOT, 'data');
```

### Files and folders

Use `kebab-case`:

```txt
source-loader/
theme-presets/
popular-all.js
ui-reader-page-rendering.js
```

Avoid vague names:

```txt
stuff.js
things.js
misc.js
test2.js
new-file.js
```

---

## 16. Code Style

Keep the current CommonJS style unless a future migration is intentionally planned.

Use:

```js
'use strict';

const path = require('path');

module.exports = {
  functionName,
};
```

Avoid mixing CommonJS and ES Modules in the same area unless there is a clear reason.

Rules:

- keep imports at the top;
- group imports by type;
- avoid mutable global state;
- prefer `const`;
- use `let` only when reassignment is needed;
- avoid huge functions;
- avoid deeply nested callbacks;
- prefer `async/await` when possible;
- handle errors clearly.

### Size

"Avoid huge functions" has numbers: **a new file stays within 450 lines (test files included) and a
function within 80 lines.** `eslint.config.js` does not turn these rules on, so measure the files you
touched by passing them on the command line:

```txt
tools/node/node.exe node_modules/eslint/bin/eslint.js --rule {"max-lines":["warn",450],"max-lines-per-function":["warn",80]} <files>
```

(quote the JSON for your shell; in `cmd.exe` write the two paths with backslashes, as the scripts in
`package.json` do). `eslint.config.js` ignores `public/**`, so this cannot measure front-end files: count
their lines (`wc -l <file>`, or `(Get-Content <file>).Count` in PowerShell) and read their functions
against the 80-line limit by eye. Code that was already over a limit is not split after the fact, but a
change does not make it longer when the new logic can live in a module of its own: the FlareSolverr pool
is `server/modules/network/solver/`, one responsibility per file, and the `[key, type]` settings table,
the System Health solver rows and the disabled-sources helper were taken out of the functions that
would have grown.

---

## 17. HTTP Routes

Routes should be small and predictable.

Each route should follow this sequence:

```txt
1. Read input
2. Validate input
3. Call service/module
4. Return response
5. Handle errors
```

Recommended structure:

```js
router.post('/example', async (req, res) => {
  try {
    const input = validateExampleInput(req.body);
    const result = await exampleService.run(input);

    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});
```

Avoid:

- extensive business logic inside routes;
- multiple responsibilities in the same route;
- inconsistent response shapes;
- errors without appropriate status codes;
- partial validation.

---

## 18. Frontend

The frontend in `public/` should remain separated by modules.

Rules:

- `app.js` should not concentrate all UI logic;
- UI modules should live in `public/modules/`;
- HTTP calls should go through the API wrapper;
- visible text should go through the i18n system (`public/modules/i18n/`);
- global state should remain centralized;
- utility functions should go in `utils.js`;
- reader-specific logic should stay in `ui-reader-*` modules;
- analytics logic should stay in its own module;
- settings logic should stay in its own module.

Avoid hardcoded frontend values:

- text;
- colors;
- sizes;
- URLs;
- repeated selectors;
- storage names;
- error messages.

### Settings the server owns, and copies the browser keeps

- A Settings card for a setting the server owns (`ui-settings-solver.js`, "Protected sites") reads the
  values with `GET /api/settings`, saves **only the key that was changed**, shows the server's refusal
  next to the field and puts the field back to the last value the server confirmed. A refused value is
  never left on screen looking saved, and a made-up failure (a network error, `HTTP 500`) is replaced by
  a translated sentence. Sending all the keys would let a stale copy in another tab, or the defaults of a
  failed load, overwrite real values.
- A bound or default the browser needs but cannot `require()` (`SOLVER_CARD_FIELDS`, the id rule and cap
  of `ui-disabled-sources-sync.js`) is mirrored in the front-end file with a comment naming the server
  file, and a unit test loads both and fails when they drift (`frontend-solver-ui.test.js`,
  `frontend-disabled-sources-sync.test.js`). The server stays the judge: the mirror only seeds inputs and
  cleans a list before it is sent.
- When the browser and the server each keep a copy of a setting (the Disabled sources list), the file
  that syncs them states the merge rule in its header and sends everything through one queue, so the
  last action wins. Here: toggling replaces the server's list, start-up only adds, a browser with an
  empty list sends nothing (so a start-up can never delete what another device decided), and Reset All
  Settings pushes too. A failed sync is logged once and never shown as an error: the interface works
  without the server's copy.
- A read that happens on every page load gets a route that returns only what it needs: the start-up read
  of the Disabled sources list is `GET /api/settings/disabled-sources`, because `GET /api/settings` hands
  over every stored credential (proxy password, API keys) and a page load must not pull those into the
  browser to read one field. The narrow route is in `PRIVILEGED_ROUTES` like the wide one.
- A feature's script is optional to the page that hosts it: the hook in `showSettings()` or `main()` is
  one guarded line (`if (typeof fn === 'function')`), and a test runs it with the file missing.

---

## 19. CSS, Themes, and Variables

Avoid isolated styles and hardcoded values.

Rules:

- use CSS variables for colors;
- use CSS variables for spacing;
- use CSS variables for shadows;
- use CSS variables for fonts;
- respect dark and light modes;
- respect community themes;
- do not place fixed colors inside components;
- keep styles reusable;
- avoid duplicated CSS blocks.

Recommended:

```css
.card {
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
```

Avoid:

```css
.card {
  background: #ffffff;
  color: #222222;
  padding: 16px;
}
```

---

## 20. Visual Rework Without Breaking Themes

During visual changes to HTML, CSS, or UI components, the appearance of elements may be redesigned, but the connection to the theme system must always be preserved.

Buttons, switches, cards, inputs, menus, badges, modals, and other UI components must continue to receive their colors from the active theme variables.

The visual structure may change:

- button shape;
- border radius;
- shadows;
- spacing;
- transitions;
- hover states;
- active states;
- switch design;
- card layout;
- menu appearance;
- interface structure.

However, the color source must remain centralized in the theme system.

### Main rule

> The visual design may change. The theme color priority must not be broken.

### Correct

```css
.button {
  background: var(--color-primary);
  color: var(--color-on-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.switch {
  background: var(--color-surface-muted);
}

.switch.is-active {
  background: var(--color-primary);
}
```

### Wrong

```css
.button {
  background: #7c3aed;
  color: #ffffff;
}

.switch.is-active {
  background: blue;
}
```

### Rules for component rework

- Never replace theme variables with fixed colors.
- Never use hex, rgb, hsl, or named colors directly in components, except inside theme definition files.
- All visual states must respect the theme:
  - normal;
  - hover;
  - active;
  - focus;
  - disabled;
  - selected;
  - loading;
  - error;
  - success.
- If a new color is needed, create a new variable in the theme system.
- If a component needs a visual variation, create a semantic variable instead of using a fixed color.
- Ensure dark mode, light mode, and community themes still affect the component.
- Always test at least two themes after changing global styles.

### Recommended semantic variables

Prefer names based on the role of the color, not the literal color.

Correct:

```css
:root {
  --color-primary: #8b5cf6;
  --color-on-primary: #ffffff;
  --color-surface: #111827;
  --color-surface-muted: #1f2937;
  --color-border: #374151;
  --color-text: #f9fafb;
  --color-text-muted: #9ca3af;
  --color-danger: #ef4444;
  --color-success: #22c55e;
}
```

Avoid:

```css
:root {
  --purple: #8b5cf6;
  --white: #ffffff;
  --gray-dark: #111827;
}
```

### Buttons

All buttons must use theme variables.

```css
.btn {
  background: var(--button-bg, var(--color-primary));
  color: var(--button-text, var(--color-on-primary));
  border-color: var(--button-border, var(--color-primary));
}

.btn:hover {
  background: var(--button-bg-hover, var(--color-primary-hover));
}
```

If `--color-primary-hover` does not exist, it should be added to the theme or generated centrally. It must not be invented directly inside the component.

### Switches

Switches must remain connected to the primary theme color.

```css
.switch {
  background: var(--switch-bg, var(--color-surface-muted));
}

.switch-thumb {
  background: var(--switch-thumb, var(--color-surface));
}

.switch[aria-checked="true"] {
  background: var(--switch-active-bg, var(--color-primary));
}
```

### Cards and panels

Cards must use theme surface colors.

```css
.card {
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-md);
}
```

### Inputs

Inputs must respect theme background, text, border, and focus colors.

```css
.input {
  background: var(--color-input-bg, var(--color-surface));
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}
```

### Rule for new variables

Whenever a new component needs a specific color, follow this order:

```txt
1. Check if a suitable variable already exists.
2. Reuse the existing variable if appropriate.
3. Create a new semantic variable if needed.
4. Add that variable to all themes.
5. Test the component in light mode, dark mode, and community themes.
```

### Visual rework checklist

Before completing any visual change, confirm:

```txt
[ ] The component still uses CSS variables.
[ ] No hardcoded colors were added.
[ ] Hover, active, focus, and disabled states respect the theme.
[ ] Switches still use the main theme color.
[ ] Buttons still change with the active theme.
[ ] Cards remain compatible with dark and light modes.
[ ] The change was tested with more than one theme.
[ ] New variables were added to all themes.
```

---

## 21. i18n and UI Text

The project supports multiple languages through:

```txt
public/modules/i18n/index.js
public/modules/i18n/locales/
```

Rules:

- do not write reusable visible text directly inside components;
- add new text to the i18n system;
- keep keys clear;
- avoid duplicating the same phrase across multiple files;
- provide fallback behavior when a translation is missing.

Example:

```js
t('settings.readerAppearance.title')
```

Avoid:

```js
title.textContent = 'Reader Appearance';
```

---

## 22. Interface States

Each important UI flow should account for:

- initial state;
- loading state;
- empty state;
- success state;
- error state;
- disabled state.

Example:

```txt
Library:
- loading while data is being fetched;
- empty when there is no manga;
- error when the API fails;
- success when data is loaded.
```

Never leave an action without visual feedback.

---

## 23. API and Data Contracts

API responses should remain consistent.

Recommended success shape:

```js
{
  ok: true,
  data: {}
}
```

Recommended error shape:

```js
{
  ok: false,
  error: "Clear message"
}
```

Rules:

- do not return different formats without a reason;
- document new endpoints in the README;
- validate input and output;
- preserve compatibility when possible;
- avoid silently breaking the frontend.

---

## 24. Errors

Errors should be useful for development but safe for the end user.

Backend example:

```js
res.status(400).json({
  ok: false,
  error: 'Invalid source id.'
});
```

Avoid sending:

```js
res.status(500).json({
  error: error.stack
});
```

Rules:

- do not expose stack traces to the client;
- do not expose local paths;
- do not expose tokens;
- use clear messages;
- log technical details only internally;
- handle network, filesystem, and invalid data errors.

---

## 25. Dependencies

Before adding a dependency:

- check if the project already has a solution;
- evaluate whether the library is maintained;
- evaluate bundle impact;
- evaluate security impact;
- confirm that it is actually necessary.

Avoid dependencies for simple tasks.

Remove unused dependencies.

---

## 26. `.bat` and `.sh` Scripts

Startup scripts should be clear and conservative.

Rules:

- do not delete user data;
- do not overwrite `data/` without confirmation;
- do not hide critical errors;
- use clear messages;
- keep behavior similar between Windows and Linux/macOS;
- avoid absolute paths from the developer's machine;
- document relevant changes in the README.

### Self-contained: delete the project folder, nothing is left behind

This is not a new rule — it's the design goal the portable `tools/node/node.exe` and the
self-installing FlareSolverr (capítulo 4/13) already existed to satisfy; writing it down
explicitly here so it's not just implicit in two examples. The build/installation should
be **self-contained**: everything it needs lives inside the project's own folder (bundled,
or downloaded into a subfolder of the project by the app itself), so that deleting that
one folder removes the whole thing — no leftover files elsewhere on disk, no packages
installed system-wide, no registry entries. Never make the app depend on something that
merely *happens* to already be on the user's computer.

- Prefer bundling a real copy inside the project (`tools/node/`) over requiring a system
  install.
- When something must be fetched at runtime (FlareSolverr), download it into a folder
  under the project itself, not somewhere outside it.
- A feature that can only work via a system-wide install (a package installed with `pip`/
  `npm -g`/an OS installer, outside the project folder) is a real exception to this goal,
  not a clean case of it — acceptable only as a clearly optional, non-core convenience
  (detected at runtime, silently skipped when unavailable, never blocking core startup),
  and it must be documented as a known exception, not treated as equivalent to bundling.
  The terminal dashboard (`tools/dashboard/`, needs system Python) is the one accepted
  case of this today. A "rain screensaver" launcher option (a curses TUI needing Python
  ≥3.12 plus two more `pip`-installed packages, one of them undeclared and Windows-only)
  was proposed, built, and then removed for exactly this reason — see
  `manual-tecnico/13-deployment-launcher.md` for the full account, kept as a real example
  of applying this rule, not just a hypothetical. The same principle also ruled out
  Windows Task Scheduler as the mechanism for System Health's Node.js runtime update
  (`manual-tecnico/13-deployment-launcher.md`, `manual-tecnico/14-licoes-e-armadilhas.md`)
  — it worked technically, but a scheduled task is a persistent, system-wide registration
  outside the project folder, exactly the kind of crumb this rule exists to prevent.

---

## 27. Docker

Docker changes must respect:

- `data/` persistence;
- `public/` mounting when needed;
- rebuild only when necessary;
- compatibility with the current structure.

Do not change volumes without evaluating the impact on user data.

---

## 28. Performance

Rules:

- avoid repeated calls without cache;
- avoid reading files repeatedly in loops when unnecessary;
- use TTL cache when appropriate;
- avoid blocking the event loop;
- avoid processing large files fully in memory unless necessary;
- apply pagination when lists grow;
- compress responses when appropriate;
- optimize images and public assets.

---

## 29. Manual Testing and Validation

Before considering a change complete, test:

- startup with `node server.js`;
- opening the application on `localhost`;
- main API endpoints;
- library;
- installed sources;
- chapter reading;
- local import;
- downloads;
- themes;
- analytics;
- achievements;
- settings;
- Docker, if the change affects environment setup;
- Windows launcher, if the change affects scripts.

---

## 30. Checklist Before Finalizing Code

Before completing any change, confirm:

```txt
[ ] Is the code in the correct file?
[ ] Does the function have a single responsibility?
[ ] Are there avoidable hardcoded values?
[ ] Are names clear?
[ ] Is there unnecessary code duplication?
[ ] Are errors handled?
[ ] Is input validated?
[ ] Are there temporary logs?
[ ] Are sensitive values logged?
[ ] Does the code respect the existing structure?
[ ] Does the README need to be updated?
[ ] Was the change manually tested?
[ ] Could the change break existing user data?
```

---

## 31. Main Rule for New Features

Whenever a new feature is created, follow this order:

```txt
1. Create or update the domain module in server/modules/
2. Create or update the route in server/routes/
3. Use existing helpers/configuration
4. Avoid hardcoded values
5. Validate input
6. Handle errors
7. Update the frontend if needed
8. Update README/GUIDELINES if needed
9. Test the complete flow
```

---

## 32. External API Verification and Error Code Registry

External APIs and third-party services must be treated as unstable dependencies.

APIs such as MangaDex, AniList, MangaUpdates, source repositories, image providers, metadata providers, and any scraper target may change over time. Endpoints, response formats, rate limits, authentication requirements, field names, pagination behavior, and anti-bot behavior can change without warning.

Because of this, every integration with an external API must be easy to inspect, debug, and update.

### Mandatory rules for external APIs

- Do not assume external APIs will keep the same response structure forever.
- Validate all external API responses before using them.
- Check for missing fields, renamed fields, empty arrays, unexpected status codes, and invalid JSON.
- Keep API-specific parsing isolated in the relevant service/module.
- Do not spread API response parsing across unrelated files.
- Add timeouts to all external API calls.
- Handle rate limits and temporary failures clearly.
- Treat a rate limit as a **budget shared by the whole app for that API**, not a per-call-site concern — any unattended background job (startup sync, periodic refresh) that loops over many items must serialize its own calls with real spacing between them (a shared, module-level throttle, not just a reactive cooldown after the first 429), or it can silently exhaust the entire budget before an interactive feature elsewhere in the app gets to make its own, unrelated call. See `manual-tecnico/16-updates-seasons-rate-limiting.md` for a real incident and fix.
- Avoid crashing the application when one external API fails.
- Return a useful fallback or a clear error state when an API changes.
- Document important external API assumptions near the integration code.
- Review API integrations periodically, especially when users report missing results, failed searches, broken covers, failed metadata, or empty responses.

### API change examples

Possible API changes include:

```txt
- Search endpoint changed response format.
- Manga details endpoint renamed a field.
- Covers moved to a different endpoint.
- Pagination behavior changed.
- API now requires a new header.
- API started returning 403 or 429 more often.
- API returns an empty result set despite a valid query.
- Image URLs expire faster than before.
- Metadata provider changed its schema.
```

### A known limit is declared by its code, never found by reading the text

Some things a site simply makes impossible for ScrollScape, and the honest report for them is "known
limit", not "failure". The clearest case is a CAPTCHA in front of a source's chapters, which ScrollScape
does not solve or bypass. Such a source declares it with an `err.code` that ends in `NEED_CAPTCHA`, and
System Health (`image-quality-health.js`, `CAPTCHA_WALL_CODE`) turns exactly that code into a passing row
that says "Known limit: ...". The text of an error is never matched to decide this: a change of wording
on the site, or an unrelated error that happens to mention the word, would turn a real failure into a pass
(or the reverse). Everything else about that source is still reported, and its baseline is left alone
while the limit holds. The reader branches on the same code (`loadChapter` in `ui-add-to-list-modal.js`): a chapter that fails behind a CAPTCHA shows the
server's own message (read it on the site, or use another source) instead of the generic "try Migrate" text, so the person learns WHY
(`frontend-chapter-captcha-message.test.js`). A new known limit gets a code a source can set, a test for that code and a test
that any other failure is reported as before (`tests/unit/image-quality-captcha-wall.test.js` is the
model). Callers branch the same way on the pool's own refusals: `err.code` (`SOLVER_*`,
`FLARESOLVERR_UNAVAILABLE`) decides, while `classifySourceError`, which does read text, is only how
System Health groups errors for display, so the pool's messages are written to avoid the substrings that
steer it.

### An automatic sync only sends up, and never changes what the person set

The AniList sync that runs on every app open and after every chapter (`_reconcileAniListProgress`,
`anilistStartupReconcileProgress`, `anilistReconcileAnimeProgress`) touches every linked title without anyone asking, so
whatever it does wrong it does to the whole library. Seen live: a title read to chapter ~300 of 963 ended up "read in full"
and every title moved to Reading. Three rules came out of it, each with a test in
`tests/unit/frontend-anilist-sync-safety.test.js`:

1. **Writing a progress never writes a status** for a title that already has an entry on AniList
   (`_anilistWriteProgressByMediaId(..., { newEntry })`): a `status: CURRENT` in the mutation moved Planning, Paused, Dropped
   and Completed titles to Reading. Only a title with no entry yet is created as CURRENT. The status is what the person set, on
   AniList or in the tracker window.
2. **The automatic sync copies numbers up, never down.** A higher number on AniList is not written into the library: AniList can
   hold a wrong value (an old sync, an edit by hand) and copying it down marks every chapter up to it as read. Bringing AniList
   in is the Import (`anilistImportLibrary`) and the tracker window, both started by the person. (The anime sync still catches an
   episode count up from AniList, a decision of its own: an episode count is small and was asked for.)
3. **A chapter number is not a count.** `highestReadChapter` is a chapter number (a title can list 963 chapters and number them
   differently); `_repairMangaChapterProgressIfNeeded` used it as "how many chapters to mark". How many were read is how many
   are marked.
4. **An unattended sync never sends what the library merely HAS; it sends what was READ now.** The start-up sync used to compare
   `highestReadChapter` of every linked manga with AniList's number and write the higher one. That number can be wrong (the
   library had "Kingdom" at 916), so within a minute of opening the app it wrote 916 over the 343 the person had just put back by
   hand: pushing from wrong data spreads the mistake the other way, exactly like copying down. Now `_reconcileAniListProgress`
   sends only the chapter it is given (the one open in the reader, or the one marked as read), never `highestReadChapter`, and the
   start-up sync only sends again what could NOT be sent (`scrollscape_al_pending_push`, kept by `_alPendingKeep` when a push
   fails, dropped when it goes through). Tests: `frontend-anilist-sync-safety.test.js`, `frontend-anilist-finalize.test.js`.
   (The anime sync has not been changed: an episode count comes from watching, there is no "mark everything" that inflates it.)
   The same goes for the tracker window: its "Chapter Progress" shows AniList's own number for a title that has an entry
   (`_trackerProgressPrefill`), not the higher of that and the number this browser kept, because "Save to AniList" writes the field as it
   stands. A browser with a mistaken 348 offered it over the 162 on AniList.

### A bulk write to the person's own account is a preview, then a confirmation

Changing many titles on the person's AniList (or any account that is theirs, not the app's) has no bulk undo, so it is never
one click. `public/modules/anilist-status-restore.js` is the model: the decision (`planAniListStatusRestore`) is a pure function
made from one read of the list, shown in full as a preview that writes nothing; only the changes the preview found are offered
for applying, behind a confirmation that says there is no undo; it writes only what it announced (the status: never the
progress, never adding or deleting a title); it paces its requests (`ANILIST_RESTORE_GAP_MS`) and stops at the first rate
limit saying how far it got, because a new preview finds what is left. What each title HAS is saved first in
`store.anilistRestoreUndo` (`server/modules/anilist/restore-journal.js`; if that cannot be saved, nothing is written) and "Undo the
last reset" puts back only the titles that still have the status the reset gave them, so a change made by hand since is never undone. Anything left alone is counted and named, not
guessed (`tests/unit/frontend-anilist-status-restore.test.js`).

### The covers of the library are kept on the server, and the library alone decides which

A cover is an address on the source's image host, and those hosts change their rules (one refuses a browser's User-Agent, others refuse their own
address as Referer, others want the site's), so a page that asks each host straight for each cover goes blank for whatever the host refused.
`server/modules/covers/service.js` keeps a copy of the cover of every favourite in `data/covers/` and the page draws that
(`normalizeImageUrl` swaps the address for `/api/library-cover/<file>` once the server's map is loaded; nothing changes before that or when it cannot be
read). One idea, a reconcile of what the library needs against what is on disk: fetch what is missing, delete what no title needs (that is how a
changed cover replaces the old and how a title that leaves the library takes its cover). Rules that must not be broken: it never trusts what it
fetches (an image type, 64 B to 32 MB, kept as sent and never recompressed, written to a temporary name and renamed); only a name that is in the index is served; a failure keeps the
old state and is retried after a few hours, never in a loop; nothing is deleted when the store cannot say what the library is; titles kept on this
computer (`local`) and titles outside the library (search, history) get no copy; the fetch goes through the image proxy, so a host's own rules live in ONE
place, `server/config/image-hosts.js` (a host is added there only after a real request showed it). The library page also loads the covers of its grid itself, top down and a few at a time (the cards are `loading="lazy"`, which on a big library means
blank cards for a while), and shows the progress as a ring under the floating column (`ui-library-cover-progress.js`): it appears only after a moment (a library in
the cache never shows it), a failed cover counts as done, a newer draw of the library replaces the run in progress, and it is placed under the column, above it, or
beside it when the window leaves no room. The home page has the same ring for its rows (an observer on `#discoverMangaContent` and `#discoverAnimeContent`, a pause after the
last row is drawn; a cover swapped into a card that was already there does not restart the count), in the bottom right corner because there is no column to sit under; it is never shown
while another view is in use. A cover that is NOT in the library is still asked of its host, except the hosts a browser cannot load from
directly (`browserBlockedHosts` in the same file, kept equal in `utils.js`, tested): those go through `/api/proxy-image`. Every place that draws a manga cover goes through `normalizeImageUrl` (the cover picker, the cover scan, the migration, search and updates did not, and the
choices they showed were broken), and `utils.js` has a safety net for any page that does not: a failed `<img>` of such a host is asked once more through the
proxy (capture-phase `error` listener, stopped before the image's own `onerror` hides it). System Health cannot see this: it measures
what the SERVER can fetch, not what a page's `<img>` can. The page and the server must agree on the key of a
cover (`coverUrlKey`, tested). Tests: `library-covers.test.js`, `frontend-library-covers.test.js`, `proxy-image-host-rules.test.js`.

### The web cover search asks a browser first, and gives it the time it was measured to need

"Search Brave Images" in the cover picker is a scrape of a page that is rendered by script, so it asks FlareSolverr first and a plain request second. Measured on a real
FlareSolverr (2026-11-01): the page takes about 12 s with a cold browser and 7 s with a warm one (every search gets a browser of its own), and the site answers 429 to
the plain request. `CALLER_PATIENCE.coverTryMs` is therefore 24 s (it was 8 s, and every search gave up just before the page arrived), and `coverTotalMs` (27 s,
inside the 30 s `/api` allows) is what the plain fallback may still use. The 429 cooldown belongs to the PLAIN request only: it used to be checked before the browser,
so one refused plain request made every search fail for five minutes. An empty list and a refused search are different answers and the picker says which. An install
with no FlareSolverr fails the browser step at once (nothing listens) and goes straight to the plain request. Tests: `cover-search-patience.test.js`.

**One request per search; "load more" is a slice.** One Brave images page already holds about 200 results (measured), and every request opens a browser: a few
searches in a row make Brave answer with its "Verifying you're not a bot" page, which holds no results and used to read as "nothing found" (so "load more" kept
"finding nothing"). The whole list is therefore cached under the query (the SafeSearch flag is part of the key) and a page is a slice of it, so "load more" makes no
request. The bot-check page is recognised (`isBraveBotCheck`), answered as limited (`rateLimited`) and puts the host on `blockedUntil` for 10 minutes, for the browser
and the plain request alike. When testing by hand, do not make rapid Brave searches: that is what trips the check.

**The pause is a guess that grows, and it is remembered.** Brave does not say how long a flagged client stays flagged (it varies), so the pause is NOT a promise: the picker shows a countdown to when the app will ask again (`retryInMs`, a duration and not a time of day, so a server and a page whose clocks differ do not matter), and the text says the wait grows if Brave still refuses. First pause 10 min, doubled for each check that comes back right after a pause (`_noteBotCheck`), at most 2 h, reset by a good search or by 6 h of quiet. `{ until, strikes }` is kept in `data/cache/cover-search-state.json` (a restart used to wipe the pause and the app went straight back to Brave, which is how the check was kept alive). The list of each search is kept 24 h in `data/cache/cover-search.json` (`createTtlDiskCache`, at most 60 lists: `maxEntries`), is served even during a pause, and a search for the same title is not repeated. Real searches go through `_braveTurn`, one at a time, `limits.coverSearchSpacingMs` (8 s) apart: the gap is only 8 s because it counts inside the 30 s the API allows (the browser is given what is left of its 24 s). `configure({ cacheDir, searchSpacingMs })` is wired in `server.js`; without it the module works in memory with no gap (the tests). Tests: `cover-search-patience.test.js`, `ttl-disk-cache.test.js`, `frontend-cover-picker-resolution.test.js`.

**The picker shows the size of what it offers.** Nothing in the app compresses or blurs a cover (no server-side re-encoding, no CSS filter): a soft image is a small
source image. Each choice reads `naturalWidth×naturalHeight` from the loaded image, and one under `COVER_PICKER_MIN_SIZE` (460×726, AniList's "large" cover: measured on a library cover that looks sharp, drawn at about 255 px wide; 1080p is not needed) is marked and, in the web search
only, left out while "Only large images" is on (default on, remembered in `localStorage`). The covers of the sources and AniList are never filtered: they are what they are.
Tests: `frontend-cover-picker-resolution.test.js`.

### The library's Tags filter (it replaced the Categories side button)

The side column's **Tags** button (`#btnLibraryTags`, `ui-library-tags.js`) opens a panel of every tag of the library: the genres a title carries (through
`_getEnrichedGenres`, which also falls back to the history, because most favourites are stored with `genres: []`) plus the person's own `mangaTags`. A tag
is compared lowercased and trimmed, counted once per title, and spelled the way most titles spell it. **Match all** is the default (a title needs every picked
tag), **Match any** is remembered in localStorage; the pick itself is kept in the page only. The panel counts only the titles the library could show (a hidden
source or a title hidden by Hide NSFW adds no tags to the list) and draws the library again on close, and only if the pick changed. The filter is one more line
of the `favs` filter chain in `renderLibrary` and of the local-manga filter. Managing the categories (the old button's job) is the gear
`#btnManageCategories` beside the category filter, which kept the id and so the handler. The anime library has the same button and gear (`#btnAnimeLibraryTags`,
`#btnManageAnimeCategories`) and the same panel (`_showTagFilterPanel`, one for both): an anime favorite carries its `genres` and its own `tags` (from `animeTags`,
keyed by `idMal`), the anime pick is a separate set (`animeTagFilter`) and the match mode is shared. The pick is applied by `_animeApplyLibraryFilters`, and a
failed push of an episode to AniList now says so once (the episode stays recorded, so a failing push is not a toast and a request on every progress tick).
Tests: `frontend-library-tags.test.js`.

### A library served from a CDN: its "latest" is what that CDN has, and its worker is the same version

`public/index.html` pins a few frontend libraries to a version in their CDN address (`PINNED_CDN_LIBS` in `dependency-health.js`). Two rules, both learnt the hard way:
- **"Latest" is what the CDN that serves it has, not what npm has.** cdnjs lags npm (pdf.js 6.5.438 was on npm and a 404 on cdnjs), and the in-app Update writes the
  version it reported into `index.html`: an npm-only version would pin an address that does not exist and the library would not load. A library served from cdnjs
  declares `cdnjsName` and is checked against `api.cdnjs.com` (`fetchLatestCdnLibVersion`, used by the health row and by the Update button alike); the others (jsDelivr
  serves npm as it is) are checked against npm.
- **pdf.js's worker must be EXACTLY the library's version.** It refuses a document otherwise (`The API version "x" does not match the Worker version "y"`), and the PDF
  reader swallowed that error, so no PDF opened after the library was bumped in `index.html` and the worker URL in `ui-pdf-reader.js` was not (10 Oct to 6 Nov 2026).
  The worker URL is built from `pdfjsLib.version`: there is only one place to bump. A second copy of a version in another file is how this happens again.
Tests: `pdf-reader-worker-version.test.js`.

### The webtoon reader remembers the image at the top of the view

A webtoon chapter is one long scroll, so its "page" is the image at the top of the view. It used to store 0 whatever the scroll (116 saved places on the
author's install, 6 above 0), and a chapter opened from the chapter list always began at the top, which also wrote 0 over the saved place. Now each image
carries its own number (`data-idx`, the index in `pages`, which survives an image without a source), the scroll is looked at once per frame and written only
when the image changes (`_bindWebtoonProgress`, `webtoonPageAtTop` in `reader-position.js`), and opening the chapter scrolls back to the saved image once the
images above it have a size (`_restoreWebtoonPosition`). Nothing is written while that restore runs, and the person scrolling by hand ends it: the first draw
must never store the top of the chapter over the place that was saved. A chapter opened from the list resumes only if it is the one the manga was left in and
it was not finished (`chapterStartPage`); incognito never resumes. Checked live in a page with the real module and 30 fake images (the draw stores the
opening place, a hand scroll is tracked, a reopen at 12 lands on image 12). Tests: `reader-position.test.js`.

### Syncing one manga, in either direction, is a window the person drives

Reading in another app (Komikku, the AniList site) changes AniList and not this library, and the automatic sync never pulls (rule 2 above). The way to
bring a single manga in line is **Library → right-click → "Sync progress with AniList"** (`public/modules/anilist-progress-sync.js`): it shows AniList's
number and the number worked out here side by side and offers the two ways, with exactly what each would do (how many chapters, up or DOWN). Rules:
the number here is the highest chapter NUMBER among the chapters really read that the source lists now (never `highestReadChapter`); the person
chooses the direction every time and nothing is applied by default; changes here are made only after the server kept a copy of its files
(`/api/progress/safety-copy`); raising here uses the Tracker's own `_syncTrackerProgressToLocal` and lowering uses `planAniListProgressLowering`, so the
preview and the result cannot disagree; writing to AniList writes the progress only, never the status (a title with no entry is created as Reading).
The decision is the pure `planProgressSync`. Tests: `frontend-anilist-progress-sync.test.js`.
Marking a chapter read by hand also pushes the progress up (`_syncProgressForManuallyReadChapter`), and that push used to fail in silence: the tracker kept the
old number and nothing said why. `anilistSyncProgress` now returns what happened and the manual mark shows a toast for a failure (kept and sent again at the
next start) or a title it could not find, and one when AniList really was raised; an off auto-sync or a missing login stays quiet, it is a choice
(`frontend-manual-mark-anilist-feedback.test.js`).

### "You might also like" is AniList's recommendations first, the genre row only as the fallback

`ui-similar-anilist.js` fills the row under a manga's page from AniList (`Media.recommendations`, sorted by the readers' votes): by the AniList id when it is known (the
library's link `_alGetLink`, or the hint left by the card that opened the page, `similarAlRememberHint`), else by NAME, kept three days in the browser (`scrollscape_similar_anilist_v2`, bounded).
**A name is not an identity:** AniList's search ranks by text, so for a short or common name its first answer is often another title (the recommendations of a horror manhwa were
shown under a boxing manga called "RRR"). So the name path is two requests: the candidates (`Page(media(search:))`, 8 of them with every name and synonym, the year and the popularity), then
the recommendations of the one that `anilistMatchPick` (ui-anilist-match.js) judges to be the same title: any of its names alike enough (the app's own `_titleSimilarity`, threshold 0.7, with full-width
letters folded and a parenthesis compared apart) to any name the page has (title and alternative title), a known year within one of the page's, the author as a SOFT signal (the same one raises a candidate, a different one lowers it, words in either order, one of several), and, between equally alike names,
the more popular title ("Real" is a famous manga and a dozen doujinshi). With no clear match there is NO AniList row, and the page keeps the genre row. The same rule serves every
title: nothing is corrected one title at a time. **Every place that has a name and needs an AniList id goes through `ui-anilist-match.js`** (`anilistMediaIdForManga`: the library's link, then the hint, then the
checked match): the link of the cover on a manga's page (a search for "Sugar" used to open "SUG*R" of 2025: with no clear title it opens AniList's own search), the link that decides
where a manga's reading progress is written (`_resolveAniListMediaIdForManga`; a wrong link sent the progress to someone else's entry and stayed there, so a link is written ONLY for a clear
match), `anilistSearchMedia`, and the recommendations row. Never take the first answer of AniList's text search. Tests: `frontend-anilist-match.test.js`. Nothing about a source is asked until the
person clicks a card: the click goes to `_resolveAndOpenAuthorTitle` (ui-genre-author-navigation.js), the same "find it in my sources" the author search uses, with the
AniList id first so a title the library already owns opens that copy. The filters run when the row is DRAWN, not when the answer is kept (Hide NSFW: the adult flag and the
adult genres; the blacklist; the titles the library has and the title itself are not offered), so a change of setting needs no new request. Fewer than four left, no AniList
entry, an error or no answer in 8 seconds returns false and `loadSimilarManga` (ui-search.js) builds the old genre row. One listener on the row (the auto-scroll clones
cards, and a clone keeps no handler). Everything from AniList is read as plain values (manga only, an https cover or none) and set as text. Tests: `frontend-similar-anilist.test.js`.

### The edition without sources is the same code, named by edition.json

`server/config/edition.js` names the edition: `edition.json` at the root of the app (the build tool writes it into the folder it packages; the repository's own says `standard`) or
`SCROLLSCAPE_EDITION` (the environment wins, for trying it out). **An unknown name is the standard edition**, so a typo or a hostile value can never loosen anything. The `sourceless`
edition changes exactly four things: the catalog's default repository is OFF until the person pastes its address (`settings.catalogDefaultOff` is tri-state: true removed, false
put back, nothing chosen means the edition's default, so "put back" must be kept as `false`); the content the catalog may offer is the edition's own (`catalogWarnings`; with Hide NSFW on by
default nothing adult is listed until the person turns it off); Hide NSFW is ON for a person who never set it (the page reads `hideNsfwDefault` from `/edition.js`, a script
served before `state.js`; a saved setting is never overridden); and there is no Suwayomi engine. A page with no source installed shows a notice with what to do
(`ui-empty-sources.js`). `tools/build-light.js --edition sourceless` is the one place that accepts an EMPTY allow-list and the one that writes `edition.json`; `package.json` bundles it.
**Adding a repository takes the BIGGEST list of the forms of its address, not the first that reads**: the biggest repository of its kind answers `index.min.json` with two entries that tell an
old app to update and keeps the real list in `index.json` (found by trying the real flow in a throwaway copy). Tests: `edition.test.js`, `frontend-empty-sources.test.js`,
`build-light.test.js`, `source-catalog-repos.test.js`.

### The recommended row learns what was LIKED from the AniList statistics, and falls back to the library count

A count of the genres in the library says what was read, and for a big library it saturates (every genre has "a lot", so any shared genre earned the full 45 points).
`ui-taste-profile.js` reads `Viewer.statistics.manga` (count, meanScore, standardDeviation and the genres with count and meanScore) with the account's own token, through the
same `/api/anilist` proxy, and turns it into `affinity = sqrt(count / largest count) * (1 + 0.5 * relative score)`, divided by the best one (0..1; the relative score is the genre's
mean against the account's, in standard deviations, within -1.5..1.5). A genre with fewer than three titles is noise, one with no scores is neutral, and one with at least five
titles rated clearly below the person's own average is "disliked": it takes up to 30 points off a candidate and is never asked of the sources. `getHomepageRecommendationScore`
(ui-discover.js) tries `tasteScoreForManga` first and keeps the count rule as the fallback when no genre of the candidate is known; `loadRecommendations` (ui-calendar.js)
asks the sources for `tasteTopGenres` (the liked ones, never a blacklisted or, with Hide NSFW, adult genre) and labels them with the mean score. The answer is kept twelve hours per
account (`scrollscape_al_taste_v1`); a failed attempt is not repeated for ten minutes, an older answer beats none, and 5 seconds is the most it holds the row. No account, no token
and no answer all mean "built from the library, as before". Tests: `frontend-taste-profile.test.js`.

### Bringing a number DOWN here from AniList is its own, deliberate tool

The automatic sync never copies a higher or LOWER number from AniList into the library, and the Import only adds: a wrong
progress here (an old sync marked every chapter of a manga as read) therefore stays wrong after AniList is corrected by hand.
`public/modules/anilist-progress-restore.js` is the way down, with the same shape as the status tool (a pure plan, a preview that
writes nothing, a confirmation) plus what a local write needs: the person TICKS which titles to lower; only a title with MORE read
here than on AniList is a candidate (ahead is the Import's, a 0 on AniList is "not filled in", never "read nothing"); chapters are
only ever UNMARKED, never marked; "beyond" is decided by the chapter NUMBER, not by a count (chapters here are counted, AniList's
progress is a number: a source with a chapter 0, a 5.5 and bonus chapters has more chapters than its last number, and counting
would unmark chapters really read; the first preview, comparing counts, offered 35 titles of which most were that), so a small gap
is listed apart and unticked, and a title with nothing numbered beyond AniList's is left alone; a chapter is "beyond" only if it can be placed in the source's list (a source that changed its
ids is an error, not "everything is beyond"); nothing is written until `POST /api/progress/safety-copy` says the server kept a copy
of its files; one failing title does not stop the others. The server only raises `highest`, so lowering it is "forget, then set"
in two requests (`progressSyncLowerManga` in `progress-sync.js`, server first, then the browser, so an unreachable server changes
nothing). Tests: `frontend-anilist-progress-restore.test.js`, `progress-sync.test.js`, `progress-safety-copy.test.js`.

### What was read and watched is kept per day and per title, from the start

A year-in-review needs "of what, and when", and a history that was not kept cannot be rebuilt: `readingSessions` keeps only the last
200 sessions and `dailyChapterCounts` has a number per day without saying which manga. `store.analytics.ledger`
(`server/modules/analytics/ledger.js`) is the uncapped answer: `manga[day][mangaId] = { c: chapters, m: minutes, s: sessions }`,
the same for `anime[day][idMal]` (`e` episodes), and each title kept once in `titles`. It is fed by `recordSession` and
`recordAnimeSession` on the SAME day key as the heatmap and the streak (so the numbers agree), it is seeded once from the sessions
that survived the cap when a store without one is loaded (never counted twice: a ledger that is well formed is left as it is, also
when it comes with a restored backup), values are clamped, and days beyond ~4 years are dropped. A new thing that records reading
activity must go through those two functions, or it is missing from the review. The same manga on two sources has two ids: anything
that ranks titles has to merge them (by title), not count the ids.

Most of what is read is not in the library, so there is no favorite to take a cover, author or genres from: a manga session also
sends `sourceId`, `cover`, `author`, `genres` and `nsfw` (the reader's own `isNsfwManga`), kept in `ledger.meta.manga` (each field
only if it has the right shape; a cover is an address of the image proxy or an http(s) one, never a script). The numbers of a
period are one pure function, `server/modules/analytics/wrapped.js` (`computeWrapped`, served by
`GET /api/analytics/wrapped?period=week|month|year|all&year=&top=&hideNsfw=1&excludeGenres=&excludeTitles=`). Its rules:
titles merged by a normalised title; `coverage.partial` is true when the period starts before `ledger.since` (the screen must say
"detailed since ...", never pass a partial top as the whole year); what is hidden (adult titles, adult tags, titles the person
excluded) is left out of EVERY total, not only of the lists, and the count of what was hidden is returned; a title whose adult
status is not known is `nsfw: null` and is NOT hidden by `hideNsfw` (the page has to offer to hide titles by hand); a day on
which 20 or more reading statuses changed is an import and is never counted as "finished that day"; streaks, active days and the
best day come from `dailyChapterCounts`, which goes back further than the titles. Tests: `analytics-ledger.test.js`,
`analytics-wrapped.test.js`.

The page that draws it is the **Wrapped** tab of Analytics (`public/modules/ui-analytics-wrapped.js`, `css-modules/analytics-wrapped.css`;
the existing Analytics content moved into an Overview panel, `#analyticsOverview`, next to `#analyticsWrapped`). The markup is built
from a plain object by pure functions (`_wrappedHtml`, `_wToolbarHtml`) so it is tested without a browser; every title, author and
genre goes through `escapeHtml`, there are no inline handlers (one delegated listener reads `data-wrapped-action`), and the choices
(period, year, hide adult titles, the titles hidden by hand) live in this browser's localStorage and are sent to the server with every
request, so a hidden title is out of every number. Every string has an English and a Portuguese entry (a test checks it).
`frontend-analytics-wrapped.test.js`.

**The share cards** (`public/modules/wrapped-share-cards.js`, the window in `ui-wrapped-share-modal.js`) are drawn on a canvas in the
browser from the SAME object the page shows, which the server already filtered: what was hidden cannot reach the card, and a period
that reaches before the detailed history says so on the card ("Titles counted since ..."). The card is split into a model
(`wrappedCardModel`: plain data, what is on it) and the drawing (`drawWrappedCard`), so both are tested with a context that records
what it is asked to draw (`frontend-wrapped-share-cards.test.js`): nothing may be drawn past the bottom or the sides, whatever the
titles; when a layout changes, the test says how much room is left. Rules that must not be broken: every cover goes through this
app's own `/api/proxy-image` (a cover from another site taints the canvas and the browser refuses to export it), `wrappedCardCoverSrc`
accepts only a path of this app or an http(s) address to proxy (never `//host`, `javascript:`, `data:`), and copying an image is only
offered where the browser can do it (a secure context: https or localhost; the server reached by its network address is not one).

**The AniList view** (a switch "This app | AniList" on the same tab, with Manga / Anime) is `public/modules/wrapped-anilist.js` (the list is
read from AniList, then `wrappedAniListBuild` works everything out as a pure function) and `ui-analytics-wrapped-anilist.js` (the page).
It is **read-only**: nothing is ever written to AniList from the Wrapped, and the token stays in the browser (the list goes through this
app's `/api/anilist` proxy, so AniList's rate limit stays one budget; chunks are read one after the other). What AniList does not know is
not faked: it has no day for a chapter, so there is no streak, weekday, "last 7 / 30 days" or reading time for manga, and **a year means
the titles FINISHED that year** (the page says so). Rules that must not be broken: the list is kept in memory only (never on disk) for a few
minutes, and "Refresh" reads it again; a title on several custom lists is counted once (by media id); hiding adult titles and hiding a title
are applied BEFORE every figure, the people behind the titles included (AniList names them by the ids of their titles, so the ranking is
re-made on what is shown); the people statistics are optional (AniList may not have calculated them for an account: the card is left out,
the page still works); the share card is made from the same object (`w.card`, already in words) and `wrappedCardModel` only draws it.
A name opens the title only when it is in the library (a manga by the AniList id saved on the favourite or linked by the Tracker, an anime by its
MyAnimeList or AniList id; one that is not is plain text), through the same openers as the library (`loadMangaDetails` after switching to the
title's source, `_animeGoToDetails`); a manga author opens the app's own author search. The click is looked up in the index that was drawn, never in
an id read from the page. A chart shows its number above each bar (a value on hover is not a way to read a chart); the blocks of the page have the
same 1rem between them as the cards of the grid.
A new field means checking the query against AniList's schema first (an introspection call is enough). Tests:
`frontend-wrapped-anilist.test.js`.

### The reading progress lives on the server, and travels as changes, never as state

Chapters read, where each manga was left (chapter and page), the highest chapter number and the flagged chapters used to be in
localStorage only: per address, per browser, outside every backup. They are in `data/reading-progress.json` now
(`server/modules/progress/service.js`, routes in `routes/progress.js`; its own file because the store is rewritten whole and a
change every few seconds over a network share must not rewrite it). `public/modules/progress-sync.js` keeps the browser's copy in
step. The rules that keep two browsers from damaging each other:

1. **Changes, not state.** The browser sends ops (`readAdd`, `readRemove`, `last`, ...), each idempotent, worked out as a diff
   against what the server already has (`_psDiff`). Sending a whole picture would let a browser with an old one overwrite another's
   reading. Where a manga was left is decided by time (`at`, ms: the newer wins), the highest chapter number only goes up.
2. **Every change passes through `saveSettings()`** (and `_persistLocalReadingState()` in anilist.js, which writes the same keys by
   itself). New code that changes the progress must end there, or it is never sent (`tests/unit/progress-wiring.test.js`). A new
   field of the progress is added in three places: the snapshot/diff/apply in progress-sync.js, `sanitizeOps` and `applyOps` in
   the service, and `get()`.
3. **Keys are opaque.** `"<mangaId>:<chapterId>"` is never split: both ids can contain `:` and `/`.
4. **What was not sent waits** in localStorage (`scrollscapeProgressQueue`), survives closing the tab, and is retried; a request the
   server refuses for good (400/413) is dropped so it cannot block the rest.
5. **Meeting the server.** An empty server takes the browser's progress (marked `legacy`: those chapters are read before this
   existed and are recorded with an unknown day, never as read today). A server that has progress, met for the first time by this
   browser, only receives what it lacks. Afterwards the server is the truth, plus what this browser had not sent yet. A server
   with under 70% of a browser that has at least 100 chapters changes nothing: both sides stop until the person chooses in
   Settings (a restored old file or a lost one is more likely than a library really emptied elsewhere). Replacing one side with the
   other is only ever a button, and a restored backup file replaces the server's copy on the next start.
6. **The day each chapter was first read** is kept on the server (epoch day, UTC) for a year-in-review; it is never sent to browsers.

Tests: `progress-service.test.js` (the ops), `progress-sync.test.js` (two browsers over HTTP against the real routes),
`progress-wiring.test.js` (the one-line connections).

### Copies of the store are automatic, and the store is never touched by them

`data/store.json` holds the whole library, so the only copy used to be the one a person remembered to export. Now
`server/modules/store/auto-backup.js` copies it by itself to `data/backups/`: a daily copy (`store-YYYY-MM-DD.json`, the newest 7
days plus the newest of each of 4 earlier weeks) and a safety copy (`store-before-<what>-YYYYMMDD-HHMMSS.json`, the newest 5) taken
just before a route replaces much of the library at once. Rules that keep it harmless: it copies the file as it is on disk (it is
written by renaming a finished temporary file, so it is always whole) and never writes to `store.json`; it copies only a file that
parses as a JSON object, so a damaged store never replaces a good copy; a safety copy is taken at most once per 10 minutes for one
reason, so a flow that calls a route many times keeps the copy of the state from BEFORE it started; it deletes only files with
names it made. A route that is about to replace much of the library calls `safetySnapshot('<what>')` first (today: restoring a
backup file, the AniList import and resolve, migrating sources). Restoring is manual on purpose. The copies hold the whole store,
secrets included, like `store.json` itself: they are not for sharing (the export in Settings strips them).

### A bulk write to the person's own account is a preview, then a confirmation

The System Health image-quality check compares the first page of its pinned chapter with the last healthy one, and a
smaller file is only a loss of quality if the picture itself got worse. A site that cuts the same chapter into other
pieces (seen live on DemonicScans: tall strips, then 83 slices of 800x1365) changes the bytes of page 1 by 4x with the
same compression. So the width and height of the page are stored in `store.imageHealthBaseline` next to its bytes
(`pageWidth`, `pageHeight`), and a drop is let through only when the page is as wide as before (a narrower one was
downscaled, which is the very regression the check exists for) **and** at least as dense in bytes per pixel as the ratio
allows (a harder-compressed one is still reported). A baseline from before sizes were stored, or an image whose size
cannot be read, is never a reason to hide a drop: the first moves to the new page once, the second is reported as before
(`tests/unit/image-quality-recut-page.test.js`). Compare what the reader would see, not the length of the file.

### Error codes for recurring issues

Whenever a known error occurs, the application should generate a stable internal error code.

This allows the same problem to be identified quickly in the future.

Example:

```txt
ERR-001 -> MangaDex search returned no results for a valid query.
ERR-002 -> MangaDex response format changed or expected field is missing.
ERR-003 -> AniList GraphQL request failed.
ERR-004 -> MangaUpdates search failed or returned invalid data.
ERR-005 -> Source module did not return valid chapters.
ERR-006 -> Cover image proxy rejected or failed to fetch image.
ERR-007 -> Local file import failed.
ERR-008 -> Store read/write failed.
ERR-009 -> Theme preset failed to load or save.
ERR-010 -> External API rate limit reached.
```

The exact codes may change, but they must remain centralized and documented.

### Error code registry

Create and maintain a centralized error code registry.

Recommended structure:

```txt
server/modules/errors/
  error-codes.js
server/modules/
  error-logger.js
```

Example:

```js
// server/modules/errors/error-codes.js
'use strict';

module.exports = {
  MANGADEX_NO_RESULTS: 'ERR-001',
  MANGADEX_INVALID_RESPONSE: 'ERR-002',
  ANILIST_REQUEST_FAILED: 'ERR-003',
  MANGAUPDATES_REQUEST_FAILED: 'ERR-004',
  SOURCE_INVALID_CHAPTERS: 'ERR-005',
  COVER_PROXY_FAILED: 'ERR-006',
  LOCAL_IMPORT_FAILED: 'ERR-007',
  STORE_PERSISTENCE_FAILED: 'ERR-008',
  THEME_PRESET_FAILED: 'ERR-009',
  EXTERNAL_RATE_LIMITED: 'ERR-010'
};
```

The real file spells its codes `ERROR-0xx`; the `ERR-0xx` above is the illustration. Registered today:
`ERROR-001`..`010` generic, `011`..`013` MangaKatana, `014`..`016` AllManga.To, `017` ComicVine, `018`
League of Comic Geeks, and `019` / `020` the FlareSolverr session pool (`SOLVER_SESSION_FAILED`: sessions
kept failing, so one-off browsers are used for a while; `SOLVER_HOST_BLOCKED`: Cloudflare blocked the
solver for a site), and `021` (`SOURCE_IMPORT_FAILED`: the source import tool refused a file or rolled an
install back). The next free code is `ERROR-022`. A new code is added to the registry in the same
change that records it, and is mentioned in the README when a user can meet it.

### Error log file

When a recurring or known error happens, the application should add an entry to a log file.

Recommended file:

```txt
data/error-log.json
```

The log should help identify the same error in the future.

Recommended entry format:

```json
{
  "code": "ERR-001",
  "area": "mangadex",
  "message": "MangaDex search returned no results for a valid query.",
  "details": {
    "query": "one piece",
    "endpoint": "/manga",
    "status": 200
  },
  "firstSeenAt": "2026-05-16T10:20:00.000Z",
  "lastSeenAt": "2026-05-16T10:25:00.000Z",
  "count": 3
}
```

Rules:

- If the same error happens again, update `lastSeenAt` and increment `count`.
- Do not duplicate the same error unnecessarily.
- Do not log sensitive data.
- Do not log tokens, cookies, authentication headers, or private user data.
- Keep the error log readable and bounded.
- If the file grows too much, rotate it or keep only the most recent entries.

### Error logger helper

This is implemented in `server/modules/error-logger.js` (`recordError()` /
`clearErrors()`), configured with the real writable data dir at startup via
`configure(dataDir)` (matters for the packaged `.exe`, where `__dirname`
sits inside a read-only snapshot). It keeps the log bounded to the most
recent 50 entries and serializes writes through a promise-chain mutex so
concurrent errors never race on the same file.

```js
// server/modules/error-logger.js (shape, not full source)
async function recordError({ code, area, message, details }) { /* ... */ }
async function clearErrors() { /* ... */ }
module.exports = { configure, recordError, clearErrors };
```

Most routes never call this directly — `server/modules/http/async-handler.js`
(the shared `createAsyncHandler()` wrapper used by nearly every route) already
calls `recordError()` on any thrown/rejected error, deriving `area` from the
route's `:id` param or URL. Call `recordError()` directly only for a
non-throwing "soft" failure worth tracking (see the ComicVine example below).
The same wrapper writes the failed request's body to the console to help debugging, with every field whose name looks like a credential (`password`, `token`,
`secret`, `cookie`, `api key`, `authorization`) replaced by `[redacted]` (`redactBody`), so a login or a settings save that fails never leaves a secret in the
log; a new credential field needs a name that matches, or the pattern widened (`tests/unit/http-async-handler.test.js`).

### Example: ComicVine request failure

```js
// server/modules/comicvine/service.js
const { recordError } = require('../error-logger');
const { COMICVINE_REQUEST_FAILED } = require('../errors/error-codes');

try {
  // ...request ComicVine...
} catch (err) {
  await recordError({
    code: COMICVINE_REQUEST_FAILED,
    area: 'comicvine',
    message: err.message,
    details: { title: cleanTitle }
  });
}
```

### API integration checklist

Before finishing changes related to an external API, confirm:

```txt
[ ] The API response is validated.
[ ] Missing fields are handled safely.
[ ] Empty responses are handled.
[ ] Rate limits are handled.
[ ] Timeouts are configured.
[ ] The error has a stable error code when relevant.
[ ] Recurring errors are added to data/error-log.json.
[ ] Sensitive data is not logged.
[ ] The frontend/debug panel can show the error code.
[ ] The README or relevant documentation was updated if behavior changed.
```


---

## 33. Documentation Sync Is Part of the Commit, Not a Follow-Up

Every commit pushed to GitHub must ship its documentation update in the same commit — not
as a separate "docs" commit later, not "if there's time." This applies to every commit,
not only ones flagged as a "new feature" (rule 31 covers the ordering for those
specifically; this rule covers the commit workflow itself, for any change).

Before staging a commit, check whether it changed:

```txt
[ ] A source's real capabilities (filters, sort, fields it returns) -> manual-tecnico/04-sistema-de-sources.md
[ ] Anime-specific behavior (title handling, streaming providers, calendar, sync) -> manual-tecnico/15-sistema-de-anime.md
[ ] A user-visible feature list (new source, new page, new integration) -> README.md's feature table
[ ] A architectural decision, a bug whose root cause is worth remembering, or a "looked broken but wasn't" investigation -> the relevant manual-tecnico chapter (see 00-indice.md for which one)
[ ] A new setting, environment variable or error code (a store.settings key, a *_DISABLED switch, an ERROR-0xx) -> README.md (Configuration, and the feature's own section) and the manual-tecnico chapter that owns the feature
[ ] How the FlareSolverr pool, System Health or the Disabled sources list judges something (a limit, a text, a rollback path, a skipped source) -> README.md's Browser Sessions and System Health sections, and manual-tecnico/18-sessoes-do-flaresolverr.md
[ ] The source contract, or a route/tool that puts source code on disk (import, install, update) -> section 10 ("Importing a source file"), section 11, README's "Adding a Source" and Security rows, manual-tecnico/04 and 11
[ ] A rule in this file itself (a new pattern adopted, an old one retired) -> the relevant section above
```

If none of these apply — a pure refactor with no behavior change, a typo fix — say so
explicitly rather than skipping the check silently. The habit this rule exists to prevent:
finishing real work, verifying it live, and then treating "write it down" as an optional
epilogue that quietly never happens once the next request arrives.

---

## Final Note

These guidelines should evolve with the project.

Whenever a new technical pattern, folder structure, configuration system, or security rule is adopted, this file should be updated.

ScrollScape should keep the same core logic: organized, modular, secure code, without unnecessary hardcoded values, and easy to maintain.
