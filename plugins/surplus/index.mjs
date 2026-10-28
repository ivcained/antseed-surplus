import {
  BaseProvider, parseCsv, parseJsonObject, parseNonNegativeNumber,
  parseServicePricingJson, parseServiceCapabilitiesJson, parseServiceUnitBillingModelsJson,
  streamVideoResponse, videoDownloadSignal, stripRelayResponseHeaders,
} from '@antseed/provider-core';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION } from '@antseed/node';
import { createStreamingResponseHash } from '@antseed/buyer-core/response-auth';
import { extractRequestBodyFields } from '@antseed/api-adapter';

const supportedProtocols = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'openai-images', 'typesafe-systemone', 'venice-video']);
const routes = new Map([
  ['/v1/chat/completions', 'openai-chat-completions'], ['/v1/responses', 'openai-responses'],
  ['/v1/messages', 'anthropic-messages'], ['/v1/images/generations', 'openai-images'],
  ['/v1/images/edits', 'openai-images'], ['/v1/systemone', 'typesafe-systemone'],
  ['/api/v1/video/queue', 'venice-video'], ['/api/v1/video/retrieve', 'venice-video'],
]);
const allowedHeaders = new Set(['content-type', 'accept', 'anthropic-version', 'anthropic-beta']);
function gatewayUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A numeric loopback gateway URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway URL must be a credential-free numeric loopback HTTP(S) URL');
  }
  return url.href.replace(/\/+$/, '');
}
function explicitProtocols(raw, services) {
  const protocols = parseJsonObject(raw, 'SURPLUS_PROTOCOLS_JSON');
  if (!protocols || Object.keys(protocols).length !== services.length
      || Object.keys(protocols).some(service => !services.includes(service))) {
    throw new Error('SURPLUS_PROTOCOLS_JSON must cover exactly the allowed services');
  }
  for (const service of services) {
    const values = protocols[service];
    if (!Array.isArray(values) || values.length === 0 || values.some(value => !supportedProtocols.has(value))) {
      throw new Error(`SURPLUS_PROTOCOLS_JSON.${service} requires a nonempty array of supported protocols`);
    }
  }
  return protocols;
}
function errorResponse(request, statusCode, message) {
  return { requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: message })) };
}
class SurplusProvider extends BaseProvider {
  #baseUrl;
  #auth;
  #videoActive = 0;
  #inFlightIds = new Set();
  constructor(config) {
    super(config);
    this.#baseUrl = config.relay.baseUrl;
    this.#auth = config.relay.authHeaderValue;
  }
  getCapacity() {
    const capacity = super.getCapacity();
    return { current: capacity.current + this.#videoActive, max: capacity.max };
  }
  async prepare(request) {
    const path = request.path?.split('?')[0];
    const protocol = routes.get(path);
    if (!protocol || request.method !== 'POST' || request.path.includes('\\')) return { error: errorResponse(request, 404, 'Unsupported gateway route') };
    const isRetrieve = path === '/api/v1/video/retrieve';
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (allowedHeaders.has(lower) || lower === 'x-antseed-service'
          || (isRetrieve && ['x-antseed-buyer-peer-id', VIDEO_DOWNLOAD_STREAM_HEADER].includes(lower))) headers[lower] = value;
    }
    const fields = extractRequestBodyFields(headers, request.body);
    const selectors = [headers['x-antseed-service']?.trim(), fields?.service, fields?.model].filter(value => value !== undefined && value !== '');
    const service = selectors[0];
    if (selectors.some(value => value !== service)) return { error: errorResponse(request, 403, 'Conflicting service selectors') };
    if (path === '/api/v1/video/queue') headers['x-surplus-request-id'] = request.requestId;
    if (typeof service !== 'string' || !Object.hasOwn(this.serviceApiProtocols, service)
        || !this.serviceApiProtocols[service].includes(protocol)) {
      return { error: errorResponse(request, 403, 'Service/protocol pair is not configured') };
    }
    if (isRetrieve && !/^[A-Za-z0-9_-]{1,256}$/.test(fields?.queue_id ?? '')) {
      return { error: errorResponse(request, 400, 'A valid queue_id is required') };
    }
    let body = request.body;
    if (!isRetrieve && !fields?.model && !fields?.service && !headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) {
      let payload;
      try { payload = JSON.parse(Buffer.from(body).toString()); } catch { return { error: errorResponse(request, 400, 'A JSON object is required') }; }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') return { error: errorResponse(request, 400, 'A JSON object is required') };
      body = Buffer.from(JSON.stringify({ ...payload, model: service }));
    }
    return { request: { ...request, headers, body }, service, protocol, isRetrieve };
  }
  async handleRequest(request) {
    return this.#handle(request);
  }
  async handleRequestStream(request, callbacks) {
    return this.#handle(request, callbacks);
  }
  async #handle(request, callbacks) {
    const requestId = request.requestId;
    // BaseProvider keys pending responses and stream callbacks by requestId.
    // Reserve before prepare can yield, including for native video retrieval.
    if (this.#inFlightIds.has(requestId)) return errorResponse(request, 409, 'Request ID is already in flight');
    this.#inFlightIds.add(requestId);
    try {
      const prepared = await this.prepare(request);
      if (prepared.error) return prepared.error;
      if (this.getCapacity().current >= this.maxConcurrency) return errorResponse(request, 429, 'Max concurrency reached');
      if (prepared.isRetrieve) return await this.#retrieve(prepared.request, callbacks);
      return await (callbacks ? super.handleRequestStream(prepared.request, callbacks) : super.handleRequest(prepared.request));
    } finally {
      this.#inFlightIds.delete(requestId);
    }
  }
  async #retrieve(request, callbacks) {
    const negotiated = request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] === VIDEO_DOWNLOAD_STREAM_VERSION;
    const download = videoDownloadSignal(callbacks?.signal ?? new AbortController().signal);
    this.#videoActive++;
    let started = false;
    try {
      const upstream = await fetch(`${this.#baseUrl}${request.path}`, {
        method: 'POST', headers: { ...request.headers, authorization: this.#auth, 'accept-encoding': 'identity' },
        body: Buffer.from(request.body), signal: download.signal, redirect: 'error',
      });
      const type = upstream.headers.get('content-type')?.split(';')[0]?.trim();
      if (type === 'application/json') {
        const reader = upstream.body?.getReader();
        const chunks = [];
        let size = 0;
        try {
          if (reader) while (true) {
            download.signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1_048_576) throw new Error('Video status response exceeds limits');
            chunks.push(Buffer.from(value));
          }
          return { requestId: request.requestId, statusCode: upstream.status, headers: stripRelayResponseHeaders(upstream), body: Buffer.concat(chunks) };
        } finally {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
      }
      if (!negotiated || !callbacks) {
        await upstream.body?.cancel();
        return errorResponse(request, 400, 'Video downloads require negotiated streaming');
      }
      let hash;
      const response = await streamVideoResponse(request, upstream, {
        onResponseStart(start) {
          hash = createStreamingResponseHash(start);
          started = true;
          callbacks.onResponseStart(start);
        },
        async onResponseChunk(chunk) {
          hash.update(chunk.data);
          await callbacks.onResponseChunk(chunk);
        },
      }, download);
      return hash ? { ...response, streamedBody: hash.finish() } : response;
    } catch {
      if (started) throw new Error('Video download interrupted');
      return errorResponse(request, 502, 'Loopback video gateway unavailable');
    } finally {
      download.done();
      this.#videoActive--;
    }
  }
}

const fields = [
  ['OPENAI_API_KEY', 'secret'], ['OPENAI_BASE_URL', 'string'],
  ['SURPLUS_GATEWAY_TOKEN', 'secret'], ['SURPLUS_GATEWAY_URL', 'string'],
  ['SURPLUS_PROTOCOLS_JSON', 'string'], ['ANTSEED_ALLOWED_SERVICES', 'string[]'],
  ['ANTSEED_SERVICE_PRICING_JSON', 'string'], ['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', 'string'],
  ['ANTSEED_SERVICE_CAPABILITIES_JSON', 'string'],
  ['ANTSEED_INPUT_USD_PER_MILLION', 'number'], ['ANTSEED_OUTPUT_USD_PER_MILLION', 'number'],
  ['ANTSEED_CACHED_INPUT_USD_PER_MILLION', 'number'], ['ANTSEED_MAX_CONCURRENCY', 'number'],
];

export default {
  name: 'surplus', type: 'provider', version: '0.1.0', displayName: 'Surplus Loopback Gateway',
  configSchema: fields.map(([key, type]) => ({ key, type, label: key, required: false })),
  createProvider(config) {
    const services = parseCsv(config.ANTSEED_ALLOWED_SERVICES);
    if (!services.length) throw new Error('ANTSEED_ALLOWED_SERVICES must not be empty');
    const serviceApiProtocols = explicitProtocols(config.SURPLUS_PROTOCOLS_JSON, services);
    const baseUrl = gatewayUrl(config.SURPLUS_GATEWAY_URL ?? config.OPENAI_BASE_URL);
    const token = (config.SURPLUS_GATEWAY_TOKEN ?? config.OPENAI_API_KEY)?.trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('OPENAI_API_KEY or SURPLUS_GATEWAY_TOKEN is required');
    const maxConcurrency = Number(config.ANTSEED_MAX_CONCURRENCY ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const servicePricing = parseServicePricingJson(config.ANTSEED_SERVICE_PRICING_JSON);
    const pricing = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_INPUT_USD_PER_MILLION, 'ANTSEED_INPUT_USD_PER_MILLION', 0),
        outputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_OUTPUT_USD_PER_MILLION, 'ANTSEED_OUTPUT_USD_PER_MILLION', 0),
        ...(config.ANTSEED_CACHED_INPUT_USD_PER_MILLION !== undefined ? {
          cachedInputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_CACHED_INPUT_USD_PER_MILLION, 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0),
        } : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };
    return new SurplusProvider({
      name: 'surplus', services, pricing, serviceApiProtocols,
      serviceCapabilities: parseServiceCapabilitiesJson(config.ANTSEED_SERVICE_CAPABILITIES_JSON),
      serviceUnitBillingModels: parseServiceUnitBillingModelsJson(config.ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON),
      relay: {
        baseUrl, authHeaderName: 'authorization', authHeaderValue: `Bearer ${token}`,
        maxConcurrency, allowedServices: services, redirect: 'error',
      },
    });
  },
};
