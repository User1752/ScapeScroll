// ============================================================================
// SETTINGS CARDS — THEME AND THE ANILIST TRACKER
// ============================================================================

// UI Theme card
function settingsCardUiTheme() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">${t('settings.uiThemeTitle')}</p>
              <div class="setting-group">
                <label for="uiThemeSelect">${t('settings.uiThemeTitle')}</label>
                <select id="uiThemeSelect" class="input">
                  ${SHOP_THEMES.map(theme => {
                    const isOwned = getPurchasedThemes().includes(theme.id);
                    const isActive = getActiveTheme() === theme.id;
                    if (!isOwned) return '';
                    return `<option value="${escapeHtml(theme.id)}" ${isActive ? 'selected' : ''}>${escapeHtml(theme.name)}</option>`;
                  }).join('')}
                </select>
                <p class="setting-description">${t('settings.uiThemeDesc')}</p>
              </div>
              <div class="setting-group">
                <button class="btn secondary" id="btnGoToThemeShop" style="display:flex; gap:8px; justify-content:center; align-items:center; width:100%;">
                  Shop: ${t('nav.shop')}
                </button>
              </div>
            </div>
  `;
}

function settingsCardAniList() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">AniList</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="anilistAutoSync,anilistShowTrackerOnAdd,anilistAutoImportOnConnect,anilistAutoCategorize,anilistKeepCover">Reset</button>
              </div>
              <div id="anilist-loggedout" ${_alToken() ? 'style="display:none"' : ''}>
                <div class="setting-group">
                  <label for="anilistClientIdInput">AniList Client ID</label>
                  <input type="text" id="anilistClientIdInput" class="input" value="${escapeHtml(_alClientId())}" placeholder="e.g. 23361" autocomplete="off" spellcheck="false">
                  <p class="setting-description">
                    Register a free app at <strong>anilist.co/settings/developer</strong> and set the
                    redirect URI to <code>${escapeHtml(window.location.origin)}</code>.
                  </p>
                </div>
                <div class="setting-group">
                  <button class="btn primary" id="btnAniListConnect">Connect AniList</button>
                </div>
              </div>
              <div id="anilist-loggedin" ${_alToken() ? '' : 'style="display:none"'}>
                <div class="setting-group">
                  <div class="anilist-user-card" id="anilistUserCard">
                    ${(() => {
                      const u = _alUser();
                      if (!u) return '<span class="muted" style="padding:0">Loading…</span>';
                      return `${u.avatar ? `<img src="${escapeHtml(u.avatar)}" alt="" class="anilist-avatar">` : ''}
                              <span class="anilist-username">${escapeHtml(u.name)}</span>`;
                    })()}
                  </div>
                </div>
                <div class="setting-group">
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.anilistAutoSync">${t('settings.anilistAutoSync')}</span>
                    <input type="checkbox" id="anilistAutoSyncToggle" ${state.settings.anilistAutoSync ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <p class="setting-description">Automatically updates your AniList chapter progress when you read</p>
                </div>
                <div class="setting-group">
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.anilistShowTrackerOnAdd">${t('settings.anilistShowTrackerOnAdd')}</span>
                    <input type="checkbox" id="anilistShowTrackerOnAddToggle" ${state.settings.anilistShowTrackerOnAdd ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <p class="setting-description">Opens the AniList Tracker to link/set status right after you add a manga to your library</p>
                </div>
                <div class="setting-group">
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.anilistAutoImportOnConnect">${t('settings.anilistAutoImportOnConnect')}</span>
                    <input type="checkbox" id="anilistAutoImportToggle" ${state.settings.anilistAutoImportOnConnect ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <p class="setting-description">Imports your AniList manga library automatically when you connect your account</p>
                </div>
                <div class="setting-group">
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.anilistAutoCategorize">${t('settings.anilistAutoCategorize')}</span>
                    <input type="checkbox" id="anilistAutoCategorizeToggle" ${state.settings.anilistAutoCategorize ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <p class="setting-description">Automatically adds completed manga to a "Read" category when importing</p>
                </div>
                <div class="setting-group">
                  <label for="anilistImportCategorySelect">Import into category</label>
                  <div style="display:flex;gap:8px;align-items:center">
                    <select id="anilistImportCategorySelect" class="input" style="flex:1">
                      <option value="">— None (mix with library) —</option>
                      ${(state.customLists || []).map(l => `<option value="${escapeHtml(l.id)}" ${state.settings.anilistImportCategoryId === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
                    </select>
                    <button class="btn secondary" id="btnNewAnilistImportCategory" title="Create a new category">+ New</button>
                  </div>
                  <p class="setting-description">Every manga imported from AniList (not just Completed) also gets added to this category, so it doesn't mix in with the rest of your library.</p>
                </div>
                <div class="setting-group">
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.anilistKeepCover">${t('settings.anilistKeepCover')}</span>
                    <input type="checkbox" id="anilistKeepCoverToggle" ${state.settings.anilistKeepCover ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <p class="setting-description">Uses the cover art from AniList instead of the one from the source it resolves to</p>
                </div>
                <div class="setting-group" style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn primary" id="btnAniListImportNow">Import Library Now</button>
                  <button class="btn secondary" id="btnAniListDisconnect">Disconnect</button>
                </div>
                <div id="anilistImportProgressWrap" class="anilist-import-progress hidden">
                  <div class="anilist-import-progress-bar">
                    <div id="anilistImportProgressFill" class="anilist-import-progress-fill"></div>
                  </div>
                  <p id="anilistImportProgressText" class="setting-description">Waiting to start import…</p>
                </div>
                ${(() => {
                  const sync = state.anilistSync;
                  if (!sync?.lastImportAt) return '<p id="anilistLastImportLabel" class="setting-description" style="margin-top:4px;display:none"></p>';
                  const d = new Date(sync.lastImportAt).toLocaleString();
                  return `<p id="anilistLastImportLabel" class="setting-description" style="margin-top:4px">Last import: <strong>${escapeHtml(d)}</strong> &mdash; ${sync.importedCount || 0} new, ${sync.overwriteCount || 0} updated</p>`;
                })()}
                ${typeof anilistStatusRestoreHtml === 'function' ? anilistStatusRestoreHtml() : ''}
                ${typeof anilistProgressRestoreHtml === 'function' ? anilistProgressRestoreHtml() : ''}
              </div>
            </div>
  `;
}
