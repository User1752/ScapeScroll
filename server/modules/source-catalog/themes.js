'use strict';

const { PACKAGE_RE } = require('./index-format');

// What a site is built on (the "theme" of an extension in the repository's source) decides whether this app can write a source for
// it by itself: the generator has a template for two of them. The list the repository publishes does not say, so the one build file
// of the extension is read from the project's source code on GitHub (not from the site) and its `theme = "..."` line is taken.
// An extension with no such line is a scraper written for its one site ("custom"): nothing here can write a source for it.

const THEME_LINE_RE = /^[ \t]*theme[ \t]*=[ \t]*"([a-z0-9_]{1,40})"/m;
const CUSTOM = 'custom';
const UNKNOWN = 'unknown';

/** The theme of the build file's text: its name, or 'custom' when the file names none. */
function parseTheme(gradleText) {
  const match = THEME_LINE_RE.exec(String(gradleText || ''));
  return match ? match[1] : CUSTOM;
}

/** 'en/mangaplus' for an extension package, or '' when the package is not shaped like one (it is third-party text: never put in an address as it is). */
function themeFolder(pkg) {
  const match = PACKAGE_RE.exec(String(pkg || ''));
  return match ? `${match[1]}/${match[2]}` : '';
}

/**
 * @param {{ baseUrl: string, fetchText: (url: string, maxBytes: number) => Promise<{ status: number, text: string }>, cache: { getFresh: Function, set: Function, ensureLoaded: Function }, ttlMs: number, retryMs: number, maxBytes: number }} deps
 */
function createThemeResolver({ baseUrl, fetchText, cache, ttlMs, retryMs, maxBytes }) {
  /** What is remembered for the extension: { theme, ok } while it is fresh, or null. A failed read is remembered for a shorter time. */
  async function known(pkg) {
    await cache.ensureLoaded();
    const found = cache.getFresh(pkg, ttlMs);
    if (!found) return null;
    if (found.ok) return found;
    return cache.getFresh(pkg, retryMs) || null;
  }

  /** The same as known(), for a cache that is already loaded (the caller awaited cache.ensureLoaded()). */
  function peek(pkg) {
    const found = cache.getFresh(pkg, ttlMs);
    if (!found) return null;
    if (found.ok) return found;
    return cache.getFresh(pkg, retryMs) || null;
  }

  /** Reads the build file and remembers what it says. A missing file is an answer ('unknown'); a failed request is remembered as one that failed. */
  async function resolve(pkg) {
    const folder = themeFolder(pkg);
    if (!folder) return { theme: UNKNOWN, ok: true };
    let answer;
    try {
      const res = await fetchText(`${baseUrl}${folder}/build.gradle.kts`, maxBytes);
      if (res.status === 404) answer = { theme: UNKNOWN, ok: true };
      else if (res.status >= 200 && res.status < 300) answer = { theme: parseTheme(res.text), ok: true };
      else answer = { theme: UNKNOWN, ok: false };
    } catch (_) {
      answer = { theme: UNKNOWN, ok: false };
    }
    cache.set(pkg, answer);
    return answer;
  }

  return { known, peek, resolve };
}

module.exports = { parseTheme, themeFolder, createThemeResolver, CUSTOM, UNKNOWN };
