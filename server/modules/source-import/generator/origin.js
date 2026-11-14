'use strict';

// Where a generated source came from, written into the file itself as one comment line:
//
//   // scrollscape-generated engine=madara base=https://example.org on=2026-10-28
//
// It is what lets the app offer "Regenerate" for a source it wrote (look at the site again, write the source again, replace the
// installed one after the person confirms), whichever way the source was installed. It is read from the file that is installed, not
// from anything the browser sends, and it only counts while the file is the one that was installed (regenerate.js checks the
// fingerprint). Reading it never runs the file. A line like this in a hand-written file only offers a re-run of the generator for that
// address, and the replacement still needs the person's confirmation.

const TAG = 'scrollscape-generated';
const LINE_RE = new RegExp(`^// ${TAG} engine=([a-z]{3,30}) base=(https://[a-z0-9.-]{1,200}(?::\\d{1,5})?) on=(\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm');
const LINE_ANY_RE = new RegExp(`^// ${TAG} .*$`, 'gm');
const HEAD_CHARS = 4000;

/** The line a generated file carries, for a validated engine id and base origin. */
const originLine = ({ engine, base, on }) => `// ${TAG} engine=${engine} base=${base} on=${on}`;

/** { engine, base, on } of the line near the top of `text`, or null when there is none or it is not exactly this shape. */
function readOrigin(text) {
  const match = LINE_RE.exec(String(text || '').slice(0, HEAD_CHARS));
  if (!match) return null;
  let origin;
  try { origin = new URL(match[2]).origin; } catch (_) { return null; }
  return origin === match[2] ? { engine: match[1], base: match[2], on: match[3] } : null;
}

/** The text with its origin line taken out and line endings made LF, so two generations can be compared. */
const withoutOrigin = (text) => String(text || '').replace(/\r\n/g, '\n').replace(LINE_ANY_RE, '');

/** Whether two generated files are the same apart from the date they were written. */
const sameApartFromOrigin = (a, b) => withoutOrigin(a) === withoutOrigin(b);

module.exports = { originLine, readOrigin, sameApartFromOrigin, TAG };
