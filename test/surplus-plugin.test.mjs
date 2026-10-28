import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, VIDEO_DOWNLOAD_MAX_BYTES, VIDEO_DOWNLOAD_CHUNK_BYTES } from '@antseed/node';
import { createStreamingResponseHash } from '@antseed/buyer-core/response-auth';

const pluginUrl = new URL('../plugins/surplus/index.mjs', import.meta.url);
const protocols = {
  'gpt-image-chat': ['openai-chat-completions', 'openai-responses', 'anthropic-messages'],
  'arbitrary-art': ['openai-images'],
  'system-one': ['typesafe-systemone'],
  'video-model': ['venice-video'],
};
function config(overrides = {}) {
  return {
    OPENAI_BASE_URL: 'http://127.0.0.1:9876',
    OPENAI_API_KEY: 'local-test-token',
    ANTSEED_ALLOWED_SERVICES: Object.keys(protocols).join(','),
    SURPLUS_PROTOCOLS_JSON: JSON.stringify(protocols),
    ...overrides,
  };
}
async function loadPlugin() {
  try { return (await import(pluginUrl)).default; }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === pluginUrl.href) return undefined;
    throw error;
  }
}

test('local package exports a provider plugin with CLI-compatible config fields', async () => {
  const plugin = await loadPlugin();
  assert.ok(plugin, 'Surplus provider plugin exists');
  assert.equal(plugin.name, 'surplus');
  assert.equal(plugin.type, 'provider');
  const fields = new Map(plugin.configSchema.map(field => [field.key, field]));
  assert.equal(fields.get('OPENAI_API_KEY').type, 'secret');
  for (const key of Object.keys(config())) assert.ok(fields.has(key), `${key} declared`);
  const pkg = JSON.parse(await readFile(new URL('../plugins/surplus/package.json', import.meta.url)));
  assert.equal(pkg.name, '@local/antseed-provider-surplus');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports, './index.mjs');
  for (const dependency of ['@antseed/provider-core', '@antseed/node', '@antseed/api-adapter', '@antseed/buyer-core']) {
    assert.ok(pkg.peerDependencies?.[dependency] || pkg.dependencies?.[dependency], `${dependency} declared`);
  }
});

test('official CLI maps custom package baseUrl and apiKeyEnv to OPENAI config keys', async () => {
  const { buildSellerPluginRuntimeEnv } = await import('../node_modules/@antseed/cli/dist/cli/commands/seller/start.js');
  const key = 'SURPLUS_PLUGIN_TEST_GATEWAY_TOKEN';
  const previous = process.env[key];
  process.env[key] = 'local-test-token';
  try {
    const env = buildSellerPluginRuntimeEnv({ maxConcurrentBuyers: 2, providers: { surplus: {
      plugin: '@local/antseed-provider-surplus', baseUrl: 'http://127.0.0.1:9876', apiKeyEnv: key,
      services: { 'gpt-image-chat': {} },
    } } }, 'surplus');
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:9876');
    assert.equal(env.OPENAI_API_KEY, 'local-test-token');
    assert.equal(env.ANTSEED_ALLOWED_SERVICES, 'gpt-image-chat');
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('advertises only explicit protocols without guessing from service names', async () => {
  const plugin = await loadPlugin();
  assert.ok(plugin, 'Surplus provider plugin exists');
  const pricing = { 'arbitrary-art': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
  const billing = { 'arbitrary-art': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } } };
  const capabilities = { 'arbitrary-art': { inputs: ['text', 'image'], outputs: ['image'] } };
  const provider = plugin.createProvider(config({
    ANTSEED_INPUT_USD_PER_MILLION: '1.2', ANTSEED_OUTPUT_USD_PER_MILLION: '2.3',
    ANTSEED_CACHED_INPUT_USD_PER_MILLION: '0.4', ANTSEED_MAX_CONCURRENCY: '3',
    ANTSEED_SERVICE_PRICING_JSON: JSON.stringify(pricing),
    ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify(billing),
    ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify(capabilities),
  }));
  assert.equal(provider.name, 'surplus');
  assert.deepEqual(provider.services, Object.keys(protocols));
  assert.deepEqual(provider.serviceApiProtocols, protocols);
  assert.deepEqual(provider.serviceUnitBillingModels, billing);
  assert.deepEqual(provider.serviceCapabilities, capabilities);
  assert.deepEqual(provider.pricing, { defaults: { inputUsdPerMillion: 1.2, outputUsdPerMillion: 2.3, cachedInputUsdPerMillion: 0.4 }, services: pricing });
  assert.deepEqual(provider.getCapacity(), { current: 0, max: 3 });
});

test('rejects non-loopback URLs, URL credentials, missing local token and invalid concurrency', async () => {
  const plugin = await loadPlugin();
  for (const baseUrl of ['https://api.surplusintelligence.ai', 'http://localhost:80', 'file:///etc/passwd', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/#fragment', 'http://127.0.0.1/?query']) {
    assert.throws(() => plugin.createProvider(config({ OPENAI_BASE_URL: baseUrl })), /loopback|gateway/i, baseUrl);
  }
  assert.throws(() => plugin.createProvider(config({ OPENAI_API_KEY: '' })), /token|API_KEY/i);
  for (const max of ['0', '-1', '1.5', 'NaN', '3x']) {
    assert.throws(() => plugin.createProvider(config({ ANTSEED_MAX_CONCURRENCY: max })), /concurrency/i);
  }
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined, SURPLUS_GATEWAY_URL: 'http://[::1]:9876', SURPLUS_GATEWAY_TOKEN: 'local-test-token' }));
  assert.equal(provider.name, 'surplus');
});

test('requires exact complete explicit protocol map and nonempty service allow-list', async () => {
  const plugin = await loadPlugin();
  for (const value of [undefined, '{}', '[]', '{', JSON.stringify({ ...protocols, extra: ['openai-images'] }), JSON.stringify({ ...protocols, 'arbitrary-art': [] }), JSON.stringify({ ...protocols, 'arbitrary-art': ['made-up'] }), JSON.stringify({ ...protocols, 'arbitrary-art': 'openai-images' })]) {
    assert.throws(() => plugin.createProvider(config({ SURPLUS_PROTOCOLS_JSON: value })), /SURPLUS_PROTOCOLS_JSON/);
  }
  assert.throws(() => plugin.createProvider(config({ ANTSEED_ALLOWED_SERVICES: '' })), /ALLOWED_SERVICES/);
});

async function gateway(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(request);
    if (handler) return handler(request, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
function request(path, model = 'gpt-image-chat', fields = {}) {
  return { requestId: `test-${path}`, method: 'POST', path,
    headers: { 'content-type': 'application/json', authorization: 'buyer-secret', 'x-api-key': 'buyer-key', 'x-private': 'not-allowed', 'x-antseed-spending-auth': 'private-spending-auth' },
    body: Buffer.from(JSON.stringify({ model, prompt: 'test', ...fields })),
  };
}

test('relays every configured protocol to loopback with only local auth and allowed headers', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  await provider.init();
  assert.equal(upstream.requests.length, 0, 'startup never probes');
  const cases = [
    ['/v1/chat/completions', 'gpt-image-chat'], ['/v1/responses', 'gpt-image-chat'], ['/v1/messages', 'gpt-image-chat'],
    ['/v1/images/generations', 'arbitrary-art'], ['/v1/systemone', 'system-one'], ['/api/v1/video/queue', 'video-model'],
  ];
  for (const [path, model] of cases) {
    const req = request(path, model);
    req.headers['anthropic-version'] = '2023-06-01';
    const response = await provider.handleRequest(req);
    assert.equal(response.statusCode, 200);
    const sent = upstream.requests.at(-1);
    assert.equal(sent.path, path);
    assert.equal(sent.headers.authorization, 'Bearer local-test-token');
    assert.equal(sent.headers['x-api-key'], undefined);
    assert.equal(sent.headers['x-private'], undefined);
    assert.equal(sent.headers['x-antseed-spending-auth'], undefined);
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(JSON.parse(sent.body).model, model);
    assert.equal(req.headers.authorization, 'buyer-secret', 'does not mutate input');
  }
});

test('rejects unsupported service/protocol pairs and path escape without network calls', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  for (const req of [request('/v1/chat/completions', 'not-configured'), request('/v1/chat/completions', 'arbitrary-art'), request('/v1/images/generations', 'gpt-image-chat'), request('/v1/models'), request('/v1/../secret'), request('http://elsewhere.test/v1/chat/completions')]) {
    const response = await provider.handleRequest(req);
    assert.ok([400, 403, 404].includes(response.statusCode), `${req.path} rejected`);
  }
  assert.equal(upstream.requests.length, 0);
});

test('preserves binary multipart image edits and model routing', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const binary = Buffer.from([0, 128, 255, 13, 10, 99]);
  const body = Buffer.concat([Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\narbitrary-art\r\n--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'), binary, Buffer.from('\r\n--test-boundary--\r\n')]);
  const response = await provider.handleRequest({ requestId: 'edit', method: 'POST', path: '/v1/images/edits', headers: { 'content-type': 'multipart/form-data; boundary=test-boundary', 'x-antseed-service': 'arbitrary-art' }, body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(upstream.requests[0].body, body);
});

function retrieve(overrides = {}) {
  const req = request('/api/v1/video/retrieve', undefined, { queue_id: 'job-1' });
  req.body = Buffer.from(JSON.stringify({ queue_id: 'job-1' }));
  req.headers['x-antseed-service'] = 'video-model';
  req.headers['x-antseed-buyer-peer-id'] = 'authenticated-buyer';
  req.headers[VIDEO_DOWNLOAD_STREAM_HEADER] = VIDEO_DOWNLOAD_STREAM_VERSION;
  return { ...req, ...overrides };
}

test('native video retrieval preserves trusted routing and streams bounded chunks without buffering', async t => {
  const plugin = await loadPlugin();
  const bytes = Buffer.alloc(VIDEO_DOWNLOAD_CHUNK_BYTES * 3 + 17, 7);
  const upstream = await gateway(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const starts = [], chunks = [];
  let hash;
  const response = await provider.handleRequestStream(retrieve(), {
    onResponseStart(start) { starts.push(start); hash = createStreamingResponseHash(start); },
    async onResponseChunk(chunk) { chunks.push(chunk); hash.update(chunk.data); },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(starts.length, 1);
  assert.equal(response.body.length, 0, 'video is not reassembled in memory');
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data))), bytes);
  assert.ok(chunks.every(chunk => chunk.data.length <= VIDEO_DOWNLOAD_CHUNK_BYTES));
  assert.equal(chunks.at(-1).done, true);
  assert.equal(chunks.filter(chunk => chunk.done).length, 1);
  assert.deepEqual(response.streamedBody, hash.finish());
  assert.equal(response.streamedBody.byteLength, bytes.length);
  const sent = upstream.requests[0];
  assert.equal(sent.headers['x-antseed-service'], 'video-model');
  assert.equal(sent.headers['x-antseed-buyer-peer-id'], 'authenticated-buyer');
  assert.equal(sent.headers.authorization, 'Bearer local-test-token');
  assert.equal(sent.headers['x-private'], undefined);
  assert.equal(sent.headers[VIDEO_DOWNLOAD_STREAM_HEADER], VIDEO_DOWNLOAD_STREAM_VERSION);
  assert.deepEqual(JSON.parse(sent.body), { queue_id: 'job-1' });
  assert.deepEqual(provider.getCapacity(), { current: 0, max: 10 });
});

test('native video pending JSON polls return unchanged without follow-up fetches', async t => {
  const plugin = await loadPlugin();
  const pending = JSON.stringify({ status: 'PROCESSING', download_url: 'https://must-not-fetch.invalid/video.mp4' });
  const upstream = await gateway(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(pending); });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  let started = false;
  const result = await provider.handleRequestStream(retrieve(), { onResponseStart() { started = true; }, onResponseChunk() {} });
  assert.equal(result.statusCode, 200);
  assert.equal(Buffer.from(result.body).toString(), pending);
  assert.equal(started, false);
  assert.equal(upstream.requests[0].headers['x-antseed-service'], 'video-model');
  assert.equal(upstream.requests.length, 1);
});

test('native video enforces negotiation, MP4 limits, redirect refusal and queue-id validation', async t => {
  const plugin = await loadPlugin();
  let mode = 'mp4';
  const upstream = await gateway(t, (_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { location: '/leak-token' }); return res.end(); }
    res.writeHead(200, { 'content-type': mode === 'wrong-type' ? 'text/html' : 'video/mp4', 'content-length': mode === 'oversize' ? String(VIDEO_DOWNLOAD_MAX_BYTES + 1) : '4' });
    res.end('test');
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const callbacks = { onResponseStart() { assert.fail('invalid download must not start'); }, onResponseChunk() { assert.fail('invalid download must not emit'); } };
  const unnegotiated = retrieve(); delete unnegotiated.headers[VIDEO_DOWNLOAD_STREAM_HEADER];
  const response = await provider.handleRequest(unnegotiated);
  assert.equal(response.statusCode, 400);
  for (const [nextMode, status] of [['wrong-type', 502], ['oversize', 413], ['redirect', 502]]) {
    mode = nextMode;
    const result = await provider.handleRequestStream(retrieve(), callbacks);
    assert.equal(result.statusCode, status, nextMode);
  }
  const before = upstream.requests.length;
  assert.equal((await provider.handleRequestStream(retrieve({ body: Buffer.from('{"queue_id":"../escape"}') }), callbacks)).statusCode, 400);
  assert.equal(upstream.requests.length, before);
  assert.ok(upstream.requests.every(req => req.path === '/api/v1/video/retrieve'));
});

test('rejects conflicting service selectors and supplies header-only JSON model routing', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const conflicting = request('/v1/images/generations', 'gpt-image-chat');
  conflicting.headers['x-antseed-service'] = 'arbitrary-art';
  assert.equal((await provider.handleRequest(conflicting)).statusCode, 403);
  const conflictingBody = request('/v1/images/generations', 'gpt-image-chat', { service: 'arbitrary-art' });
  assert.equal((await provider.handleRequest(conflictingBody)).statusCode, 403);
  assert.equal(upstream.requests.length, 0);
  const req = request('/v1/images/generations');
  req.body = Buffer.from('{"prompt":"test"}');
  req.headers['x-antseed-service'] = 'arbitrary-art';
  assert.equal((await provider.handleRequest(req)).statusCode, 200);
  assert.equal(JSON.parse(upstream.requests[0].body).model, 'arbitrary-art');
});

test('streams ordinary SSE through BaseProvider and preserves error responses', async t => {
  const plugin = await loadPlugin();
  let fail = false;
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello'.repeat(80) } }] })}\n\ndata: [DONE]\n\n`;
  const upstream = await gateway(t, (_req, res) => {
    res.writeHead(fail ? 429 : 200, { 'content-type': fail ? 'application/json' : 'text/event-stream', ...(fail ? { 'retry-after': '5' } : {}) });
    res.end(fail ? '{"error":"quota"}' : text);
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const starts = [], chunks = [];
  const result = await provider.handleRequestStream(request('/v1/chat/completions', 'gpt-image-chat', { stream: true }), { onResponseStart(start) { starts.push(start); }, onResponseChunk(chunk) { chunks.push(chunk); } });
  assert.equal(starts.length, 1);
  assert.equal(Buffer.from(result.body).toString(), text);
  assert.equal(Buffer.concat(chunks.map(chunk => chunk.data)).toString(), text);
  assert.equal(chunks.at(-1).done, true);
  assert.equal(JSON.parse(upstream.requests[0].body).stream_options.include_usage, true);
  fail = true;
  const failure = await provider.handleRequest(request('/v1/chat/completions'));
  assert.equal(failure.statusCode, 429);
  assert.equal(failure.headers['retry-after'], '5');
  assert.equal(Buffer.from(failure.body).toString(), '{"error":"quota"}');
});

test('video cancellation aborts before completion and releases shared concurrency', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.write(Buffer.alloc(32, 7));
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl, ANTSEED_MAX_CONCURRENCY: '1' }));
  const controller = new AbortController();
  let done = false;
  let entered;
  const firstChunk = new Promise(resolve => { entered = resolve; });
  const pending = provider.handleRequestStream(retrieve(), {
    signal: controller.signal, onResponseStart() {},
    onResponseChunk(chunk) { done ||= chunk.done; entered(); },
  });
  await firstChunk;
  assert.deepEqual(provider.getCapacity(), { current: 1, max: 1 });
  assert.equal((await provider.handleRequest(request('/v1/chat/completions'))).statusCode, 429);
  controller.abort();
  await assert.rejects(pending, /interrupted/);
  assert.equal(done, false);
  assert.deepEqual(provider.getCapacity(), { current: 0, max: 1 });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, label, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

for (const streaming of [false, true]) {
  test(`concurrent duplicate request-ID rejects before ${streaming ? 'stream callbacks' : 'a second network call'} and permits reuse`, { timeout: 5000 }, async t => {
    const plugin = await loadPlugin();
    const entered = deferred();
    const held = [];
    let hold = true;
    const text = prompt => streaming ? `data: ${JSON.stringify({ choices: [{ delta: { content: prompt.repeat(80) } }] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ prompt });
    const upstream = await gateway(t, (req, res) => {
      const body = text(JSON.parse(req.body).prompt);
      res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
      if (hold) { held.push(() => { if (!res.writableEnded) res.end(body); }); entered.resolve(); }
      else res.end(body);
    });
    const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
    const a = request('/v1/chat/completions', 'gpt-image-chat', { prompt: 'buyer-A', stream: streaming });
    const b = { ...request(a.path, 'gpt-image-chat', { prompt: 'buyer-B', stream: streaming }), requestId: a.requestId };
    const starts = [], chunks = [], duplicateEvents = [];
    const run = (req, duplicate = false) => streaming ? provider.handleRequestStream(req, {
      onResponseStart(start) { (duplicate ? duplicateEvents : starts).push(start); },
      onResponseChunk(chunk) { (duplicate ? duplicateEvents : chunks).push(chunk); },
    }) : provider.handleRequest(req);
    const first = run(a);
    try {
      await within(entered.promise, 'first loopback request');
      assert.equal(provider.getCapacity().current, 1);
      const duplicate = await within(run(b, true), 'duplicate request-ID rejection');
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.requestId, a.requestId);
      assert.match(Buffer.from(duplicate.body).toString(), /request.*(?:active|flight)/i);
      assert.equal(upstream.requests.length, 1, 'duplicate never reaches loopback');
      assert.deepEqual(duplicateEvents, [], 'duplicate never receives callbacks');
      held.forEach(finish => finish());
      const response = await within(first, 'first response');
      assert.equal(response.requestId, a.requestId);
      assert.equal(Buffer.from(response.body).toString(), text('buyer-A'));
      if (streaming) {
        assert.equal(starts.length, 1);
        assert.equal(starts[0].requestId, a.requestId);
        assert.ok(chunks.every(chunk => chunk.requestId === a.requestId));
        assert.equal(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data))).toString(), text('buyer-A'));
        assert.equal(chunks.at(-1).done, true);
      }
      assert.deepEqual(duplicateEvents, []);
      assert.equal(provider.getCapacity().current, 0);
      hold = false;
      const reused = await within(run(b), 'completed request-ID reuse');
      assert.equal(reused.statusCode, 200);
      assert.equal(reused.requestId, a.requestId);
      assert.equal(Buffer.from(reused.body).toString(), text('buyer-B'));
      assert.equal(upstream.requests.length, 2);
      assert.equal(provider.getCapacity().current, 0);
    } finally {
      held.forEach(finish => finish());
      await within(first, 'fixture cleanup', 100).catch(() => {});
    }
  });
}

for (const [firstKind, duplicateKind] of [['ordinary', 'retrieve'], ['retrieve', 'ordinary'], ['retrieve', 'retrieve'], ['queue', 'ordinary']]) {
  test(`concurrent duplicate request-ID is shared across ${firstKind}/${duplicateKind} paths`, { timeout: 5000 }, async t => {
    const plugin = await loadPlugin();
    const entered = deferred();
    const held = [];
    const upstream = await gateway(t, (_req, res) => {
      held.push(() => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"owner":"A"}'); } });
      entered.resolve();
    });
    const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
    const make = kind => ({ ...(kind === 'retrieve' ? retrieve() : kind === 'queue' ? request('/api/v1/video/queue', 'video-model') : request('/v1/chat/completions')), requestId: 'cross-kind-id' });
    const first = provider.handleRequest(make(firstKind));
    try {
      await within(entered.promise, 'first cross-kind request');
      const duplicate = await within(provider.handleRequestStream(make(duplicateKind), {
        onResponseStart() { assert.fail('duplicate must not start'); },
        onResponseChunk() { assert.fail('duplicate must not emit chunks'); },
      }), 'cross-kind duplicate rejection');
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.requestId, 'cross-kind-id');
      assert.equal(upstream.requests.length, 1);
      held.forEach(finish => finish());
      assert.equal(Buffer.from((await within(first, 'cross-kind owner response')).body).toString(), '{"owner":"A"}');
      assert.equal(provider.getCapacity().current, 0);
    } finally {
      held.forEach(finish => finish());
      await within(first, 'cross-kind fixture cleanup', 100).catch(() => {});
    }
  });
}

test('concurrent duplicate request-ID is reserved before awaited prepare and released on preparation errors', { timeout: 5000 }, async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const originalPrepare = provider.prepare.bind(provider);
  const entered = deferred(), release = deferred();
  let preparations = 0;
  provider.prepare = async req => {
    preparations++;
    entered.resolve();
    await release.promise;
    return originalPrepare(req);
  };
  const req = request('/v1/chat/completions');
  const first = provider.handleRequest(req);
  try {
    await within(entered.promise, 'preparation entered');
    const duplicate = await within(provider.handleRequest(req), 'preparation duplicate rejection');
    assert.equal(duplicate.statusCode, 409);
    assert.equal(preparations, 1, 'duplicate never enters preparation');
    assert.equal(upstream.requests.length, 0);
  } finally {
    release.resolve();
    await within(first, 'preparation fixture cleanup', 100).catch(() => {});
  }
  provider.prepare = async () => { throw new Error('prepare failed'); };
  await assert.rejects(within(provider.handleRequest(req), 'preparation error'), /prepare failed/);
  provider.prepare = originalPrepare;
  assert.equal((await within(provider.handleRequest(req), 'reuse after preparation error')).statusCode, 200);
  assert.equal(provider.getCapacity().current, 0);
});

test('request-ID reservation releases after validation, capacity refusal and upstream errors', { timeout: 5000 }, async t => {
  const plugin = await loadPlugin();
  let fail = true;
  const entered = deferred(), release = deferred();
  let hold = false;
  const upstream = await gateway(t, (_req, res) => {
    if (hold) { entered.resolve(); release.promise.then(() => res.end('{"ok":true}')); }
    else if (fail) res.destroy();
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl, ANTSEED_MAX_CONCURRENCY: '1' }));
  const req = request('/v1/chat/completions');
  assert.equal((await within(provider.handleRequest({ ...req, path: '/unsupported' }), 'invalid request')).statusCode, 404);
  assert.equal((await within(provider.handleRequest(req), 'upstream failure')).statusCode, 502);
  assert.equal(provider.getCapacity().current, 0);
  fail = false;
  assert.equal((await within(provider.handleRequest(req), 'reuse after upstream failure')).statusCode, 200);
  hold = true;
  const first = provider.handleRequest({ ...req, requestId: 'capacity-owner' });
  try {
    await within(entered.promise, 'capacity owner');
    assert.equal((await within(provider.handleRequest(req), 'capacity refusal')).statusCode, 429);
  } finally {
    release.resolve();
    await within(first, 'capacity owner cleanup');
  }
  hold = false;
  assert.equal((await within(provider.handleRequest(req), 'reuse after capacity refusal')).statusCode, 200);
  assert.equal(provider.getCapacity().current, 0);
});

test('request-ID reservation releases after video cancellation and permits reuse', { timeout: 5000 }, async t => {
  const plugin = await loadPlugin();
  let hang = true;
  const upstream = await gateway(t, (_req, res) => {
    if (hang) { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write(Buffer.alloc(32, 7)); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"PROCESSING"}'); }
  });
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const controller = new AbortController(), entered = deferred();
  const req = retrieve();
  const pending = provider.handleRequestStream(req, {
    signal: controller.signal, onResponseStart() {}, onResponseChunk() { entered.resolve(); },
  });
  const rejected = assert.rejects(within(pending, 'cancelled video'), /interrupted/);
  try { await within(entered.promise, 'video chunk'); }
  finally { controller.abort(); }
  await rejected;
  assert.equal(provider.getCapacity().current, 0);
  hang = false;
  const response = await within(provider.handleRequest(req), 'reuse after video cancellation');
  assert.equal(response.statusCode, 200);
  assert.equal(response.requestId, req.requestId);
  assert.equal(provider.getCapacity().current, 0);
});

test('video queue overwrites untrusted surplus request id with serialized requestId', async t => {
  const plugin = await loadPlugin();
  const upstream = await gateway(t);
  const provider = plugin.createProvider(config({ OPENAI_BASE_URL: upstream.baseUrl }));
  const req = request('/api/v1/video/queue', 'video-model');
  req.requestId = 'stable-local-id';
  req.headers['X-Surplus-Request-Id'] = 'forged';
  req.headers['x-surplus-request-id'] = 'also-forged';
  assert.equal((await provider.handleRequest(req)).statusCode, 200);
  assert.equal((await provider.handleRequest(req)).statusCode, 200);
  assert.deepEqual(upstream.requests.map(sent => sent.headers['x-surplus-request-id']), ['stable-local-id', 'stable-local-id']);
});
