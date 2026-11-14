// ============================================================================
// SETTINGS > ADVANCED > "IMPORT A SOURCE" CARD — MARKUP AND REPORT CLEANING
// ============================================================================
// The pure half of the card (the other half, ui-settings-source-import.js, holds
// the check/install logic and the DOM glue and is loaded after this file): what
// the server answered, cleaned into something the markup can trust, and the
// markup itself. Nothing here touches the DOM or the network, and every value
// that ends up in HTML goes through escapeHtml().
//
// What the card is for: adds a source the person wrote (or generated)
// themselves, in two steps they see. "Check" sends the text to the server,
// which reads it WITHOUT running it and answers with a report (id, size,
// fingerprint, what it requires, which hosts it names, risky calls, id
// clashes); "Install" then sends back only that fingerprint, so what is
// installed is exactly the text that was checked. See
// server/modules/source-import/service.js and GUIDELINES.md, section 10.

// Mirror of limits.sourceImportMaxBytes in server/config/limits.js (the browser cannot require it);
// tests/unit/frontend-source-import-markup.test.js fails when the two drift apart. The server stays the judge: this
// only spares a request that would be refused anyway.
const SOURCE_IMPORT_MAX_BYTES = 512 * 1024;
// A server sentence is shown as it is; this only keeps a runaway one from stretching the card.
const SOURCE_IMPORT_ERROR_MAX_CHARS = 300;
const SOURCE_IMPORT_LIST_MAX = 60;
const SOURCE_IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_IMPORT_SHA256_RE = /^[a-f0-9]{64}$/;  const SOURCE_IMPORT_SHA_SHORT = 12;
// A risk id is a short lower-case word with dashes (RISK_IDS in server/modules/source-import/static-report.js).
const SOURCE_IMPORT_RISK_ID_RE = /^[a-z][a-z-]{0,39}$/;

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Replaces {name} placeholders; a placeholder with no value is left as written. */
function sourceImportFill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

function sourceImportText(key) {
  return escapeHtml(t(key));
}

/** Bytes of `text` as UTF-8 (what the server counts); a lone surrogate counts as the 3 bytes of U+FFFD. */
function sourceImportByteLength(text) {
  const value = String(text);
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

const sourceImportCleanText = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);
const sourceImportCleanInt = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0);

function sourceImportCleanList(value, mapItem) {
  return (Array.isArray(value) ? value : []).slice(0, SOURCE_IMPORT_LIST_MAX).map(mapItem);
}

const SOURCE_IMPORT_FILTER_KEYS = ['orderBy', 'publicationStatus', 'contentRating', 'format', 'genres'];

/** The declaration (meta.ui) part of a check, as plain capped values. Nothing here is HTML. */
function sourceImportNormalizeDeclaration(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const ui = d.ui && typeof d.ui === 'object' ? d.ui : {};
  const filters = ui.filters && typeof ui.filters === 'object' ? ui.filters : {};
  return {
    present: d.present === true,
    readable: d.readable === true,
    filters: SOURCE_IMPORT_FILTER_KEYS.filter((key) => typeof filters[key] === 'boolean').map((key) => ({ key, on: filters[key] })),
    orderBy: sourceImportCleanList(ui.orderBy, (o) => sourceImportCleanText(o && o.label, 60)),
    genres: sourceImportCleanList(ui.genres, (name) => sourceImportCleanText(name, 60)),
    // The real number: the list above is capped for display, so counting it would under-report a long genre list.
    genresCount: Array.isArray(ui.genres) ? Math.min(ui.genres.length, 1000) : 0,
    nsfwCount: Array.isArray(ui.nsfwGenres) ? Math.min(ui.nsfwGenres.length, 1000) : 0,
    adultOnly: ui.adultOnly === true,
    nativeDates: ui.nativeDates === true, customTags: ui.customTags === true,
    // The only part of a declaration that changes network requests, so the person approving the install sees it.
    referers: sourceImportCleanList(d.imageReferers, (rule) => ({ host: sourceImportCleanText(rule && rule.host, 100), referer: sourceImportCleanText(rule && rule.referer, 100) })),
    problems: sourceImportCleanList(d.problems, (p) => ({
      level: p && p.level === 'error' ? 'error' : 'warning',
      message: sourceImportCleanText(p && p.message, SOURCE_IMPORT_ERROR_MAX_CHARS),
    })),
  };
}

// The reports this file made. The declaration of a clean report has another shape than the server's, so cleaning one again would
// empty it: the check cleans the answer once and the markup cleans what it is given, and a clean report is passed through.
const SOURCE_IMPORT_CLEAN_REPORTS = new WeakSet();

/**
 * What the server answered, as a plain object the markup can trust: every string is a string and cut, every number
 * a whole number, every list a capped list, and a field that is not there is empty. Nothing here is HTML.
 */
function sourceImportNormalizeReport(raw) {
  if (SOURCE_IMPORT_CLEAN_REPORTS.has(raw)) return raw;
  const r = raw && typeof raw === 'object' ? raw : {};
  const existing = r.existing && typeof r.existing === 'object' ? r.existing : null;
  const sha = sourceImportCleanText(r.sha256, 64);
  const clean = {
    kind: r.kind === 'anime' ? 'anime' : 'manga',
    id: sourceImportCleanText(r.id, 80),
    idSource: ['given', 'detected', 'none'].includes(r.idSource) ? r.idSource : 'none',
    detectedId: sourceImportCleanText(r.detectedId, 80),
    sha256: SOURCE_IMPORT_SHA256_RE.test(sha) ? sha : '',
    bytes: sourceImportCleanInt(r.bytes),
    lines: sourceImportCleanInt(r.lines),
    requires: sourceImportCleanList(r.requires, (item) => ({
      specifier: sourceImportCleanText(item && item.specifier, 200),
      kind: ['relative', 'npm', 'builtin'].includes(item && item.kind) ? item.kind : 'npm',
      line: sourceImportCleanInt(item && item.line),
    })),
    dynamicRequires: sourceImportCleanInt(r.dynamicRequires),
    // How many distinct requires and hosts the server found beyond the ones it listed (0 when it cut nothing).
    requiresMore: sourceImportCleanInt(r.requiresMore),
    hostsMore: sourceImportCleanInt(r.hostsMore),
    hosts: sourceImportCleanList(r.hosts, (host) => sourceImportCleanText(host, 200)),
    risks: sourceImportCleanList(r.risks, (risk) => {
      // Judged whole, not cut first: a long id is not a shorter id.
      const id = risk && typeof risk.id === 'string' ? risk.id : '';
      return {
        id: SOURCE_IMPORT_RISK_ID_RE.test(id) ? id : '',
        text: sourceImportCleanText(risk && risk.text, 200),
        line: sourceImportCleanInt(risk && risk.line),
      };
    }),
    declaration: sourceImportNormalizeDeclaration(r.declaration),
    existing: existing ? {
      installedVia: sourceImportCleanText(existing.installedVia, 40),
      name: sourceImportCleanText(existing.name, 200),
      version: sourceImportCleanText(existing.version, 80),
    } : null,
    replace: r.replace === true,
    blockers: sourceImportCleanList(r.blockers, (text) => sourceImportCleanText(text, SOURCE_IMPORT_ERROR_MAX_CHARS)),
    // The fingerprint is what an install asks for: without a well-formed one nothing can be installed.
    canInstall: r.canInstall === true && SOURCE_IMPORT_SHA256_RE.test(sha) && !!r.id,
  };
  SOURCE_IMPORT_CLEAN_REPORTS.add(clean);
  return clean;
}

/**
 * The text to show for a failed request. A refusal from another device is a translated sentence; the server's own
 * refusal is shown as it is; what a browser or the wrapper makes up (a network TypeError, "HTTP 500") is replaced by
 * a translated sentence. `err.name` and not instanceof: the error may come from another realm.
 */
function sourceImportErrorText(err) {
  if (err && err.data && err.data.code === 'LOCAL_ONLY') return t('settings.sourceImport.localOnly');
  const message = err && typeof err.message === 'string' ? err.message.trim() : '';
  const madeUp = !message || err.name === 'TypeError' || /^HTTP \d{3}$/.test(message);
  return madeUp ? t('settings.sourceImport.requestFailed') : message.slice(0, SOURCE_IMPORT_ERROR_MAX_CHARS);
}

/** The reasons a refusal lists next to its message (the contract errors), as clean short strings. */
function sourceImportErrorDetails(err) {
  const list = err && err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
  return list.slice(0, SOURCE_IMPORT_LIST_MAX).map((text) => sourceImportCleanText(text, SOURCE_IMPORT_ERROR_MAX_CHARS));
}

/** The imported sources in the store: [{ id, name, version }], names and versions as text. */
function sourceImportImportedEntries(installedSources) {
  const all = installedSources && typeof installedSources === 'object' ? Object.values(installedSources) : [];
  return all
    .filter((entry) => entry && entry.installedVia === 'imported' && SOURCE_IMPORT_ID_RE.test(String(entry.id)))
    .map((entry) => {
      // A result counts only for the file it was made on: a replaced file is a new entry with none, and one with another
      // fingerprint is stale. Both fingerprints must exist: two empty ones are not a match. (It says what was true when the
      // file was installed; a hand edit of data/sources is not noticed.)
      const result = entry.liveTest && typeof entry.liveTest === 'object' ? entry.liveTest : null;
      const sha = String(entry.sha256 || '');
      const current = !!result && !!sha && String(result.sha256 || '') === sha;
      return {
        id: String(entry.id),
        name: sourceImportCleanText(entry.name || entry.id, 200),
        version: sourceImportCleanText(entry.version, 80),
        tested: current ? { verified: result.verified === true, at: sourceImportCleanText(result.at, 40), fail: sourceImportCleanInt(result.fail), warn: sourceImportCleanInt(result.warn) } : null,
      };
    });
}

const SOURCE_IMPORT_TEST_STATUSES = ['pass', 'fail', 'warn', 'skip'];
const SOURCE_IMPORT_TEST_ICONS = { pass: '✓', fail: '✗', warn: '!', skip: '–' };

/** The answer of a live test, as plain capped values. Nothing here is HTML. */
function sourceImportNormalizeTest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const counts = r.counts && typeof r.counts === 'object' ? r.counts : {};
  return {
    verified: r.verified === true,
    depth: r.depth === 'full' ? 'full' : 'basic',
    aborted: sourceImportCleanText(r.aborted, 200),
    calls: sourceImportCleanInt(r.calls),
    images: sourceImportCleanInt(r.images),
    seconds: Math.round(sourceImportCleanInt(r.durationMs) / 100) / 10,
    counts: { pass: sourceImportCleanInt(counts.pass), fail: sourceImportCleanInt(counts.fail), warn: sourceImportCleanInt(counts.warn), skip: sourceImportCleanInt(counts.skip) },
    checks: sourceImportCleanList(r.checks, (check) => {
      const id = check && typeof check.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(check.id) ? check.id : '';
      return {
        id,
        status: SOURCE_IMPORT_TEST_STATUSES.includes(check && check.status) ? check.status : 'skip',
        detail: sourceImportCleanText(check && check.detail, SOURCE_IMPORT_ERROR_MAX_CHARS),
      };
    }),
  };
}

/** What a live test found, check by check. */
function buildSourceImportTestHtml(rawResult) {
  const r = sourceImportNormalizeTest(rawResult);
  const summary = sourceImportFill(t('settings.sourceImport.testSummary'), { ...r.counts, calls: r.calls, images: r.images, seconds: r.seconds });
  const rows = r.checks.map((check) => {
    const title = check.id ? tr('settings.sourceImport.test.check.' + check.id, check.id) : '';
    const label = t('settings.sourceImport.testStatus.' + check.status);
    return `<li class="source-import-test-check is-${check.status}"><span class="source-import-test-icon" role="img" aria-label="${escapeHtml(label)}">${SOURCE_IMPORT_TEST_ICONS[check.status]}</span> <strong>${escapeHtml(title)}</strong>${check.detail ? ` <span class="setting-description">${escapeHtml(check.detail)}</span>` : ''}</li>`;
  });
  return `<p class="source-import-test-summary is-${r.verified ? 'pass' : 'fail'}"><strong>${sourceImportText(r.verified ? 'settings.sourceImport.testVerified' : 'settings.sourceImport.testNotVerified')}</strong> <span>${escapeHtml(summary)}</span></p>${
    r.aborted ? `<p class="setting-description">${escapeHtml(sourceImportFill(t('settings.sourceImport.testStopped'), { reason: r.aborted }))}</p>` : ''}${
    rows.length ? `<ul class="source-import-test-list">${rows.join('')}</ul>` : ''}`;
}

/**
 * What each test showed, kept because the imported list is rebuilt (and its result boxes emptied) whenever the state is read.
 * A result is kept with the fingerprint of the file it was about and is not shown again under a file replaced since.
 * @param {{ resultBox: (id: string) => ({ innerHTML: string } | null), currentSha: (id: string) => string }} deps
 */
function createSourceImportTestStore({ resultBox, currentSha }) {
  const kept = new Map();
  return {
    running(sourceId) {
      const box = resultBox(sourceId);
      kept.delete(sourceId);
      if (box) box.innerHTML = `<p class="setting-description">${sourceImportText('settings.sourceImport.testRunning')}</p>`;
    },
    failed(sourceId) {
      const box = resultBox(sourceId);
      const old = kept.get(sourceId);
      if (box) box.innerHTML = old ? old.html : '';
    },
    show(sourceId, result) {
      kept.set(sourceId, { html: buildSourceImportTestHtml(result), sha: currentSha(sourceId) });
      const box = resultBox(sourceId);
      if (box) box.innerHTML = kept.get(sourceId).html;
    },
    reapply() {
      for (const [sourceId, old] of [...kept]) {
        const sha = currentSha(sourceId);
        if (!sha || sha !== old.sha) { kept.delete(sourceId); continue; }
        const box = resultBox(sourceId);
        if (box) box.innerHTML = old.html;
      }
    },
  };
}

/** The small tag after an imported source's name: verified, not verified, or not tested. */
function sourceImportTestedTagHtml(entry) {
  if (!entry.tested) return `<span class="source-import-tested is-none">${sourceImportText('settings.sourceImport.testNone')}</span>`;
  const when = entry.tested.at && Number.isFinite(Date.parse(entry.tested.at)) ? new Date(entry.tested.at).toLocaleString() : '';
  const title = when ? ` title="${escapeHtml(sourceImportFill(t('settings.sourceImport.testWhen'), { when }))}"` : '';
  return `<span class="source-import-tested is-${entry.tested.verified ? 'pass' : 'fail'}"${title}>${sourceImportText(entry.tested.verified ? 'settings.sourceImport.testVerified' : 'settings.sourceImport.testNotVerified')}</span>`;
}

/** A risk as a sentence: the translation for its id, or the server's own text when the id is unknown or missing. */
function sourceImportRiskText(risk) {
  return risk.id ? tr('settings.sourceImport.risk.' + risk.id, risk.text) : risk.text;
}

// ── Markup ────────────────────────────────────────────────────────────────

function sourceImportListHtml(items) {
  return `<ul class="source-import-list">${items.join('')}</ul>`;
}

function sourceImportSectionHtml(titleKey, bodyHtml) {
  return `<div class="source-import-section"><p class="source-import-subtitle">${sourceImportText(titleKey)}</p>${bodyHtml}</div>`;
}

/** The line under a list the server cut short: a list that looks complete must not hide what it left out. */
function sourceImportMoreHtml(key, count) {
  return count ? `<p class="setting-description source-import-more">${escapeHtml(sourceImportFill(t(key), { count }))}</p>` : '';
}

function sourceImportLineHtml(line) {
  return line ? ` <span class="muted">${escapeHtml(sourceImportFill(t('settings.sourceImport.line'), { line }))}</span>` : '';
}

function sourceImportFactsHtml(report) {
  const idLine = report.id
    ? `<code>${escapeHtml(report.id)}</code>`
    : `<span class="muted">${sourceImportText('settings.sourceImport.noId')}</span>`;
  const shaShort = report.sha256.slice(0, SOURCE_IMPORT_SHA_SHORT);
  return `<dl class="source-import-facts">
    <dt>${sourceImportText('settings.sourceImport.factId')}</dt><dd>${idLine}</dd>
    <dt>${sourceImportText('settings.sourceImport.factSize')}</dt><dd>${escapeHtml(sourceImportFill(t('settings.sourceImport.sizeValue'), { bytes: report.bytes, lines: report.lines }))}</dd>
    <dt>${sourceImportText('settings.sourceImport.factFingerprint')}</dt><dd>${shaShort ? `<code title="${escapeHtml(report.sha256)}">${escapeHtml(shaShort)}…</code>` : '—'}</dd>
  </dl>`;
}

function sourceImportRequiresHtml(report) {
  const items = report.requires.map((item) => `<li><code>${escapeHtml(item.specifier)}</code>
    <span class="source-import-tag">${sourceImportText('settings.sourceImport.kind.' + item.kind)}</span>${sourceImportLineHtml(item.line)}</li>`);
  const dynamic = report.dynamicRequires
    ? `<p class="setting-description">${escapeHtml(sourceImportFill(t('settings.sourceImport.requiresDynamic'), { count: report.dynamicRequires }))}</p>`
    : '';
  const list = items.length ? sourceImportListHtml(items) : `<p class="muted">${sourceImportText('settings.sourceImport.requiresNone')}</p>`;
  return sourceImportSectionHtml('settings.sourceImport.requiresTitle',
    list + sourceImportMoreHtml('settings.sourceImport.requiresMore', report.requiresMore) + dynamic);
}

function sourceImportHostsAndRisksHtml(report) {
  const hosts = report.hosts.map((host) => `<li><code>${escapeHtml(host)}</code></li>`);
  const risks = report.risks.map((risk) => `<li>${escapeHtml(sourceImportRiskText(risk))}${sourceImportLineHtml(risk.line)}</li>`);
  return sourceImportSectionHtml('settings.sourceImport.hostsTitle',
    (hosts.length ? sourceImportListHtml(hosts) : `<p class="muted">${sourceImportText('settings.sourceImport.hostsNone')}</p>`)
    + sourceImportMoreHtml('settings.sourceImport.hostsMore', report.hostsMore))
    + sourceImportSectionHtml('settings.sourceImport.risksTitle',
      (risks.length ? sourceImportListHtml(risks) : `<p class="muted">${sourceImportText('settings.sourceImport.risksNone')}</p>`)
      + `<p class="setting-description">${sourceImportText('settings.sourceImport.risksCaveat')}</p>`);
}

// What the app will do with the source: what it declared in meta.ui, or a plain warning when it declared nothing (its
// filters and genres then look like those of any source, and some of them may do nothing on this site).
function sourceImportDeclarationHtml(report) {
  const d = report.declaration;
  const lines = [];
  if (!d.present) {
    lines.push(`<p class="setting-description source-import-warning">${sourceImportText('settings.sourceImport.declNone')}</p>`);
  } else if (!d.readable) {
    lines.push(`<p class="setting-description">${sourceImportText('settings.sourceImport.declComputed')}</p>`);
  } else {
    const items = [];
    if (d.filters.length) {
      const list = d.filters.map((f) => sourceImportFill(t(f.on ? 'settings.sourceImport.declFilterOn' : 'settings.sourceImport.declFilterOff'), { name: t('settings.sourceImport.declFilterName.' + f.key) })).join(', ');
      items.push(sourceImportFill(t('settings.sourceImport.declFilters'), { list }));
    }
    if (d.orderBy.length) items.push(sourceImportFill(t('settings.sourceImport.declOrderBy'), { list: d.orderBy.join(', ') }));
    if (d.genresCount) {
      items.push(sourceImportFill(t('settings.sourceImport.declGenres'), { count: d.genresCount, sample: d.genres.slice(0, 8).join(', ') }));
      if (d.nsfwCount) items.push(sourceImportFill(t('settings.sourceImport.declNsfw'), { count: d.nsfwCount }));
    }
    if (d.adultOnly) items.push(t('settings.sourceImport.declAdultOnly'));
    for (const [on, key] of [[d.nativeDates, 'settings.sourceImport.declNativeDates'], [d.customTags, 'settings.sourceImport.declCustomTags']]) if (on) items.push(t(key));
    if (d.referers.length) items.push(sourceImportFill(t('settings.sourceImport.declReferers'), { list: d.referers.map((rule) => `${rule.host} → ${rule.referer}`).join(', ') }));
    lines.push(items.length
      ? sourceImportListHtml(items.map((text) => `<li>${escapeHtml(text)}</li>`))
      : `<p class="muted">${sourceImportText('settings.sourceImport.declEmpty')}</p>`);
  }
  if (d.problems.length) {
    lines.push(`<p class="source-import-subtitle">${sourceImportText('settings.sourceImport.declProblems')}</p>${
      sourceImportListHtml(d.problems.map((p) => `<li${p.level === 'error' ? ' class="source-import-blocker"' : ''}>${escapeHtml(p.message)}</li>`))}`);
  }
  return sourceImportSectionHtml('settings.sourceImport.declTitle', lines.join(''));
}

function sourceImportReplaceHtml(report) {
  if (!report.replace) return '';
  const what = report.existing && (report.existing.name || report.existing.version)
    ? sourceImportFill(t('settings.sourceImport.replaceWhat'), { name: report.existing.name || report.id, version: report.existing.version || '?' })
    : '';
  return `<p class="source-import-replace">${sourceImportText('settings.sourceImport.replaceNote')}${what ? ' ' + escapeHtml(what) : ''}</p>`;
}

/** The report of a check. `report` goes through sourceImportNormalizeReport first, so a hostile answer is only text. */
function buildSourceImportReportHtml(rawReport) {
  const report = sourceImportNormalizeReport(rawReport);
  const parts = [];
  if (report.blockers.length) {
    parts.push(`<div class="source-import-blockers"><p class="source-import-subtitle">${sourceImportText('settings.sourceImport.blockersTitle')}</p>${
      sourceImportListHtml(report.blockers.map((text) => `<li>${escapeHtml(text)}</li>`))}</div>`);
  }
  parts.push(sourceImportFactsHtml(report));
  if (report.detectedId && report.detectedId !== report.id) {
    parts.push(`<p class="setting-description source-import-detected">${escapeHtml(sourceImportFill(t('settings.sourceImport.detectedHint'), { id: report.detectedId }))}
      <button type="button" class="btn secondary" data-si-action="adopt-id">${sourceImportText('settings.sourceImport.adoptId')}</button></p>`);
  }
  parts.push(sourceImportRequiresHtml(report), sourceImportHostsAndRisksHtml(report), report.kind === 'anime' ? '' : sourceImportDeclarationHtml(report), sourceImportReplaceHtml(report));
  const installKey = report.replace ? 'settings.sourceImport.replaceButton' : 'settings.sourceImport.installButton';
  parts.push(`<div class="source-import-actions">
    <button type="button" class="btn primary" data-si-action="install"${report.canInstall ? '' : ' disabled'}>${sourceImportText(installKey)}</button>
    <button type="button" class="btn secondary" data-si-action="cancel">${sourceImportText('settings.sourceImport.cancelButton')}</button>
  </div>`);
  return parts.join('');
}

/** The list of imported sources, from sourceImportImportedEntries(). */
function buildSourceImportImportedHtml(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return `<p class="muted">${sourceImportText('settings.sourceImport.importedNone')}</p>`;
  return sourceImportListHtml(list.map((entry) => `<li class="source-import-imported-row">
    <span class="toggle-text">${escapeHtml(entry.name)}${entry.version ? ` <span class="setting-description">v${escapeHtml(entry.version)}</span>` : ''} ${sourceImportTestedTagHtml(entry)}</span>
    <span class="source-import-imported-actions">
      <button type="button" class="btn secondary" data-si-action="test" data-depth="basic" data-source-id="${escapeHtml(entry.id)}" title="${escapeHtml(t('settings.sourceImport.testHint'))}">${sourceImportText('settings.sourceImport.testButton')}</button>
      <button type="button" class="btn secondary" data-si-action="test" data-depth="full" data-source-id="${escapeHtml(entry.id)}" title="${escapeHtml(t('settings.sourceImport.testHint'))}">${sourceImportText('settings.sourceImport.testFullButton')}</button>
      <button type="button" class="btn secondary" data-si-action="uninstall" data-source-id="${escapeHtml(entry.id)}">${sourceImportText('settings.sourceImport.uninstallButton')}</button>
    </span>
    <div class="source-import-test-result" data-test-for="${escapeHtml(entry.id)}" aria-live="polite"></div>
  </li>`));
}

/** The inside of the card (its wrapper is made by mountSourceImportCard). */
function buildSourceImportCardHtml(importedEntries) {
  return `
    <p class="settings-section-title" data-i18n="settings.sourceImport.title">${sourceImportText('settings.sourceImport.title')}</p>
    <p class="setting-description" data-i18n="settings.sourceImport.description">${sourceImportText('settings.sourceImport.description')}</p>
    <div class="source-import-notice" role="note">
      <strong data-i18n="settings.sourceImport.noticeTitle">${sourceImportText('settings.sourceImport.noticeTitle')}</strong>
      <span data-i18n="settings.sourceImport.notice">${sourceImportText('settings.sourceImport.notice')}</span>
    </div>
    <div class="setting-group">
      <div class="source-import-file-row">
        <button type="button" class="btn secondary" data-si-action="choose-file" id="sourceImportFileBtn">${sourceImportText('settings.sourceImport.chooseFile')}</button>
        <input type="file" id="sourceImportFile" accept=".js,text/javascript" hidden>
      </div>
      <label for="sourceImportCode">${sourceImportText('settings.sourceImport.codeLabel')}</label>
      <textarea id="sourceImportCode" class="input source-import-code" rows="8" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="sourceImportCodeHint" placeholder="${escapeHtml(t('settings.sourceImport.codePlaceholder'))}"></textarea>
      <p class="setting-description" id="sourceImportCodeHint">${escapeHtml(sourceImportFill(t('settings.sourceImport.codeHint'), { max: Math.round(SOURCE_IMPORT_MAX_BYTES / 1024) }))}</p>
    </div>
    <div class="setting-group">
      <label for="sourceImportId">${sourceImportText('settings.sourceImport.idLabel')}</label>
      <input type="text" id="sourceImportId" class="input source-import-id" maxlength="80" autocomplete="off" spellcheck="false" aria-describedby="sourceImportIdHint" placeholder="${escapeHtml(t('settings.sourceImport.idPlaceholder'))}">
      <p class="setting-description" id="sourceImportIdHint">${sourceImportText('settings.sourceImport.idHint')}</p>
    </div>
    <div class="setting-group">
      <button type="button" class="btn primary" data-si-action="check" id="sourceImportCheckBtn">${sourceImportText('settings.sourceImport.checkButton')}</button>
    </div>
    <p class="setting-description source-import-error" id="sourceImportError" role="alert"></p>
    <div id="sourceImportReport" class="source-import-report" aria-live="polite"></div>
    <div class="setting-group">
      <p class="source-import-subtitle" data-i18n="settings.sourceImport.importedTitle">${sourceImportText('settings.sourceImport.importedTitle')}</p>
      <div id="sourceImportImported">${buildSourceImportImportedHtml(importedEntries)}</div>
    </div>`;
}

window.SOURCE_IMPORT_MAX_BYTES = SOURCE_IMPORT_MAX_BYTES;
window.buildSourceImportCardHtml = buildSourceImportCardHtml;
window.buildSourceImportReportHtml = buildSourceImportReportHtml;
window.buildSourceImportImportedHtml = buildSourceImportImportedHtml;
window.sourceImportNormalizeReport = sourceImportNormalizeReport;
window.sourceImportByteLength = sourceImportByteLength;
window.sourceImportImportedEntries = sourceImportImportedEntries;
window.buildSourceImportTestHtml = buildSourceImportTestHtml;
window.sourceImportNormalizeTest = sourceImportNormalizeTest;
