// ============================================================================
// SETTINGS > SOURCES / SUWAYOMI — THE SOURCE CATALOG BLOCK: MARKUP
// ============================================================================
// The markup of the catalog block (ui-settings-source-catalog.js): the block, a card per site, the language box and the status line. Every
// value that reaches it has been through sourceCatalogNormalize, and text is only ever put in through escapeHtml. Loaded before
// ui-settings-source-catalog.js, whose constants it reads when it is called, not when it loads.

// ── Markup ────────────────────────────────────────────────────────────────

/** One row: the site, what it is, and the Add button (only for a site the app can write a source for that is not added yet). */
function buildSourceCatalogRowHtml(row) {
  const badge = (kind, key) => `<span class="source-catalog-badge is-${kind}">${sourceImportText(key)}</span>`;
  const badges = [];
  if (row.warning === 'NSFW') badges.push(badge('adult', 'settings.sourceCatalog.warnNsfw'));
  else if (row.warning === 'MIXED') badges.push(badge('mixed', 'settings.sourceCatalog.warnMixed'));
  if (row.cloudflare === 'yes') badges.push(badge('cloudflare', 'settings.sourceCatalog.cloudflare'));
  if (row.repo) badges.push(`<span class="source-catalog-badge is-repo">${escapeHtml(row.repo)}</span>`);
  if (row.via === 'engine') badges.push(badge('via-engine', 'settings.sourceCatalog.viaEngine'));
  else if (row.engine !== 'ready' && row.via !== 'check') badges.push(badge('engine', 'settings.sourceCatalog.engine.' + row.engine));
  if (row.installed) badges.push(badge('installed', 'settings.sourceCatalog.installed'));
  if (row.blocked) badges.push(badge('blocked', 'settings.sourceCatalog.blocked'));
  const canAdd = !!row.via && !row.installed && !row.blocked;
  // A site written from a template is added with "Add"; one that runs in the person's Suwayomi-Server has its own button, since it installs a program there.
  // A site of a repository the person added is added with "Check this site": the generator looks at the site itself and says whether a source can be written.
  const viaEngine = row.via === 'engine';
  const viaCheck = row.via === 'check';
  const attr = viaEngine ? 'data-catalog-engine' : 'data-catalog-add';
  const label = viaEngine ? 'settings.sourceCatalog.addEngineLabel' : (viaCheck ? 'settings.sourceCatalog.checkLabel' : 'settings.sourceCatalog.addLabel');
  // The logo sits over a coloured initial: a logo that does not load (offline, a changed address) leaves the initial, and no script is needed for that.
  const initial = escapeHtml((Array.from(row.name.trim())[0] || '?').toUpperCase());
  const image = row.icon ? `<img class="source-catalog-logo-img" src="${escapeHtml(row.icon)}" alt="" width="56" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  // A site that is added and whose source is known gets Uninstall instead of a disabled Add.
  const button = row.installedId
    ? `<button type="button" class="btn secondary source-catalog-uninstall" data-catalog-uninstall="${escapeHtml(row.installedId)}" aria-label="${escapeHtml(sourceImportFill(t('settings.sourceCatalog.uninstallLabel'), { name: row.name }))}">${sourceImportText('settings.sourceCatalog.uninstall')}</button>`
    : `<button type="button" class="btn secondary" ${attr}="${escapeHtml(row.key)}" title="${escapeHtml(t(viaEngine ? 'settings.sourceCatalog.addEngineHint' : (viaCheck ? 'settings.sourceCatalog.checkHint' : 'settings.sourceCatalog.addHint')))}" aria-label="${escapeHtml(sourceImportFill(t(label), { name: row.name }))}"${canAdd ? '' : ' disabled'}>${sourceImportText(viaEngine ? 'settings.sourceCatalog.addEngine' : (viaCheck ? 'settings.sourceCatalog.check' : 'settings.sourceCatalog.add'))}</button>`;
  return `<li class="source-catalog-card${row.installed ? ' is-installed' : ''}">
    <span class="source-catalog-logo" aria-hidden="true"><span class="source-catalog-initial">${initial}</span>${image}</span>
    <span class="source-catalog-body">
      <span class="source-catalog-name">${escapeHtml(row.name)}</span>
      ${!row.blocked && /^[a-z0-9][a-z0-9.-]{1,118}[a-z0-9]$/i.test(row.host) ? `<a class="source-catalog-host source-catalog-link" href="https://${escapeHtml(row.host)}/" target="_blank" rel="noopener noreferrer">${escapeHtml(row.host)}</a>` : `<code class="source-catalog-host">${escapeHtml(row.host)}</code>`}
      <span class="source-catalog-badges">${badges.join(' ')}</span>
    </span>
    ${button}
  </li>`;
}

const buildSourceCatalogRowsHtml = (rows) => rows.map(buildSourceCatalogRowHtml).join('');

/** The language box: the languages the repository has, and the one in use even when the list has none of it. */
function buildSourceCatalogLanguageOptionsHtml(languages, current) {
  const list = languages.some((item) => item.lang.toLowerCase() === String(current).toLowerCase())
    ? languages
    : [{ lang: current, count: 0 }, ...languages];
  return list.map((item) => `<option value="${escapeHtml(item.lang)}"${item.lang.toLowerCase() === String(current).toLowerCase() ? ' selected' : ''}>${item.lang.toLowerCase() === 'all' ? sourceImportText('settings.sourceCatalog.langMulti') : escapeHtml(item.lang)} (${item.count})</option>`).join('');
}

/** The sentence under the filters: what the list is doing, or how much it holds. */
function sourceCatalogStatusText(page) {
  if (page.pending.paused) return t('settings.sourceCatalog.paused');
  if (page.pending.themes > 0) return sourceImportFill(t('settings.sourceCatalog.checking'), { count: page.pending.themes });
  const base = page.total ? sourceImportFill(t('settings.sourceCatalog.count'), { total: page.total }) : t('settings.sourceCatalog.empty');
  return page.stale ? `${base} ${t('settings.sourceCatalog.stale')}` : base;
}

/**
 * The block, added to the card above "add from a link" and, with its own prefix, in the Advanced tab. Every id starts with the prefix (an id is
 * unique in the page), so two blocks never share an element; both write through the same controller of the import card.
 */
function buildSourceCatalogHtml(prefix = SOURCE_CATALOG_PREFIX, collapsible = true) {
  const p = typeof prefix === 'string' && SOURCE_CATALOG_PREFIX_RE.test(prefix) ? prefix : SOURCE_CATALOG_PREFIX;
  // A block that closes (a <details>) asks nothing until it is opened. One that does not (the Advanced tab, where the catalog is the point of the card)
  // is a plain block, and the tab asks for the list when it is opened.
  const tag = collapsible ? 'details' : 'div';
  const title = collapsible
    ? `<summary class="source-import-subtitle">${sourceImportText('settings.sourceCatalog.title')}</summary>`
    : `<div class="source-import-subtitle">${sourceImportText('settings.sourceCatalog.title')}</div>`;
  return `<${tag} class="setting-group source-catalog-block" id="${p}Block">
    ${title}
    <p class="setting-description">${sourceImportText(typeof window !== 'undefined' && window.SCROLLSCAPE_EDITION && window.SCROLLSCAPE_EDITION.sourceless === true ? 'settings.sourceCatalog.descriptionNoEngine' : 'settings.sourceCatalog.description')}</p>
    ${typeof buildSourceReposBlockHtml === 'function' ? buildSourceReposBlockHtml(p) : ''}
    <p class="setting-description" id="${p}FilterNote" hidden>${sourceImportText('settings.sourceCatalog.hideNsfwNote')}</p>
    <div class="source-catalog-filters">
      <label for="${p}Lang">${sourceImportText('settings.sourceCatalog.langLabel')}</label>
      <select id="${p}Lang" class="input source-catalog-lang"><option value="en" selected>en</option></select>
      <input type="search" id="${p}Query" class="input source-catalog-query" maxlength="80" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('settings.sourceCatalog.searchPlaceholder'))}" aria-label="${escapeHtml(t('settings.sourceCatalog.searchPlaceholder'))}">
    </div>
    <label class="source-catalog-check"><input type="checkbox" id="${p}Native" checked> <span>${sourceImportText('settings.sourceCatalog.onlyReady')}</span></label>
    <label class="source-catalog-check"><input type="checkbox" id="${p}HideCf"> <span>${sourceImportText('settings.sourceCatalog.hideCloudflare')}</span></label>
    <label class="source-catalog-check"><input type="checkbox" id="${p}HideAdult"> <span>${sourceImportText('settings.sourceCatalog.hideAdult')}</span></label>
    <label class="source-catalog-check"><input type="checkbox" id="${p}HideInstalled"> <span>${sourceImportText('settings.sourceCatalog.hideInstalled')}</span></label>
    <label class="source-catalog-check"><input type="checkbox" id="${p}OnlyInstalled"> <span>${sourceImportText('settings.sourceCatalog.onlyInstalled')}</span></label>
    <p class="setting-description">${sourceImportText('settings.sourceCatalog.cloudflareHint')}</p>
    <p class="setting-description" id="${p}EngineHint" hidden>${sourceImportText('settings.sourceCatalog.engineHint')}</p>
    <p class="setting-description source-import-error" id="${p}Error" role="alert"></p>
    <p class="setting-description source-catalog-status" id="${p}Status" aria-live="polite"></p>
    <ul class="source-import-list source-catalog-list" id="${p}List"></ul>
    <button type="button" class="btn secondary" id="${p}More" hidden>${sourceImportText('settings.sourceCatalog.more')}</button>
  </${tag}>`;
}
