// ============================================================================
// SETTINGS CARDS — NETWORK, ACCOUNTS, SECURITY, DATA AND COMMANDS
// ============================================================================

function settingsCardNetworkAntiBot() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Network & Anti-Bot</p>
              <div class="setting-group">
                <label for="flaresolverrUrlInput">FlareSolverr URL</label>
                <input type="text" id="flaresolverrUrlInput" class="input" placeholder="http://localhost:8191/v1" autocomplete="off" spellcheck="false" style="width:100%">
                <p class="setting-description">Used to bypass Cloudflare on protected sources. Leave blank to disable.</p>
              </div>
              <div class="setting-group">
                <label for="proxyUrlInput">Proxy URL (for FlareSolverr)</label>
                <input type="text" id="proxyUrlInput" class="input" placeholder="http://203.0.113.10:1080" autocomplete="off" spellcheck="false" style="width:100%">
                <p class="setting-description">Routes FlareSolverr's own browser through this proxy (http://, socks4://, or socks5://). Only needed for sources whose Cloudflare tier blocks by IP reputation rather than by detecting a real browser — e.g. Miruro. Doesn't affect actual video playback, which never goes through this proxy. Leave blank to disable.</p>
              </div>
              <div class="setting-group" style="display:flex;gap:0.6rem">
                <div style="flex:1">
                  <label for="proxyUsernameInput">Proxy Username</label>
                  <input type="text" id="proxyUsernameInput" class="input" autocomplete="off" spellcheck="false" style="width:100%">
                </div>
                <div style="flex:1">
                  <label for="proxyPasswordInput">Proxy Password</label>
                  <input type="password" id="proxyPasswordInput" class="input" autocomplete="off" spellcheck="false" style="width:100%">
                </div>
              </div>
              <div class="setting-group">
                <label for="comicVineApiKeyInput">ComicVine API Key</label>
                <input type="password" id="comicVineApiKeyInput" class="input" placeholder="Get a free key at comicvine.gamespot.com/api" autocomplete="off" spellcheck="false" style="width:100%">
                <p class="setting-description">Used to fetch higher-quality covers for Western comics (e.g. BatCave). Leave blank to disable.</p>
              </div>
            </div>
  `;
}

function settingsCardDiscordPresence() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Discord Rich Presence</p>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.discordShowActivity">${t('settings.discordShowActivity')}</span>
                  <input type="checkbox" id="discordRpcToggle">
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Broadcasts the manga/anime you're currently reading or watching to your Discord status (cover art, title, chapter/episode) — visible to anyone who can see your Discord activity. <strong>Off by default.</strong> Requires Discord's desktop app running on this same computer — ScrollScape's own server talks to it over a local connection, which only works when both are on the same machine (not a phone, not a remote/Docker install).</p>
              </div>
              <div class="setting-group">
                <label for="discordClientIdInput">Discord Application Client ID</label>
                <input type="text" id="discordClientIdInput" class="input" placeholder="e.g. 1191234567890123456" autocomplete="off" spellcheck="false" style="width:100%">
                <p class="setting-description">One-time setup, done on Discord's side: create a free application at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">discord.com/developers/applications</a> (any name — it's what shows as the bold title above your status), then paste its <strong>Application ID</strong> here. Leave blank to disable — ScrollScape never attempts a connection without one.</p>
                <p class="setting-description" style="margin-top:0.4rem">Optional, for the small badge icon in the corner of the cover art: add two <em>Rich Presence Art Assets</em> named exactly <code>manga_icon</code> and <code>anime_icon</code> to that same application. The cover art itself works either way — Discord just won't show a badge if those aren't uploaded.</p>
                <p class="setting-description" id="discordRpcStatusLine" style="margin-top:0.6rem;font-weight:600">Status: —</p>
              </div>
            </div>
  `;
}

function settingsCardAccessPassword() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Access Password</p>
              <div class="setting-group">
                <p class="setting-description" id="accessPasswordStatus" style="margin:0 0 0.6rem 0">Loading…</p>
                <div id="accessPasswordCurrentGroup" style="display:none;margin-bottom:0.6rem">
                  <label for="accessPasswordCurrentInput">Current password</label>
                  <input type="password" id="accessPasswordCurrentInput" class="input" autocomplete="current-password">
                </div>
                <label for="accessPasswordNewInput">New password (leave empty to remove the lock)</label>
                <input type="password" id="accessPasswordNewInput" class="input" autocomplete="new-password">
                <div class="setting-group" style="display:flex;gap:8px;margin-top:0.6rem">
                  <button class="btn secondary" id="btnSaveAccessPassword">Save</button>
                </div>
                <p class="setting-description" style="margin-top:0.5rem">Only gates the app itself — the OPDS catalog stays unauthenticated since external e-reader apps can't fill in a login form.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text">Allow installing sources from other devices</span>
                  <input type="checkbox" id="allowRemoteImportToggle">
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Lets the source import tool (Settings &gt; Sources &gt; Import a source), the source catalog and the Suwayomi extension engine work from another device, such as the browser of another computer when ScrollScape runs on a server. It needs the Access Password above: anyone who has it, or a logged-in session, could then install code on the computer that runs ScrollScape. Off by default; no effect without a password, or when the app is started in local-only mode.</p>
              </div>
            </div>
  `;
}

function settingsCardFactoryReset() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Factory Reset</p>
              <div class="setting-group">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                  <p class="setting-description" style="margin:0">Reset all application settings to their default values. This will not delete your library or reading history.</p>
                  <button class="btn secondary" id="btnResetAllSettings" style="white-space:nowrap">Reset All Settings</button>
                </div>
              </div>
            </div>
  `;
}

function settingsCardBackupRestore() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Backup &amp; Restore</p>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Save your library, reading history, custom lists, achievements, settings and AniList links to a single file — or restore from one.</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <button class="btn secondary" id="btnExportBackup">Export Backup</button>
                  <button class="btn secondary" id="btnImportBackup">Import Backup</button>
                  <input type="file" id="importBackupFileInput" accept=".json" style="display:none">
                </div>
                <p class="setting-description" style="margin-top:0.5rem">Your AniList login token isn't included for security — reconnect AniList (one click) after restoring. Downloaded/local manga files aren't included either, only their library entries.</p>
              </div>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Export your library as a spreadsheet — title, source, status, progress and tags — for viewing or sorting outside the app. Not restorable; use Export Backup above for that.</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <button class="btn secondary" id="btnExportCsv">Export as CSV</button>
                </div>
              </div>
            </div>
  `;
}

function settingsCardOpdsCatalog() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">OPDS Catalog</p>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Browse this library from an external e-reader app (KOReader, Moon+ Reader, Calibre, etc.) by pointing it at this catalog URL.</p>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <input type="text" id="opdsCatalogUrl" class="input" readonly value="${escapeHtml(window.location.origin)}/opds" style="flex:1;min-width:220px">
                  <button class="btn secondary" id="btnCopyOpdsUrl">Copy</button>
                </div>
                <p class="setting-description" style="margin-top:0.5rem">Read-only, no login required — matches the rest of this self-hosted app.</p>
              </div>
            </div>
  `;
}

function settingsCardMihonImport() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Tachiyomi / Mihon / Komikku</p>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Import a Tachiyomi, Mihon, or Komikku library backup (.tachibk) — Komikku is a Tachiyomi fork and shares the same backup format, so it works here too. Manga you already have (matched by exact title) get their reading progress and categories merged in rather than duplicated. Anything new from a source ScrollScape doesn't recognise imports as metadata only; use Migrate afterward to re-link it to a live source here.</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <button class="btn secondary" id="btnImportMihon">Import Tachiyomi/Mihon/Komikku Backup</button>
                  <input type="file" id="importMihonFileInput" accept=".tachibk,.proto.gz,.gz" style="display:none">
                </div>
              </div>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Export your ScrollScape library as a .tachibk file Tachiyomi, Mihon, or Komikku can restore — titles, covers, authors, genres, categories and read-chapter markers come across. A source id here has no equivalent on the receiving app's own extensions, so use its Migrate-equivalent (or just re-add the extension) to re-link each manga to a live source after restoring, same as importing the other way round.</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <button class="btn secondary" id="btnExportMihon">Export to Tachiyomi/Mihon/Komikku Backup</button>
                </div>
              </div>
            </div>
  `;
}

// The source catalog (ui-settings-source-catalog.js, mountAdvancedCatalog) draws itself into this slot: the sites of the repositories, and the repositories.
function settingsCardSourceCatalog() {
  return `
            <div class="settings-section-card">
              <div id="advancedCatalogSlot"></div>
            </div>
  `;
}

function settingsCardCommands() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Commands</p>
              <div class="setting-group">
                <div style="display:flex;gap:8px;align-items:center">
                  <input type="text" id="cheatInput" class="input" placeholder="Enter command…" autocomplete="off" autocorrect="off" spellcheck="false" style="flex:1;font-family:monospace">
                  <button class="btn primary" id="cheatRunBtn">Run</button>
                </div>
                <p class="setting-description">Available: <code>cls</code> — reset all AP &amp; achievements &nbsp;·&nbsp; <code>godmode</code> — add 500 AP &nbsp;·&nbsp; <code>lcls</code> — clear library</p>
              </div>
            </div>
  `;
}
