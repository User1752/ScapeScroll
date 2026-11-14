'use strict';

// Reading the answer a Next.js site gives to a page asked with the "rsc" header (React Server Components): the data a page is made of, as rows.
//
//   <hex id>:<value>         one to a line; the value is JSON
//   <hex id>:T<hex n>,<text> a long string: n BYTES of text follow (the JSON refers to it as "$<id>")
//
// References inside a value are strings: "$<id>" (or "$L<id>", "$@<id>") for another row, "$undefined", and "$$" for a literal dollar. The data a
// source wants sits somewhere inside the rows; it is found by the NAMES of its fields (a site that renames a field is "not found", never a wrong
// value). Everything read here is plain data: nothing is run, nothing is put in a page. This file is shared by the sources written for such sites
// (they require it) and by the generator's discovery, so the two can never read an answer differently.

const ROW_ID_RE = /^[0-9a-f]{1,8}$/;
const REF_RE = /^\$[L@]?([0-9a-f]{1,8})$/;
const MAX_RESOLVE_NODES = 200_000;
const MAX_DEPTH = 30;

/**
 * The rows of an answer: id -> { value } or { text }. A row that is neither JSON nor text (a module reference, a hint) is skipped.
 * @param {string} answer
 * @returns {Map<string, { value?: any, text?: string }>}
 */
function rscRows(answer) {
  const bytes = Buffer.from(String(answer), 'utf8').toString('latin1'); // one character per byte, so the lengths of text rows are exact
  const rows = new Map();
  let at = 0;
  while (at < bytes.length) {
    while (bytes[at] === '\n' || bytes[at] === '\r') at += 1; // a line break between rows (also after a text row)
    const colon = bytes.indexOf(':', at);
    if (colon < 0) break;
    const id = bytes.slice(at, colon);
    if (!ROW_ID_RE.test(id)) {
      const nl = bytes.indexOf('\n', at);
      at = nl < 0 ? bytes.length : nl + 1;
      continue;
    }
    const start = colon + 1;
    if (bytes[start] === 'T') {
      const comma = bytes.indexOf(',', start);
      const length = comma < 0 ? NaN : parseInt(bytes.slice(start + 1, comma), 16);
      if (!Number.isFinite(length)) break;
      rows.set(id, { text: Buffer.from(bytes.slice(comma + 1, comma + 1 + length), 'latin1').toString('utf8') });
      at = comma + 1 + length;
      continue;
    }
    const nl = bytes.indexOf('\n', start);
    const end = nl < 0 ? bytes.length : nl;
    try { rows.set(id, { value: JSON.parse(Buffer.from(bytes.slice(start, end), 'latin1').toString('utf8')) }); } catch (_) { /* not JSON */ }
    at = end + 1;
  }
  return rows;
}

/** A value with the references to other rows replaced by what they hold (a budget and a depth keep a loop from running away). */
function rscResolve(value, rows, budget = { left: MAX_RESOLVE_NODES }, depth = 0) {
  if (budget.left-- <= 0 || depth > MAX_DEPTH) return null;
  if (typeof value === 'string') {
    if (value === '$undefined') return null;
    const m = REF_RE.exec(value);
    if (m && rows.has(m[1])) {
      const row = rows.get(m[1]);
      return row.text !== undefined ? row.text : rscResolve(row.value, rows, budget, depth + 1);
    }
    return value.startsWith('$$') ? value.slice(1) : value;
  }
  if (Array.isArray(value)) return value.map((v) => rscResolve(v, rows, budget, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rscResolve(v, rows, budget, depth + 1)]));
  return value;
}

/** The first object, anywhere in the rows, for which `test` is true (by the names of its fields). */
function rscFind(rows, test) {
  const walk = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 16) return null;
    if (!Array.isArray(x) && test(x)) return x;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      const hit = walk(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const row of rows.values()) {
    if (row.value !== undefined) {
      const hit = walk(row.value, 0);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = { rscRows, rscResolve, rscFind };
