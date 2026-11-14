#!/usr/bin/env python3
"""ScrollScape terminal monitoring dashboard.

Polls a running ScrollScape server over its existing REST API and renders
source health, a library snapshot, and active bulk downloads as a live
terminal UI. Does not touch ScrollScape's own store or process — it's a
read-only client, safe to run alongside the normal web UI.

Usage:
    python dashboard.py --url http://localhost:4000 [--password ...] [--interval 8]

Environment variables (used when the matching flag is omitted):
    SCROLLSCAPE_URL       default: http://localhost:4000
    SCROLLSCAPE_PASSWORD  only needed if the instance has a password set
"""

import argparse
import os
import sys

import httpx
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Header, ProgressBar, Static

STATUS_COLOR = {"pass": "green", "warning": "yellow", "fail": "red"}

# /api/system/health live-probes every installed source (manga + anime) and
# external service (FlareSolverr, AniList) in parallel, each individually
# capped around 15-20s server-side (see server/routes/system-health.js's own
# comment, which allows up to 45s for this exact reason) — comfortably under
# that in the common case, but real contention (several Cloudflare sources
# queueing on the same FlareSolverr instance, a concurrent Image Quality
# check) can genuinely push it past 10s. The client's blanket default timeout
# used to apply here too, so this endpoint alone would intermittently report
# "Could not reach" while every other, cheap endpoint kept responding
# normally in under half a second — confirmed live (8.8s response time on an
# otherwise idle instance, no error at all, just slow by design).
HEALTH_TIMEOUT = 40.0

# Special exit code the launcher batch script watches for (see
# Launch-ScrollScape.bat, right after it calls this script): rather than
# have this "read-only API client" reach into taskkill/Node process
# management itself, restarting is just "exit with this code" - the batch
# script, which already owns and knows how to restart the server process,
# does the actual work and then re-launches this same dashboard once the
# server is back up.
RESTART_EXIT_CODE = 42


def _color(status: str) -> str:
    return STATUS_COLOR.get(status, "white")


def _fmt_bytes_per_sec(n: float) -> str:
    n = max(0.0, n)
    if n < 1024:
        return f"{n:.0f} B/s"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB/s"
    return f"{n / (1024 * 1024):.1f} MB/s"


def _degraded_names(results: list, max_names: int = 4) -> str | None:
    """Renders the names of any not-passing entries in a health results list
    (e.g. "MangaFox, BatCave, +1 more") — the summary line above it only ever
    said *how many* were degraded/failing, never *which ones*, even though
    the names were already sitting right there in the same API response.
    """
    bad = [r for r in (results or []) if r.get("status") in ("warning", "fail")]
    if not bad:
        return None
    names = [str(r.get("name") or r.get("id") or "?") for r in bad[:max_names]]
    text = ", ".join(names)
    remaining = len(bad) - max_names
    if remaining > 0:
        text += f", +{remaining} more"
    color = "red" if any(r.get("status") == "fail" for r in bad) else "yellow"
    return f"[{color}]{text}[/]"


def _fmt_bytes(n: float) -> str:
    n = max(0.0, n)
    for unit, size in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if n >= size:
            return f"{n / size:.0f} {unit}"
    return f"{n:.0f} B"


class ScrollScapeDashboard(App):
    CSS = """
    Screen {
        layout: horizontal;
    }
    #left-col, #right-col {
        width: 1fr;
        padding: 1 2;
    }
    .panel-title {
        text-style: bold;
        color: $accent;
        margin-top: 1;
    }
    #health-panel, #library-panel, #anime-library-panel {
        border: round $primary;
        padding: 1;
        margin-bottom: 1;
        height: auto;
    }
    #jobs-table, #completed-jobs-table {
        height: 1fr;
        border: round $primary;
    }
    #resource-panel {
        border: round $primary;
        padding: 1;
        margin-bottom: 1;
        height: auto;
    }
    #resource-panel ProgressBar {
        width: 100%;
        margin-bottom: 1;
    }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "restart_everything", "Restart server"),
    ]

    def __init__(self, base_url: str, password: str | None, interval: float):
        super().__init__()
        self.base_url = base_url.rstrip("/")
        self.password = password
        self.interval = interval
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=10.0)
        # refresh_all() is re-fired by a Textual timer every `interval` seconds
        # regardless of whether the previous call finished — without this
        # guard, a slow /api/system/health poll (see HEALTH_TIMEOUT below)
        # overlaps with the next one instead of being skipped, piling up
        # concurrent health probes against the server exactly when it's
        # already slow, making the underlying slowness worse instead of just
        # showing it.
        self._refreshing = False
        # JS Heap's own display used to show only the current instant value,
        # even though the comment right next to it explains the whole point
        # is watching it *trend* upward across a session (the earliest sign
        # of a leaked reference before RSS itself becomes a problem) — there
        # was nowhere that trend was actually kept. Session-local (not
        # persisted): resets on dashboard restart, which is fine since a
        # fresh session watching a fresh trend is exactly what's wanted.
        self._heap_used_peak: float | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal():
            with Vertical(id="left-col"):
                yield Static("Server & Sources", classes="panel-title")
                yield Static("Connecting…", id="health-panel")
                yield Static("Library Snapshot (Manga)", classes="panel-title")
                yield Static("Connecting…", id="library-panel")
                yield Static("Library Snapshot (Anime)", classes="panel-title")
                yield Static("Connecting…", id="anime-library-panel")
            with Vertical(id="right-col"):
                yield Static("Resource Usage", classes="panel-title")
                with Vertical(id="resource-panel"):
                    yield Static("CPU", id="cpu-label")
                    yield ProgressBar(total=100, id="cpu-bar", show_eta=False)
                    yield Static("RAM", id="ram-label")
                    yield ProgressBar(total=100, id="ram-bar", show_eta=False)
                    yield Static("Connecting…", id="network-panel")
                yield Static("Active Downloads", classes="panel-title")
                yield DataTable(id="jobs-table")
                yield Static("Completed Downloads", classes="panel-title")
                yield DataTable(id="completed-jobs-table")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "ScrollScape"
        self.sub_title = self.base_url
        table = self.query_one("#jobs-table", DataTable)
        table.add_columns("Manga", "Progress", "Status")
        table.cursor_type = "row"
        completed_table = self.query_one("#completed-jobs-table", DataTable)
        completed_table.add_columns("Manga", "Chapters", "Result", "Started")
        completed_table.cursor_type = "row"
        await self._ensure_login()
        self.set_interval(self.interval, self.refresh_all)
        await self.refresh_all()

    async def action_restart_everything(self) -> None:
        self.exit(return_code=RESTART_EXIT_CODE, message="Restarting ScrollScape...")

    async def _ensure_login(self) -> None:
        try:
            status = (await self.client.get("/api/auth/status")).json()
        except httpx.HTTPError as e:
            self._show_connection_error(e)
            return

        if status.get("passwordSet") and not status.get("authenticated"):
            if not self.password:
                self.query_one("#health-panel", Static).update(
                    "[red]This instance has a password set.[/red]\n"
                    "Restart with --password or SCROLLSCAPE_PASSWORD."
                )
                return
            try:
                await self.client.post("/api/auth/login", json={"password": self.password})
            except httpx.HTTPError as e:
                self._show_connection_error(e)

    def _show_connection_error(self, e: Exception) -> None:
        msg = f"[red]Could not reach {self.base_url}[/red]\n{e}"
        self.query_one("#health-panel", Static).update(msg)
        self.query_one("#library-panel", Static).update("-")
        self.query_one("#anime-library-panel", Static).update("-")
        self.query_one("#network-panel", Static).update("-")

    async def refresh_all(self) -> None:
        if self._refreshing:
            return
        self._refreshing = True
        try:
            await self._refresh_health()
            await self._refresh_library()
            await self._refresh_anime_library()
            await self._refresh_jobs()
            await self._refresh_resources()
        finally:
            self._refreshing = False

    async def _refresh_resources(self) -> None:
        cpu_bar = self.query_one("#cpu-bar", ProgressBar)
        ram_bar = self.query_one("#ram-bar", ProgressBar)
        cpu_label = self.query_one("#cpu-label", Static)
        ram_label = self.query_one("#ram-label", Static)
        net_panel = self.query_one("#network-panel", Static)

        try:
            data = (await self.client.get("/api/system/resources")).json()
        except httpx.HTTPError:
            cpu_label.update("CPU  [red]unreachable[/red]")
            ram_label.update("RAM")
            net_panel.update("—")
            return

        cpu = data.get("cpu") or {}
        mem = data.get("memory") or {}
        net = data.get("network") or {}

        cpu_percent = min(100.0, max(0.0, float(cpu.get("percent", 0))))
        cpu_bar.update(progress=cpu_percent)
        cpu_label.update(f"CPU  {cpu_percent:.1f}%  ({cpu.get('cores', '?')} cores)")

        rss = mem.get("rssBytes", 0)
        sys_total = mem.get("systemTotalBytes", 0) or 1
        ram_percent = min(100.0, (rss / sys_total) * 100)
        ram_bar.update(progress=ram_percent)
        ram_label.update(f"RAM  {_fmt_bytes(rss)} / {_fmt_bytes(sys_total)}  ({ram_percent:.1f}%)")

        # heapUsed/heapTotal are V8's own JS heap, a subset of RSS — RSS can
        # look fine while the JS heap alone climbs steadily across hours of
        # uptime, the classic signature of a leaked reference (an
        # ever-growing Map/array never cleared) rather than just normal
        # native-buffer memory (image bytes in flight, etc.). Watching this
        # trend across restarts is the earliest signal of that kind of leak,
        # well before RSS itself becomes a problem.
        heap_used = mem.get("heapUsedBytes", 0)
        heap_total = mem.get("heapTotalBytes", 0)
        sys_free = mem.get("systemFreeBytes", 0)

        if heap_used and (self._heap_used_peak is None or heap_used > self._heap_used_peak):
            self._heap_used_peak = heap_used
        peak_suffix = f"  (peak: {_fmt_bytes(self._heap_used_peak)})" if self._heap_used_peak else ""

        net_panel.update(
            f"Net In:   {_fmt_bytes_per_sec(net.get('bytesInPerSec', 0))}\n"
            f"Net Out:  {_fmt_bytes_per_sec(net.get('bytesOutPerSec', 0))}\n"
            f"Requests: {net.get('requestsPerSec', 0)}/s\n"
            f"Uptime:   {data.get('uptimeSec', 0) // 60}m\n"
            f"JS Heap:  {_fmt_bytes(heap_used)} / {_fmt_bytes(heap_total)}{peak_suffix}\n"
            f"Host free RAM: {_fmt_bytes(sys_free)}"
        )

    def _render_error_catalog(self, catalog: list, heading: str) -> list[str]:
        """Shared by both the manga and anime sections — anime's own catalog
        (service.js's animeErrorCatalog) is built only from live probe
        results, not error-log history like manga's is (no anime provider
        currently logs there), but the rendering is identical either way.
        """
        catalog = (catalog or [])[:3]
        if not catalog:
            return []
        lines = ["", f"[yellow]{heading}:[/yellow]"]
        for c in catalog:
            lines.append(
                f"  - {c.get('label', c.get('code', '?'))} ×{c.get('count', 0)}: {c.get('suggestedAction', '')}"
            )
        return lines

    def _summary_text(self, summary: dict) -> str:
        text = f"{summary.get('passing', 0)}/{summary.get('total', 0)} passing"
        if summary.get("degraded"):
            text += f", {summary['degraded']} degraded"
        if summary.get("failing"):
            text += f", {summary['failing']} failing"
        return text

    async def _refresh_health(self) -> None:
        panel = self.query_one("#health-panel", Static)
        try:
            data = (await self.client.get("/api/system/health", timeout=HEALTH_TIMEOUT)).json()
        except httpx.HTTPError as e:
            self._show_connection_error(e)
            return

        overall = data.get("overallStatus", "?")
        sources = data.get("sources", {})
        anime = data.get("anime", {})
        services = data.get("services", {})
        db = data.get("database", {})

        summary = sources.get("summary") or {}
        summary_text = (
            self._summary_text(summary) if isinstance(summary, dict) else str(summary)
        )

        lines = [
            f"App:      [{_color(overall)}]{overall.upper()}[/]",
            f"Store:    [{_color(db.get('status', ''))}]{db.get('status', '?')}[/]  ({db.get('engine', '')})",
            f"Sources:  [{_color(sources.get('status', ''))}]{sources.get('status', '?')}[/]  {summary_text}",
        ]
        source_names = _degraded_names(sources.get("results"))
        if source_names:
            lines.append(f"            {source_names}")

        anime_summary = anime.get("summary") if isinstance(anime, dict) else None
        if anime_summary:
            lines.append(
                f"Anime:    [{_color(anime.get('status', ''))}]{anime.get('status', '?')}[/]  {self._summary_text(anime_summary)}"
            )
            anime_names = _degraded_names(anime.get("results"))
            if anime_names:
                lines.append(f"            {anime_names}")

        # FlareSolverr and the AniList API specifically — both are recurring,
        # documented sources of otherwise-confusing failures elsewhere in the
        # app (a source hanging because FlareSolverr is stuck; AniList calls
        # 429ing because its shared rate-limit budget got exhausted — see
        # manual-tecnico/16-updates-seasons-rate-limiting.md) — surfacing
        # them directly here means "is it them or is it my code" is a
        # glance at the dashboard, not a fresh investigation each time.
        for svc in (services.get("results") or []):
            label = svc.get("name") or svc.get("id") or "?"
            detail = f"  {svc['details']}" if svc.get("details") else ""
            err = f"  [red]{svc['error']}[/red]" if svc.get("error") else ""
            lines.append(f"  {label}: [{_color(svc.get('status', ''))}]{svc.get('status', '?')}[/]{detail}{err}")

        # errorCatalog groups the same recentErrors by error CODE with a
        # count and a suggested action — recentErrors below is "what just
        # happened", this is "what kind of problem, how often" at a glance,
        # without having to count duplicate messages by eye.
        lines.extend(self._render_error_catalog(sources.get("errorCatalog"), "Error patterns"))
        lines.extend(self._render_error_catalog(anime.get("errorCatalog"), "Anime error patterns"))

        errors = (sources.get("recentErrors") or [])[:5]
        if errors:
            lines.append("")
            lines.append("[red]Recent source errors:[/red]")
            for err in errors:
                if isinstance(err, str):
                    lines.append(f"  - {err}")
                else:
                    area = err.get("area", "")
                    count = err.get("count")
                    suffix = f" (×{count})" if count and count > 1 else ""
                    lines.append(f"  - {area}: {err.get('message', str(err))}{suffix}")

        warnings = data.get("warnings") or []
        if warnings:
            lines.append("")
            lines.append("[yellow]Warnings:[/yellow]")
            for w in warnings[:5]:
                lines.append(f"  - {w}")

        panel.update("\n".join(lines))

    async def _refresh_library(self) -> None:
        panel = self.query_one("#library-panel", Static)
        try:
            lib = (await self.client.get("/api/library")).json()
            user_status = (await self.client.get("/api/user/status")).json()
        except httpx.HTTPError as e:
            self._show_connection_error(e)
            return

        favorites = lib.get("favorites", [])
        reading_status = user_status.get("readingStatus", {})
        counts: dict[str, int] = {}
        for entry in reading_status.values():
            st = entry.get("status", "unknown")
            counts[st] = counts.get(st, 0) + 1

        lines = [f"Favorites: {len(favorites)}"]
        for st in ("reading", "completed", "on_hold", "dropped", "plan_to_read"):
            if counts.get(st):
                lines.append(f"  {st}: {counts[st]}")

        # AniList entries that were imported but never got linked to a real,
        # readable source — see docs/manual/06-integracao-anilist.md for why
        # this can legitimately stay above 0 (some titles just aren't in any
        # installed source) vs. when it's worth re-running the AniList import.
        unresolved = sum(1 for m in favorites if m.get("sourceId") == "anilist")
        if unresolved:
            lines.append(f"[yellow]AniList placeholders unresolved: {unresolved}[/yellow]")

        try:
            sync = (await self.client.get("/api/anilist/sync-meta")).json()
        except httpx.HTTPError:
            sync = None

        if sync and sync.get("lastImportAt"):
            lines.append("")
            lines.append(f"Last AniList sync: {sync['lastImportAt']}")
            lines.append(
                f"  +{sync.get('importedCount', 0)} new, "
                f"{sync.get('overwriteCount', 0)} updated, "
                f"{sync.get('failedCount', 0)} failed"
            )

        panel.update("\n".join(lines))

    async def _refresh_anime_library(self) -> None:
        panel = self.query_one("#anime-library-panel", Static)
        try:
            anime = (await self.client.get("/api/anime/favorites")).json()
        except httpx.HTTPError as e:
            self._show_connection_error(e)
            return

        favorites = anime.get("favorites", [])
        # watchStatus is a pure user-set sidecar (server/routes/anime.js's
        # POST /api/anime/status), same explicit-only semantics as manga's
        # readingStatus above — a favorite with no status set yet just isn't
        # counted in any bucket below, matching how the manga panel doesn't
        # count untracked manga either.
        counts: dict[str, int] = {}
        for entry in favorites:
            st = entry.get("watchStatus")
            if st:
                counts[st] = counts.get(st, 0) + 1

        lines = [f"Favorites: {len(favorites)}"]
        for st in ("watching", "completed", "on_hold", "dropped", "plan_to_watch"):
            if counts.get(st):
                lines.append(f"  {st}: {counts[st]}")

        panel.update("\n".join(lines))

    async def _refresh_jobs(self) -> None:
        table = self.query_one("#jobs-table", DataTable)
        table.clear()
        try:
            jobs = (await self.client.get("/api/download/bulk/jobs")).json().get("jobs", [])
        except httpx.HTTPError:
            table.add_row("-", "-", "[red]unreachable[/red]")
            return

        active = [j for j in jobs if j.get("status") in ("pending", "running")]
        if not active:
            table.add_row("-", "-", "no active downloads")
        for job in active:
            title = job.get("mangaTitle") or job["jobId"][:8]
            progress = f"{job.get('done', 0)}/{job.get('total', 0)}"
            status = job.get("status", "")
            style = {"running": "yellow", "pending": "white"}.get(status, "white")
            table.add_row(title, progress, f"[{style}]{status}[/]")

        await self._refresh_download_history()

    async def _refresh_download_history(self) -> None:
        completed_table = self.query_one("#completed-jobs-table", DataTable)
        completed_table.clear()
        try:
            history = (await self.client.get("/api/download/history")).json().get("history", [])
        except httpx.HTTPError:
            completed_table.add_row("-", "-", "[red]unreachable[/red]", "-")
            return

        # Persisted log (server/modules/downloads/service.js's
        # recordDownloadHistory), newest first, capped at 200 entries — this
        # is the real "downloads made" record, unlike /api/download/bulk/jobs
        # above which only keeps a finished job for 15 minutes and resets on
        # restart. Show the most recent 20 here so the panel stays a glance,
        # not a scroll.
        if not history:
            completed_table.add_row("-", "-", "no completed downloads yet", "-")
        for entry in history[:20]:
            title = entry.get("mangaTitle") or "?"
            chapters = str(entry.get("total", 0))
            status = entry.get("status", "")
            style = {"done": "green", "error": "red"}.get(status, "white")
            result = f"[{style}]{status}[/]" if status == "done" else f"[{style}]{status}: {entry.get('error') or '?'}[/]"
            finished = entry.get("finishedAt") or "-"
            completed_table.add_row(title, chapters, result, finished)

    async def on_unmount(self) -> None:
        await self.client.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description="ScrollScape terminal monitoring dashboard")
    parser.add_argument("--url", default=os.environ.get("SCROLLSCAPE_URL", "http://localhost:4000"))
    parser.add_argument("--password", default=os.environ.get("SCROLLSCAPE_PASSWORD"))
    parser.add_argument("--interval", type=float, default=8.0, help="Refresh interval in seconds")
    args = parser.parse_args()

    app = ScrollScapeDashboard(base_url=args.url, password=args.password, interval=args.interval)
    app.run()
    sys.exit(app.return_code or 0)


if __name__ == "__main__":
    main()
