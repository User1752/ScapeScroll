// ============================================================================
// READER POSITION  –  where in a chapter the person is, and where to start it
//
// Pure functions, so they can be tested without a page. The webtoon reader shows every image of a chapter in one long scroll, so its "page" is the image
// at the top of the view; it used to be written as 0 whatever the scroll, and opening a chapter from the list always began at the top.
// ============================================================================

// items: [{ idx, top }] in reading order (idx = the image's own number in the chapter, top = its top edge on the screen); wrapTop = the top edge of the
// reading area. The image "being read" is the last one whose top edge has reached the top of the view (a little slack, so an image whose edge is a few
// pixels below the line already counts), or the first one when the view is above them all.
function webtoonPageAtTop(items, wrapTop, slack = 24) {
  if (!Array.isArray(items) || !items.length) return 0;
  let found = items[0].idx;
  for (const item of items) {
    if (item.top <= wrapTop + slack) found = item.idx;
    else break;
  }
  return found;
}

// The page to open a chapter at when it is opened from the chapter list. Only the chapter the manga was left in resumes, and only while it is not
// finished: a chapter whose last page was reached is opened again from its first page, as a chapter read before always was.
function chapterStartPage({ saved, total, isLastRead }) {
  const page = Number(saved);
  if (!isLastRead || !Number.isFinite(page) || page <= 0) return 0;
  const pages = Number(total);
  if (Number.isFinite(pages) && pages > 0 && page >= pages - 1) return 0;
  return Math.floor(page);
}
