// ============================================================================
// SETTINGS CARDS — READING (reading mode, chapters, auto scroll, the reader's look)
// ============================================================================
// One function per card; ui-settings-modal-html.js lays them out in the tabs. Each returns the card's markup and reads state/i18n at call time.

function settingsCardReadingMode() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Reading Mode</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="readingMode,autoWebtoonDetect,autoLoadNextChapter,webtoonTurnButtonsEnabled,webtoonTurnButtonPlacement,pageFlipAnimation,showBookSpine,panWideImages,lineSharpness">Reset</button>
              </div>
              <div class="setting-group">
                <label for="modeSelect">Default reading direction</label>
                <select id="modeSelect" class="input">
                  <option value="ltr"     ${state.settings.readingMode === "ltr"     ? "selected" : ""}>Left to Right</option>
                  <option value="rtl"     ${state.settings.readingMode === "rtl"     ? "selected" : ""}>Right to Left (Manga)</option>
                  <option value="webtoon" ${state.settings.readingMode === "webtoon" ? "selected" : ""}>Webtoon (Vertical Scroll)</option>
                </select>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.autoWebtoonDetect">${t('settings.autoWebtoonDetect')}</span>
                  <input type="checkbox" id="autoWebtoonToggle" ${state.settings.autoWebtoonDetect !== false ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Automatically switches to Webtoon mode for Korean and Chinese comics.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.autoLoadNextChapter">${t('settings.autoLoadNextChapter')}</span>
                  <input type="checkbox" id="autoLoadNextChapterToggle" ${state.settings.autoLoadNextChapter ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Automatically opens the next chapter when you scroll to the end.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.webtoonTurnButtons">${t('settings.webtoonTurnButtons')}</span>
                  <input type="checkbox" id="webtoonTurnButtonsToggle" ${state.settings.webtoonTurnButtonsEnabled !== false ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
              </div>
              <div class="setting-group">
                <label for="webtoonTurnButtonPlacementSelect">Webtoon button placement</label>
                <select id="webtoonTurnButtonPlacementSelect" class="input">
                  <option value="bottom"  ${(state.settings.webtoonTurnButtonPlacement || 'corners') === 'bottom' ? 'selected' : ''}>Bottom center</option>
                  <option value="corners" ${(state.settings.webtoonTurnButtonPlacement || 'corners') === 'corners' ? 'selected' : ''}>Bottom corners</option>
                </select>
                <p class="setting-description">Only applies to Webtoon mode.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.pageFlipAnimation">${t('settings.pageFlipAnimation')}</span>
                  <input type="checkbox" id="pageFlipAnimationToggle" ${state.settings.pageFlipAnimation !== false ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">3D page-turn effect in Book (RTL/LTR) mode.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.showBookSpine">${t('settings.showBookSpine')}</span>
                  <input type="checkbox" id="showBookSpineToggle" ${state.settings.showBookSpine !== false ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description" data-i18n="settings.showBookSpineDesc">${t('settings.showBookSpineDesc')}</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.panWideImages">${t('settings.panWideImages')}</span>
                  <input type="checkbox" id="panWideToggle" ${state.settings.panWideImages ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Allows horizontal scrolling on double-page spreads.</p>
              </div>
              <div class="setting-group">
                <label for="sharpnessSelect">Line Sharpness</label>
                <select id="sharpnessSelect" class="input">
                  <option value="0" ${(state.settings.lineSharpness||0) === 0 ? 'selected' : ''}>Off</option>
                  <option value="1" ${(state.settings.lineSharpness||0) === 1 ? 'selected' : ''}>Subtle</option>
                  <option value="2" ${(state.settings.lineSharpness||0) === 2 ? 'selected' : ''}>Strong</option>
                  <option value="3" ${(state.settings.lineSharpness||0) === 3 ? 'selected' : ''}>Max</option>
                </select>
                <p class="setting-description">Increases contrast to make manga lines crisper.</p>
              </div>
                </div>
  `;
}

function settingsCardChapterBehaviour() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Chapter Behaviour</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="skipReadChapters,skipDuplicates">Reset</button>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.skipReadChapters">${t('settings.skipReadChapters')}</span>
                  <input type="checkbox" id="skipReadToggle" ${state.settings.skipReadChapters ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Hides chapters you've already finished reading</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.skipDuplicateChapters">${t('settings.skipDuplicateChapters')}</span>
                  <input type="checkbox" id="skipDuplicatesToggle" ${state.settings.skipDuplicates ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Automatically advances past duplicates of the same chapter number</p>
              </div>
            </div>
  `;
}

function settingsCardAutoScroll() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Auto Scroll</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="autoScrollPointSpeeds">Reset</button>
              </div>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.5rem 0">Set the speed used by each auto-scroll level (points 1 to 5).</p>
                <div id="autoScrollPointSpeedGrid" class="auto-scroll-point-grid">
                  ${(() => {
                    const defaults = [0.2, 0.5, 1.0, 2.0, 3.5];
                    const raw = Array.isArray(state.settings.autoScrollPointSpeeds)
                      ? state.settings.autoScrollPointSpeeds
                      : defaults;
                    const speeds = defaults.map((fallback, idx) => {
                      const n = Number(raw[idx]);
                      return Number.isFinite(n) ? Math.min(12, Math.max(0.05, n)) : fallback;
                    });
                    return speeds.map((v, i) => `
                      <div class="auto-scroll-point-row">
                        <label for="autoScrollPointSpeed${i + 1}">Point ${i + 1}</label>
                        <input type="range" class="settings-speed-slider" id="autoScrollPointSpeed${i + 1}" min="0.05" max="12" step="0.05" value="${v.toFixed(2)}">
                        <span id="autoScrollPointSpeed${i + 1}Label" class="auto-scroll-point-speed-label">${v.toFixed(2)} px/f</span>
                      </div>
                    `).join('');
                  })()}
                </div>
              </div>
            </div>
  `;
}

// Reader Appearance card
function settingsCardReaderAppearance() {
  return `
            <div class="settings-section-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <p class="settings-section-title" style="margin-bottom:0">Reader Appearance</p>
                <button class="btn secondary reset-section-btn" style="padding:2px 6px;font-size:0.75rem" data-keys="readerBackground,readerNoiseEnabled,readerNoiseSource,readerNoiseGifFile">Reset</button>
              </div>
              <div class="setting-group" id="readerBgColorGroup" style="${state.settings.readerNoiseEnabled ? 'display:none' : ''}">
                <label for="readerBgSelect">Background colour</label>
                <select id="readerBgSelect" class="input">
                  <option value="black" ${(state.settings.readerBackground||'black') === 'black' ? 'selected' : ''}>Black</option>
                  <option value="dark"  ${(state.settings.readerBackground||'black') === 'dark'  ? 'selected' : ''}>Dark</option>
                  <option value="gray"  ${(state.settings.readerBackground||'black') === 'gray'  ? 'selected' : ''}>Gray</option>
                  <option value="sepia" ${(state.settings.readerBackground||'black') === 'sepia' ? 'selected' : ''}>Sepia</option>
                  <option value="white" ${(state.settings.readerBackground||'black') === 'white' ? 'selected' : ''}>White</option>
                </select>
                <p class="setting-description">Background colour shown behind pages while reading.</p>
              </div>
              <div class="setting-group">
                <label class="toggle-label">
                  <span class="toggle-text" data-i18n="settings.readerAnimatedWallpaper">${t('settings.readerAnimatedWallpaper')}</span>
                  <input type="checkbox" id="readerNoiseToggle" ${state.settings.readerNoiseEnabled ? "checked" : ""}>
                  <span class="toggle-slider"></span>
                </label>
                <p class="setting-description">Replaces the background colour with an animated wallpaper.</p>
              </div>
              <div id="readerWallpaperOptions" style="${state.settings.readerNoiseEnabled ? '' : 'display:none'}">
                <div class="setting-group">
                  <label for="readerNoiseSourceSelect">Wallpaper type</label>
                  <select id="readerNoiseSourceSelect" class="input">
                    <option value="generated" ${(state.settings.readerNoiseSource||'generated')==='generated'?'selected':''}>Film grain (generated)</option>
                    <option value="gif"        ${(state.settings.readerNoiseSource||'generated')==='gif'       ?'selected':''}>GIF / image file</option>
                  </select>
                </div>
                <div class="setting-group" id="readerNoiseGifGroup" style="${(state.settings.readerNoiseSource||'generated')==='gif'?'':'display:none'}">
                  <label for="readerNoiseGifFileSelect">Wallpaper file</label>
                  <select id="readerNoiseGifFileSelect" class="input">
                    <option value="">— loading… —</option>
                  </select>
                  <p class="setting-description">Place GIF / WebP files in the <code>public/</code> folder.</p>
                </div>
              </div>
            </div>
  `;
}
