'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { CALLER_PATIENCE } = require('../../config/solver');

// How patient the caller of a FlareSolverr request is, carried beside the call
// instead of through it. Source probes, cover search, the comic lookup and the
// image proxy all reach the solver through code whose signatures they do not own
// (fetchText -> resolveViaSolver -> executeFlareSolverr), so they declare their
// patience around the call and the pool reads it back when the job is queued:
//
//   priority   'interactive' (default for an undeclared call) goes before 'background'
//   deadlineAt epoch ms after which a job still WAITING in the queue is dropped.
//              It never shortens a navigation that has already started, unless
//              boundSolve is also set (see below).
//   boundSolve true lets the pool derive the navigation timeout from deadlineAt;
//              only for callers whose page is never a Cloudflare challenge, since
//              cutting a cold challenge short means its cookie is never warmed.
//   label      for logs only.
//   oneOff     true: this call gets a browser of its own (a one-off request, never a shared session) and
//              leaves nothing behind in one. For a caller whose page depends on cookies the site sets from
//              what was asked before: the image engines keep SafeSearch in cookies, so a persistent session
//              could serve unfiltered results to a later search that asked for the filter. Saying it is all
//              there is to it (false is the same as not saying it), and nothing the caller calls can take
//              it back. Cover search is the one user.
//
// How long one navigation may take is not declared here: the pool reads it from
// the request itself (request.maxTimeoutMs) or, with boundSolve, from deadlineAt.
//
// Nothing here starts a timer or touches a file: it is a wrapper around
// AsyncLocalStorage, so it is safe to require from anywhere.

// Strongest first. A call that declared nothing is the first: the default of the pool and of single-flight.
const PRIORITIES = Object.freeze(['interactive', 'background']);
const DEFAULT_PRIORITY = PRIORITIES[0];

const storage = new AsyncLocalStorage();

// Only well-formed fields survive, so a bad value can neither reach the pool nor
// hide the value an outer context declared.
function cleanContext(ctx) {
  const clean = {};
  if (!ctx || typeof ctx !== 'object') return clean;
  if (PRIORITIES.includes(ctx.priority)) clean.priority = ctx.priority;
  if (Number.isFinite(ctx.deadlineAt)) clean.deadlineAt = ctx.deadlineAt;
  if (typeof ctx.label === 'string' && ctx.label) clean.label = ctx.label;
  if (typeof ctx.boundSolve === 'boolean') clean.boundSolve = ctx.boundSolve;
  if (ctx.oneOff === true) clean.oneOff = true;
  return clean;
}

/**
 * `inner` declared inside `outer`. The inner priority, label and boundSolve win;
 * the deadline is the EARLIER of the two, because an outer caller that gives up
 * at a given moment cannot be made to wait longer by what it calls. oneOff, which only
 * ever survives as true, stays once an outer caller said it. Used by
 * runWithSolverContext and by the pool to lay a per-call context over the
 * ambient one, so there is one nesting rule.
 */
function mergeSolverContext(outer, inner) {
  const base = cleanContext(outer);
  const over = cleanContext(inner);
  const merged = { ...base, ...over };
  if (base.deadlineAt !== undefined && over.deadlineAt !== undefined) {
    merged.deadlineAt = Math.min(base.deadlineAt, over.deadlineAt);
  }
  return merged;
}

/**
 * Runs `fn` with `ctx` declared for every solver request it starts, however deep
 * and across awaits. Always returns a promise: a function that throws before its
 * first await rejects instead of throwing out of the caller's synchronous code.
 */
function runWithSolverContext(ctx, fn) {
  return storage.run(mergeSolverContext(storage.getStore(), ctx), async () => fn());
}

/**
 * The patience of a probe that runs in the background (System Health, the startup checks): it waits
 * behind what a person is doing for the browser, and is dropped from the queue (never from a browser
 * that already started on it) a moment before its own timeout gives up on it anyway.
 */
function backgroundProbeContext(timeoutMs) {
  return { priority: 'background', deadlineAt: Date.now() + timeoutMs - CALLER_PATIENCE.probeGiveUpMarginMs, label: 'health' };
}

/** What the surrounding code declared; {} outside any context. A copy, never the shared object. */
function getSolverContext() {
  return { ...(storage.getStore() || {}) };
}

module.exports = {
  PRIORITIES,
  DEFAULT_PRIORITY,
  cleanContext,
  runWithSolverContext,
  getSolverContext,
  mergeSolverContext,
  backgroundProbeContext,
};
