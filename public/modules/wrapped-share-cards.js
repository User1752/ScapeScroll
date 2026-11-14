// ============================================================================
// WRAPPED SHARE CARDS
//
// The Wrapped tab's numbers as an image to share (PNG), drawn on a canvas in the browser: nothing is sent anywhere. Two cards ("recap":
// the big number, three totals, the tops and the genres; "top5": the five most read manga with their covers) in two sizes (square
// 1080x1080, story 1080x1920).
//
// Split in two so most of it can be tested without a canvas:
//   wrappedCardModel(w, options)        what is on the card, as plain data: strings (translated), the lists cut to what fits, the notes
//   drawWrappedCard(ctx, model, ...)    puts that on a 2D context (the real one, or a recording one in the tests)
//   renderWrappedCardBlob(w, options)   loads the covers, draws, and returns the PNG
//
// Two rules that matter for something that leaves the app:
//  - the card is made from the SAME object the page shows, which the server already filtered (adult titles, hidden titles): nothing
//    that was hidden can reach it, and a period that reaches before the detailed history says so on the card;
//  - every cover goes through this app's own image proxy (same origin), or the browser would refuse to export the canvas ("tainted").
// ============================================================================

const WRAPPED_CARD_SIZES = Object.freeze({ square: { w: 1080, h: 1080 }, story: { w: 1080, h: 1920 } });
const WRAPPED_CARD_VARIANTS = Object.freeze(['recap', 'top5']);
const WRAPPED_CARD_FONT = '"Inter","Segoe UI",system-ui,-apple-system,sans-serif';
const WRAPPED_COVER_TIMEOUT_MS = 8000;

const _wcNum = (n) => Number(n || 0).toLocaleString(typeof currentLanguage === 'string' ? currentLanguage : undefined);

// The cover as an address on THIS server's origin ('' when there is none).
function wrappedCardCoverSrc(cover) {
  const value = typeof normalizeImageUrl === 'function' ? normalizeImageUrl(cover) : String(cover || '').trim();
  if (!value) return '';
  if (value.startsWith('/api/proxy-image')) return value;
  if (/^https?:\/\//i.test(value)) return `/api/proxy-image?url=${encodeURIComponent(value)}`;
  // A path of this app only. "//host/x" (and "/\\host/x") is an address on ANOTHER site that a browser reads as a path: it would be fetched
  // directly, outside the proxy, and the canvas could not be exported.
  return /^\/(?![/\\])/.test(value) ? value : '';
}

function _wcTime(minutes) {
  return typeof formatTime === 'function' ? formatTime(minutes) : `${Math.round(minutes)}m`;
}

function wrappedCardModel(w, options = {}) {
  const variant = WRAPPED_CARD_VARIANTS.includes(options.variant) ? options.variant : 'recap';
  const sizeId = options.size === 'story' ? 'story' : 'square';
  const story = sizeId === 'story';
  const r = w.reading || {};
  const a = w.anime || {};
  const act = w.activity || {};
  const showPeriod = options.showPeriod !== false;
  // The AniList view brings its card already in words (wrapped-anilist.js): its manga or anime fills the "manga" slot, its people the "authors" one.
  const al = w.source === 'anilist' ? w.card : null;

  const manga = al ? al.top.map((m) => ({ ...m, cover: wrappedCardCoverSrc(m.cover) })) : (r.topManga || []).map((m, i) => ({
    rank: i + 1,
    title: m.title,
    detail: [t('wrapped.nChapters').split('{n}').join(_wcNum(m.chapters)), m.minutes ? _wcTime(m.minutes) : '', m.rating ? `★ ${m.rating}` : ''].filter(Boolean).join(' · '),
    cover: wrappedCardCoverSrc(m.cover),
  }));
  const authors = al ? al.people : (r.topAuthors || []).map((x, i) => ({ rank: i + 1, title: x.author, detail: t('wrapped.nChapters').split('{n}').join(_wcNum(x.chapters)), cover: '' }));
  const anime = al ? [] : (a.topAnime || []).map((x, i) => ({ rank: i + 1, title: x.title, detail: t('wrapped.nEpisodes').split('{n}').join(_wcNum(x.episodes)), cover: wrappedCardCoverSrc(x.cover) }));
  const genres = al ? al.genres : (r.topGenres || []).map((g) => ({ label: g.genre, share: g.share, text: `${Math.round(g.share * 100)}%` }));

  const partial = w.coverage?.partial && w.coverage.detailedSince
    ? t('wrapped.card.since').split('{date}').join(_wcDate(w.coverage.detailedSince))
    : '';

  const model = {
    variant,
    sizeId,
    size: WRAPPED_CARD_SIZES[sizeId],
    brand: t('wrapped.card.brand'),
    period: al ? (showPeriod ? al.periodText : 'AniList') : (showPeriod ? `${w.period?.label || ''} · Wrapped` : 'Wrapped'),
    partial,
    number: al ? al.number : _wcNum(r.chapters),
    unit: al ? al.unit : t('wrapped.heroChapters'),
    stats: al ? al.stats : [
      { label: t('wrapped.card.readingTime'), value: r.minutes ? _wcTime(r.minutes) : '—' },
      { label: t('wrapped.card.titles'), value: _wcNum(r.titles) },
      { label: t('wrapped.card.streak'), value: act.longestStreak ? t('wrapped.days').split('{n}').join(act.longestStreak) : '—' },
    ],
    sections: [],
    empty: al ? !manga.length : !r.chapters && !a.episodes,
  };

  if (variant === 'recap') {
    model.sections.push({ id: 'manga', title: al ? al.topTitle : t('wrapped.card.topManga'), rows: manga.slice(0, story ? 5 : 3), covers: true });
    model.sections.push({ id: 'authors', title: al ? al.peopleTitle : t('wrapped.card.topAuthors'), rows: authors.slice(0, 3), covers: false });
    if (genres.length) model.sections.push({ id: 'genres', title: t('wrapped.card.topGenres'), bars: genres.slice(0, story ? 5 : 2) });
    if (story && anime.length) model.sections.push({ id: 'anime', title: t('wrapped.card.topAnime'), rows: anime.slice(0, 2), covers: true });
  } else {
    model.title = t('wrapped.card.top5');
    model.sections.push({ id: 'manga', rows: manga.slice(0, 5), covers: true, big: true });
    if (story && genres.length) model.sections.push({ id: 'genres', title: t('wrapped.card.topGenres'), bars: genres.slice(0, 3) });
  }
  model.sections = model.sections.filter((s) => (s.rows && s.rows.length) || (s.bars && s.bars.length));
  return model;
}

function _wcDate(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12).toLocaleDateString(typeof currentLanguage === 'string' ? currentLanguage : undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function wrappedCardFileName(w, options = {}) {
  const period = String(w.period?.id === 'year' ? w.period.label : w.period?.id || 'wrapped').replace(/[^a-z0-9-]/gi, '');
  const from = w.source === 'anilist' ? `anilist-${w.kind === 'anime' ? 'anime' : 'manga'}-` : '';
  return `scrollscape-wrapped-${from}${period}-${WRAPPED_CARD_VARIANTS.includes(options.variant) ? options.variant : 'recap'}-${options.size === 'story' ? 'story' : 'square'}.png`;
}

// ── drawing ─────────────────────────────────────────────────────────────────

function _wcPalette(options) {
  let primary = '#913FE2';
  let dark = '#5b2a91';
  if (options.followTheme !== false && typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    const style = getComputedStyle(document.documentElement);
    primary = (style.getPropertyValue('--primary') || primary).trim() || primary;
    dark = (style.getPropertyValue('--primary-dark') || dark).trim() || dark;
  }
  return { primary, dark, text: '#ffffff', muted: 'rgba(255,255,255,0.62)', panel: 'rgba(255,255,255,0.07)', line: 'rgba(255,255,255,0.12)' };
}

function _wcRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// The text cut with an ellipsis to fit `maxWidth` at the font the context has now.
function _wcFit(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

function _wcText(ctx, text, x, y, { size, weight = 400, color, align = 'left', max, spacing }) {
  ctx.font = `${weight} ${size}px ${WRAPPED_CARD_FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing || '0px';
  ctx.fillText(max ? _wcFit(ctx, text, max) : String(text), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

function _wcCover(ctx, img, x, y, w, h, radius, label, pal) {
  _wcRoundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = pal.panel;
  ctx.fill();
  if (img) {
    ctx.save();
    _wcRoundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    const scale = Math.max(w / img.width, h / img.height);
    ctx.drawImage(img, x + (w - img.width * scale) / 2, y + (h - img.height * scale) / 2, img.width * scale, img.height * scale);
    ctx.restore();
  } else {
    _wcText(ctx, String(label || '?').trim().charAt(0).toUpperCase() || '?', x + w / 2, y + h / 2 + h * 0.14, { size: Math.round(h * 0.42), weight: 800, color: pal.muted, align: 'center' });
  }
}

// A column of ranked rows (a rank, an optional cover, a title and a detail line). Returns the y under the last row.
function _wcRows(ctx, section, x, width, y, spec, images, pal) {
  section.rows.forEach((row, i) => {
    const top = y + i * spec.rowH;
    _wcText(ctx, String(row.rank), x + 14, top + spec.rowH / 2 + 12, { size: 34, weight: 800, color: pal.primary, align: 'center' });
    let tx = x + 44;
    if (section.covers) {
      _wcCover(ctx, images.get(row.cover) || null, tx, top + (spec.rowH - spec.coverH) / 2, spec.coverW, spec.coverH, 8, row.title, pal);
      tx += spec.coverW + 18;
    }
    const maxW = x + width - tx;
    _wcText(ctx, row.title, tx, top + spec.rowH / 2 - 2, { size: spec.titleSize, weight: 700, color: pal.text, max: maxW });
    _wcText(ctx, row.detail, tx, top + spec.rowH / 2 + spec.titleSize * 0.85, { size: Math.round(spec.titleSize * 0.72), weight: 500, color: pal.muted, max: maxW });
  });
  return y + section.rows.length * spec.rowH;
}

function _wcHeading(ctx, text, x, y, pal) {
  _wcText(ctx, String(text).toUpperCase(), x, y, { size: 20, weight: 700, color: pal.muted, spacing: '3px' });
}

// The bars of the genres. Returns the y under the last one.
function _wcBars(ctx, section, box, startY, pal) {
  let y = startY;
  const labelW = 210;
  const valueW = 90;
  const trackX = box.x + labelW + 16;
  const trackW = box.w - labelW - valueW - 32;
  const max = Math.max(0.0001, ...section.bars.map((b) => b.share));
  section.bars.forEach((b) => {
    _wcText(ctx, b.label, box.x, y + 30, { size: 26, weight: 600, color: pal.text, max: labelW });
    _wcRoundRect(ctx, trackX, y + 12, trackW, 16, 8);
    ctx.fillStyle = pal.panel;
    ctx.fill();
    _wcRoundRect(ctx, trackX, y + 12, Math.max(16, trackW * (b.share / max)), 16, 8);
    ctx.fillStyle = pal.primary;
    ctx.fill();
    _wcText(ctx, b.text, box.x + box.w, y + 30, { size: 24, weight: 600, color: pal.muted, align: 'right' });
    y += 46;
  });
  return y;
}

// What the layout needs below the content: nothing may be drawn under H - BOTTOM (the tests check it).
const WRAPPED_CARD_PAD = 72;

// `images`: Map of cover address -> a loaded image (a cover that did not load is simply not in it: its first letter is drawn instead).
function drawWrappedCard(ctx, model, options = {}, images = new Map()) {
  const { w: W, h: H } = model.size;
  const pal = _wcPalette(options);
  const pad = WRAPPED_CARD_PAD;
  const story = model.sizeId === 'story';
  const box = { x: pad, w: W - pad * 2 };

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d0a14');
  bg.addColorStop(0.55, '#14101f');
  bg.addColorStop(1, pal.dark);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.1, H * 0.06, 0, W * 0.1, H * 0.06, W * 0.85);
  glow.addColorStop(0, `${pal.primary}55`);
  glow.addColorStop(1, `${pal.primary}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.beginPath();
  ctx.arc(pad + 14, pad + 8, 14, 0, Math.PI * 2);
  ctx.fillStyle = pal.primary;
  ctx.fill();
  _wcText(ctx, model.brand, pad + 44, pad + 18, { size: 26, weight: 700, color: pal.muted, spacing: '3px' });
  let y = pad + 96;
  _wcText(ctx, model.period, pad, y, { size: 36, weight: 600, color: pal.muted, max: box.w });
  y += 24;

  if (model.empty) {
    _wcText(ctx, t('wrapped.empty'), pad, y + 120, { size: 34, weight: 600, color: pal.muted, max: box.w });
    return;
  }

  const note = () => { if (model.partial) { _wcText(ctx, model.partial, pad, y, { size: 22, weight: 500, color: pal.muted, max: box.w }); y += 26; } };

  if (model.variant === 'top5') {
    _wcText(ctx, model.title, pad, y + 66, { size: 72, weight: 800, color: pal.text, max: box.w });
    y += 104;
    note();
    y += 14;
    const manga = model.sections.find((s) => s.id === 'manga');
    if (manga) {
      y = _wcRows(ctx, manga, box.x, box.w, y, story ? { rowH: 240, coverW: 150, coverH: 214, titleSize: 44 } : { rowH: 128, coverW: 88, coverH: 120, titleSize: 34 }, images, pal) + 20;
    }
    const genres = model.sections.find((s) => s.id === 'genres');
    if (genres) {
      _wcHeading(ctx, genres.title, pad, y, pal);
      _wcBars(ctx, genres, box, y + 26, pal);
    }
    return;
  }

  // recap: the big number...
  const numberSize = story ? 230 : 170;
  _wcText(ctx, model.number, pad - 4, y + (story ? 190 : 136), { size: numberSize, weight: 800, color: pal.text });
  const numWidth = ctx.measureText(model.number).width;
  _wcText(ctx, model.unit, pad + numWidth + 24, y + (story ? 190 : 136), { size: 44, weight: 600, color: pal.muted, max: W - pad - numWidth - 24 - pad });
  y += story ? 230 : 170;
  note();
  y += 14;

  // ...three totals...
  const gap = 24;
  const boxW = (box.w - gap * 2) / 3;
  const boxH = story ? 130 : 118;
  model.stats.forEach((s, i) => {
    const bx = pad + i * (boxW + gap);
    _wcRoundRect(ctx, bx, y, boxW, boxH, 20);
    ctx.fillStyle = pal.panel;
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    _wcText(ctx, s.label.toUpperCase(), bx + 24, y + 40, { size: 19, weight: 700, color: pal.muted, spacing: '2px', max: boxW - 40 });
    _wcText(ctx, s.value, bx + 24, y + boxH - 22, { size: 44, weight: 800, color: pal.text, max: boxW - 40 });
  });
  y += boxH + (story ? 44 : 34);

  const manga = model.sections.find((s) => s.id === 'manga');
  const authors = model.sections.find((s) => s.id === 'authors');
  const genres = model.sections.find((s) => s.id === 'genres');
  const anime = model.sections.find((s) => s.id === 'anime');

  // ...the tops: side by side on the square card, one under the other on the story
  if (!story && manga && authors) {
    const colGap = 48;
    const colW = (box.w - colGap) / 2;
    _wcHeading(ctx, manga.title, box.x, y, pal);
    _wcHeading(ctx, authors.title, box.x + colW + colGap, y, pal);
    const rowSpec = { rowH: 84, coverW: 46, coverH: 64, titleSize: 26 };
    const bottomA = _wcRows(ctx, manga, box.x, colW, y + 26, rowSpec, images, pal);
    const bottomB = _wcRows(ctx, authors, box.x + colW + colGap, colW, y + 26, { ...rowSpec, coverW: 0, coverH: 0 }, images, pal);
    y = Math.max(bottomA, bottomB) + 32;
  } else {
    for (const section of [manga, authors]) {
      if (!section) continue;
      _wcHeading(ctx, section.title, box.x, y, pal);
      y = _wcRows(ctx, section, box.x, box.w, y + 26, section.covers ? { rowH: 88, coverW: 46, coverH: 64, titleSize: 28 } : { rowH: 66, coverW: 0, coverH: 0, titleSize: 28 }, images, pal) + 16;
    }
  }
  if (genres) {
    _wcHeading(ctx, genres.title, box.x, y, pal);
    y = _wcBars(ctx, genres, box, y + 26, pal) + 14;
  }
  if (story && anime) {
    _wcHeading(ctx, anime.title, box.x, y, pal);
    _wcRows(ctx, anime, box.x, box.w, y + 26, { rowH: 88, coverW: 46, coverH: 64, titleSize: 28 }, images, pal);
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

function _wcLoadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    const timer = setTimeout(() => resolve(null), WRAPPED_COVER_TIMEOUT_MS);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}

async function renderWrappedCardCanvas(w, options = {}) {
  const model = wrappedCardModel(w, options);
  const sources = new Set();
  for (const s of model.sections) for (const row of (s.rows || [])) if (row.cover) sources.add(row.cover);
  const loaded = await Promise.all([...sources].map(async (src) => [src, await _wcLoadImage(src)]));
  const images = new Map(loaded.filter(([, img]) => img));
  const canvas = document.createElement('canvas');
  canvas.width = model.size.w;
  canvas.height = model.size.h;
  drawWrappedCard(canvas.getContext('2d'), model, options, images);
  return canvas;
}

async function renderWrappedCardBlob(w, options = {}) {
  const canvas = await renderWrappedCardCanvas(w, options);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be made'))), 'image/png');
    } catch (e) { reject(e); } // a tainted canvas throws here: every cover goes through the proxy so it should not
  });
}
