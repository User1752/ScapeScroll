// ============================================================================
// SYSTEM HEALTH PAGE
// ============================================================================

(function () {
  'use strict';

  function tr(key, fallback) {
    if (typeof t === 'function') {
      const value = t(key);
      if (value && value !== key) return value;
    }
    return fallback;
  }

  const ROUTE_MANIFEST = [
    { view: 'discover', labelKey: 'nav.home', fallbackLabel: 'Home', renderFn: null },
    { view: 'advanced-search', labelKey: 'nav.search', fallbackLabel: 'Advanced Search', renderFn: 'advancedSearch' },
    { view: 'seasons', labelKey: 'nav.seasons', fallbackLabel: 'Seasons', renderFn: 'renderSeasonsView' },
    { view: 'library', labelKey: 'nav.library', fallbackLabel: 'Library', renderFn: 'renderLibrary' },
    { view: 'updates', labelKey: 'nav.updates', fallbackLabel: 'Updates', renderFn: 'renderUpdatesView' },
    { view: 'history', labelKey: 'nav.history', fallbackLabel: 'History', renderFn: 'renderHistoryView' },
    { view: 'calendar', labelKey: 'nav.calendar', fallbackLabel: 'Calendar', renderFn: 'renderCalendarView' },
    { view: 'analytics', labelKey: 'nav.analytics', fallbackLabel: 'Analytics', renderFn: 'renderAnalyticsView' },
    { view: 'achievements', labelKey: 'nav.achievements', fallbackLabel: 'Achievements', renderFn: 'renderAchievementsView' },
    { view: 'themes', labelKey: 'nav.themes', fallbackLabel: 'Themes', renderFn: 'renderThemesView' },
    { view: 'shop', labelKey: 'nav.shop', fallbackLabel: 'Shop', renderFn: 'renderShopView' },
    { view: 'customize', labelKey: 'nav.customize', fallbackLabel: 'Customize', renderFn: 'renderCustomizeView' },
    { view: 'system-health', labelKey: 'nav.systemHealth', fallbackLabel: 'System Health', renderFn: 'renderSystemHealthPage' },
    { view: 'manga-details', labelKey: 'systemHealth.route.mangaDetails', fallbackLabel: 'Manga Details', renderFn: 'loadMangaDetails' },
  ];

  let lastSmokeResult = null;
  let lastHealthData = null;
  let lastImageQualityResult = null;
  let lastDependencyCheckResult = null;
  let healthLoadedOnce = false;

  function esc(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function titleStatus(status) {
    if (status === 'fail') return tr('systemHealth.status.fail', 'Fail');
    if (status === 'warning') return tr('systemHealth.status.warning', 'Warning');
    return tr('systemHealth.status.pass', 'Pass');
  }

  function statusClass(status) {
    if (status === 'fail') return 'is-fail';
    if (status === 'warning') return 'is-warning';
    return 'is-pass';
  }

  function safeTextById(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function safeHtmlById(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function formatTimestamp(iso) {
    if (!iso) return tr('systemHealth.status.never', 'Never');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function renderSummaryCards(healthData) {
    const overall = healthData?.overallStatus || 'fail';
    const dbStatus = healthData?.database?.status || 'fail';
    const smokeStatus = lastSmokeResult?.overallStatus || 'warning';
    const sourcesStatus = healthData?.sources?.status || 'warning';
    const sourceSummary = healthData?.sources?.summary || { total: 0, passing: 0, failing: 0 };
    const imageQualityStatus = lastImageQualityResult?.overallStatus || 'warning';
    const dependencyCheckStatus = lastDependencyCheckResult?.overallStatus || 'warning';

    const overallBadge = document.getElementById('systemHealthOverallBadge');
    const dbBadge = document.getElementById('systemHealthDatabaseBadge');
    const smokeBadge = document.getElementById('systemHealthSmokeBadge');
    const sourcesBadge = document.getElementById('systemHealthSourcesBadge');
    const imageQualityBadge = document.getElementById('systemHealthImageQualityBadge');
    const dependencyCheckBadge = document.getElementById('systemHealthDependencyCheckBadge');

    if (overallBadge) {
      overallBadge.className = 'sh-status-badge ' + statusClass(overall);
      overallBadge.textContent = titleStatus(overall);
    }
    if (dbBadge) {
      dbBadge.className = 'sh-status-badge ' + statusClass(dbStatus);
      dbBadge.textContent = titleStatus(dbStatus);
    }
    if (smokeBadge) {
      smokeBadge.className = 'sh-status-badge ' + statusClass(smokeStatus);
      smokeBadge.textContent = titleStatus(smokeStatus);
    }
    if (sourcesBadge) {
      sourcesBadge.className = 'sh-status-badge ' + statusClass(sourcesStatus);
      sourcesBadge.textContent = titleStatus(sourcesStatus);
    }
    if (imageQualityBadge) {
      imageQualityBadge.className = 'sh-status-badge ' + statusClass(imageQualityStatus);
      imageQualityBadge.textContent = lastImageQualityResult ? titleStatus(imageQualityStatus) : tr('systemHealth.status.notRun', 'Not run');
    }
    if (dependencyCheckBadge) {
      dependencyCheckBadge.className = 'sh-status-badge ' + statusClass(dependencyCheckStatus);
      dependencyCheckBadge.textContent = lastDependencyCheckResult ? titleStatus(dependencyCheckStatus) : tr('systemHealth.status.notRun', 'Not run');
    }

    safeTextById('systemHealthTimestamp', formatTimestamp(healthData?.app?.timestamp));
    safeTextById('systemHealthSmokeTimestamp', formatTimestamp(lastSmokeResult?.timestamp));
    safeTextById('systemHealthImageQualityTimestamp', formatTimestamp(lastImageQualityResult?.timestamp));
    safeTextById('systemHealthDependencyCheckTimestamp', formatTimestamp(lastDependencyCheckResult?.timestamp));
    safeTextById(
      'systemHealthSourcesSummary',
      sourceSummary.total > 0
        ? `${sourceSummary.passing}/${sourceSummary.total} ${tr('systemHealth.label.sourcesPassing', 'sources passing')}`
        : tr('systemHealth.status.noSourcesSummary', 'No sources detected')
    );
  }

  function renderSourceDiagnostics(sources) {
    const results = Array.isArray(sources?.results) ? sources.results : [];
    if (!results.length) {
      safeHtmlById('systemHealthSourcesGrid', `<p class="sh-empty">${esc(tr('systemHealth.status.noSources', 'No source diagnostics available.'))}</p>`);
      return;
    }

    safeHtmlById('systemHealthSourcesGrid', results.map((source) => `
      <div class="sh-module-card">
        <div class="sh-module-head">
          <span class="sh-module-label">${esc(source.name || source.id)}</span>
          <span class="sh-status-dot ${statusClass(source.status)}">${esc(titleStatus(source.status))}</span>
        </div>
        <p class="sh-module-id">${esc(source.id)}</p>
        <p class="sh-module-details">${esc(source.error || tr('systemHealth.status.sourceHealthy', 'Source is healthy'))}</p>
        ${source.errorCode ? `<p class="sh-module-id">${esc(source.errorCode)} · ${esc(source.errorLabel || '')}</p>` : ''}
        ${source.suggestedAction ? `<p class="sh-module-details">${esc(source.suggestedAction)}</p>` : ''}
      </div>
    `).join(''));
  }

  // Anime sources and external services use the same card shape as manga
  // source diagnostics but without the errorCode/suggestedAction fields
  // (those come from classifySourceError() in the backend, which only
  // manga sources' error-log entries feed into) — kept as a separate
  // renderer rather than overloading renderSourceDiagnostics so that one
  // doesn't need an increasingly conditional template.
  function renderSimpleDiagnosticsGrid(elementId, results, emptyMessageKey, emptyMessageFallback) {
    const list = Array.isArray(results) ? results : [];
    if (!list.length) {
      safeHtmlById(elementId, `<p class="sh-empty">${esc(tr(emptyMessageKey, emptyMessageFallback))}</p>`);
      return;
    }

    safeHtmlById(elementId, list.map((item) => `
      <div class="sh-module-card">
        <div class="sh-module-head">
          <span class="sh-module-label">${esc(item.name || item.id)}</span>
          <span class="sh-status-dot ${statusClass(item.status)}">${esc(titleStatus(item.status))}</span>
        </div>
        <p class="sh-module-id">${esc(item.id)}</p>
        <p class="sh-module-details">${esc(item.error || item.details || tr('systemHealth.status.sourceHealthy', 'Healthy'))}</p>
      </div>
    `).join(''));
  }

  function renderAnimeDiagnostics(anime) {
    renderSimpleDiagnosticsGrid(
      'systemHealthAnimeGrid',
      anime?.results,
      'systemHealth.status.noAnimeSources',
      'No anime source diagnostics available.'
    );
  }

  function renderServicesDiagnostics(services) {
    renderSimpleDiagnosticsGrid(
      'systemHealthServicesGrid',
      services?.results,
      'systemHealth.status.noServices',
      'No service diagnostics available.'
    );
  }

  function renderImageQualityDiagnostics() {
    renderSimpleDiagnosticsGrid(
      'systemHealthImageQualityGrid',
      lastImageQualityResult?.results,
      'systemHealth.status.noImageQuality',
      'Not checked yet.'
    );
  }

  // Separate from renderSimpleDiagnosticsGrid on purpose (see that
  // function's own comment) — an "Update" action only ever makes sense for
  // an outdated dependency row, never for a source/service/image-quality
  // one, so it doesn't belong in the shared template.
  function renderDependencyCheckDiagnostics() {
    const list = Array.isArray(lastDependencyCheckResult?.results) ? lastDependencyCheckResult.results : [];
    if (!list.length) {
      safeHtmlById('systemHealthDependencyGrid', `<p class="sh-empty">${esc(tr('systemHealth.status.noDependencyCheck', 'Not checked yet.'))}</p>`);
      return;
    }

    safeHtmlById('systemHealthDependencyGrid', list.map((item) => {
      const canUpdate = item.updatable && item.status !== 'pass' && item.latestVersion;
      const updateBtn = canUpdate
        ? `<button class="btn secondary sh-update-btn" data-dep-id="${esc(item.id)}" data-dep-version="${esc(item.latestVersion)}">${esc(tr('systemHealth.updateBtn', 'Update'))}</button>`
        : '';
      return `
      <div class="sh-module-card" data-dep-card-id="${esc(item.id)}">
        <div class="sh-module-head">
          <span class="sh-module-label">${esc(item.name || item.id)}</span>
          <span class="sh-status-dot ${statusClass(item.status)}">${esc(titleStatus(item.status))}</span>
        </div>
        <p class="sh-module-id">${esc(item.id)}</p>
        <p class="sh-module-details">${esc(item.error || item.details || tr('systemHealth.status.sourceHealthy', 'Healthy'))}</p>
        ${updateBtn}
      </div>
    `;
    }).join(''));
  }

  // One delegated listener for the whole grid instead of re-binding a
  // listener per row on every re-render (the row count/identity changes
  // each time a check or an update runs).
  async function handleDependencyGridClick(event) {
    const btn = event.target.closest('.sh-update-btn');
    if (!btn) return;
    const depId = btn.dataset.depId;
    const version = btn.dataset.depVersion;
    const card = btn.closest('[data-dep-card-id]');
    const originalLabel = btn.textContent;

    btn.disabled = true;
    btn.textContent = tr('systemHealth.updateBtnRunning', 'Updating...');

    try {
      const res = await api('/api/system/dependency-update', {
        method: 'POST',
        body: JSON.stringify({ id: depId, latestVersion: version }),
      });
      const message = res?.result?.message || tr('systemHealth.updateSuccess', 'Updated — click "Check for Updates" to confirm.');

      if (depId === 'node-runtime') {
        // The check reports the Node version actually RUNNING, so it can't
        // see a runtime that's staged but not yet applied — re-checking would
        // just bring the Update button straight back. Keep the server's
        // "relaunch to apply it" message on the card instead.
        if (card) card.querySelector('.sh-module-details').textContent = message;
        btn.remove();
        return;
      }

      // npm / CDN updates: re-run the check so the card shows what's really
      // installed now (and, for npm, whether a restart is still pending)
      // rather than staying red with a stale "outdated" line until the user
      // thinks to click "Check for Updates" themselves.
      await runDependencyCheck();
      safeTextById('systemHealthLoadState', message);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (card) {
        const details = card.querySelector('.sh-module-details');
        details.textContent = `${tr('systemHealth.updateFailedPrefix', 'Update failed')}: ${err?.message || err}`;
      }
    }
  }

  function renderSourceErrors(sources) {
    const entries = Array.isArray(sources?.recentErrors) ? sources.recentErrors : [];
    const catalog = Array.isArray(sources?.errorCatalog) ? sources.errorCatalog : [];
    if (!entries.length) {
      const catalogHtml = catalog.length
        ? `<div class="sh-card" style="margin-bottom:10px"><p class="sh-module-label">${esc(tr('systemHealth.section.errorList', 'Error list'))}</p>${catalog.map((item) => `<p class="sh-module-id">${esc(item.code)} · ${esc(item.label)} · x${esc(item.count)}</p>`).join('')}</div>`
        : '';
      safeHtmlById('systemHealthSourceErrors', `${catalogHtml}<p class="sh-empty">${esc(tr('systemHealth.status.noSourceErrors', 'No recent source errors recorded.'))}</p>`);
      return;
    }

    const catalogHtml = catalog.length
      ? `<div class="sh-card" style="margin-bottom:10px"><p class="sh-module-label">${esc(tr('systemHealth.section.errorList', 'Error list'))}</p>${catalog.map((item) => `<p class="sh-module-id">${esc(item.code)} · ${esc(item.label)} · x${esc(item.count)}</p>`).join('')}</div>`
      : '';

    safeHtmlById('systemHealthSourceErrors', `${catalogHtml}${entries.map((entry) => `
      <div class="sh-module-card">
        <div class="sh-module-head">
          <span class="sh-module-label">${esc(entry.area)}</span>
          <span class="sh-status-dot is-warning">${esc(tr('systemHealth.status.warning', 'Warning'))}</span>
        </div>
        <p class="sh-module-details">${esc(entry.message || '')}</p>
        <p class="sh-module-id">${esc(entry.errorCode || '')}${entry.errorLabel ? ` · ${esc(entry.errorLabel)}` : ''}${entry.code ? ` · ${esc(entry.code)}` : ''}${entry.count ? ` · x${esc(entry.count)}` : ''}${entry.lastSeenAt ? ` · ${esc(formatTimestamp(entry.lastSeenAt))}` : ''}</p>
        ${entry.suggestedAction ? `<p class="sh-module-details">${esc(entry.suggestedAction)}</p>` : ''}
      </div>
    `).join('')}`);
  }

  // Builds a full diagnostic snapshot, not just a list of failures. The
  // original version of this only included sources.failing/recentErrors +
  // warnings/errors — and returned null (copying nothing) whenever none of
  // those were non-empty. That silently dropped exactly the information
  // needed to diagnose a real bug found live in this project: a frontend-
  // only smoke test check (fe-sidebar-manifest-match) was failing, but the
  // smoke test's own results were never part of this payload at all — the
  // failure was only found because the user sent a screenshot of the Smoke
  // Test table, which this button should have made unnecessary. Now this
  // always includes the full smoke test table (every check, not just
  // failing ones — it's a small fixed list, and knowing what WAS verified
  // is as useful as knowing what wasn't), the anime/services sections
  // (previously omitted entirely), the source error catalog (grouped by
  // error code, not just the raw recent-errors list), and a fresh resource
  // snapshot (CPU/RAM/uptime) to rule out "is the server under load" as a
  // contributing factor. And it never returns null — a clean bill of
  // health is itself a useful, explicit thing to hand to an AI/technician
  // ("confirmed nothing is failing as of this timestamp"), not nothing.
  async function buildErrorCopyPayload() {
    const health = lastHealthData || {};
    const sourceResults = Array.isArray(health?.sources?.results) ? health.sources.results : [];
    const animeResults = Array.isArray(health?.anime?.results) ? health.anime.results : [];
    const serviceResults = Array.isArray(health?.services?.results) ? health.services.results : [];
    const recentErrors = Array.isArray(health?.sources?.recentErrors) ? health.sources.recentErrors : [];
    const errorCatalog = Array.isArray(health?.sources?.errorCatalog) ? health.sources.errorCatalog : [];
    const warnings = Array.isArray(health?.warnings) ? health.warnings : [];
    const errors = Array.isArray(health?.errors) ? health.errors : [];

    // Image Quality is a separate, explicitly-triggered check (not part of
    // healthData) - only included when it's actually been run.
    const imageQualityResults = Array.isArray(lastImageQualityResult?.results) ? lastImageQualityResult.results : [];
    const imageQualityIssues = imageQualityResults.filter((r) => r.status !== 'pass');

    // Same reasoning as Image Quality above — a separate, explicitly-
    // triggered check, only included when it's actually been run.
    const dependencyCheckResults = Array.isArray(lastDependencyCheckResult?.results) ? lastDependencyCheckResult.results : [];
    const dependencyCheckIssues = dependencyCheckResults.filter((r) => r.status !== 'pass');

    let resources = null;
    try {
      resources = await api('/api/system/resources');
    } catch (_) { /* best-effort — a stale/missing resource snapshot shouldn't block copying everything else */ }

    const payload = {
      copiedAt: new Date().toISOString(),
      overallStatus: health?.overallStatus || 'unknown',
      database: health?.database || null,
      resources: resources ? {
        uptimeSec: resources.uptimeSec,
        cpu: resources.cpu,
        memory: resources.memory,
      } : null,
      sources: {
        summary: health?.sources?.summary || { total: 0, passing: 0, failing: 0 },
        failing: sourceResults.filter((s) => s.status === 'fail'),
        recentErrors,
        errorCatalog,
      },
      anime: {
        summary: health?.anime?.summary || { total: 0, passing: 0, failing: 0 },
        failing: animeResults.filter((s) => s.status === 'fail'),
      },
      services: {
        summary: health?.services?.summary || { total: 0, passing: 0, failing: 0 },
        results: serviceResults,
      },
      smokeTest: lastSmokeResult ? {
        executedAt: lastSmokeResult.timestamp,
        overallStatus: lastSmokeResult.overallStatus,
        checks: lastSmokeResult.checks,
      } : { executedAt: null, overallStatus: 'never-run', checks: [] },
      warnings,
      errors,
    };

    if (imageQualityIssues.length || lastImageQualityResult) {
      payload.imageQuality = {
        summary: lastImageQualityResult?.summary || { total: 0, passing: 0, failing: 0 },
        issues: imageQualityIssues,
      };
    }

    if (dependencyCheckIssues.length || lastDependencyCheckResult) {
      payload.dependencyCheck = {
        summary: lastDependencyCheckResult?.summary || { total: 0, passing: 0, failing: 0 },
        issues: dependencyCheckIssues,
      };
    }

    return payload;
  }

  async function copyErrorsToClipboard() {
    safeTextById('systemHealthLoadState', tr('systemHealth.status.copyingDiagnostics', 'Gathering diagnostics...'));
    const payload = await buildErrorCopyPayload();
    const text = JSON.stringify(payload, null, 2);

    try {
      if (!(await copyTextToClipboard(text))) {
        // The browser would not copy (a page opened by the address of a server on the home network has no clipboard): the text is shown to select.
        showTextToCopy(tr('systemHealth.copyErrorsBtn', 'Copy Diagnostics'), text);
        safeTextById('systemHealthLoadState', tr('systemHealth.copyErrorsManual', 'The browser did not allow copying: the diagnostics are shown to select and copy.'));
        return;
      }
      if (typeof showToast === 'function') {
        showToast(tr('systemHealth.copyErrorsBtn', 'Copy Diagnostics'), tr('systemHealth.copyErrorsSuccess', 'Full diagnostics copied to clipboard.'), 'success');
      }
      safeTextById('systemHealthLoadState', tr('systemHealth.copyErrorsSuccess', 'Full diagnostics copied to clipboard.'));
    } catch (err) {
      console.error(err);
      safeTextById('systemHealthLoadState', tr('systemHealth.copyErrorsFailedPrefix', 'Failed to copy diagnostics'));
    }
  }

  function safeI18n(key, fallback) {
    const value = typeof tr === 'function' ? tr(key, fallback) : key;
    return value && value !== key ? value : fallback;
  }

  async function clearSourceErrors() {
    if (!confirm(safeI18n('systemHealth.clearErrorsConfirm', 'Clear source logs? This will not remove your Library.'))) return;
    
    const btn = document.getElementById('systemHealthClearErrorsBtn');
    if (btn) btn.disabled = true;
    
    try {
      const res = await api('/api/health/source-errors', { method: 'DELETE' });
      if (res.ok) {
        if (typeof showToast === 'function') showToast(tr('systemHealth.clearErrorsSuccessTitle', 'Logs Cleared'), tr('systemHealth.clearErrorsSuccess', 'Source logs cleared.'), 'success');
        await refreshHealth();
      }
    } catch (err) {
      console.error(err);
      if (typeof showToast === 'function') showToast(tr('systemHealth.clearErrorsFailedTitle', 'Error'), tr('systemHealth.clearErrorsFailedPrefix', 'Could not clear source logs.'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderModules(modules) {
    const list = Array.isArray(modules) ? modules : [];
    if (!list.length) {
      safeHtmlById('systemHealthModulesGrid', `<p class=\"sh-empty\">${esc(tr('systemHealth.status.noModules', 'No module information available.'))}</p>`);
      return;
    }

    safeHtmlById('systemHealthModulesGrid', list.map(mod => `
      <div class=\"sh-module-card\">
        <div class=\"sh-module-head\">
          <span class=\"sh-module-label\">${esc(mod.label || mod.id)}</span>
          <span class=\"sh-status-dot ${statusClass(mod.status)}\">${esc(titleStatus(mod.status))}</span>
        </div>
        <p class=\"sh-module-id\">${esc(mod.id)}</p>
        <p class=\"sh-module-details\">${esc(mod.details || '')}</p>
      </div>
    `).join(''));
  }

  function renderHealthMessages(healthData) {
    const warnings = Array.isArray(healthData?.warnings) ? healthData.warnings : [];
    const errors = Array.isArray(healthData?.errors) ? healthData.errors : [];

    if (!warnings.length && !errors.length) {
      safeHtmlById('systemHealthMessages', `<p class=\"sh-empty\">${esc(tr('systemHealth.status.noWarnings', 'No warnings or errors reported.'))}</p>`);
      return;
    }

    const html = [];
    for (const msg of errors) {
      html.push(`<div class=\"sh-message sh-message-error\">${esc(msg)}</div>`);
    }
    for (const msg of warnings) {
      html.push(`<div class=\"sh-message sh-message-warning\">${esc(msg)}</div>`);
    }
    safeHtmlById('systemHealthMessages', html.join(''));
  }

  function renderSmokeChecks(smokeData, frontendChecks) {
    const backendChecks = Array.isArray(smokeData?.checks) ? smokeData.checks : [];
    const localChecks = Array.isArray(frontendChecks) ? frontendChecks : [];
    const checks = backendChecks.concat(localChecks);

    if (!checks.length) {
      safeHtmlById('systemHealthSmokeTableBody', `<tr><td colspan=\"5\" class=\"sh-empty\">${esc(tr('systemHealth.status.noSmokeChecks', 'No smoke checks executed.'))}</td></tr>`);
      return;
    }

    const rows = checks.map(check => {
      const duration = Number.isFinite(check.durationMs) ? `${Math.max(0, check.durationMs)} ms` : '-';
      return `
        <tr>
          <td>${esc(check.id)}</td>
          <td>${esc(check.label)}</td>
          <td><span class=\"sh-status-dot ${statusClass(check.status)}\">${esc(titleStatus(check.status))}</span></td>
          <td>${esc(duration)}</td>
          <td>${esc(check.details || '')}</td>
        </tr>
      `;
    }).join('');

    safeHtmlById('systemHealthSmokeTableBody', rows);
  }

  function computeFrontendOverall(checks) {
    if (checks.some(c => c.status === 'fail')) return 'fail';
    if (checks.some(c => c.status === 'warning')) return 'warning';
    return 'pass';
  }

  function runFrontendSmokeChecks() {
    const checks = [];
    const start = Date.now();

    function push(id, label, status, details) {
      checks.push({ id, label, status, details, durationMs: Date.now() - start });
    }

    const duplicateViews = [];
    const byView = {};
    for (const route of ROUTE_MANIFEST) {
      byView[route.view] = (byView[route.view] || 0) + 1;
    }
    for (const view of Object.keys(byView)) {
      if (byView[view] > 1) duplicateViews.push(view);
    }
    push(
      'fe-route-duplicates',
      tr('systemHealth.frontendCheck.routeDuplicates.label', 'Frontend routes have no duplicates'),
      duplicateViews.length ? 'fail' : 'pass',
      duplicateViews.length
        ? `${tr('systemHealth.frontendCheck.routeDuplicates.duplicatesPrefix', 'Duplicated views')}: ${duplicateViews.join(', ')}`
        : tr('systemHealth.frontendCheck.routeDuplicates.ok', 'No duplicates found in route manifest.')
    );

    const missingLabels = ROUTE_MANIFEST
      .map((route) => ({
        view: route.view,
        label: tr(route.labelKey, route.fallbackLabel),
      }))
      .filter((route) => !route.label || !route.label.trim())
      .map((route) => route.view);

    push(
      'fe-route-labels',
      tr('systemHealth.frontendCheck.routeLabels.label', 'Frontend routes have labels'),
      missingLabels.length ? 'warning' : 'pass',
      missingLabels.length
        ? `${tr('systemHealth.frontendCheck.routeLabels.missingPrefix', 'Missing labels for')}: ${missingLabels.join(', ')}`
        : tr('systemHealth.frontendCheck.routeLabels.ok', 'All routes define labels.')
    );

    const sidebarViews = Array.from(document.querySelectorAll('.sidebar .nav-link[data-view]')).map(el => el.dataset.view);

    const missingRender = ROUTE_MANIFEST
      .filter(r => r.renderFn)
      .filter(r => typeof window[r.renderFn] !== 'function')
      .map(r => `${r.view} -> ${r.renderFn}`);

    push(
      'fe-route-render-functions',
      tr('systemHealth.frontendCheck.routeRender.label', 'Frontend routes render functions exist'),
      missingRender.length ? 'warning' : 'pass',
      missingRender.length
        ? `${tr('systemHealth.frontendCheck.routeRender.missingPrefix', 'Missing functions')}: ${missingRender.join(', ')}`
        : tr('systemHealth.frontendCheck.routeRender.ok', 'All declared render functions are available.')
    );

    const manifestViews = new Set(ROUTE_MANIFEST.map(r => r.view));
    const missingFromManifest = sidebarViews.filter(v => !manifestViews.has(v));

    push(
      'fe-sidebar-manifest-match',
      tr('systemHealth.frontendCheck.sidebarMatch.label', 'Sidebar links exist in route manifest'),
      missingFromManifest.length ? 'fail' : 'pass',
      missingFromManifest.length
        ? `${tr('systemHealth.frontendCheck.sidebarMatch.missingPrefix', 'Sidebar views missing from manifest')}: ${missingFromManifest.join(', ')}`
        : tr('systemHealth.frontendCheck.sidebarMatch.ok', 'All sidebar links are mapped in route manifest.')
    );

    return {
      overallStatus: computeFrontendOverall(checks),
      checks,
      summary: {
        total: checks.length,
        pass: checks.filter(c => c.status === 'pass').length,
        warning: checks.filter(c => c.status === 'warning').length,
        fail: checks.filter(c => c.status === 'fail').length,
      },
    };
  }

  async function refreshHealth() {
    safeTextById('systemHealthLoadState', tr('systemHealth.status.loading', 'Loading health status...'));
    try {
      const healthData = await api('/api/system/health');
      lastHealthData = healthData;
      renderSummaryCards(healthData);
      renderSourceDiagnostics(healthData.sources || {});
      renderSourceErrors(healthData.sources || {});
      renderAnimeDiagnostics(healthData.anime || {});
      renderServicesDiagnostics(healthData.services || {});
      renderModules(healthData.modules || []);
      renderHealthMessages(healthData);
      safeTextById('systemHealthLoadState', tr('systemHealth.status.loaded', 'System health loaded.'));
    } catch (err) {
      console.error(err);
      safeTextById('systemHealthLoadState', tr('systemHealth.error.loadHealthPrefix', 'Failed to load health status'));
      safeHtmlById('systemHealthSourcesGrid', `<p class="sh-empty">${esc(tr('systemHealth.error.sourceData', 'Could not load source diagnostics.'))}</p>`);
      safeHtmlById('systemHealthSourceErrors', `<p class="sh-empty">${esc(tr('systemHealth.error.sourceErrors', 'Could not load source error history.'))}</p>`);
      safeHtmlById('systemHealthAnimeGrid', `<p class="sh-empty">${esc(tr('systemHealth.error.sourceData', 'Could not load source diagnostics.'))}</p>`);
      safeHtmlById('systemHealthServicesGrid', `<p class="sh-empty">${esc(tr('systemHealth.error.sourceData', 'Could not load source diagnostics.'))}</p>`);
      safeHtmlById('systemHealthModulesGrid', `<p class=\"sh-empty\">${esc(tr('systemHealth.error.moduleData', 'Could not load module data.'))}</p>`);
      safeHtmlById('systemHealthMessages', `<div class=\"sh-message sh-message-error\">${esc(tr('systemHealth.error.loadHealthPrefix', 'Failed to load health status'))}</div>`);
    }
  }

  async function runSmoke() {
    const runBtn = document.getElementById('systemHealthRunSmokeBtn');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = tr('systemHealth.runSmokeBtnRunning', 'Running...');
    }

    safeTextById('systemHealthLoadState', tr('systemHealth.status.runningSmoke', 'Running smoke tests...'));

    try {
      const [backendSmoke, healthData] = await Promise.all([
        api('/api/system/smoke-test'),
        api('/api/system/health'),
      ]);
      lastHealthData = healthData;
      const frontendSmoke = runFrontendSmokeChecks();

      const combinedChecks = (backendSmoke.checks || []).concat(frontendSmoke.checks || []);
      const combinedStatus = computeFrontendOverall(combinedChecks);

      lastSmokeResult = {
        overallStatus: combinedStatus,
        checks: combinedChecks,
        timestamp: new Date().toISOString(),
      };

      renderSummaryCards(healthData);
      renderSourceDiagnostics(healthData.sources || {});
      renderSourceErrors(healthData.sources || {});
      renderAnimeDiagnostics(healthData.anime || {});
      renderServicesDiagnostics(healthData.services || {});
      renderModules(healthData.modules || []);
      renderHealthMessages(healthData);
      renderSmokeChecks(backendSmoke, frontendSmoke.checks);

      safeTextById(
        'systemHealthLoadState',
        `${tr('systemHealth.status.smokeFinishedPrefix', 'Smoke test finished')}: ${titleStatus(combinedStatus)} (backend ${backendSmoke.summary?.pass || 0} ${tr('systemHealth.status.pass', 'Pass').toLowerCase()} / ${backendSmoke.summary?.warning || 0} ${tr('systemHealth.status.warning', 'Warning').toLowerCase()} / ${backendSmoke.summary?.fail || 0} ${tr('systemHealth.status.fail', 'Fail').toLowerCase()}; frontend ${frontendSmoke.summary.pass} ${tr('systemHealth.status.pass', 'Pass').toLowerCase()} / ${frontendSmoke.summary.warning} ${tr('systemHealth.status.warning', 'Warning').toLowerCase()} / ${frontendSmoke.summary.fail} ${tr('systemHealth.status.fail', 'Fail').toLowerCase()}).`
      );
    } catch (err) {
      console.error(err);
      safeTextById('systemHealthLoadState', tr('systemHealth.error.smokeFailedPrefix', 'Smoke test failed'));
      safeHtmlById('systemHealthSmokeTableBody', `<tr><td colspan=\"5\">${esc(tr('systemHealth.error.smokeFailedPrefix', 'Smoke test failed'))}</td></tr>`);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = tr('systemHealth.runSmokeBtn', 'Run Smoke Test');
      }
    }
  }

  async function runImageQualityCheck() {
    const runBtn = document.getElementById('systemHealthRunImageQualityBtn');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = tr('systemHealth.runImageQualityBtnRunning', 'Checking...');
    }

    safeTextById('systemHealthLoadState', tr('systemHealth.status.runningImageQuality', 'Checking image quality across sources (this can take a minute)...'));

    try {
      lastImageQualityResult = await api('/api/system/image-quality');
      renderSummaryCards(lastHealthData || {});
      renderImageQualityDiagnostics();

      const summary = lastImageQualityResult.summary || { total: 0, passing: 0, failing: 0 };
      safeTextById(
        'systemHealthLoadState',
        `${tr('systemHealth.status.imageQualityFinishedPrefix', 'Image quality check finished')}: ${summary.passing || 0}/${summary.total || 0} ${tr('systemHealth.label.sourcesPassing', 'sources passing')}.`
      );
    } catch (err) {
      console.error(err);
      safeTextById('systemHealthLoadState', tr('systemHealth.error.imageQualityFailedPrefix', 'Image quality check failed'));
      safeHtmlById('systemHealthImageQualityGrid', `<p class="sh-empty">${esc(tr('systemHealth.error.imageQualityFailedPrefix', 'Image quality check failed'))}</p>`);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = tr('systemHealth.runImageQualityBtn', 'Check Image Quality');
      }
    }
  }

  async function runDependencyCheck() {
    const runBtn = document.getElementById('systemHealthRunDependencyCheckBtn');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = tr('systemHealth.runDependencyCheckBtnRunning', 'Checking...');
    }

    safeTextById('systemHealthLoadState', tr('systemHealth.status.runningDependencyCheck', 'Checking dependency and tool versions...'));

    try {
      lastDependencyCheckResult = await api('/api/system/dependency-check?force=true');
      renderSummaryCards(lastHealthData || {});
      renderDependencyCheckDiagnostics();

      const summary = lastDependencyCheckResult.summary || { total: 0, passing: 0, failing: 0 };
      safeTextById(
        'systemHealthLoadState',
        `${tr('systemHealth.status.dependencyCheckFinishedPrefix', 'Dependency check finished')}: ${summary.passing || 0}/${summary.total || 0} ${tr('systemHealth.label.upToDate', 'up to date')}.`
      );
    } catch (err) {
      console.error(err);
      safeTextById('systemHealthLoadState', tr('systemHealth.error.dependencyCheckFailedPrefix', 'Dependency check failed'));
      safeHtmlById('systemHealthDependencyGrid', `<p class="sh-empty">${esc(tr('systemHealth.error.dependencyCheckFailedPrefix', 'Dependency check failed'))}</p>`);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = tr('systemHealth.runDependencyCheckBtn', 'Check for Updates');
      }
    }
  }

  function bindEvents() {
    const runBtn = document.getElementById('systemHealthRunSmokeBtn');
    const refreshBtn = document.getElementById('systemHealthRefreshBtn');
    const copyErrorsBtn = document.getElementById('systemHealthCopyErrorsBtn');
    const imageQualityBtn = document.getElementById('systemHealthRunImageQualityBtn');
    const dependencyCheckBtn = document.getElementById('systemHealthRunDependencyCheckBtn');

    if (runBtn && !runBtn.dataset.bound) {
      runBtn.dataset.bound = '1';
      runBtn.addEventListener('click', runSmoke);
    }

    if (imageQualityBtn && !imageQualityBtn.dataset.bound) {
      imageQualityBtn.dataset.bound = '1';
      imageQualityBtn.addEventListener('click', runImageQualityCheck);
    }

    if (dependencyCheckBtn && !dependencyCheckBtn.dataset.bound) {
      dependencyCheckBtn.dataset.bound = '1';
      dependencyCheckBtn.addEventListener('click', runDependencyCheck);
    }

    // One delegated listener on the grid container, not per-button — the
    // set of "Update" buttons is re-rendered wholesale on every check/update
    // (renderDependencyCheckDiagnostics), so per-button binding would need
    // to run again after every render anyway.
    const dependencyGrid = document.getElementById('systemHealthDependencyGrid');
    if (dependencyGrid && !dependencyGrid.dataset.bound) {
      dependencyGrid.dataset.bound = '1';
      dependencyGrid.addEventListener('click', handleDependencyGridClick);
    }

    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', refreshHealth);
    }

    if (copyErrorsBtn && !copyErrorsBtn.dataset.bound) {
      copyErrorsBtn.dataset.bound = '1';
      copyErrorsBtn.addEventListener('click', copyErrorsToClipboard);
    }

    const clearErrorsBtn = document.getElementById('systemHealthClearErrorsBtn');
    if (clearErrorsBtn) {
      clearErrorsBtn.textContent = safeI18n('systemHealth.clearErrorsBtn', 'Clear Logs');
      if (!clearErrorsBtn.dataset.bound) {
        clearErrorsBtn.dataset.bound = '1';
        clearErrorsBtn.addEventListener('click', clearSourceErrors);
      }
    }
  }

  window.renderSystemHealthPage = async function renderSystemHealthPage() {
    bindEvents();
    if (!healthLoadedOnce) {
      healthLoadedOnce = true;
      await refreshHealth();
    }
  };
})();
