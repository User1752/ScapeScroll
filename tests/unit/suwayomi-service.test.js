const test = require('node:test');
const assert = require('node:assert');
const { createSuwayomiService } = require('../../server/modules/suwayomi/service');

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => body,
  };
}

test('Suwayomi Service - configuration', async (t) => {
  await t.test('getConfig() returns null when suwayomiUrl is unset', async () => {
    const service = createSuwayomiService({ readStore: async () => ({ settings: {} }) });
    assert.strictEqual(await service.getConfig(), null);
  });

  await t.test('getConfig() rejects a non-http(s) URL', async () => {
    const service = createSuwayomiService({ readStore: async () => ({ settings: { suwayomiUrl: 'file:///etc/passwd' } }) });
    await assert.rejects(() => service.getConfig(), { statusCode: 400 });
  });

  await t.test('getConfig() trims trailing slashes', async () => {
    const service = createSuwayomiService({ readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567/' } }) });
    const cfg = await service.getConfig();
    assert.strictEqual(cfg.baseUrl, 'http://suwayomi:4567');
  });

  await t.test('requireConfig-gated calls fail clearly when unconfigured', async () => {
    const service = createSuwayomiService({ readStore: async () => ({ settings: {} }) });
    await assert.rejects(() => service.getThumbnail('1'), { statusCode: 400 });
    await assert.rejects(() => service.testConnection(), { statusCode: 400 });
  });
});

test('Suwayomi Service - authenticated requests', async (t) => {
  await t.test('testConnection() sends Basic Auth header when credentials are set and reports source count', async () => {
    let capturedHeaders;
    const fetchImpl = async (url, opts) => {
      capturedHeaders = opts.headers;
      assert.strictEqual(url, 'http://suwayomi:4567/api/v1/source/list');
      return jsonResponse(200, [{ id: '1' }, { id: '2' }]);
    };
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567', suwayomiUsername: 'manga', suwayomiPassword: 'hello123' } }),
      fetchImpl,
    });

    const result = await service.testConnection();
    assert.deepStrictEqual(result, { ok: true, sourceCount: 2 });
    assert.strictEqual(capturedHeaders.Authorization, `Basic ${Buffer.from('manga:hello123').toString('base64')}`);
  });

  await t.test('testConnection() omits Authorization header when no username is set', async () => {
    let capturedHeaders;
    const fetchImpl = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return jsonResponse(200, []);
    };
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567' } }),
      fetchImpl,
    });

    await service.testConnection();
    assert.strictEqual(capturedHeaders.Authorization, undefined);
  });

  await t.test('a non-OK upstream response surfaces as a clear error', async () => {
    const fetchImpl = async () => jsonResponse(401, {});
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567' } }),
      fetchImpl,
    });

    await assert.rejects(() => service.testConnection(), { statusCode: 401 });
  });
});

test('Suwayomi Service - image streaming', async (t) => {
  await t.test('getThumbnail() builds the correct path and forwards content-type', async () => {
    let requestedUrl;
    const fetchImpl = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, body: 'fake-stream' };
    };
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567' } }),
      fetchImpl,
    });

    const result = await service.getThumbnail('42');
    assert.strictEqual(requestedUrl, 'http://suwayomi:4567/api/v1/manga/42/thumbnail');
    assert.strictEqual(result.contentType, 'image/jpeg');
    assert.strictEqual(result.body, 'fake-stream');
  });

  await t.test('getPage() builds the correct path from mangaId/chapterIndex/index', async () => {
    let requestedUrl;
    const fetchImpl = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, headers: { get: () => 'image/webp' }, body: 'fake-stream' };
    };
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567' } }),
      fetchImpl,
    });

    await service.getPage('42', '3', '0');
    assert.strictEqual(requestedUrl, 'http://suwayomi:4567/api/v1/manga/42/chapter/3/page/0');
  });

  await t.test('a 404 from upstream is preserved', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => null } });
    const service = createSuwayomiService({
      readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi:4567' } }),
      fetchImpl,
    });

    await assert.rejects(() => service.getThumbnail('999'), { statusCode: 404 });
  });
});
