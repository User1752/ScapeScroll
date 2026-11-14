// ============================================================================
// THEME SHOP — definitions & AP helpers
// ============================================================================

const _BASE_THEMES = [
  { id: 'default', name: 'Default', desc: 'Classic purple theme', cost: 0, primary: '#913FE2', primaryDark: '#6F2598', primaryLight: '#A855F7', preview: 'linear-gradient(135deg,#913FE2,#A855F7)' },
];
// Merge any community themes registered in themes.js (loaded before this file)
// Every theme is free in this edition: nothing costs AP, and all of them are owned from the start.
const SHOP_THEMES = [..._BASE_THEMES, ...(window.COMMUNITY_THEMES || [])].map((theme) => ({ ...theme, cost: 0 }));

// Fire-and-forget push to the server-side wallet/theme store (see
// server/modules/achievements/service.js's updateProgression) — keeps the
// server copy in sync with every local mutation so AP/themes survive a
// cleared browser profile the same way the library/history already do.
function _pushProgressionToServer(patch) {
  fetch('/api/achievements/progression', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

function getSpentAP()   { return parseInt(localStorage.getItem('scrollscape_ap_spent')  || '0', 10); }
function getBonusAP()   { return parseInt(localStorage.getItem('scrollscape_ap_bonus')  || '0', 10); }
function addBonusAP(n)  {
  const next = getBonusAP() + n;
  localStorage.setItem('scrollscape_ap_bonus', next);
  _pushProgressionToServer({ apBonus: next });
}
function spendAP(n)     {
  const next = Math.max(0, getSpentAP() + n);
  localStorage.setItem('scrollscape_ap_spent', next);
  _pushProgressionToServer({ apSpent: next });
}
function getAvailableAP() { return Math.max(0, achievementManager.unlockedAchievements.size + getBonusAP() - getSpentAP()); }

function getPurchasedThemes() {
  return SHOP_THEMES.map((theme) => theme.id);
}
function addPurchasedTheme(id) {
  const p = getPurchasedThemes();
  if (!p.includes(id)) {
    p.push(id);
    localStorage.setItem('scrollscape_purchased_themes', JSON.stringify(p));
    _pushProgressionToServer({ purchasedThemes: p });
  }
}
function getActiveTheme() { return localStorage.getItem('scrollscape_active_theme') || 'default'; }
function setActiveTheme(id) {
  localStorage.setItem('scrollscape_active_theme', id);
  _pushProgressionToServer({ activeTheme: id });
  applyTheme(id);

  // Activating a base/community theme must clear custom overlay/theme tweaks.
  if (typeof window.setActiveCustom === 'function') window.setActiveCustom(null);
  if (typeof window.applyCustomization === 'function') window.applyCustomization(null);
}

// Called once at startup (see ui-state.js's refreshState()) to reconcile
// localStorage against the server-side copy. Merges rather than overwrites
// in either direction — a "richer side wins" union — so neither a cleared
// browser profile nor a stale/fresh server store file can regress progress;
// whichever side has less simply catches up to whichever has more.
async function syncProgressionWithServer() {
  let server;
  try {
    const res = await fetch('/api/achievements');
    server = res.ok ? await res.json() : null;
  } catch (_) {
    server = null;
  }
  if (!server) return;

  const serverAchievements = Array.isArray(server.achievements) ? server.achievements : [];
  let achievementsChanged = false;
  for (const id of serverAchievements) {
    if (!achievementManager.unlockedAchievements.has(id)) {
      achievementManager.unlockedAchievements.add(id);
      achievementsChanged = true;
    }
  }
  if (achievementsChanged) {
    achievementManager.achievementPoints = Array.from(achievementManager.unlockedAchievements)
      .reduce((sum, id) => sum + (achievementManager.getAchievement(id)?.points || 0), 0);
    achievementManager.saveToStorage();
  }
  // Push any unlock the server doesn't have yet (e.g. a prior POST that
  // failed while offline) back up to it.
  for (const id of achievementManager.unlockedAchievements) {
    if (!serverAchievements.includes(id)) {
      fetch('/api/achievements/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ achievementId: id }),
      }).catch(() => {});
    }
  }

  const serverAp = server.ap || { bonus: 0, spent: 0 };
  const mergedBonus = Math.max(getBonusAP(), Number(serverAp.bonus) || 0);
  const mergedSpent = Math.max(getSpentAP(), Number(serverAp.spent) || 0);
  const apChanged = mergedBonus !== getBonusAP() || mergedSpent !== getSpentAP();
  localStorage.setItem('scrollscape_ap_bonus', mergedBonus);
  localStorage.setItem('scrollscape_ap_spent', mergedSpent);

  const serverThemes = Array.isArray(server.purchasedThemes) ? server.purchasedThemes : ['default'];
  const localThemes = getPurchasedThemes();
  const mergedThemes = Array.from(new Set([...localThemes, ...serverThemes]));
  const themesChanged = mergedThemes.length !== localThemes.length;
  localStorage.setItem('scrollscape_purchased_themes', JSON.stringify(mergedThemes));

  // Active theme has no "merge" concept (single value, not a set/counter) —
  // keep the local choice if one was ever made, otherwise adopt the
  // server's so a wiped profile at least restores the last known theme.
  const hasLocalActive = localStorage.getItem('scrollscape_active_theme') !== null;
  const resolvedActiveTheme = hasLocalActive ? getActiveTheme() : (server.activeTheme || 'default');
  if (!hasLocalActive) localStorage.setItem('scrollscape_active_theme', resolvedActiveTheme);

  if (apChanged || themesChanged || achievementsChanged || !hasLocalActive) {
    _pushProgressionToServer({
      apBonus: mergedBonus,
      apSpent: mergedSpent,
      purchasedThemes: mergedThemes,
      activeTheme: resolvedActiveTheme,
    });
  }

  if (typeof updateApBadge === 'function') updateApBadge();
  applyTheme(resolvedActiveTheme);
  // applyTheme() alone resets --primary/etc. to the base theme's colours —
  // without this, a custom preset's palette silently reverts to default
  // purple the moment this (startup-only) resync runs, while the preset's
  // background images stay put, since those aren't touched by applyTheme().
  if (typeof getActiveCustom === 'function' && typeof applyCustomization === 'function') {
    applyCustomization(getActiveCustom());
  }
}
window.syncProgressionWithServer = syncProgressionWithServer;
// WCAG relative luminance / contrast ratio — used below to pick readable
// button text per theme. Buttons (.btn/.btn-reroll, manga-details-page.css)
// are a fixed linear-gradient(--primary -> --primary-light) with plain white
// text; confirmed live that a couple of themes (dragonball, gintama) have
// gradients light enough that white text drops to ~1.6:1 contrast against
// the lighter stop — genuinely hard to read, not just "a bit weak". A
// text-shadow was tried first and wasn't enough against a background that
// light; picking black-or-white per theme is what actually fixes it.
function _hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function _relLuminance(hex) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = _hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function _contrastRatio(hex1, hex2) {
  const l1 = _relLuminance(hex1), l2 = _relLuminance(hex2);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}
// Checked against BOTH gradient stops, not just the lighter one — picks
// whichever of white/dark keeps the higher WORST-case contrast across the
// whole gradient, not just one end of it.
function _bestOnPrimaryText(bgHex1, bgHex2) {
  const WHITE = '#ffffff', DARK = '#14121a';
  const worstFor = (textHex) => Math.min(_contrastRatio(textHex, bgHex1), _contrastRatio(textHex, bgHex2));
  return worstFor(WHITE) >= worstFor(DARK) ? WHITE : DARK;
}

function applyTheme(id) {
  // Call onRemove for the previously active community theme
  const prevId = document.documentElement.getAttribute('data-color-theme') || '';
  if (prevId && prevId !== id) {
    const prev = (window.COMMUNITY_THEMES || []).find(t => t.id === prevId);
    if (prev?.onRemove) prev.onRemove();
  }
  const t = SHOP_THEMES.find(x => x.id === id) || SHOP_THEMES[0];
  const root = document.documentElement;
  root.style.setProperty('--primary',       t.primary);
  root.style.setProperty('--primary-dark',  t.primaryDark);
  root.style.setProperty('--primary-light', t.primaryLight);
  root.style.setProperty('--btn-text', _bestOnPrimaryText(t.primary, t.primaryLight));
  root.setAttribute('data-color-theme', id === 'default' ? '' : id);
  // Call onApply for the newly activated community theme
  const next = (window.COMMUNITY_THEMES || []).find(t => t.id === id);
  if (next?.onApply) next.onApply();
}
function updateApBadge() {
  const ap = getAvailableAP();
  
  // Update sidebar badge (always present)
  const badge = document.getElementById('sidebarApBadge');
  if (badge) badge.textContent = `${ap} AP`;
  
  // Update achievements page balance
  const achEl = document.getElementById('achPageApBalance');
  if (achEl) achEl.textContent = ap;
  
  // Update shop page balance
  const shopEl = document.getElementById('shopApBalance');
  if (shopEl) shopEl.textContent = ap;
  
  // Update any other AP displays in the current view
  document.querySelectorAll('[data-ap-balance]').forEach(el => {
    el.textContent = ap;
  });
}

