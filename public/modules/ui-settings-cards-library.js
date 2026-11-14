// ============================================================================
// SETTINGS CARDS — LIBRARY, ANIME LIBRARY AND FILTERS
// ============================================================================

function settingsCardGridAppearance() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Grid Appearance</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="displayMode,showCompactInfo,mangasPerRow,overlays,statusBadgeLocation,mangaTitleLanguage">Reset</button>
              </div>
              <div class="setting-group">
                <label for="displayModeSelect">Display mode</label>
                <select id="displayModeSelect" class="input">
                  <option value="detailed" ${state.settings.displayMode === 'detailed' ? 'selected' : ''}>Detailed Grid</option>
                  <option value="compact" ${state.settings.displayMode === 'compact' ? 'selected' : ''}>Compact Grid</option>
                </select>
                <p class="setting-description">Choose how manga are displayed in your library.</p>
              </div>
              <div class="setting-group">
                <label for="mangaTitleLanguageSelect">Manga title language</label>
                <select id="mangaTitleLanguageSelect" class="input">
                  <option value="original" ${state.settings.mangaTitleLanguage === 'original' ? 'selected' : ''}>Original (as scraped)</option>
                  <option value="romaji"   ${state.settings.mangaTitleLanguage === 'romaji'   ? 'selected' : ''}>Romaji</option>
                  <option value="english"  ${state.settings.mangaTitleLanguage === 'english'  ? 'selected' : ''}>English</option>
                  <option value="native"   ${state.settings.mangaTitleLanguage === 'native'   ? 'selected' : ''}>Native</option>
                </select>
                <p class="setting-description">Shows titles from the manga's linked AniList entry instead of each source's own title. Only affects manga already linked to AniList — falls back to the original title otherwise.</p>
              </div>
              <div class="setting-group" id="compactInfoGroup" style="${state.settings.displayMode === 'compact' ? '' : 'display:none'}">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.showCompactInfo">${t('settings.showCompactInfo')}</span>
                  <input type="checkbox" id="showCompactInfoToggle" ${state.settings.showCompactInfo ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Show title and author below cover art when using Compact Grid mode.</p>
              </div>
              <div class="setting-group">
                <label for="mangasPerRowSelect">Mangas per row</label>
                <select id="mangasPerRowSelect" class="input">
                  <option value="3" ${state.settings.mangasPerRow == 3 ? 'selected' : ''}>3</option>
                  <option value="4" ${state.settings.mangasPerRow == 4 ? 'selected' : ''}>4</option>
                  <option value="5" ${state.settings.mangasPerRow == 5 ? 'selected' : ''}>5</option>
                  <option value="6" ${state.settings.mangasPerRow == 6 ? 'selected' : ''}>6</option>
                  <option value="7" ${state.settings.mangasPerRow == 7 ? 'selected' : ''}>7</option>
                  <option value="8" ${state.settings.mangasPerRow == 8 ? 'selected' : ''}>8</option>
                  <option value="9" ${state.settings.mangasPerRow == 9 ? 'selected' : ''}>9</option>
                  <option value="10" ${state.settings.mangasPerRow == 10 ? 'selected' : ''}>10</option>
                  <option value="11" ${state.settings.mangasPerRow == 11 ? 'selected' : ''}>11</option>
                  <option value="12" ${state.settings.mangasPerRow == 12 ? 'selected' : ''}>12</option>
                  <option value="13" ${state.settings.mangasPerRow == 13 ? 'selected' : ''}>13</option>
                  <option value="14" ${state.settings.mangasPerRow == 14 ? 'selected' : ''}>14</option>
                </select>
                <p class="setting-description">Number of manga cards per row (grid modes only).</p>
              </div>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.4rem 0;font-weight:600">Overlay badges</p>
                <label class="toggle-label" style="margin-bottom:0.3em">
                  <span class="toggle-text" data-i18n="settings.overlayDownloaded">${t('settings.overlayDownloaded')}</span>
                  <input type="checkbox" id="toggleOverlayDownloaded" ${state.settings.overlays?.downloaded !== false ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <label class="toggle-label" style="margin-bottom:0.3em">
                  <span class="toggle-text" data-i18n="settings.overlayUnread">${t('settings.overlayUnread')}</span>
                  <input type="checkbox" id="toggleOverlayUnread" ${state.settings.overlays?.unread !== false ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.overlayLocal">${t('settings.overlayLocal')}</span>
                  <input type="checkbox" id="toggleOverlayLocal" ${state.settings.overlays?.local !== false ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Show badges for downloaded, unread, and local manga in your library.</p>
              </div>
              <div class="setting-group">
                <label for="statusBadgeLocationSelect">Reading status badge location</label>
                <select id="statusBadgeLocationSelect" class="input">
                  <option value="cover" ${(state.settings.statusBadgeLocation || 'cover') === 'cover' ? 'selected' : ''}>On cover (top-left)</option>
                  <option value="info" ${state.settings.statusBadgeLocation === 'info' ? 'selected' : ''}>Below title</option>
                  <option value="both" ${state.settings.statusBadgeLocation === 'both' ? 'selected' : ''}>Both</option>
                </select>
                <p class="setting-description">Controls where the Reading/Completed/etc. badge appears on each library card</p>
              </div>
              <div class="setting-group">
                <p class="setting-description" style="margin:0">Whether the status badge, source badge, and unread-chapter count show at all — not just where — is now controlled per-card from the Library's own "Customize Library Card" button.</p>
              </div>
            </div>
  `;
}

// Moved here from the Theme & Appearance tab, where it had nothing to do with theming — it belongs with the rest of Library's own
// settings.
function settingsCardLibraryAppearance() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Library Appearance</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="libraryBookshelf3d">Reset</button>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.libraryBookshelf3d">${t('settings.libraryBookshelf3d')}</span>
                  <input type="checkbox" id="libraryBookshelf3dToggle" ${state.settings.libraryBookshelf3d ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Shows library cards in a 3D bookshelf with depth effect</p>
              </div>
            </div>
  `;
}

// Also moved here from the Theme & Appearance tab, same reason.
function settingsCardLibrarySync() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Library Sync</p>
              </div>
              <div class="setting-group">
                <p class="setting-description">Manually check all sources and Anime-Planet for status updates (Ongoing, Completed, Hiatus, Cancelled).</p>
                <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
                  <button class="btn primary" id="btnSyncLibraryStatus">Sync Library Status</button>
                  <span id="syncLibraryStatusResult" style="font-size:0.8rem; color:var(--color-success)"></span>
                </div>
              </div>
            </div>
  `;
}

function settingsCardClearReadingHistory() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Data</p>
              <div class="setting-group">
                <button class="btn secondary" id="clearReadBtn">Clear Reading History</button>
                <p class="setting-description">Removes all reading history, last-read pages, and chapter flags</p>
              </div>
            </div>
  `;
}

function settingsCardDefaults() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Defaults</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="libraryDefaultStatusFilter">Reset</button>
              </div>
              <div class="setting-group">
                <label for="libraryDefaultStatusFilterSelect">Default status filter when opening Library</label>
                <select id="libraryDefaultStatusFilterSelect" class="input">
                  <option value="all" ${state.settings.libraryDefaultStatusFilter === 'all' ? 'selected' : ''}>All Manga</option>
                  <option value="reading" ${state.settings.libraryDefaultStatusFilter === 'reading' ? 'selected' : ''}>Reading</option>
                  <option value="completed" ${state.settings.libraryDefaultStatusFilter === 'completed' ? 'selected' : ''}>Completed</option>
                  <option value="on_hold" ${state.settings.libraryDefaultStatusFilter === 'on_hold' ? 'selected' : ''}>On Hold</option>
                  <option value="plan_to_read" ${state.settings.libraryDefaultStatusFilter === 'plan_to_read' ? 'selected' : ''}>Plan to Read</option>
                  <option value="dropped" ${state.settings.libraryDefaultStatusFilter === 'dropped' ? 'selected' : ''}>Dropped</option>
                </select>
                <p class="setting-description">When you open Library, this filter is selected automatically</p>
              </div>
            </div>
  `;
}

function settingsCardHomePage() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Home Page</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="showHomeSearch,homeMode,homeSourceMode,homeSelectedSourceIds">Reset</button>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.showHomeSearch">${t('settings.showHomeSearch')}</span>
                  <input type="checkbox" id="showHomeSearchToggle" ${state.settings.showHomeSearch !== false ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Shows or hides the Search Manga panel at the top of the Home page.</p>
              </div>
              <div class="setting-group">
                <label for="homeModeSelect">Default home page</label>
                <select id="homeModeSelect" class="input">
                  <option value="manga" ${state.settings.homeMode !== 'anime' ? 'selected' : ''}>Manga</option>
                  <option value="anime" ${state.settings.homeMode === 'anime' ? 'selected' : ''}>Anime</option>
                </select>
                <p class="setting-description">Which content the Home page shows. Also switchable anytime from the Anime/Manga toggle in the top bar — that choice is remembered here too.</p>
              </div>
              <div class="setting-group">
                <label for="homeSourceModeSelect">Home page source mode</label>
                <select id="homeSourceModeSelect" class="input">
                  <option value="all" ${state.settings.homeSourceMode !== 'selected' ? 'selected' : ''}>Show all installed sources</option>
                  <option value="selected" ${state.settings.homeSourceMode === 'selected' ? 'selected' : ''}>Only selected sources</option>
                </select>
                <p class="setting-description">Controls which sources are used in Home rows (Most Popular Today, Recently Added and Latest Updates)</p>
              </div>
              <div class="setting-group" id="homeSourceSelectionGroup" style="${state.settings.homeSourceMode === 'selected' ? '' : 'display:none'}">
                <p class="setting-description" style="margin:0 0 0.4rem 0;font-weight:600">Sources visible on Home</p>
                <div id="homeSourceSelectionList">
                  ${(() => {
                    const ids = new Set(Array.isArray(state.settings.homeSelectedSourceIds) ? state.settings.homeSelectedSourceIds : []);
                    const sources = getSelectableSources();
                    if (!sources.length) return '<p class="muted" style="margin:0">No installed sources</p>';
                    return sources.map(s => `
                      <label class="home-source-check">
                        <input type="checkbox" class="home-source-option" value="${escapeHtml(s.id)}" ${ids.size === 0 || ids.has(s.id) ? 'checked' : ''}>
                        <span class="home-source-check-label">${escapeHtml(s.name || s.id)}</span>
                      </label>
                    `).join('');
                  })()}
                </div>
                <p class="setting-description">If no source is selected, ScrollScape falls back to showing all.</p>
              </div>
            </div>
  `;
}

function settingsCardContentFilters() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Content Filters</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="hideNsfw">Reset</button>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.hideNsfw">${t('settings.hideNsfw')}</span>
                  <input type="checkbox" id="hideNsfwToggle" ${state.settings.hideNsfw ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Hides NSFW-related filters in Advanced Search and excludes NSFW-tagged titles from Library</p>
              </div>
            </div>
  `;
}

function settingsCardGenreBlacklist() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Genre Blacklist</p>
              <div class="setting-group">
                <label for="genreBlacklistInput">Blacklisted Genres (comma separated)</label>
                <input type="text" id="genreBlacklistInput" class="input" placeholder="e.g. yaoi, doujinshi, harem" autocomplete="off" spellcheck="false" value="${escapeHtml((state.settings.genreBlacklist || []).join(', '))}"></input>
                <p class="setting-description">Manga containing these genres will be hidden from Search and Discover.</p>
              </div>
            </div>
  `;
}

function settingsCardAnimeLibraryCard() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Library Card</p>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.4rem 0;font-weight:600">Visible fields</p>
                ${(() => {
                  const s = typeof loadAnimeLibraryCardSettings === 'function' ? loadAnimeLibraryCardSettings() : {};
                  return `
                  <label class="toggle-label" style="margin-bottom:0.3em">
                    <span class="toggle-text" data-i18n="settings.animeCardProgressBar">${t('settings.animeCardProgressBar')}</span>
                    <input type="checkbox" id="animeSetCardProgressBar" ${s.showProgressBar ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <label class="toggle-label" style="margin-bottom:0.3em">
                    <span class="toggle-text" data-i18n="settings.animeCardEpisodeLabel">${t('settings.animeCardEpisodeLabel')}</span>
                    <input type="checkbox" id="animeSetCardEpisodeLabel" ${s.showEpisodeLabel ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <label class="toggle-label" style="margin-bottom:0.3em">
                    <span class="toggle-text" data-i18n="settings.animeCardTags">${t('settings.animeCardTags')}</span>
                    <input type="checkbox" id="animeSetCardTags" ${s.showTags ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                  <label class="toggle-label">
                    <span class="toggle-text" data-i18n="settings.animeCardStatus">${t('settings.animeCardStatus')}</span>
                    <input type="checkbox" id="animeSetCardStatus" ${s.showStatus ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>`;
                })()}
                <p class="setting-description">Controls what shows on each anime's card in your My Anime library grid.</p>
              </div>
            </div>
  `;
}

function settingsCardAnimeLibrarySync() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Library Sync</p>
              </div>
              <div class="setting-group">
                <p class="setting-description">Manually check AniList for each My Anime title's current airing status (Ongoing, Completed, Not Yet Released, Hiatus, Cancelled).</p>
                <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
                  <button class="btn primary" id="btnSyncAnimeLibraryStatus">Sync Anime Library Status</button>
                  <span id="syncAnimeLibraryStatusResult" style="font-size:0.8rem; color:var(--color-success)"></span>
                </div>
              </div>
            </div>
  `;
}
