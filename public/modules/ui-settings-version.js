// ============================================================================
// SETTINGS > THE VERSION OF THE APP, IN THE CORNER (next to the title)
// ============================================================================
// GET /api/version answers once per page load; the label is filled each time the Settings modal opens (showSettings calls it). A server that
// cannot say, or an old server with no such route, leaves the label empty instead of showing an error: it is only a label.

let _settingsAppVersion = null; // null: not asked yet; '': the server could not say

async function fillSettingsAppVersion() {
  const el = document.getElementById('settingsAppVersion');
  if (!el) return;
  if (_settingsAppVersion === null) {
    try {
      const answer = await api('/api/version');
      _settingsAppVersion = answer && answer.ok && typeof answer.version === 'string' ? answer.version : '';
    } catch (_) {
      return; // asked again the next time Settings opens
    }
  }
  if (_settingsAppVersion) el.textContent = `v${_settingsAppVersion}`;
}
