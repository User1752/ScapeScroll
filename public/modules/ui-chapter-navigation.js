// ============================================================================
// CHAPTER NAVIGATION
// ============================================================================

// Pulls the chapter number a title embeds as plain text ("Vol.38 Chapter
// 407 : 5000-Man Commander" → "407"), independent of whatever the source
// declared in the chapter's own `chapter`/`number` field.
function _chapterTitleNumber(ch) {
  const text = String(ch?.name || ch?.title || '');
  const m = text.match(/chapter\s+(\d+(?:\.\d+)?)/i);
  return m ? m[1] : '';
}

// Two chapter entries are the same real chapter if either their declared
// number matches OR the number embedded in their title text matches — the
// second check exists because some sources' own re-imports/republishes
// carry a DIFFERENT declared number from the original they duplicate.
// Confirmed live: Comizy's Kingdom re-added chapter 407 as a second entry
// with `chapter: "455"` and a mangled title "Chapter 407 - 5000", while
// the original carries `chapter: "456"` and "Vol.38 Chapter 407 : 5000-Man
// Commander" — a plain `.chapter` comparison never caught this since the
// declared numbers genuinely differ, but both titles still embed "Chapter
// 407" as text.
function _isSameChapter(a, b) {
  if (!a || !b) return false;
  const declaredA = String(a.chapter ?? '').trim();
  const declaredB = String(b.chapter ?? '').trim();
  if (declaredA && declaredA === declaredB) return true;
  const titleA = _chapterTitleNumber(a);
  const titleB = _chapterTitleNumber(b);
  return !!titleA && titleA === titleB;
}

function getNextChapterIndex(currentIndex) {
  // Chapters are sorted newest-first, so "next" chapter = lower index
  if (!state.settings.skipDuplicates || !state.allChapters.length) return currentIndex - 1;
  const cur = state.allChapters[currentIndex];
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (!_isSameChapter(state.allChapters[i], cur)) return i;
  }
  return currentIndex - 1;
}

function getPrevChapterIndex(currentIndex) {
  // Chapters are sorted newest-first, so "prev" chapter = higher index
  if (!state.settings.skipDuplicates || !state.allChapters.length) return currentIndex + 1;
  const cur = state.allChapters[currentIndex];
  for (let i = currentIndex + 1; i < state.allChapters.length; i++) {
    if (!_isSameChapter(state.allChapters[i], cur)) return i;
  }
  return currentIndex + 1;
}

async function goToNextChapter() {
  const next = getNextChapterIndex(state.currentChapterIndex);
  if (next < 0 || next >= (state.allChapters?.length || 0)) {
    showToast("Last chapter reached", "", "info"); return;
  }
  const ch = state.allChapters[next];
  if (!ch) { showToast("Last chapter reached", "", "info"); return; }
  await recordReadingSession();
  await loadChapter(ch.id, ch.name || `Chapter ${ch.chapter || next + 1}`, next);
}

async function goToPrevChapter() {
  const prev = getPrevChapterIndex(state.currentChapterIndex);
  if (prev >= state.allChapters.length) { showToast("First chapter reached", "", "info"); return; }
  await recordReadingSession();
  const ch = state.allChapters[prev];
  await loadChapter(ch.id, ch.name || `Chapter ${ch.chapter || prev + 1}`, prev);
}

