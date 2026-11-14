'use strict';

// The date a site prints beside a chapter, as an ISO date: or null. Sites print "3 days ago", "Mar 4, 2026", "04/03/2026", "4 de março de 2026", "il y a 3 jours"...
// and a wrong date is worse than none, so this never guesses: a relative time is counted only for seconds, minutes, hours and days (a week or a month ago is not
// a day), a numeric date whose order (day first or month first) the site never settled is read in the order the generator measured on that site, and anything it
// cannot read is null. The month and unit words of the main Latin-script languages of manga sites are here (English, Portuguese, Spanish, French, German,
// Italian, Indonesian, Turkish). This file is shared by the sources the generator writes (they require it) and by the generator's own measurement of a site's
// date order, so the two can never read a date differently.

const DAY_MS = 86_400_000;

// Lower-case, accents removed ("março" -> "marco", "gün" -> "gun"), so one table serves every spelling.
// The combining marks (U+0300 to U+036F) built from code points, never typed.
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const fold = (text) => String(text || '').normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();

const MONTH_WORDS = {
  1: 'january jan janeiro janv januar gennaio gen januari ocak enero ene',
  2: 'february feb fevereiro fev fevrier februar febbraio februari subat febrero',
  3: 'march mar marco mars marz marzo maret mart',
  4: 'april apr abril avril aprile nisan abr',
  5: 'may mai maio mayo mag maggio mei mayis',
  6: 'june jun junho juin juni giugno giu haziran junio',
  7: 'july jul julho juillet juil juli luglio lug temmuz julio',
  8: 'august aug agosto aout ago agu agustus agustos',
  9: 'september sep sept setembro set septembre settembre septiembre setiembre eylul',
  10: 'october oct outubro out octobre oktober okt ottobre ott octubre ekim',
  11: 'november nov novembro novembre noviembre kasim',
  12: 'december dec dezembro dez decembre dezember dicembre dic desember des diciembre aralik',
};
const MONTH_OF = new Map();
for (const [number, words] of Object.entries(MONTH_WORDS)) for (const word of words.split(' ')) MONTH_OF.set(word, Number(number));

// The units of a relative time, by scale: the exact ones count, the coarse ones are recognised (so they are not mistaken for something else) and give null.
const UNIT_WORDS = [
  [1000, /^(?:s|sec|secs|second|seconds|seg|segundo|segundos|seconde|secondes|sekunde|sekunden|secondo|secondi|detik|saniye)$/],
  [60_000, /^(?:m|min|mins|minute|minutes|minuto|minutos|minuut|minuten|minuti|menit|dakika)$/],
  [3_600_000, /^(?:h|hr|hrs|hour|hours|hora|horas|heure|heures|stunde|stunden|std|ora|ore|jam|saat)$/],
  [DAY_MS, /^(?:d|day|days|dia|dias|jour|jours|tag|tage|tagen|giorno|giorni|hari|gun)$/],
  [0, /^(?:w|week|weeks|semana|semanas|semaine|semaines|woche|wochen|settimana|settimane|minggu|hafta|mes|meses|month|months|mois|monat|monate|monaten|mese|mesi|bulan|ay|ano|anos|year|years|an|ans|annee|annees|jahr|jahre|jahren|anno|anni|tahun|yil)$/],
];
const RELATIVE_MARKER = /\b(?:ago|atras|ha|hace|il y a|vor|fa|lalu|once|yang lalu)\b/;
const RELATIVE_RE = /(\d+|an?|um|uma|un|una|ein|eine|bir)\s*([a-z]+)\b/g;

/** Whether the text is a relative time ("3 days ago", "há 2 horas"): a date that is only a day is not one. */
function isRelativeDate(text) {
  const s = fold(text);
  return RELATIVE_MARKER.test(s) && /\d|\b(?:an?|um|uma|un|una|ein|eine|bir)\b/.test(s);
}

function parseRelative(s, now) {
  RELATIVE_RE.lastIndex = 0;
  let m;
  while ((m = RELATIVE_RE.exec(s))) {
    const amount = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const unit = UNIT_WORDS.find(([, re]) => re.test(m[2]));
    if (!unit) continue;
    if (!unit[0] || amount > 100_000) return null; // coarse units are not a publication date
    return new Date(now - amount * unit[0]).toISOString();
  }
  return null;
}

const iso = (year, month, day, now) => {
  if (!(year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const t = Date.UTC(year, month - 1, day);
  const back = new Date(t);
  if (back.getUTCMonth() !== month - 1) return null; // "31 February"
  return t <= now + 2 * DAY_MS ? back.toISOString() : null;
};

/**
 * The ISO date a chapter's printed date stands for, or null.
 * @param {string} text   as the site prints it
 * @param {{ order?: 'dmy'|'mdy'|'ymd', now?: number }} [options]   `order`: how a numeric date with no day above 12 is read (measured on the site)
 * @returns {string|null}
 */
function parseChapterDate(text, { order = 'mdy', now = Date.now() } = {}) {
  const s = fold(text);
  if (!s || s.length > 60) return null;
  if (isRelativeDate(s)) return parseRelative(s, now);
  // A full ISO date or time ("2026-03-04", "2026-03-04T05:06:07Z").
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[t ].*)?$/.exec(s);
  if (m) { const t = /[t ]\d/.test(s) ? Date.parse(String(text).trim()) : NaN; return Number.isFinite(t) && t <= now + 2 * DAY_MS ? new Date(t).toISOString() : iso(Number(m[1]), Number(m[2]), Number(m[3]), now); }
  // Numbers only, with ".", "/" or "-": the year is the four-digit part, the other two are read in the measured order.
  m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(s);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[1].length === 4) return iso(a, b, c, now); // year first: month then day
    const year = m[3].length === 2 ? 2000 + c : c;
    if (a > 12) return iso(year, b, a, now); // the first part cannot be a month: day first
    if (b > 12) return iso(year, a, b, now); // the second cannot: month first
    return order === 'dmy' ? iso(year, b, a, now) : iso(year, a, b, now);
  }
  // A month named in words, in either order ("4 de marco de 2026", "4 mar 2026", "march 4, 2026", "mar 4 2026").
  const words = s.replace(/[.,]/g, ' ').replace(/\b(?:de|del|of|the|em|le|am|den|di|pada)\b/g, ' ').replace(/\b(\d{1,2})(?:st|nd|rd|th|o|er)\b/g, '$1').replace(/\s+/g, ' ').trim();
  m = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(words);
  if (m && MONTH_OF.has(m[2])) return iso(Number(m[3]), MONTH_OF.get(m[2]), Number(m[1]), now);
  m = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(words);
  if (m && MONTH_OF.has(m[1])) return iso(Number(m[3]), MONTH_OF.get(m[1]), Number(m[2]), now);
  m = /^(\d{4}) ([a-z]+) (\d{1,2})$/.exec(words);
  if (m && MONTH_OF.has(m[2])) return iso(Number(m[1]), MONTH_OF.get(m[2]), Number(m[3]), now);
  return null;
}

/**
 * How a site orders the parts of a numeric date, from what it printed: a part above 12 settles it; four digits first is year first; nothing settled falls back to
 * the language of the page (month first for plain English, day first for the rest of the world).
 * @param {string[]} samples   the printed dates
 * @param {string} [lang]   the `lang` of the page ("en-US", "pt-BR"...)
 * @returns {'dmy'|'mdy'|'ymd'}
 */
function detectDateOrder(samples, lang = '') {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const m = /^\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\s*$/.exec(String(sample || ''));
    if (!m) continue;
    if (m[1].length === 4) { ymd += 1; continue; }
    if (Number(m[1]) > 12) dmy += 1;
    else if (Number(m[2]) > 12) mdy += 1;
  }
  if (ymd && !dmy && !mdy) return 'ymd';
  if (dmy > mdy) return 'dmy';
  if (mdy > dmy) return 'mdy';
  const code = String(lang || '').toLowerCase();
  return code === 'en' || code === 'en-us' || code === 'en_us' ? 'mdy' : 'dmy';
}

module.exports = { parseChapterDate, detectDateOrder, isRelativeDate, fold };
