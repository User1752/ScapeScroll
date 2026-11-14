// ============================================================================
// SETTINGS MODAL — HTML TEMPLATE
// ============================================================================
// Pure function of global state/i18n: builds the settings modal's entire
// innerHTML as a string. No closure over the modal element or any of
// showSettings()'s local variables — every event listener is wired up
// separately, after this string is injected, in ui-settings-modal.js.

// The tabs of Settings, in the order of the sidebar, and the cards each one holds (the builders are in ui-settings-cards-*.js). A card
// that is not there is skipped. Two cards are added after the markup is injected, next to the
// card they belong with: "Protected sites" (ui-settings-solver.js, after the first card of the Network & Anti-Bot tab) and "Import a
// source" (ui-settings-source-import.js, after the Anime Sources card of the Sources tab).
const SETTINGS_TABS = [
  { id: 'tab-reading', label: () => 'Reading', cards: ['settingsCardReadingMode', 'settingsCardChapterBehaviour', 'settingsCardAutoScroll', 'settingsCardReaderAppearance'] },
  { id: 'tab-library', label: () => 'Library', cards: ['settingsCardGridAppearance', 'settingsCardLibraryAppearance', 'settingsCardLibrarySync', 'settingsCardDefaults', 'settingsCardHomePage'] },
  { id: 'tab-anime', label: () => 'Anime', cards: ['settingsCardAnimeLibraryCard', 'settingsCardAnimeLibrarySync'] },
  { id: 'tab-appearance', label: () => t('settings.tabThemeAppearance'), cards: ['settingsCardUiTheme'] },
  { id: 'tab-tracking', label: () => 'Tracking', cards: ['settingsCardAniList'] },
  { id: 'tab-sources', label: () => 'Sources', cards: ['settingsCardSources', 'settingsCardAnimeSources'] },
  { id: 'tab-suwayomi', label: () => 'Suwayomi', cards: ['settingsCardSuwayomiBridge'], wide: true, needsEngine: true },
  { id: 'tab-filters', label: () => 'Filters', cards: ['settingsCardContentFilters', 'settingsCardGenreBlacklist'] },
  { id: 'tab-network', label: () => 'Network & Anti-Bot', cards: ['settingsCardNetworkAntiBot'] },
  { id: 'tab-accounts', label: () => 'Accounts', cards: ['settingsCardDiscordPresence'] },
  { id: 'tab-security', label: () => 'Security', cards: ['settingsCardAccessPassword', 'settingsCardFactoryReset'] },
  { id: 'tab-data', label: () => 'Data & Backup', cards: ['settingsCardBackupRestore', 'settingsCardProgressSync', 'settingsCardOpdsCatalog', 'settingsCardMihonImport', 'settingsCardClearReadingHistory'] },
  { id: 'tab-advanced', label: () => 'Advanced', cards: ['settingsCardSourceCatalog', 'settingsCardCommands'], wide: true },
];

function settingsTabCardsHtml(tab) {
  return tab.cards.map((name) => (typeof globalThis[name] === 'function' ? globalThis[name]() : '')).join('');
}

// The edition without sources has no Suwayomi engine (server/config/edition.js): its tab is not shown, nor anything that is only for it.
const settingsEditionHasEngine = () => !(typeof window !== 'undefined' && window.SCROLLSCAPE_EDITION && window.SCROLLSCAPE_EDITION.sourceless === true);

function buildSettingsModalHtml() {
  const tabs = SETTINGS_TABS.filter((tab) => !tab.needsEngine || settingsEditionHasEngine());
  const nav = tabs.map((tab, i) => `
          <button class="settings-nav-item${i === 0 ? ' active' : ''}" data-tab="${tab.id}">${tab.label()}</button>`).join('');
  const panels = tabs.map((tab, i) => `
          <div class="settings-tab${i === 0 ? ' active' : ''}${tab.wide ? ' settings-tab-wide' : ''}" id="${tab.id}">${settingsTabCardsHtml(tab)}
          </div>`).join('');
  return `
    <div class="settings-content">
      <div class="settings-header">
        <div style="display:flex;align-items:center;gap:12px;flex:1">
          <h2>Settings</h2>
          <span id="settingsAppVersion" class="settings-app-version" title="ScrollScape version"></span>
          <span id="settingsSavedIndicator" style="opacity:0;transition:opacity 0.3s;color:var(--color-success);font-size:0.85em;font-weight:600">✓ Saved</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="text" id="settingsSearchInput" class="input" placeholder="Search settings..." autocomplete="off" style="padding:4px 8px;font-size:0.9em;width:160px">
          <button class="btn secondary" id="closeSettings">&#x2715;</button>
        </div>
      </div>
      <div class="settings-layout">

        <!-- ── Sidebar nav ── -->
        <nav class="settings-nav">${nav}
        </nav>

        <!-- ── Content panels ── -->
        <div class="settings-panel-wrap">
${panels}

        </div><!-- end panel-wrap -->
      </div><!-- end layout -->
    </div><!-- end content -->
  `;
}
