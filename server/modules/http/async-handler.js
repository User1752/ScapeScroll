'use strict';

const { recordError } = require('../error-logger');

// Every route's failed-request body gets logged for debugging (below) — this
// masks anything credential-shaped first, so a login or a settings save
// (passwords, tokens, API keys in the body) never writes a plaintext secret
// to the console just because the request itself failed.
const SENSITIVE_BODY_KEY_PATTERN = /password|token|secret|cookie|api.?key|authorization/i;
function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const redacted = {};
  for (const [key, value] of Object.entries(body)) {
    redacted[key] = SENSITIVE_BODY_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return redacted;
}

/**
 * Creates an async route wrapper with consistent error logging/response.
 */
function createAsyncHandler(tag = 'API', defaultStatus = 500, defaultMessage = 'Internal Server Error') {
  return (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const status = Number(err?.statusCode) || defaultStatus;
      const isExpected = !!err?.expected || (status >= 400 && status < 500);
      const logMethod = isExpected ? 'warn' : 'error';

      console[logMethod](`[${tag}][${isExpected ? 'WARN' : 'ERROR'}]`, {
        method: req?.method,
        path: req?.originalUrl,
        params: req?.params,
        body: redactBody(req?.body),
        error: err?.message,
        ...(isExpected ? {} : { stack: err?.stack }),
      });

      if (!isExpected) {
        let area = tag.toLowerCase();
        if (req?.params?.id) area = req.params.id;
        else if (req?.originalUrl?.includes('/api/proxy-image')) area = 'proxy-image';

        recordError({
          code: `HTTP-${status}`,
          area,
          message: err?.message || defaultMessage,
          details: { url: req?.originalUrl }
        }).catch(() => {});
      }

      if (res.headersSent) return;
      res.status(status).json({
        ok: false,
        ...(err?.code ? { code: err.code } : {}),
        error: err?.message || defaultMessage,
        ...(err?.details || {})
      });
    }
  };
}

module.exports = {
  createAsyncHandler,
};
