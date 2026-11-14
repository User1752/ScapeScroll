'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { THEME_PRESET_FAILED } = require('../errors/error-codes');
const { retryTransientFs, FS_RETRY_DELAYS_MS } = require('../common/fs-retry');

// A rename the operating system refuses for a moment is tried again a few times (common/fs-retry.js) instead of
// dropping the save: the browser would otherwise keep a theme the server never got.

function createThemePresetService() {
  let presetsDir = '';
  let presetsFile = '';
  let fsImpl = fsp; // replaced only by a test
  let retryDelays = FS_RETRY_DELAYS_MS;

  function configure(opts = {}) {
    presetsDir = opts.presetsDir || '';
    presetsFile = path.join(presetsDir, 'custom-presets.json');
    fsImpl = opts.fsp || fsp;
    retryDelays = Array.isArray(opts.writeRetryDelaysMs) ? opts.writeRetryDelaysMs : FS_RETRY_DELAYS_MS;
  }

  function safeStr(v, max = 500) {
    return String(v ?? '').slice(0, max);
  }

  function safeNum(v, fallback = 0, min = 0, max = 100) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // The client builds ids as "custom-<timestamp>" and pastes them, unescaped, into
  // id="..." and onclick="fn('<id>')" attributes in the Customize and Themes views.
  // Any id outside this alphabet is therefore script waiting to run in the owner's
  // session (PUT /api/theme-presets is open to the LAN while no password is set),
  // so it is dropped — on the way in, and again on the way out for anything an older
  // build already stored.
  const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

  function sanitizePreset(input) {
    if (!input || typeof input !== 'object') return null;
    const id = safeStr(input.id, 120).trim();
    if (!PRESET_ID_RE.test(id)) return null;
    return {
      id,
      name: safeStr(input.name, 80).trim() || 'My Preset',
      bgUrl: safeStr(input.bgUrl, 1500),
      bgDim: safeNum(input.bgDim, 0),
      bgOpac: safeNum(input.bgOpac, 0),
      bgPosX: safeNum(input.bgPosX, 50),
      bgPosY: safeNum(input.bgPosY, 50),
      charUrl: safeStr(input.charUrl, 1500),
      charDim: safeNum(input.charDim, 0),
      charDark: safeNum(input.charDark, 0),
      charPosX: safeNum(input.charPosX, 50),
      charPosY: safeNum(input.charPosY, 50),
      headerUrl: safeStr(input.headerUrl, 1500),
      headerDim: safeNum(input.headerDim, 0),
      headerOpac: safeNum(input.headerOpac, 0),
      headerPosX: safeNum(input.headerPosX, 50),
      headerPosY: safeNum(input.headerPosY, 50),
      cornerUrl: safeStr(input.cornerUrl, 1500),
      cornerDim: safeNum(input.cornerDim, 0),
      cornerDark: safeNum(input.cornerDark, 0),
      cornerPosX: safeNum(input.cornerPosX, 50),
      cornerPosY: safeNum(input.cornerPosY, 50),
      paletteColor: safeStr(input.paletteColor, 20),
      buttonColor: safeStr(input.buttonColor, 20),
      sidebarTextColor: safeStr(input.sidebarTextColor, 20),
      fontFamily: safeStr(input.fontFamily, 200),
    };
  }

  async function getPresets() {
    if (!presetsFile) throw new Error('Theme presets route not configured');
    try {
      const raw = await fsImpl.readFile(presetsFile, 'utf8');
      const parsed = JSON.parse(raw);
      const stored = Array.isArray(parsed?.presets) ? parsed.presets : [];
      return { presets: stored.filter((preset) => PRESET_ID_RE.test(String(preset?.id ?? ''))) };
    } catch {
      return { presets: [] };
    }
  }

  async function writePresets(presets) {
    if (!presetsFile) throw new Error('Theme presets route not configured');
    const payload = { presets, updatedAt: new Date().toISOString() };
    // Same tmp-file + rename pattern as store/persistence.js — a direct
    // write left a crash mid-save free to truncate the file, and getPresets()
    // treats any parse failure as "no presets", so a torn write would have
    // silently discarded every saved preset with no error surfaced anywhere.
    const tmpFile = `${presetsFile}.tmp`;
    try {
      await fsImpl.mkdir(presetsDir, { recursive: true });
      await retryTransientFs(async () => {
        await fsImpl.writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
        await fsImpl.rename(tmpFile, presetsFile);
      }, { delays: retryDelays });
    } catch (e) {
      // Wrapped rather than tagging e.code directly: e is a raw Node fs
      // error here, whose .code is already a real diagnostic (ENOENT,
      // EACCES, ...) — overwriting it would throw that away for the sake
      // of adding this project's own error-code taxonomy on top.
      const err = new Error(`Failed to save theme presets: ${e.message}`);
      err.code = THEME_PRESET_FAILED;
      err.cause = e;
      throw err;
    }
  }

  async function replacePresets({ presets } = {}) {
    const incoming = Array.isArray(presets) ? presets : [];
    const safe = incoming.map(sanitizePreset).filter(Boolean).slice(0, 200);
    await writePresets(safe);
    return { ok: true, presets: safe };
  }

  return {
    configure,
    getPresets,
    replacePresets,
  };
}

module.exports = { createThemePresetService };