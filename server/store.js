/**
 * store.js — In-memory store cache backed by disk persistence
 *
 * Refactored for:
 *  • Atomic writes: using a .tmp file and fs.rename/renameSync to prevent corruption on power loss.
 *  • Maintainability: cleaner event hooks and bounded flush logic.
 *  • Security: strict path configurations, safer parsing, and default state generation.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const { createStorePersistence } = require('./modules/store/persistence');
const { createStoreLoader } = require('./modules/store/loader');
const { normaliseStore } = require('./modules/store/schema');

class StorageService {
  // The options let a test inject a fake fs (e.g. an EBUSY on the start-up
  // read) and shorten the debounce; production uses the defaults.
  constructor({ fs: fsImpl = fs, fsp: fspImpl = fsp, logger = console, delayMs } = {}) {
    this.storePath = null;
    this.store = null;
    this.isShuttingDown = false;
    this.writeListeners = [];
    // Set when store.json exists but could not be loaded. From then on nothing
    // may be written: this.store is null (or stale), and flushing it would
    // replace the real library with a blank one. Sticky for the process life.
    this.loadError = null;
    this.logger = logger;
    this.persistence = createStorePersistence({ fs: fsImpl, fsp: fspImpl, logger, delayMs });
    this.loader = createStoreLoader({ fs: fsImpl, fsp: fspImpl, normalise: normaliseStore });

    this.handleTermination = this.handleTermination.bind(this);
  }

  configure(storePath) {
    if (!storePath || typeof storePath !== 'string') {
      throw new Error('Invalid storePath provided to store.configure()');
    }
    this.storePath = storePath;
  }

  // Loads store.json through the loader (ENOENT -> null). Any failure is
  // remembered so no later write, debounced or on shutdown, can replace the
  // library that could not be read.
  async loadFromDisk() {
    if (this.loadError) throw this.loadError;
    try {
      return await this.loader.loadStoreFile(this.storePath);
    } catch (e) {
      this.loadError = e;
      throw e;
    }
  }

  async readStore() {
    if (!this.store) {
      if (!this.storePath) throw new Error('Store accessed before configure() was called.');
      const loaded = await this.loadFromDisk();
      if (!loaded) {
        const err = new Error(`Library file not found: ${this.storePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      this.store = loaded;
    }
    return this.store;
  }

  async writeStore(store) {
    if (this.loadError) {
      this.logger.error('[Store] Ignoring a write: the library file could not be loaded at start-up and is being left untouched.');
      return;
    }
    this.store = store;
    for (const listener of this.writeListeners) {
      try { listener(); } catch (e) { this.logger.error('[Store] A write listener failed:', e && e.message); }
    }
    this.persistence.queueDebouncedFlush({
      getStore: () => this.store,
      getStorePath: () => this.storePath,
      isShuttingDown: () => this.isShuttingDown,
    });
  }

  // ENOENT is a first run: resolves with the store left unset, as before.
  // Any other failure (unreadable, truncated, not JSON) REJECTS instead of
  // starting empty; server.js reports it and exits, and nothing is written.
  async initStore() {
    if (!this.storePath) throw new Error('Store initialized before configure() was called.');
    const loaded = await this.loadFromDisk();
    if (loaded) this.store = loaded;
  }

  flushStoreSync() {
    if (this.loadError) return;
    this.isShuttingDown = this.persistence.flushStoreSync({
      store: this.store,
      storePath: this.storePath,
      isShuttingDown: this.isShuttingDown,
    });
  }

  // Forces an immediate write during normal operation (e.g. right after a
  // deliberate settings change), without marking the store as shutting
  // down — unlike flushStoreSync(), which is only for the process-exit path
  // and disables all future writes once called.
  flushNow() {
    if (this.loadError) return;
    this.persistence.flushNow({
      getStore: () => this.store,
      getStorePath: () => this.storePath,
      isShuttingDown: () => false,
    });
  }

  // `fn()` is called (and must be cheap) after every write; the local covers use it to look at the library a few seconds later.
  onWrite(fn) {
    if (typeof fn === 'function') this.writeListeners.push(fn);
  }

  normaliseStore(s) {
    return normaliseStore(s);
  }
  handleTermination() {
    this.flushStoreSync();
    process.exit(0);
  }
}

const storageService = new StorageService();
process.on('SIGINT', storageService.handleTermination);
process.on('SIGTERM', storageService.handleTermination);

module.exports = {
  StorageService,
  configure: storageService.configure.bind(storageService),
  readStore: storageService.readStore.bind(storageService),
  writeStore: storageService.writeStore.bind(storageService),
  initStore: storageService.initStore.bind(storageService),
  flushStoreSync: storageService.flushStoreSync.bind(storageService),
  flushNow: storageService.flushNow.bind(storageService),
  onWrite: storageService.onWrite.bind(storageService),
  normaliseStore: storageService.normaliseStore.bind(storageService),
};
