// ============================================================================
// HOME PAGE WITHOUT SOURCES
// ============================================================================
// With no source installed (the edition without sources starts like that, and so does a person who removed them all) the home page has nothing to list, and rows
// that say "No manga found" tell the person nothing about what to do. This puts a notice at the top of the manga home that says what to do: open the source
// catalog (Settings -> Advanced), add a repository and choose the sites, or add a source from a link (Settings -> Sources). It is there only while no source
// is installed and goes away by itself once one is.

const EMPTY_SOURCES_NOTICE_ID = 'noSourcesNotice';
const EMPTY_SOURCES_TABS = Object.freeze({ catalog: 'tab-advanced', link: 'tab-sources' });

/** Whether no source is installed (the sources the app knows, not the ones that are switched off). */
function emptySourcesNone() {
  const installed = typeof state !== 'undefined' && state && state.installedSources ? state.installedSources : null;
  return !!installed && Object.keys(installed).length === 0;
}

function emptySourcesHtml() {
  const text = (key) => escapeHtml(t(key));
  return `
    <h3 class="no-sources-title">${text('home.noSources.title')}</h3>
    <p class="no-sources-text">${text('home.noSources.text')}</p>
    <div class="no-sources-actions">
      <button type="button" class="btn primary" data-no-sources-tab="${EMPTY_SOURCES_TABS.catalog}">${text('home.noSources.catalog')}</button>
      <button type="button" class="btn secondary" data-no-sources-tab="${EMPTY_SOURCES_TABS.link}">${text('home.noSources.link')}</button>
    </div>`;
}

/** Opens Settings on one of the two tabs of the notice. */
function emptySourcesOpenTab(tabId) {
  if (!Object.values(EMPTY_SOURCES_TABS).includes(tabId) || typeof showSettings !== 'function') return;
  showSettings();
  const nav = document.querySelector(`.settings-nav-item[data-tab="${tabId}"]`);
  if (nav && typeof nav.click === 'function') nav.click();
}

/** Puts the notice on the home page, or takes it away: called whenever the sources the app has may have changed. Never throws. */
function renderNoSourcesNotice() {
  try {
    const host = document.getElementById('discoverMangaContent');
    if (!host) return;
    let box = document.getElementById(EMPTY_SOURCES_NOTICE_ID);
    if (!emptySourcesNone()) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('section');
      box.id = EMPTY_SOURCES_NOTICE_ID;
      box.className = 'no-sources-notice';
      box.setAttribute('role', 'status');
      box.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('[data-no-sources-tab]') : null;
        if (button) emptySourcesOpenTab(button.getAttribute('data-no-sources-tab'));
      });
      host.prepend(box);
    }
    box.innerHTML = emptySourcesHtml();
  } catch (_) { /* the home page works without the notice */ }
}

window.emptySourcesNone = emptySourcesNone;
window.emptySourcesHtml = emptySourcesHtml;
window.emptySourcesOpenTab = emptySourcesOpenTab;
window.renderNoSourcesNotice = renderNoSourcesNotice;
