// ============================================================================
// SETTINGS MODAL
// ============================================================================

function showSettings() {
  let initializingSettingsModal = true;
  const modal = document.createElement("div");
  modal.className = "settings-modal";
  // Dialog semantics + keyboard close: this modal previously had neither —
  // a screen reader had no way to know a dialog opened, and Escape did
  // nothing. aria-label falls back to a plain string rather than t()
  // because this runs before buildSettingsModalHtml() below has rendered
  // anything data-i18n could apply translations to.
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Settings');
  const _previouslyFocused = document.activeElement;
  const _onKeydown = (e) => { if (e.key === 'Escape') modal.remove(); };
  document.addEventListener('keydown', _onKeydown);

  // Closing this modal must not leave a dangling subscription behind —
  // there are several places below that call modal.remove() (the X
  // button, clicking the backdrop, a couple of post-save flows), so
  // patching remove() itself here guarantees cleanup fires no matter which
  // of those actually triggers the close, instead of having to remember to
  // unsubscribe at every call site individually.
  let _unsubscribeAnilistBadge = null;
  const _originalModalRemove = modal.remove.bind(modal);
  modal.remove = () => {
    if (_unsubscribeAnilistBadge) { _unsubscribeAnilistBadge(); _unsubscribeAnilistBadge = null; }
    document.removeEventListener('keydown', _onKeydown);
    // Return focus to whatever opened the modal (usually the settings
    // button) instead of leaving it on <body> once the dialog is gone.
    if (_previouslyFocused instanceof HTMLElement && document.contains(_previouslyFocused)) {
      _previouslyFocused.focus();
    }
    // Play the closing animation (see beta-design.css's .beta-closing rules)
    // before actually detaching the modal, instead of just vanishing
    // instantly. The 300ms timeout is a safety net in case animationend
    // never fires.
    if (modal.isConnected) {
      if (modal._betaClosing) return;
      modal._betaClosing = true;
      modal.classList.add('beta-closing');
      modal.addEventListener('animationend', () => _originalModalRemove(), { once: true });
      setTimeout(() => { if (modal.isConnected) _originalModalRemove(); }, 300);
    } else {
      _originalModalRemove();
    }
  };
  
  const _origSave = window.saveSettings;
  const saveSettings = () => {
    if (_origSave) _origSave();
    const ind = document.getElementById('settingsSavedIndicator');
    if (ind) {
      ind.style.opacity = '1';
      if (ind._to) clearTimeout(ind._to);
      ind._to = setTimeout(() => { ind.style.opacity = '0'; }, 2000);
    }
  };

  modal.innerHTML = buildSettingsModalHtml();
  document.body.appendChild(modal);
  if (typeof fillSettingsAppVersion === 'function') fillSettingsAppVersion();
  // Move focus into the dialog on open so a screen reader announces it and
  // keyboard users don't stay stranded on whatever was focused underneath.
  modal.tabIndex = -1;
  modal.focus();

  $("closeSettings").onclick = () => modal.remove();
  // Finishes initialization once every handler above is wired up
  setTimeout(() => { initializingSettingsModal = false; }, 0);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  // Tab switching
  modal.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.onclick = () => {
      modal.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
      modal.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      modal.querySelector('#' + btn.dataset.tab)?.classList.add('active');
      // Re-init custom selects inside newly visible tab
      if (window.initCustomSelects) initCustomSelects();
    };
  });

  // Search filter logic
  const searchInput = $("settingsSearchInput");
  if (searchInput) {
    searchInput.oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      const cards = modal.querySelectorAll('.settings-section-card');
      let firstVisibleTabBtn = null;
      
      cards.forEach(card => {
        let cardHasMatch = false;
        const groups = card.querySelectorAll('.setting-group');
        groups.forEach(group => {
          if (!q || group.textContent.toLowerCase().includes(q)) {
            group.style.display = '';
            cardHasMatch = true;
          } else {
            group.style.display = 'none';
          }
        });
        
        // Check title and descriptions
        if (q && card.querySelector('.settings-section-title')?.textContent.toLowerCase().includes(q)) {
          groups.forEach(group => group.style.display = '');
          cardHasMatch = true;
        }

        // Always show title and reset button if there's a match, otherwise hide the whole card
        card.style.display = (!q || cardHasMatch) ? '' : 'none';
      });

      // Show/hide tabs in sidebar if they have visible cards
      modal.querySelectorAll('.settings-nav-item').forEach(navBtn => {
        const tabId = navBtn.dataset.tab;
        const tab = modal.querySelector('#' + tabId);
        if (tab) {
          const hasVisibleCards = Array.from(tab.querySelectorAll('.settings-section-card')).some(c => c.style.display !== 'none');
          navBtn.style.display = hasVisibleCards ? '' : 'none';
          if (hasVisibleCards && !firstVisibleTabBtn) firstVisibleTabBtn = navBtn;
        }
      });
      
      // If the currently active tab has no visible cards, switch to the first one that does
      const activeNav = modal.querySelector('.settings-nav-item.active');
      if (q && activeNav && activeNav.style.display === 'none' && firstVisibleTabBtn) {
        firstVisibleTabBtn.click();
      }
    };
  }

  // Reset Section Handlers
  modal.querySelectorAll('.reset-section-btn').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('Reset these settings to their default values?')) return;
      const keys = btn.dataset.keys.split(',').map(k => k.trim());
      if (typeof window.resetSettingsSection === 'function') {
        window.resetSettingsSection(keys);
      }
      
      // Re-render settings modal smoothly by closing and reopening
      const curTab = modal.querySelector('.settings-nav-item.active')?.dataset?.tab;
      modal.remove();
      showSettings();
      if (curTab) {
        const nextTabBtn = document.querySelector(`.settings-nav-item[data-tab="${curTab}"]`);
        if (nextTabBtn) nextTabBtn.click();
      }
      
      // Update affected UI globally
      if (typeof renderLibrary === 'function') renderLibrary();
      if (typeof applyReaderBackground === 'function') applyReaderBackground();
      if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
      if (typeof applyHomeSearchVisibility === 'function') applyHomeSearchVisibility();
      if (typeof applyHomeMode === 'function') applyHomeMode(state.settings.homeMode, { persist: false });
      else {
        if (typeof loadPopularToday === 'function') loadPopularToday();
        if (typeof loadRecentlyAdded === 'function') loadRecentlyAdded();
        if (typeof loadLatestUpdates === 'function') loadLatestUpdates();
      }

      const ind = document.getElementById('settingsSavedIndicator');
      if (ind) {
        ind.style.opacity = '1';
        if (ind._to) clearTimeout(ind._to);
        ind._to = setTimeout(() => { ind.style.opacity = '0'; }, 2000);
      }
    };
  });

  const btnResetAll = $("btnResetAllSettings");
  if (btnResetAll) {
    btnResetAll.onclick = () => {
      if (!confirm('Are you sure you want to reset ALL settings to their default values? This cannot be undone.')) return;
      if (typeof window.resetSettingsSection === 'function' && typeof DEFAULT_SETTINGS !== 'undefined') {
        window.resetSettingsSection(Object.keys(DEFAULT_SETTINGS));
      } else {
        localStorage.removeItem("scrollscapeSettings");
        location.reload();
        return;
      }
      
      modal.remove();
      showSettings();
      const advancedTabBtn = document.querySelector(`.settings-nav-item[data-tab="tab-security"]`);
      if (advancedTabBtn) advancedTabBtn.click();
      
      if (typeof renderLibrary === 'function') renderLibrary();
      if (typeof applyReaderBackground === 'function') applyReaderBackground();
      if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
    };
  }

  const accessPasswordStatusEl = $("accessPasswordStatus");
  if (accessPasswordStatusEl) {
    fetch('/api/auth/status').then(r => r.json()).then(status => {
      accessPasswordStatusEl.textContent = status.passwordSet
        ? 'A password is currently set.'
        : 'No password set — ScrollScape is fully open right now.';
      $("accessPasswordCurrentGroup").style.display = status.passwordSet ? '' : 'none';
    }).catch(() => {
      accessPasswordStatusEl.textContent = 'Could not check current status.';
    });
  }

  const btnSaveAccessPassword = $("btnSaveAccessPassword");
  if (btnSaveAccessPassword) {
    btnSaveAccessPassword.onclick = async () => {
      const newPassword = $("accessPasswordNewInput")?.value || '';
      const currentPassword = $("accessPasswordCurrentInput")?.value || '';
      btnSaveAccessPassword.disabled = true;
      try {
        const resp = await fetch('/api/auth/set-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword, currentPassword }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || 'Could not update the password.');
        showToast('Access Password', newPassword ? 'Password set.' : 'Password removed — ScrollScape is now open.', 'success');
        $("accessPasswordNewInput").value = '';
        $("accessPasswordCurrentInput").value = '';
        if (accessPasswordStatusEl) {
          accessPasswordStatusEl.textContent = data.passwordSet ? 'A password is currently set.' : 'No password set — ScrollScape is fully open right now.';
          $("accessPasswordCurrentGroup").style.display = data.passwordSet ? '' : 'none';
        }
      } catch (err) {
        showToast('Error', err.message || 'Could not update the password.', 'error');
      } finally {
        btnSaveAccessPassword.disabled = false;
      }
    };
  }

  const btnCopyOpdsUrl = $("btnCopyOpdsUrl");
  if (btnCopyOpdsUrl) {
    btnCopyOpdsUrl.onclick = async () => {
      const url = $("opdsCatalogUrl")?.value || '';
      try {
        if (!(await copyTextToClipboard(url))) throw new Error('not copied');
        showToast('OPDS', 'Catalog URL copied.', 'success');
      } catch (_) {
        showToast('OPDS', 'Could not copy — select and copy the URL manually.', 'warning');
      }
    };
  }

  const btnImportMihon = $("btnImportMihon");
  const importMihonFileInput = $("importMihonFileInput");
  if (btnImportMihon && importMihonFileInput) {
    btnImportMihon.onclick = () => importMihonFileInput.click();
    importMihonFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) importMihonBackupFile(file);
      importMihonFileInput.value = '';
    };
  }

  const btnExportMihon = $("btnExportMihon");
  if (btnExportMihon) btnExportMihon.onclick = () => exportMihonBackupFile();

  if (typeof bindProgressSyncCard === 'function') bindProgressSyncCard();
  const btnExportBackup = $("btnExportBackup");
  if (btnExportBackup) btnExportBackup.onclick = () => exportBackup();

  const btnExportCsv = $("btnExportCsv");
  if (btnExportCsv) btnExportCsv.onclick = () => exportLibraryCsv();

  const btnImportBackup = $("btnImportBackup");
  const importBackupFileInput = $("importBackupFileInput");
  if (btnImportBackup && importBackupFileInput) {
    btnImportBackup.onclick = () => importBackupFileInput.click();
    importBackupFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) importBackupFile(file);
      e.target.value = '';
    };
  }

  // Display mode select
  const displayModeSelect = $("displayModeSelect");
  if (displayModeSelect) {
    displayModeSelect.onchange = (e) => {
      if (initializingSettingsModal) return;
      state.settings.displayMode = e.target.value;
      const compactInfoGroup = $("compactInfoGroup");
      if (compactInfoGroup) {
        compactInfoGroup.style.display = e.target.value === 'compact' ? '' : 'none';
      }
      saveSettings();
      renderLibrary();
    };
  }

  const mangaTitleLanguageSelect = $("mangaTitleLanguageSelect");
  if (mangaTitleLanguageSelect) {
    mangaTitleLanguageSelect.onchange = (e) => {
      if (initializingSettingsModal) return;
      state.settings.mangaTitleLanguage = e.target.value;
      saveSettings();
      // Re-render right away with whatever's already cached (mostly
      // nothing, the first time this is turned on), then kick off the
      // background resolve — mangaTitleVariantsBackgroundResolve() itself
      // re-renders the library again once it has real data, so titles
      // fill in progressively instead of blocking the toggle on a full
      // AniList round-trip.
      renderLibrary();
      if (e.target.value !== 'original' && typeof mangaTitleVariantsBackgroundResolve === 'function') {
        mangaTitleVariantsBackgroundResolve();
      }
    };
  }

  // Mangas per row select
  const mangasPerRowSelect = $("mangasPerRowSelect");
  if (mangasPerRowSelect) {
    mangasPerRowSelect.onchange = (e) => {
      if (initializingSettingsModal) return;
      state.settings.mangasPerRow = parseInt(e.target.value, 10);
      saveSettings();
      renderLibrary();
    };
  }

  // Deliberately NOT refreshState() here — that's a full app resync
  // (library, AniList, local files, ratings, popular/recent/latest sweeps
  // across every installed source) and takes many seconds. An action that
  // only changed the source list re-fetches just that. Shared with the
  // "Import a source" card (ui-settings-source-import.js), which calls it
  // after an install or an uninstall; the pickers are redrawn so a source
  // that was just added or removed shows up (or goes) there too.
  // The toggles of the "Disabled sources" list: bound here once at start-up and again every time the list is redrawn.
  const bindDisabledSourceToggles = () => {
    document.querySelectorAll('.disabledSourceToggle').forEach((toggle) => {
      toggle.onchange = (e) => {
        if (initializingSettingsModal) return;
        const sid = toggle.dataset.sourceId;
        const list = new Set(state.settings.disabledSourceIds || []);
        if (e.target.checked) list.add(sid);
        else list.delete(sid);
        state.settings.disabledSourceIds = [...list];
        saveSettings();
        // The server keeps its own copy, so System Health stops testing a source that was turned off.
        if (typeof pushDisabledSourcesToServer === 'function') pushDisabledSourcesToServer(state.settings.disabledSourceIds);
        renderSourceSelect();
        if (typeof loadPopularToday === 'function') loadPopularToday();
        if (typeof loadRecentlyAdded === 'function') loadRecentlyAdded();
        if (typeof loadLatestUpdates === 'function') loadLatestUpdates();
      };
    });
  };

  const refreshSourceReposSection = async () => {
    try {
      const data = await api("/api/state");
      state.installedSources = data.installedSources || {};
      state.availableSources = data.availableSources || [];
      state.repos = data.repos || [];
      if (typeof renderNoSourcesNotice === 'function') renderNoSourcesNotice(); // a source installed or removed changes whether the home page needs its notice
      const disabledSourcesList = $("disabledSourcesList");
      if (disabledSourcesList) {
        disabledSourcesList.innerHTML = buildDisabledSourcesListHtml();
        bindDisabledSourceToggles();
      }
      if (typeof renderSourceSelect === 'function') renderSourceSelect();
    } catch (err) {
      // Said out loud: a list that silently stays as it was looks like an install that did nothing.
      showToast('Error', err.message, 'error');
    }
  };

  bindDisabledSourceToggles();

  const fsInput = $("flaresolverrUrlInput");
  if (fsInput) {
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.ok && data.data && data.data.flaresolverrUrl) {
        fsInput.value = data.data.flaresolverrUrl;
      }
    });
    fsInput.onchange = (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flaresolverrUrl: e.target.value.trim() })
      });
      saveSettings(); // To trigger the saved indicator
    };
  }

  // Proxy for FlareSolverr's own browser (see fetch-utils.js's
  // getProxyConfig) — same load/save shape as flaresolverrUrl above, one
  // field per input since they're 3 independent settings values.
  [['proxyUrlInput', 'proxyUrl'], ['proxyUsernameInput', 'proxyUsername'], ['proxyPasswordInput', 'proxyPassword']].forEach(([id, key]) => {
    const input = $(id);
    if (!input) return;
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.ok && data.data && data.data[key]) input.value = data.data[key];
    });
    input.onchange = (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: e.target.value.trim() })
      });
      saveSettings();
    };
  });

  const cvInput = $("comicVineApiKeyInput");
  if (cvInput) {
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.ok && data.data && data.data.comicVineApiKey) {
        cvInput.value = data.data.comicVineApiKey;
      }
    });
    cvInput.onchange = (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comicVineApiKey: e.target.value.trim() })
      });
      saveSettings();
    };
  }

  // ── Suwayomi Server (Settings -> Suwayomi) ─────────────────────────
  // Same load/save shape as the proxy fields above — 3 independent settings
  // values persisted server-side, read back by the source itself.
  [['suwayomiUrlInput', 'suwayomiUrl'], ['suwayomiUsernameInput', 'suwayomiUsername'], ['suwayomiPasswordInput', 'suwayomiPassword']].forEach(([id, key]) => {
    const input = $(id);
    if (!input) return;
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.ok && data.data && data.data[key]) input.value = data.data[key];
    });
    input.onchange = (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: e.target.value.trim() })
      });
      saveSettings();
    };
  });

  // ── Allow installing sources from other devices (Security tab; middleware/local-only.js) ──
  const allowRemoteImportToggle = $("allowRemoteImportToggle");
  if (allowRemoteImportToggle) {
    fetch('/api/settings').then(r => r.json()).then(data => {
      allowRemoteImportToggle.checked = !!(data.ok && data.data && data.data.allowRemoteImport === true);
    }).catch(() => {});
    allowRemoteImportToggle.onchange = (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRemoteImport: e.target.checked === true })
      });
      saveSettings();
    };
  }

  // The three boxes above show what the settings hold (after the Suwayomi of this computer was set up, or connected).
  const fillSuwayomiInputs = async () => {
    const settings = await fetch('/api/settings').then(r => r.json()).catch(() => null);
    [['suwayomiUrlInput', 'suwayomiUrl'], ['suwayomiUsernameInput', 'suwayomiUsername'], ['suwayomiPasswordInput', 'suwayomiPassword']].forEach(([id, key]) => {
      const input = $(id);
      if (input && settings && settings.ok && settings.data && settings.data[key]) input.value = settings.data[key];
    });
  };

  // Set up, run and remove the Suwayomi-Server of this computer (ui-settings-suwayomi-local.js).
  const suwayomiLocalSlot = $("suwayomiLocalSlot");
  if (suwayomiLocalSlot && typeof mountSuwayomiLocal === 'function') mountSuwayomiLocal(suwayomiLocalSlot, { onConnected: fillSuwayomiInputs });

  // One click: the address and login of the Suwayomi that tools/windows/Setup-Suwayomi.cmd set up on this computer go into the three boxes above.
  const suwayomiConnectBtn = $("suwayomiConnectLocalBtn");
  if (suwayomiConnectBtn) {
    // silent: the first time the tab is opened with nothing set, it looks by itself and says nothing when there is nothing to find.
    const connectLocal = async (silent) => {
      const resultEl = $("suwayomiConnectLocalResult");
      const say = (text) => { if (resultEl) resultEl.textContent = text; };
      say('Looking for it…');
      try {
        const res = await fetch('/api/suwayomi/connect-local', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.ok) { say(silent && res.status === 404 ? '' : `✗ ${data.error || 'Could not connect'}`); return; }
        await fillSuwayomiInputs();
        say(data.reachable ? `✓ Connected — ${data.sourceCount} source(s) available` : 'Saved. It is not answering yet (it may still be starting): try Test Connection in a minute.');
      } catch (err) {
        say(silent ? '' : `✗ ${err.message}`);
      }
    };
    suwayomiConnectBtn.onclick = () => connectLocal(false);
    const suwayomiNav = document.querySelector('.settings-nav-item[data-tab="tab-suwayomi"]');
    if (suwayomiNav) {
      suwayomiNav.addEventListener('click', () => {
        const urlInput = $("suwayomiUrlInput");
        if (urlInput && !urlInput.value.trim()) connectLocal(true);
      }, { once: true });
    }
  }

  const suwayomiTestBtn = $("suwayomiTestBtn");
  if (suwayomiTestBtn) {
    suwayomiTestBtn.onclick = async () => {
      const resultEl = $("suwayomiTestResult");
      if (resultEl) resultEl.textContent = 'Testing…';
      try {
        const res = await fetch('/api/suwayomi/test');
        const data = await res.json();
        if (resultEl) {
          resultEl.textContent = res.ok
            ? `✓ Connected — ${data.sourceCount} source(s) available`
            : `✗ ${data.error || 'Connection failed'}`;
        }
      } catch (err) {
        if (resultEl) resultEl.textContent = `✗ ${err.message}`;
      }
    };
  }

  // ── Discord Rich Presence ────────────────────────────────────────────────
  // Both the toggle and the Client ID are server-side settings (like
  // flaresolverrUrl/comicVineApiKey above), not state.settings/localStorage
  // — the RPC connection is driven from server.js, which has no visibility
  // into the browser's localStorage, so it needs its own authoritative copy.
  // See server/modules/discord-rpc/service.js's applySettings() for how a
  // save here takes effect immediately, without a server restart.
  const discordToggle = $("discordRpcToggle");
  const discordClientIdInput = $("discordClientIdInput");
  const discordStatusLine = $("discordRpcStatusLine");
  let _discordStatusPollTimer = null;

  const renderDiscordStatus = (status) => {
    if (!discordStatusLine) return;
    if (!status || !status.dependencyLoaded) {
      discordStatusLine.textContent = 'Status: unavailable (server dependency failed to load)';
    } else if (!status.enabled) {
      discordStatusLine.textContent = 'Status: off';
    } else if (!status.configured) {
      discordStatusLine.textContent = 'Status: on, but no Client ID set yet';
    } else if (status.connected) {
      discordStatusLine.textContent = 'Status: connected to Discord';
    } else {
      discordStatusLine.textContent = 'Status: waiting for Discord (not running, or still retrying)';
    }
  };

  const pollDiscordStatus = () => {
    fetch('/api/discord-presence/status').then(r => r.json()).then(renderDiscordStatus).catch(() => {
      if (discordStatusLine) discordStatusLine.textContent = 'Status: could not reach the server';
    });
  };

  if (discordToggle || discordClientIdInput) {
    fetch('/api/settings').then(r => r.json()).then(data => {
      const s = (data.ok && data.data) || {};
      if (discordToggle) discordToggle.checked = !!s.discordRichPresenceEnabled;
      if (discordClientIdInput) discordClientIdInput.value = s.discordClientId || '';
    });

    pollDiscordStatus();
    // Only while Settings is open. Wrapping modal.remove() again (rather
    // than piggybacking on _unsubscribeAnilistBadge, which the AniList
    // section further down reassigns wholesale and would silently drop
    // this cleanup) mirrors the same "closing must not leave a dangling
    // subscription" concern this modal already applies to the AniList
    // badge — see modal.remove()'s own override at the top of this function.
    _discordStatusPollTimer = setInterval(pollDiscordStatus, 5000);
    const _preDiscordModalRemove = modal.remove.bind(modal);
    modal.remove = () => {
      if (_discordStatusPollTimer) { clearInterval(_discordStatusPollTimer); _discordStatusPollTimer = null; }
      _preDiscordModalRemove();
    };
  }

  // Saves one Discord setting and SAYS when it could not: these calls used to be fire-and-forget, so a refusal of the server (a login that expired, a change not
  // allowed from this device) looked exactly like a setting that "does not save".
  const saveDiscordSetting = async (patch, what) => {
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      let body = null;
      try { body = await res.json(); } catch (_) { /* no JSON: the status says enough */ }
      if (!res.ok || (body && body.ok === false)) throw new Error((body && body.error) || `the server answered ${res.status}`);
      saveSettings();
      pollDiscordStatus();
      return true;
    } catch (err) {
      showToast('Discord', `Could not save ${what}: ${String((err && err.message) || err).slice(0, 160)}`, 'error');
      return false;
    }
  };

  if (discordToggle) {
    discordToggle.onchange = async (e) => {
      const wanted = e.target.checked;
      if (!(await saveDiscordSetting({ discordRichPresenceEnabled: wanted }, 'the switch'))) e.target.checked = !wanted; // the switch shows what the server has
    };
  }

  if (discordClientIdInput) {
    // The ID is saved while it is typed (after a short pause), when the field is left, and when Settings is closed with the cursor still in it: a "change" is only
    // fired for a field that is LEFT, and closing the window with the ID just pasted did not always leave it, so the ID typed was lost.
    let clientIdDirty = false;
    let clientIdTimer = null;
    const sendClientId = async () => {
      clearTimeout(clientIdTimer);
      if (!clientIdDirty) return; // never sent for a field the person did not touch (it could still be empty because the stored value has not arrived)
      const value = discordClientIdInput.value.trim();
      if (await saveDiscordSetting({ discordClientId: value }, 'the Client ID')) {
        if (discordClientIdInput.value.trim() === value) clientIdDirty = false;
        if (typeof showToast === 'function') showToast('Discord', value ? 'Client ID saved.' : 'Client ID cleared.', 'success');
      }
    };
    discordClientIdInput.oninput = () => {
      clientIdDirty = true;
      clearTimeout(clientIdTimer);
      clientIdTimer = setTimeout(sendClientId, 800);
    };
    discordClientIdInput.onchange = () => { clientIdDirty = true; sendClientId(); };
    const _preClientIdRemove = modal.remove.bind(modal);
    modal.remove = () => { sendClientId(); _preClientIdRemove(); };
  }

  // Protected-sites card (the FlareSolverr session pool): ui-settings-solver.js adds it to the Integrations tab.
  if (typeof mountSolverSettingsCard === 'function') mountSolverSettingsCard(modal, saveSettings);

  // Import-a-source card: ui-settings-source-import.js adds it to the Advanced tab, after the Source Repositories card.
  if (typeof mountSourceImportCard === 'function') mountSourceImportCard(modal, refreshSourceReposSection);

  const showCompactInfoToggle = $("showCompactInfoToggle");
  if (showCompactInfoToggle) {
    showCompactInfoToggle.onchange = (e) => {
      if (initializingSettingsModal) return;
      state.settings.showCompactInfo = e.target.checked;
      saveSettings();
      renderLibrary();
    };
  }

  $("modeSelect").onchange = (e) => {
    state.settings.readingMode = e.target.value;
    saveSettings();
    if (state.currentChapter) { 
      if (typeof showReader === 'function') showReader();
      if (typeof renderPage === 'function') renderPage();
    }
  };
  const webtoonTurnBtnSelect = $("webtoonTurnButtonPlacementSelect");
  if (webtoonTurnBtnSelect) {
    webtoonTurnBtnSelect.onchange = (e) => {
      state.settings.webtoonTurnButtonPlacement = e.target.value === 'bottom' ? 'bottom' : 'corners';
      saveSettings();
      if (state.currentChapter) { showReader(); renderPage(); }
    };
  }
  const webtoonTurnButtonsToggle = $("webtoonTurnButtonsToggle");
  if (webtoonTurnButtonsToggle) {
    webtoonTurnButtonsToggle.onchange = (e) => {
      state.settings.webtoonTurnButtonsEnabled = e.target.checked;
      saveSettings();
      if (state.currentChapter) { showReader(); renderPage(); }
    };
  }
  const autoLoadNextChapterToggle = $("autoLoadNextChapterToggle");
  if (autoLoadNextChapterToggle) {
    autoLoadNextChapterToggle.onchange = (e) => {
      state.settings.autoLoadNextChapter = e.target.checked;
      saveSettings();
      if (state.currentChapter) { showReader(); renderPage(); }
    };
  }
  const ensureAutoScrollSpeedConfig = () => {
    const defaults = [0.2, 0.5, 1.0, 2.0, 3.5];
    const raw = Array.isArray(state.settings.autoScrollPointSpeeds)
      ? state.settings.autoScrollPointSpeeds
      : defaults;
    state.settings.autoScrollPointSpeeds = defaults.map((fallback, idx) => {
      const n = Number(raw[idx]);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(12, Math.max(0.05, n));
    });
  };
  ensureAutoScrollSpeedConfig();

  const bindAutoScrollPointSpeed = (point) => {
    const input = $(`autoScrollPointSpeed${point}`);
    const label = $(`autoScrollPointSpeed${point}Label`);
    if (!input || !label) return;
    const idx = point - 1;
    const current = Number(state.settings.autoScrollPointSpeeds[idx] ?? input.value);
    input.value = Number.isFinite(current) ? String(current) : String(input.value);
    label.textContent = `${Number(input.value).toFixed(2)} px/f`;
    input.oninput = (e) => {
      const value = Math.min(12, Math.max(0.05, Number(e.target.value) || 0.05));
      state.settings.autoScrollPointSpeeds[idx] = value;
      label.textContent = `${value.toFixed(2)} px/f`;
      saveSettings();
      if (state.autoScroll?.enabled && Number(state.autoScroll.speed) === point) {
        if (typeof stopAutoScroll === 'function') stopAutoScroll();
        if (typeof startAutoScroll === 'function') startAutoScroll();
      }
    };
  };
  bindAutoScrollPointSpeed(1);
  bindAutoScrollPointSpeed(2);
  bindAutoScrollPointSpeed(3);
  bindAutoScrollPointSpeed(4);
  bindAutoScrollPointSpeed(5);

  $("sharpnessSelect").onchange = (e) => {
    state.settings.lineSharpness = parseInt(e.target.value, 10);
    saveSettings();
    const pw = $("pageWrap");
    if (pw) {
      pw.classList.remove('sharp-1', 'sharp-2', 'sharp-3');
      if (state.settings.lineSharpness > 0) pw.classList.add(`sharp-${state.settings.lineSharpness}`);
    }
  };
  $("skipReadToggle").onchange = (e) => {
    state.settings.skipReadChapters = e.target.checked;
    saveSettings();
    if (state.currentManga) loadChapters();
  };
  $("skipDuplicatesToggle").onchange = (e) => {
    state.settings.skipDuplicates = e.target.checked;
    saveSettings();
  };
  $("panWideToggle").onchange = (e) => {
    state.settings.panWideImages = e.target.checked;
    saveSettings();
    if (state.currentChapter) renderPage();
  };  const autoWebtoonToggle = $('autoWebtoonToggle');
  if (autoWebtoonToggle) {
    autoWebtoonToggle.onchange = (e) => {
      state.settings.autoWebtoonDetect = e.target.checked;
      saveSettings();
    };
  }  const pageFlipAnimationToggle = $('pageFlipAnimationToggle');
  if (pageFlipAnimationToggle) {
    pageFlipAnimationToggle.onchange = (e) => {
      state.settings.pageFlipAnimation = e.target.checked;
      saveSettings();
    };
  }

  const readerBgSelect = $('readerBgSelect');
  if (readerBgSelect) {
    readerBgSelect.onchange = (e) => {
      state.settings.readerBackground = e.target.value;
      saveSettings();
      applyReaderBackground();
    };
  }

  const showBookSpineToggle = $('showBookSpineToggle');
  if (showBookSpineToggle) {
    showBookSpineToggle.onchange = (e) => {
      state.settings.showBookSpine = e.target.checked;
      saveSettings();
      if (state.currentChapter) { showReader(); renderPage(); }
    };
  }

  const readerNoiseToggle = $('readerNoiseToggle');
  if (readerNoiseToggle) {
    readerNoiseToggle.onchange = (e) => {
      state.settings.readerNoiseEnabled = e.target.checked;
      saveSettings();
      const bgGroup  = $('readerBgColorGroup');
      const wpOpts   = $('readerWallpaperOptions');
      if (bgGroup)  bgGroup.style.display  = e.target.checked ? 'none' : '';
      if (wpOpts)   wpOpts.style.display   = e.target.checked ? '' : 'none';
      if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
    };
  }

  const readerNoiseSourceSelect = $('readerNoiseSourceSelect');
  if (readerNoiseSourceSelect) {
    readerNoiseSourceSelect.onchange = (e) => {
      state.settings.readerNoiseSource = e.target.value;
      saveSettings();
      const gifGroup = $('readerNoiseGifGroup');
      if (gifGroup) gifGroup.style.display = e.target.value === 'gif' ? '' : 'none';
      if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
    };
  }

  // Populate wallpaper file list
  (async () => {
    const fileSelect = $('readerNoiseGifFileSelect');
    if (!fileSelect) return;
    try {
      const data = await fetch('/api/reader-wallpapers').then(r => r.json());
      const files = data.files || [];
      const current = state.settings.readerNoiseGifFile || '';
      if (files.length === 0) {
        fileSelect.innerHTML = '<option value="">— no GIF/WebP files found in public/ —</option>';
      } else {
        fileSelect.innerHTML = files.map(f =>
          `<option value="${f}" ${f === current ? 'selected' : ''}>${f}</option>`
        ).join('');
        if (!current && files.length > 0) {
          state.settings.readerNoiseGifFile = files[0];
          saveSettings();
        }
      }
    } catch { /* server may not be updated yet */ }
    fileSelect.onchange = (e) => {
      state.settings.readerNoiseGifFile = e.target.value;
      saveSettings();
      if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
    };
  })();


  // Overlay toggles (downloaded, unread, local)
  const overlayDownloaded = $("toggleOverlayDownloaded");
  if (overlayDownloaded) {
    overlayDownloaded.onchange = (e) => {
      if (!state.settings.overlays) state.settings.overlays = {};
      state.settings.overlays.downloaded = e.target.checked;
      saveSettings();
      renderLibrary();
    };
  }
  const overlayUnread = $("toggleOverlayUnread");
  if (overlayUnread) {
    overlayUnread.onchange = (e) => {
      if (!state.settings.overlays) state.settings.overlays = {};
      state.settings.overlays.unread = e.target.checked;
      saveSettings();
      renderLibrary();
    };
  }
  const overlayLocal = $("toggleOverlayLocal");
  if (overlayLocal) {
    overlayLocal.onchange = (e) => {
      if (!state.settings.overlays) state.settings.overlays = {};
      state.settings.overlays.local = e.target.checked;
      saveSettings();
      renderLibrary();
    };
  }

  const showHomeSearchToggle = $("showHomeSearchToggle");
  if (showHomeSearchToggle) {
    showHomeSearchToggle.onchange = (e) => {
      state.settings.showHomeSearch = e.target.checked;
      saveSettings();
      if (typeof applyHomeSearchVisibility === 'function') applyHomeSearchVisibility();
    };
  }

  const refreshHomeRows = () => {
    if (typeof loadPopularToday === 'function') loadPopularToday();
    if (typeof loadRecentlyAdded === 'function') loadRecentlyAdded();
    if (typeof loadLatestUpdates === 'function') loadLatestUpdates();
  };

  const homeModeSelect = $("homeModeSelect");
  if (homeModeSelect) {
    homeModeSelect.onchange = (e) => {
      if (typeof applyHomeMode === 'function') applyHomeMode(e.target.value === 'anime' ? 'anime' : 'manga');
    };
  }

  const homeSourceModeSelect = $("homeSourceModeSelect");
  const homeSourceSelectionGroup = $("homeSourceSelectionGroup");
  if (homeSourceModeSelect) {
    homeSourceModeSelect.onchange = (e) => {
      state.settings.homeSourceMode = e.target.value === 'selected' ? 'selected' : 'all';
      saveSettings();
      if (homeSourceSelectionGroup) {
        homeSourceSelectionGroup.style.display = state.settings.homeSourceMode === 'selected' ? '' : 'none';
      }
      refreshHomeRows();
    };
  }

  modal.querySelectorAll('.home-source-option').forEach(cb => {
    cb.onchange = () => {
      const selected = [...modal.querySelectorAll('.home-source-option:checked')].map(el => el.value);
      state.settings.homeSelectedSourceIds = [...new Set(selected)];
      saveSettings();
      if (state.settings.homeSourceMode === 'selected') refreshHomeRows();
    };
  });

  const hideNsfwToggle = $("hideNsfwToggle");
  if (hideNsfwToggle) {
    hideNsfwToggle.onchange = (e) => {
      state.settings.hideNsfw = e.target.checked;
      saveSettings();

      let advChanged = false;
      if (typeof applyAdvancedSearchNsfwVisibility === 'function') {
        advChanged = applyAdvancedSearchNsfwVisibility();
      }

      const advView = document.querySelector("#view-advanced-search");
      if (advView && !advView.classList.contains("hidden") && advChanged) {
        advancedSearch(1);
      }

      // Atualizar todas as views principais
      if (typeof renderLibrary === 'function') renderLibrary();
      if (typeof renderCalendarView === 'function') renderCalendarView();
      // Atualiza Discover (home rows)
      if (typeof window.loadPopularToday === 'function') window.loadPopularToday();
      if (typeof window.loadRecentlyAdded === 'function') window.loadRecentlyAdded();
      if (typeof window.loadLatestUpdates === 'function') window.loadLatestUpdates();
      // The recommended row and Continue Reading are drawn from other code than the three rows above: they stayed as they were until a reload.
      if (window._homeSeenManga) window._homeSeenManga.clear(); // drawn again from scratch, as at start-up
      if (typeof loadRecommendations === 'function') loadRecommendations();
      if (typeof renderContinueReading === 'function') renderContinueReading();
      // Atualiza Search se estiver visível
      const searchView = document.querySelector('#view-search');
      if (searchView && !searchView.classList.contains('hidden') && typeof window.search === 'function') window.search(1);
    };
  }

  const bookshelfToggle = $("libraryBookshelf3dToggle");
  if (bookshelfToggle) {
    bookshelfToggle.addEventListener("change", (e) => {
      state.settings.libraryBookshelf3d = e.target.checked;
      saveSettings();
      if (typeof window.renderLibrary === "function") window.renderLibrary();
    });
  }

  const libraryDefaultStatusSel = $("libraryDefaultStatusFilterSelect");
  if (libraryDefaultStatusSel) {
    libraryDefaultStatusSel.onchange = (e) => {
      state.settings.libraryDefaultStatusFilter = e.target.value || 'all';
      saveSettings();
    };
  }

  const statusBadgeLocSel = $("statusBadgeLocationSelect");
  if (statusBadgeLocSel) {
    statusBadgeLocSel.onchange = (e) => {
      state.settings.statusBadgeLocation = e.target.value || 'cover';
      saveSettings();
      renderLibrary();
    };
  }

  const uiThemeSelect = $("uiThemeSelect");
  if (uiThemeSelect) {
    uiThemeSelect.onchange = (e) => {
      const themeId = e.target.value;
      if (typeof setActiveTheme === 'function') {
        setActiveTheme(themeId);
      }
      if (typeof renderThemesView === 'function') {
        renderThemesView();
      }
      if (typeof renderShopView === 'function') {
        renderShopView();
      }
    };
  }

  const btnGoToThemeShop = $("btnGoToThemeShop");
  if (btnGoToThemeShop) {
    btnGoToThemeShop.onclick = () => {
      modal.remove();
      if (typeof setView === 'function') {
        setView('shop');
      }
    };
  }

  // ── Anime tab ─────────────────────────────────────────────────────────
  // Card-display fields live in localStorage (scrollscape.animeLibraryCardSettings,
  // see ui-anime-test.js), not state.settings — same mechanism the per-page
  // "Customize Library Card" modal on the My Anime toolbar already uses, so
  // both surfaces stay in sync without a separate settings key.
  const animeCardToggleIds = {
    showProgressBar: 'animeSetCardProgressBar',
    showEpisodeLabel: 'animeSetCardEpisodeLabel',
    showTags: 'animeSetCardTags',
    showStatus: 'animeSetCardStatus',
  };
  Object.entries(animeCardToggleIds).forEach(([key, id]) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      if (typeof loadAnimeLibraryCardSettings !== 'function' || typeof saveAnimeLibraryCardSettings !== 'function') return;
      const settings = loadAnimeLibraryCardSettings();
      settings[key] = el.checked;
      saveAnimeLibraryCardSettings(settings);
      if (typeof _animeApplyLibraryFilters === 'function') _animeApplyLibraryFilters();
    };
  });

  modal.querySelectorAll('.animeSetProviderOption').forEach(cb => {
    cb.onchange = () => {
      const checked = [...modal.querySelectorAll('.animeSetProviderOption:checked')].map(el => el.value);
      state.settings.visibleAnimeProviders = checked.length ? (typeof _animeFallbackOrder === 'function' ? _animeFallbackOrder(checked) : checked) : (typeof DEFAULT_VISIBLE_ANIME_PROVIDERS !== 'undefined' ? DEFAULT_VISIBLE_ANIME_PROVIDERS : []);
      saveSettings();
      if (typeof _animeSyncProviderSelectOptions === 'function') _animeSyncProviderSelectOptions();
    };
  });

  async function runCheatCommand(cmd) {
    switch ((cmd || '').trim().toLowerCase()) {
      case 'cls':
        achievementManager.reset();
        localStorage.setItem('scrollscape_ap_bonus', '0');
        localStorage.setItem('scrollscape_ap_spent', '0');
        _pushProgressionToServer({ resetAll: true });
        updateApBadge();
        showToast('Reset complete', 'All AP and achievements cleared.', 'info');
        break;
      case 'godmode':
        addBonusAP(500);
        updateApBadge();
        showToast('Godmode activated', '+500 AP added to your wallet.', 'success');
        break;
      case 'lcls':
        try {
          const res = await fetch('/api/library/clear', { method: 'DELETE' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          state.favorites = [];
          state.readingStatus = {};
          state.customLists = [];
          renderLibrary();
          showToast('Library cleared', 'Favorites, reading status and lists were removed.', 'success');
        } catch (e) {
          showToast('Clear failed', e?.message || 'Could not clear library.', 'warning');
        }
        break;
      default:
        showToast('Unknown command', `"${cmd}" is not a valid command.`, 'warning');
    }
  }
  $('cheatRunBtn').onclick = async () => {
    const inp = $('cheatInput');
    await runCheatCommand(inp.value);
    inp.value = '';
  };
  $('cheatInput').onkeydown = async (e) => {
    if (e.key === 'Enter') { await runCheatCommand($('cheatInput').value); $('cheatInput').value = ''; }
  };

  const genreBlacklistInput = $('genreBlacklistInput');
  if (genreBlacklistInput) {
    genreBlacklistInput.onchange = (e) => {
      const val = e.target.value || '';
      const list = val.split(/[,|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      state.settings.genreBlacklist = list;
      saveSettings();
      if (typeof applyAdvancedSearchNsfwVisibility === 'function') {
        applyAdvancedSearchNsfwVisibility();
      }
      // The home rows were drawn with the old list: draw them again, as Hide NSFW does.
      if (typeof window.loadPopularToday === 'function') window.loadPopularToday();
      if (typeof window.loadRecentlyAdded === 'function') window.loadRecentlyAdded();
      if (typeof window.loadLatestUpdates === 'function') window.loadLatestUpdates();
      if (window._homeSeenManga) window._homeSeenManga.clear();
      if (typeof loadRecommendations === 'function') loadRecommendations();
    };
  }

  $("clearReadBtn").onclick = async () => {
    if (confirm("Clear all reading history?")) {
      try { await fetch("/api/history/clear", { method: "DELETE" }); } catch (_) {}
      state.history = [];
      state.readChapters.clear();
      state.flaggedChapters.clear();
      state.lastReadPages = {};
      state.lastReadChapter = {};
      saveSettings();
      if (state.currentManga) loadChapters();
      modal.remove();
      renderLibrary();
      showToast("Reading history cleared", "", "info");
    }
  };

  const btnSyncLibraryStatus = $("btnSyncLibraryStatus");
  if (btnSyncLibraryStatus) {
    btnSyncLibraryStatus.onclick = async () => {
      const resSpan = $("syncLibraryStatusResult");
      btnSyncLibraryStatus.disabled = true;
      btnSyncLibraryStatus.textContent = "Syncing...";
      if (resSpan) resSpan.textContent = "";

      try {
        const response = await fetch("/api/library/sync-status", { method: "POST" });
        const data = await response.json();
        
        if (data.ok) {
          if (resSpan) resSpan.textContent = `Updated ${data.updated} mangas.`;
          showToast("Sync Complete", `Updated status for ${data.updated} mangas.`, "success");
          if (data.updated > 0) {
            renderLibrary(); // Re-render to show updated badges if any
          }
        } else {
          if (resSpan) resSpan.textContent = "Sync failed.";
          showToast("Sync Failed", data.error || "Unknown error occurred.", "error");
        }
      } catch (err) {
        if (resSpan) resSpan.textContent = "Error.";
        showToast("Sync Error", err.message, "error");
      } finally {
        btnSyncLibraryStatus.disabled = false;
        btnSyncLibraryStatus.textContent = "Sync Library Status";
      }
    };
  }

  const btnSyncAnimeLibraryStatus = $("btnSyncAnimeLibraryStatus");
  if (btnSyncAnimeLibraryStatus) {
    btnSyncAnimeLibraryStatus.onclick = async () => {
      const resSpan = $("syncAnimeLibraryStatusResult");
      btnSyncAnimeLibraryStatus.disabled = true;
      btnSyncAnimeLibraryStatus.textContent = "Syncing...";
      if (resSpan) resSpan.textContent = "";

      try {
        const data = await syncAnimeLibraryStatus();
        if (data.ok) {
          if (resSpan) resSpan.textContent = `Updated ${data.updated} anime.`;
          showToast("Sync Complete", `Updated status for ${data.updated} anime.`, "success");
        } else {
          if (resSpan) resSpan.textContent = "Sync failed.";
          showToast("Sync Failed", data.error || "Unknown error occurred.", "error");
        }
      } catch (err) {
        if (resSpan) resSpan.textContent = "Error.";
        showToast("Sync Error", err.message, "error");
      } finally {
        btnSyncAnimeLibraryStatus.disabled = false;
        btnSyncAnimeLibraryStatus.textContent = "Sync Anime Library Status";
      }
    };
  }

  // ── AniList settings handlers ──────────────────────────────────────────────
  const alClientInput = $('anilistClientIdInput');
  if (alClientInput) {
    alClientInput.oninput = () => _alSetClientId(alClientInput.value.trim());
  }
  const btnConnect = $('btnAniListConnect');
  if (btnConnect) {
    btnConnect.onclick = () => {
      if (alClientInput) _alSetClientId(alClientInput.value.trim());
      anilistOAuthConnect();
    };
  }
  const btnDisconnect = $('btnAniListDisconnect');
  if (btnDisconnect) {
    btnDisconnect.onclick = () => {
      _alDisconnect();
      $('anilist-loggedin').style.display = 'none';
      $('anilist-loggedout').style.display = '';
      showToast('AniList', 'Disconnected.', 'info');
    };
  }
  const alAutoToggle = $('anilistAutoSyncToggle');
  if (alAutoToggle) {
    alAutoToggle.onchange = (e) => {
      state.settings.anilistAutoSync = e.target.checked;
      saveSettings();
    };
  }
  const alShowTrackerOnAddToggle = $('anilistShowTrackerOnAddToggle');
  if (alShowTrackerOnAddToggle) {
    alShowTrackerOnAddToggle.onchange = (e) => {
      state.settings.anilistShowTrackerOnAdd = e.target.checked;
      saveSettings();
    };
  }
  const alAutoImportToggle = $('anilistAutoImportToggle');
  if (alAutoImportToggle) {
    alAutoImportToggle.onchange = (e) => {
      state.settings.anilistAutoImportOnConnect = e.target.checked;
      saveSettings();
    };
  }
  const alAutoCatToggle = $('anilistAutoCategorizeToggle');
  if (alAutoCatToggle) {
    alAutoCatToggle.onchange = (e) => {
      state.settings.anilistAutoCategorize = e.target.checked;
      saveSettings();
    };
  }
  const alImportCategorySelect = $('anilistImportCategorySelect');
  if (alImportCategorySelect) {
    alImportCategorySelect.onchange = (e) => {
      state.settings.anilistImportCategoryId = e.target.value;
      saveSettings();
    };
  }
  const alKeepCoverToggle = $('anilistKeepCoverToggle');
  if (alKeepCoverToggle) {
    alKeepCoverToggle.onchange = (e) => {
      state.settings.anilistKeepCover = e.target.checked;
      saveSettings();
    };
  }
  const btnNewAlImportCategory = $('btnNewAnilistImportCategory');
  if (btnNewAlImportCategory) {
    btnNewAlImportCategory.onclick = () => {
      showListFormModal(null, async () => {
        await _listsReload();
        const newList = state.customLists[state.customLists.length - 1];
        if (newList) {
          state.settings.anilistImportCategoryId = newList.id;
          saveSettings();
        }
        showSettings();
        const trackingTabBtn = document.querySelector('.settings-nav-item[data-tab="tab-tracking"]');
        if (trackingTabBtn) trackingTabBtn.click();
      });
    };
  }
  if (typeof bindAniListStatusRestore === 'function') bindAniListStatusRestore();
  if (typeof bindAniListProgressRestore === 'function') bindAniListProgressRestore();
  const btnImportNow = $('btnAniListImportNow');
  if (btnImportNow) {
    const progressWrap = $('anilistImportProgressWrap');
    const progressFill = $('anilistImportProgressFill');
    const progressText = $('anilistImportProgressText');
    const setProgress = (pct, txt) => {
      if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
      if (progressText && txt) progressText.textContent = txt;
    };

    // Subscribed unconditionally (not just after clicking "Start Import")
    // so that reopening Settings while an import kicked off from an
    // earlier, since-closed modal is still running shows real progress
    // instead of a blank/default button — the import itself was never
    // tied to this modal's lifetime in the first place (see
    // anilist.js's shared progress channel).
    _unsubscribeAnilistBadge = anilistSubscribeImportProgress(({ percent, label, running }) => {
      if (running) {
        btnImportNow.disabled = true;
        btnImportNow.textContent = 'Importing...';
        if (progressWrap) progressWrap.classList.remove('hidden');
        setProgress(percent, label || 'Importing…');
      } else {
        btnImportNow.disabled = false;
        btnImportNow.textContent = '↓ Import Library Now';
      }
    });
    if (typeof anilistGetImportState === 'function') {
      const importState = anilistGetImportState();
      if (importState.running) {
        btnImportNow.disabled = true;
        btnImportNow.textContent = 'Importing...';
        if (progressWrap) progressWrap.classList.remove('hidden');
        setProgress(importState.percent, importState.label || 'Importing…');
      }
    }

    btnImportNow.onclick = (e) => {
      if ($('anilistImportMenu')) {
        $('anilistImportMenu').remove();
        return;
      }

      const menu = document.createElement('div');
      menu.id = 'anilistImportMenu';
      menu.className = 'context-menu';
      menu.style.position = 'absolute';
      menu.style.zIndex = '9999';
      menu.style.padding = '12px';
      
      menu.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px;font-size:0.9rem">Select Statuses to Import:</div>
        <label style="display:flex;align-items:center;margin-bottom:6px;cursor:pointer"><input type="checkbox" class="import-status-cb" value="CURRENT" checked style="margin-right:8px"> Reading</label>
        <label style="display:flex;align-items:center;margin-bottom:6px;cursor:pointer"><input type="checkbox" class="import-status-cb" value="COMPLETED" checked style="margin-right:8px"> Completed</label>
        <label style="display:flex;align-items:center;margin-bottom:6px;cursor:pointer"><input type="checkbox" class="import-status-cb" value="DROPPED" checked style="margin-right:8px"> Dropped</label>
        <label style="display:flex;align-items:center;margin-bottom:6px;cursor:pointer"><input type="checkbox" class="import-status-cb" value="PAUSED" checked style="margin-right:8px"> On Hold</label>
        <label style="display:flex;align-items:center;margin-bottom:12px;cursor:pointer"><input type="checkbox" class="import-status-cb" value="PLANNING" checked style="margin-right:8px"> Plan to Read</label>
        <button class="btn primary" id="btnConfirmImport" style="width:100%;font-size:0.85rem;padding:6px">Start Import</button>
      `;

      document.body.appendChild(menu);
      const rect = btnImportNow.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      menu.style.left = (rect.left + window.scrollX) + 'px';

      const closeMenu = (ev) => {
        if (!menu.contains(ev.target) && ev.target !== btnImportNow) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);

      menu.querySelector('#btnConfirmImport').onclick = async () => {
        const selectedStatuses = [...menu.querySelectorAll('.import-status-cb:checked')].map(cb => cb.value);
        menu.remove();
        document.removeEventListener('click', closeMenu);

        if (selectedStatuses.length === 0) {
          showToast('Import', 'Please select at least one status to import.', 'warning');
          return;
        }

        // Button/progress-bar state from here on is driven entirely by the
        // anilistSubscribeImportProgress() subscription set up above (it
        // fires for every report() call inside anilistImportLibrary
        // regardless of which modal instance is open, or none at all) —
        // no separate onProgress callback needed here.
        setProgress(0, 'Starting AniList import…');

        try {
          const r = await anilistImportLibrary({ statuses: selectedStatuses, keepCover: state.settings.anilistKeepCover });

          const sync = state.anilistSync;
          if (sync?.lastImportAt) {
            const d = new Date(sync.lastImportAt).toLocaleString();
            const syncLine = `Last import: <strong>${escapeHtml(d)}</strong> &mdash; ${sync.importedCount || 0} new, ${sync.overwriteCount || 0} updated`;
            const label = $('anilistLastImportLabel');
            if (label) {
              label.innerHTML = syncLine;
              label.style.display = '';
            }
          }
          if (!r?.ok) {
            showToast('AniList Import', `Import stopped: ${r?.error || 'unable to complete'}`, 'warning');
          }
        } catch (err) {
          showToast('AniList Import', err?.message || 'Import failed.', 'error');
        }
      };
    };
  }
}

window.showSettings = showSettings;

