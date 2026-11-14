// ============================================================================
// SETTINGS CARDS — SOURCES (manga and anime sources, Suwayomi)
// ============================================================================

// The inside of the "Disabled sources" list — split out so it can be redrawn on its own (the "Import a source" card
// changes which sources are installed while the modal is open).
function buildDisabledSourcesListHtml() {
  const installed = Object.values(state.installedSources || {});
  if (installed.length === 0) return '<p class="muted" style="margin:0">No sources installed.</p>';
  return installed.map(s => `
                      <label class="toggle-label">
                        <span class="toggle-text">${escapeHtml(s.name || s.id)}</span>
                        <input type="checkbox" class="disabledSourceToggle" data-source-id="${escapeHtml(s.id)}" ${(state.settings.disabledSourceIds || []).includes(s.id) ? "checked" : ""}>
                        <span class="toggle-slider"></span>
                      </label>`).join("");
}

function settingsCardSources() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Manga Sources</p>
              <div class="setting-group">
                <label>Disabled sources</label>
                <p class="setting-description" style="margin:0 0 0.6rem 0" data-i18n="settings.disabledSourcesDesc">${t('settings.disabledSourcesDesc')}</p>
                <div id="disabledSourcesList" style="display:flex;flex-direction:column;gap:0.4rem">
                  ${buildDisabledSourcesListHtml()}
                </div>
              </div>
            </div>
  `;
}

function settingsCardAnimeSources() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Anime Sources</p>
              <div class="setting-group">
                <label>Visible providers</label>
                <p class="setting-description" style="margin:0 0 0.6rem 0">Which servers show up in the watch page's Server list. See the Advanced tab for manga source visibility.</p>
                <div id="animeSetProvidersList" style="display:flex;flex-direction:column;gap:0.4rem">
                  ${(() => {
                    const visible = Array.isArray(state.settings.visibleAnimeProviders) && state.settings.visibleAnimeProviders.length
                      ? state.settings.visibleAnimeProviders
                      : (typeof DEFAULT_VISIBLE_ANIME_PROVIDERS !== 'undefined' ? DEFAULT_VISIBLE_ANIME_PROVIDERS : []);
                    const providers = typeof ANIME_PROVIDERS !== 'undefined' ? ANIME_PROVIDERS : [];
                    return providers.map(p => `
                      <label class="toggle-label" style="margin-bottom:0">
                        <span class="toggle-text">${escapeHtml(p.name)}</span>
                        <input type="checkbox" class="animeSetProviderOption" value="${escapeHtml(p.id)}" ${visible.includes(p.id) ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                      </label>`).join('');
                  })()}
                </div>
              </div>
            </div>
  `;
}

function settingsCardSuwayomiBridge() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Suwayomi Server</p>
              <div class="setting-group">
                <label for="suwayomiUrlInput">Suwayomi Server URL</label>
                <input type="text" id="suwayomiUrlInput" class="input" placeholder="http://localhost:4567" autocomplete="off" spellcheck="false" style="width:100%">
                <p class="setting-description">Your own <a href="https://github.com/Suwayomi/Suwayomi-Server" target="_blank" rel="noopener noreferrer">Suwayomi-Server</a>. The Source catalog (Settings &gt; Advanced) uses it to add the sites that have a scraper of their own: the extension is installed and runs in that server, and ScrollScape only asks it. Leave blank to disable. Only "no auth" and Suwayomi's Basic Auth mode are supported — not Simple Login (cookie) mode.</p>
              </div>
              <div class="setting-group" style="display:flex;gap:0.6rem">
                <div style="flex:1">
                  <label for="suwayomiUsernameInput">Suwayomi Username</label>
                  <input type="text" id="suwayomiUsernameInput" class="input" autocomplete="off" spellcheck="false" style="width:100%">
                </div>
                <div style="flex:1">
                  <label for="suwayomiPasswordInput">Suwayomi Password</label>
                  <input type="password" id="suwayomiPasswordInput" class="input" autocomplete="off" spellcheck="false" style="width:100%">
                </div>
              </div>
              <div class="setting-group">
                <label>On this computer (Windows)</label>
                <!-- ui-settings-suwayomi-local.js draws here: set up, run and remove the Suwayomi-Server of this computer. -->
                <div id="suwayomiLocalSlot"></div>
                <details class="suwayomi-local-script">
                  <summary>Set it up with a script instead</summary>
                  <p class="setting-description" style="margin:0.4rem 0 0.6rem 0"><a href="/api/suwayomi/windows-setup.cmd" download>Download Setup-Suwayomi.cmd</a> and double-click it: it asks first, then sets up the same Suwayomi-Server. After that, one click here fills in the three boxes above.</p>
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button class="btn" id="suwayomiConnectLocalBtn" type="button">Connect to the Suwayomi on this computer</button>
                    <span id="suwayomiConnectLocalResult" class="setting-description" style="margin:0"></span>
                  </div>
                </details>
              </div>
              <div class="setting-group">
                <div style="display:flex;gap:8px;align-items:center">
                  <button class="btn" id="suwayomiTestBtn" type="button">Test Connection</button>
                  <span id="suwayomiTestResult" class="setting-description" style="margin:0"></span>
                </div>
              </div>
              <div id="suwayomiUpdatesSlot"></div>
            </div>
  `;
}
