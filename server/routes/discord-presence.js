'use strict';

// Thin HTTP surface over server/modules/discord-rpc/service.js. Every
// handler is wrapped defensively — this feature must never turn into a
// request that hangs or 500s the app just because Discord isn't running or
// isn't configured; the service module itself already no-ops in those
// cases, but a try/catch here is cheap insurance against anything
// unexpected in that path bubbling up into the normal request/response
// flow (see the "Failure handling" requirement this feature was built
// against).
const discordRpc = require('../modules/discord-rpc/service');

function registerDiscordPresenceRoutes(app) {
  app.get('/api/discord-presence/status', (_req, res) => {
    try {
      res.json(discordRpc.getStatus());
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  // Body: { details, subtitle?, cover?, iconKind?, largeText? }
  // Fired on every navigation event, not just reading/watching — see
  // ui-discord-presence.js's DISCORD_VIEW_LABELS and its call sites (reader
  // open, EPUB open, anime episode start, setView()) for where `details`
  // comes from in each case.
  app.post('/api/discord-presence/update', (req, res) => {
    try {
      const { details, subtitle, cover, iconKind, largeText } = req.body || {};
      if (typeof details === 'string' && details) {
        discordRpc.setPresence({
          details: details.slice(0, 256),
          subtitle: typeof subtitle === 'string' ? subtitle.slice(0, 256) : '',
          cover: typeof cover === 'string' ? cover.slice(0, 1024) : '',
          iconKind: (iconKind === 'manga' || iconKind === 'anime') ? iconKind : null,
          largeText: typeof largeText === 'string' ? largeText.slice(0, 256) : '',
        });
      }
      res.json({ ok: true });
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  // "Still here" ping — sent every ~30s while a reader/player page is open.
  // See service.js's heartbeat()/idle-watchdog for why this exists: there's
  // no reliable server-side "the tab closed" signal, so presence is cleared
  // if this stops arriving instead of being trusted to persist forever.
  app.post('/api/discord-presence/heartbeat', (_req, res) => {
    try {
      discordRpc.heartbeat();
      res.json({ ok: true });
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  app.post('/api/discord-presence/clear', async (_req, res) => {
    try {
      await discordRpc.clearPresence();
      res.json({ ok: true });
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerDiscordPresenceRoutes };
