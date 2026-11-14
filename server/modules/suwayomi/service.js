'use strict';

/**
 * server/modules/suwayomi/service.js — the client of a user's own Suwayomi-Server
 *
 * Suwayomi-Server (https://github.com/Suwayomi/Suwayomi-Server) is a separate,
 * self-hosted manga backend that runs Mihon-compatible extensions. This module
 * is what ScrollScape asks it, at the address the admin sets (Settings -> Suwayomi):
 * image bytes (cover/page), the install and update of an extension, its sources,
 * their filters and settings. The text/JSON side of a source (search, details,
 * chapters) lives in the source file written for it (server/modules/source-catalog/engine/).
 *
 * The configured URL is intentionally NOT run through isSafeUrl() — that
 * guard exists to stop attacker/scraper-controlled URLs from reaching the
 * server's internal network, and does not apply to a value only an admin
 * with Settings access can set. It commonly points at a private/loopback
 * address (Suwayomi-Server self-hosted on the same host or LAN), which
 * isSafeUrl would otherwise reject outright — the same carve-out this
 * project already makes for flaresolverrUrl (see fetch-utils.js).
 */

const limits = require('../../config/limits');

function createSuwayomiService({ readStore, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;

  async function getConfig() {
    const store = await readStore();
    const settings = store?.settings || {};
    const baseUrl = String(settings.suwayomiUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return null;
    if (!/^https?:\/\//i.test(baseUrl)) {
      const err = new Error('Suwayomi Server URL must start with http:// or https://');
      err.statusCode = 400;
      throw err;
    }
    return {
      baseUrl,
      username: settings.suwayomiUsername || '',
      password: settings.suwayomiPassword || '',
    };
  }

  function authHeaders(cfg) {
    if (!cfg.username) return {};
    const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  async function fetchJson(cfg, pathname) {
    const res = await doFetch(`${cfg.baseUrl}${pathname}`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`Suwayomi-Server returned HTTP ${res.status} for ${pathname}`);
      err.statusCode = res.status === 401 ? 401 : 502;
      throw err;
    }
    return res.json();
  }

  async function fetchBinary(cfg, pathname) {
    const res = await doFetch(`${cfg.baseUrl}${pathname}`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(limits.sourceCallTimeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`Suwayomi-Server returned HTTP ${res.status} for ${pathname}`);
      err.statusCode = res.status === 404 ? 404 : 502;
      throw err;
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { body: res.body, contentType };
  }

  async function requireConfig() {
    const cfg = await getConfig();
    if (!cfg) {
      const err = new Error('Suwayomi Server URL not configured (Settings -> Suwayomi)');
      err.statusCode = 400;
      throw err;
    }
    return cfg;
  }

  async function getThumbnail(mangaId) {
    const cfg = await requireConfig();
    return fetchBinary(cfg, `/api/v1/manga/${encodeURIComponent(mangaId)}/thumbnail`);
  }

  async function getPage(mangaId, chapterIndex, index) {
    const cfg = await requireConfig();
    return fetchBinary(
      cfg,
      `/api/v1/manga/${encodeURIComponent(mangaId)}/chapter/${encodeURIComponent(chapterIndex)}/page/${encodeURIComponent(index)}`
    );
  }

  async function testConnection() {
    const cfg = await requireConfig();
    const sources = await fetchJson(cfg, '/api/v1/source/list');
    return { ok: true, sourceCount: Array.isArray(sources) ? sources.length : 0 };
  }

  const PACKAGE_NAME_RE = /^[A-Za-z0-9._]{1,160}$/;

  /**
   * The extensions the Suwayomi-Server knows ({ pkg, installed }), asking it to read its repositories first. Null when it cannot be told (an older
   * server, a failure): the install is then tried anyway. Only a refused password is an answer of its own.
   */
  async function listKnownExtensions(cfg) {
    try {
      const res = await doFetch(`${cfg.baseUrl}/api/v1/extension/list`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(limits.engineInstallTimeoutMs) });
      if (res.status === 401) {
        const err = new Error('Suwayomi-Server refused the username or password.');
        err.statusCode = 401;
        throw err;
      }
      if (!res.ok) return null;
      const list = await res.json();
      return Array.isArray(list) ? list.map((item) => ({ pkg: item && typeof item.pkgName === 'string' ? item.pkgName : '', installed: !!(item && item.installed) })) : null;
    } catch (err) {
      if (err && err.statusCode === 401) throw err;
      return null;
    }
  }

  /**
   * Asks the Suwayomi-Server to install an extension from the repositories IT has configured (extension engine). It downloads and converts the file,
   * so it is slow. Suwayomi answers 201 (or another 2xx) when it installed it and 302 when it was already installed; anything else is a failure with its own sentence.
   * `redirect: 'manual'` because a 302 here is an answer, not a place to go.
   * @param {string} pkgName   the extension's package, as the repository lists it
   * @returns {Promise<{ already: boolean }>}
   */
  async function installExtension(pkgName) {
    if (!PACKAGE_NAME_RE.test(String(pkgName || ''))) {
      const err = new Error('That is not an extension package name.');
      err.statusCode = 400;
      throw err;
    }
    const cfg = await requireConfig();
    // Suwayomi only knows the extensions of a repository after it has READ that repository's list, which its own extension list call does (and
    // keeps for a minute). Right after the repository was added nothing has asked for it yet, and the install then fails with "not found".
    const known = await listKnownExtensions(cfg);
    const found = known && known.find((item) => item.pkg === pkgName);
    if (known && !found) {
      const err = new Error(`Suwayomi-Server read its repositories (${known.length} extensions) and this one is not in them. Check that the repository is added under its extension settings.`);
      err.statusCode = 404;
      throw err;
    }
    // Asking it to install what it already has is answered with a server error, not with "already installed": its own list says which it is.
    if (found && found.installed) return { already: true };
    const res = await doFetch(`${cfg.baseUrl}/api/v1/extension/install/${encodeURIComponent(pkgName)}`, {
      headers: authHeaders(cfg),
      redirect: 'manual',
      signal: AbortSignal.timeout(limits.engineInstallTimeoutMs),
    });
    // 201 is what it answers for an install; some builds answer a plain 200: any success is an install.
    if (res.status >= 200 && res.status < 300) return { already: false };
    if (res.status === 302 || (res.status >= 300 && res.status < 400)) return { already: true };
    // What the server says about its own failure (one short line of text, never markup) helps more than the number alone.
    const detail = res.status === 401 ? '' : String(await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const err = new Error(res.status === 401
      ? 'Suwayomi-Server refused the username or password.'
      : `Suwayomi-Server could not install the extension (HTTP ${res.status}). It looks for it in the repositories it is set up with.${detail ? ` It said: ${detail}` : ''}`);
    err.statusCode = res.status === 401 ? 401 : 502;
    throw err;
  }

  /**
   * The extensions the Suwayomi-Server knows, as plain values: [{ pkg, name, versionName, installed, hasUpdate }]. It reads its repositories first (that is
   * what the call does), so a version that came out since is listed with `hasUpdate`. A failure here is an error: the caller says it.
   */
  async function listExtensions() {
    const cfg = await requireConfig();
    const res = await doFetch(`${cfg.baseUrl}/api/v1/extension/list`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(limits.engineInstallTimeoutMs) });
    if (res.status === 401) throw Object.assign(new Error('Suwayomi-Server refused the username or password.'), { statusCode: 401 });
    if (!res.ok) throw Object.assign(new Error(`Suwayomi-Server could not list its extensions (HTTP ${res.status}).`), { statusCode: 502 });
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) throw Object.assign(new Error('Suwayomi-Server answered its extension list in a form this app does not read.'), { statusCode: 502 });
    return list.slice(0, 5000).map((item) => ({
      pkg: item && typeof item.pkgName === 'string' ? item.pkgName : '',
      name: String((item && item.name) || '').slice(0, 80),
      versionName: String((item && item.versionName) || '').slice(0, 30),
      installed: !!(item && item.installed),
      hasUpdate: !!(item && item.hasUpdate),
    })).filter((item) => PACKAGE_NAME_RE.test(item.pkg));
  }

  /**
   * Asks the Suwayomi-Server to update an extension it has (it downloads and converts the new file, so it is slow). Any success or redirect answer is
   * "done" (a redirect is what it says when there is nothing newer); anything else is a failure with the server's own line.
   * @param {string} pkgName
   * @returns {Promise<{ updated: boolean }>}
   */
  async function updateExtension(pkgName) {
    if (!PACKAGE_NAME_RE.test(String(pkgName || ''))) throw Object.assign(new Error('That is not an extension package name.'), { statusCode: 400 });
    const cfg = await requireConfig();
    const res = await doFetch(`${cfg.baseUrl}/api/v1/extension/update/${encodeURIComponent(pkgName)}`, { headers: authHeaders(cfg), redirect: 'manual', signal: AbortSignal.timeout(limits.engineInstallTimeoutMs) });
    if (res.status >= 200 && res.status < 300) return { updated: true };
    if (res.status >= 300 && res.status < 400) return { updated: false };
    const detail = res.status === 401 ? '' : String(await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const message = res.status === 401 ? 'Suwayomi-Server refused the username or password.' : `Suwayomi-Server could not update the extension (HTTP ${res.status}).${detail ? ` It said: ${detail}` : ''}`;
    throw Object.assign(new Error(message), { statusCode: res.status === 401 ? 401 : 502 });
  }

  /**
   * The settings of a source's extension as the Suwayomi-Server lists them, as plain values: [{ type, key, title, currentValue }] (the position in the list is
   * what a change is made by). An extension with none, an older server or a failure is "no settings", not an error; only a refused login is.
   * @param {string} sourceId   digits, as text
   */
  async function getSourcePreferences(sourceId) {
    if (!/^\d{1,20}$/.test(String(sourceId || ''))) return [];
    const cfg = await requireConfig();
    try {
      const list = await fetchJson(cfg, `/api/v1/source/${sourceId}/preferences`);
      return (Array.isArray(list) ? list : []).slice(0, 200).map((item) => {
        const props = item && typeof item.props === 'object' && item.props ? item.props : {};
        return { type: String((item && item.type) || '').slice(0, 60), key: String(props.key || '').slice(0, 100), title: String(props.title || '').slice(0, 100), currentValue: props.currentValue };
      });
    } catch (err) {
      if (err && err.statusCode === 401) throw err;
      return [];
    }
  }

  /**
   * Changes one setting of a source's extension, by its position in the list above. The value is sent as text, the way the server reads it.
   * @param {string} sourceId   digits, as text
   * @param {number} position
   * @param {string} value   'true' or 'false' for a switch
   */
  async function setSourcePreference(sourceId, position, value) {
    if (!/^\d{1,20}$/.test(String(sourceId || '')) || !Number.isInteger(position) || position < 0 || position > 199) throw Object.assign(new Error('That is not a setting of a source.'), { statusCode: 400 });
    const cfg = await requireConfig();
    const res = await doFetch(`${cfg.baseUrl}/api/v1/source/${sourceId}/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({ position, value: value === true ? 'true' : (value === false ? 'false' : String(value)) }),
      signal: AbortSignal.timeout(limits.sourceCallTimeoutMs),
    });
    if (res.status === 401) throw Object.assign(new Error('Suwayomi-Server refused the username or password.'), { statusCode: 401 });
    if (!res.ok) throw Object.assign(new Error(`Suwayomi-Server could not change the setting (HTTP ${res.status}).`), { statusCode: 502 });
    return true;
  }

  const ADD_STORE_QUERY = 'mutation AddStore($indexUrl: String!) { addExtensionStore(input: { indexUrl: $indexUrl }) { extensionStore { indexUrl name } } }';
  const STORE_URL_RE = /^https:\/\/[^\s"'\\]{1,300}$/;
  // The (server, repository) pairs this process already registered: the Suwayomi-Server keeps them in its own database.
  const registeredStores = new Set();

  /**
   * Makes sure the Suwayomi-Server knows an extension repository, through its own GraphQL call (`addExtensionStore`), so nothing has to be set in
   * its container's settings (where the quotes of the repository's address are easy to lose). Asked once per server and repository while this
   * process runs; a refusal is not remembered.
   * @param {string} indexUrl   an https address of a repository's list
   * @returns {Promise<{ already: boolean }>}
   */
  async function ensureExtensionStore(indexUrl) {
    const url = String(indexUrl || '');
    if (!STORE_URL_RE.test(url)) {
      const err = new Error('That is not the address of an extension repository.');
      err.statusCode = 400;
      throw err;
    }
    const cfg = await requireConfig();
    const key = `${cfg.baseUrl}|${url}`;
    if (registeredStores.has(key)) return { already: true };
    const res = await doFetch(`${cfg.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({ query: ADD_STORE_QUERY, variables: { indexUrl: url } }),
      signal: AbortSignal.timeout(limits.engineInstallTimeoutMs),
    });
    if (res.status === 401) {
      const err = new Error('Suwayomi-Server refused the username or password.');
      err.statusCode = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Suwayomi-Server could not add the extension repository (HTTP ${res.status}).`);
      err.statusCode = 502;
      throw err;
    }
    const body = await res.json().catch(() => null);
    const problems = body && Array.isArray(body.errors) ? body.errors : [];
    if (problems.length) {
      const err = new Error(`Suwayomi-Server could not add the extension repository: ${String((problems[0] && problems[0].message) || 'unknown error').split('\n')[0].slice(0, 160)}`);
      err.statusCode = 502;
      throw err;
    }
    registeredStores.add(key);
    return { already: false };
  }

  /**
   * The filters of one source as the Suwayomi-Server lists them (genres, status, sort...), untouched: the caller reads the shapes it understands.
   * An older server or an extension with none answers with an empty list or an error, which is "no filters", not a failure of the install.
   * @param {string} sourceId   the id Suwayomi gave the source: digits, as text
   * @returns {Promise<unknown[]>}
   */
  async function getSourceFilters(sourceId) {
    if (!/^\d{1,20}$/.test(String(sourceId || ''))) return [];
    const cfg = await requireConfig();
    try {
      const list = await fetchJson(cfg, `/api/v1/source/${sourceId}/filters`);
      return Array.isArray(list) ? list.slice(0, 600) : [];
    } catch (err) {
      if (err && err.statusCode === 401) throw err;
      return [];
    }
  }

  /** The sources Suwayomi has loaded, as plain values: [{ id, name, lang, supportsLatest, isNsfw, baseUrl }]. */
  async function listSources() {
    const cfg = await requireConfig();
    const list = await fetchJson(cfg, '/api/v1/source/list');
    return (Array.isArray(list) ? list : []).map((item) => ({
      id: String(item && item.id),
      name: String((item && (item.displayName || item.name)) || '').slice(0, 120),
      lang: String((item && item.lang) || '').slice(0, 12),
      supportsLatest: !!(item && item.supportsLatest),
      isNsfw: !!(item && item.isNsfw),
      baseUrl: String((item && item.baseUrl) || '').slice(0, 300),
    })).filter((item) => /^\d{1,20}$/.test(item.id));
  }

  return { getConfig, getThumbnail, getPage, testConnection, installExtension, listSources, getSourceFilters, getSourcePreferences, setSourcePreference, listExtensions, updateExtension, ensureExtensionStore };
}

module.exports = { createSuwayomiService };
