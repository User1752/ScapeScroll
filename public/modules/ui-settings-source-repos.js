// ============================================================================
// SETTINGS > SOURCES / SUWAYOMI — THE REPOSITORIES OF THE SOURCE CATALOG
// ============================================================================
// Inside the catalog block (ui-settings-source-catalog.js): the repositories the person added besides the default one, a box to add one (the address of a
// repository or of its index.min.json) and a Remove button for each. The server judges the address and checks that a list of extensions is really there
// (POST /api/sources/catalog/repos); this file only shows what it answers, as text. Nothing is asked until the person opens the repositories, and the
// catalog is read again whenever the list changes.
//
// Loaded before ui-settings-source-catalog-html.js (which puts the markup in) and ui-settings-source-catalog.js (which mounts it). The catalog works without it.

const SOURCE_REPOS_ENDPOINT = '/api/sources/catalog/repos';
const SOURCE_REPOS_MAX = 20;
const SOURCE_REPOS_URL_RE = /^https:\/\/[A-Za-z0-9.-]{3,200}\/[A-Za-z0-9._~%@/+-]{0,250}$/;

const sourceReposClean = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);
const sourceReposInt = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0);

/** The answer of the repositories route as plain capped values. Nothing here is HTML. */
function sourceReposNormalize(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const repos = (Array.isArray(a.repos) ? a.repos : []).slice(0, SOURCE_REPOS_MAX).map((item) => {
    const r = item && typeof item === 'object' ? item : {};
    return {
      url: typeof r.url === 'string' && SOURCE_REPOS_URL_RE.test(r.url) ? r.url : '',
      name: sourceReposClean(r.name, 60),
      ok: r.ok === true ? true : (r.ok === false ? false : null),
      count: sourceReposInt(r.count),
      isDefault: r.default === true,
    };
  }).filter((r) => r.url);
  return { max: sourceReposInt(a.max) || 8, repos };
}

/** The rows of the list: one per repository, the default one first (the server says which it is); each can be removed. */
function buildSourceReposRowsHtml(state) {
  if (!state.repos.length) return `<li class="source-catalog-repo-none setting-description">${sourceImportText('settings.sourceRepos.none')}</li>`;
  const rows = state.repos.map((repo) => {
    const status = repo.ok === false ? sourceImportText('settings.sourceRepos.unreadable') : escapeHtml(sourceImportFill(t('settings.sourceRepos.count'), { count: repo.count }));
    const tag = repo.isDefault ? ` <span class="source-catalog-repo-tag">${sourceImportText('settings.sourceRepos.default')}</span>` : '';
    return `<li class="source-catalog-repo${repo.isDefault ? ' is-default' : ''}">
      <span class="source-catalog-repo-name">${escapeHtml(repo.name || repo.url)}${tag}</span>
      <code class="source-catalog-host">${escapeHtml(repo.url.replace(/^https:\/\//, ''))}</code>
      <span class="source-catalog-repo-status${repo.ok === false ? ' is-bad' : ''}">${status}</span>
      <button type="button" class="btn secondary" data-repo-remove="${escapeHtml(repo.url)}" aria-label="${escapeHtml(sourceImportFill(t('settings.sourceRepos.removeLabel'), { name: repo.name || repo.url }))}">${sourceImportText('settings.sourceRepos.remove')}</button>
    </li>`;
  });
  return rows.join('');
}

/** The block: a <details> that asks nothing until it is opened. Every id starts with the prefix of the catalog block it is in. */
function buildSourceReposBlockHtml(prefix) {
  const p = typeof prefix === 'string' && /^[A-Za-z][A-Za-z0-9]{2,30}$/.test(prefix) ? prefix : 'sourceCatalog';
  return `<details class="source-catalog-repos" id="${p}Repos">
    <summary>${sourceImportText('settings.sourceRepos.title')}</summary>
    <p class="setting-description">${sourceImportText('settings.sourceRepos.description')}</p>
    <ul class="source-import-list source-catalog-repo-list" id="${p}RepoList"></ul>
    <div class="source-catalog-repo-add">
      <input type="url" id="${p}RepoInput" class="input" maxlength="300" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('settings.sourceRepos.placeholder'))}" aria-label="${escapeHtml(t('settings.sourceRepos.placeholder'))}">
      <button type="button" class="btn secondary" id="${p}RepoAdd">${sourceImportText('settings.sourceRepos.add')}</button>
    </div>
    <p class="setting-description" id="${p}RepoMsg" role="status" aria-live="polite"></p>
  </details>`;
}

/**
 * Wires the block that buildSourceReposBlockHtml wrote.
 * @param {HTMLElement} root
 * @param {string} prefix
 * @param {{ request: (path: string, opts?: object) => Promise<any>, onChanged?: () => void }} deps
 */
function mountSourceRepos(root, prefix, { request, onChanged = () => {} }) {
  const at = (suffix) => root.querySelector(`#${prefix}${suffix}`);
  const block = at('Repos');
  const list = at('RepoList');
  const input = at('RepoInput');
  const addButton = at('RepoAdd');
  const message = at('RepoMsg');
  if (!block || !list || !input || !addButton || !message) return null;
  let loaded = false;
  let busy = false;
  const say = (text, bad = false) => { message.textContent = text; message.classList.toggle('source-import-error', bad); };
  const failure = (err) => say(typeof sourceImportErrorText === 'function' ? sourceImportErrorText(err) : String((err && err.message) || err).slice(0, 200), true);

  async function load() {
    try {
      list.innerHTML = buildSourceReposRowsHtml(sourceReposNormalize(await request(SOURCE_REPOS_ENDPOINT)));
    } catch (err) {
      failure(err);
    }
  }

  async function guarded(work) {
    if (busy) return;
    busy = true;
    addButton.disabled = true;
    try { await work(); } catch (err) { failure(err); } finally { busy = false; addButton.disabled = false; }
  }

  const add = () => guarded(async () => {
    const text = String(input.value || '').trim();
    if (!text) return;
    say(t('settings.sourceRepos.adding'));
    const answer = await request(SOURCE_REPOS_ENDPOINT, { method: 'POST', body: JSON.stringify({ input: text.slice(0, 400) }) });
    input.value = '';
    await load();
    say(sourceImportFill(t('settings.sourceRepos.added'), { count: sourceReposInt(answer && answer.repo && answer.repo.count) }));
    onChanged();
  });

  const remove = (url) => guarded(async () => {
    await request(SOURCE_REPOS_ENDPOINT, { method: 'DELETE', body: JSON.stringify({ url: String(url).slice(0, 400) }) });
    await load();
    say(t('settings.sourceRepos.removed'));
    onChanged();
  });

  block.addEventListener('toggle', () => { if (block.open && !loaded) { loaded = true; load(); } });
  addButton.addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') { e.preventDefault(); add(); } });
  list.addEventListener('click', (e) => {
    const button = e.target && e.target.closest ? e.target.closest('[data-repo-remove]') : null;
    if (button && !button.disabled) remove(button.getAttribute('data-repo-remove'));
  });
  return { load, add, remove };
}

window.sourceReposNormalize = sourceReposNormalize;
window.buildSourceReposRowsHtml = buildSourceReposRowsHtml;
window.buildSourceReposBlockHtml = buildSourceReposBlockHtml;
window.mountSourceRepos = mountSourceRepos;
