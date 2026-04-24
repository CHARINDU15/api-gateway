const http = require('http');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8000', 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = parseInt(process.env.GATEWAY_REQUEST_TIMEOUT_MS || '15000', 10);

const upstreams = [
  {
    name: 'auth-service',
    baseUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    prefixes: ['/api/auth']
  },
  {
    name: 'notification-service',
    baseUrl: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
    prefixes: ['/api/notifications']
  },
  {
    name: 'orchestration-service',
    baseUrl: process.env.ORCHESTRATION_SERVICE_URL || 'http://localhost:3002',
    prefixes: [
      '/api/consignments',
      '/api/items',
      '/api/access-links',
      '/api/otp',
      '/api/locations',
      '/api/delivery-options',
      '/api/v1/invoices',
      '/api/v1/scheduler',
      '/api-docs'
    ]
  }
];

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), microphone=(), camera=()'
};

const setBaseHeaders = (res, origin = FRONTEND_ORIGIN) => {
  Object.entries(securityHeaders).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization,Content-Type,X-Request-ID,X-Correlation-ID');
};

const sendJson = (res, statusCode, payload, origin) => {
  setBaseHeaders(res, origin);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readRequestBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];

  req.on('data', (chunk) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    resolve(chunks.length ? Buffer.concat(chunks) : null);
  });

  req.on('error', reject);
});

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const matchUpstream = (pathname) => upstreams.find((service) =>
  service.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
);

const buildProxyHeaders = (req, body) => {
  const headers = new Headers();

  Object.entries(req.headers).forEach(([key, value]) => {
    if (!value) return;
    const lowered = key.toLowerCase();
    if (['host', 'connection', 'content-length'].includes(lowered)) return;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  });

  headers.set('x-forwarded-host', req.headers.host || `localhost:${PORT}`);
  headers.set('x-forwarded-proto', 'http');
  headers.set('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
  headers.set('x-gateway-name', 'parcelpoint-api-gateway');

  if (body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return headers;
};

const handleHealth = async (res, origin) => {
  const checks = await Promise.all(upstreams.map(async (service) => {
    try {
      const response = await fetchWithTimeout(`${service.baseUrl}/health`);
      return {
        service: service.name,
        status: response.ok ? 'UP' : 'DOWN',
        statusCode: response.status
      };
    } catch (error) {
      return {
        service: service.name,
        status: 'DOWN',
        error: error.name === 'AbortError' ? 'Timed out' : error.message
      };
    }
  }));

  const overallStatus = checks.every((check) => check.status === 'UP') ? 'UP' : 'DEGRADED';

  sendJson(res, overallStatus === 'UP' ? 200 : 503, {
    success: overallStatus === 'UP',
    data: {
      service: 'api-gateway',
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks
    }
  }, origin);
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || FRONTEND_ORIGIN;
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    setBaseHeaders(res, origin);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === '/health') {
    await handleHealth(res, origin);
    return;
  }

  const upstream = matchUpstream(pathname);

  if (!upstream) {
    sendJson(res, 404, {
      success: false,
      error: 'Route not found',
      path: pathname
    }, origin);
    return;
  }

  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readRequestBody(req);
    const targetUrl = `${upstream.baseUrl}${pathname}${url.search}`;
    const upstreamResponse = await fetchWithTimeout(targetUrl, {
      method: req.method,
      headers: buildProxyHeaders(req, body),
      body
    });

    setBaseHeaders(res, origin);
    res.statusCode = upstreamResponse.status;

    upstreamResponse.headers.forEach((value, key) => {
      const lowered = key.toLowerCase();
      if (['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(lowered)) return;
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    sendJson(res, 502, {
      success: false,
      error: 'Upstream request failed',
      details: error.name === 'AbortError' ? 'Gateway timeout' : error.message
    }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`ParcelPoint API gateway running on http://localhost:${PORT}`);
  upstreams.forEach((service) => {
    console.log(`- ${service.name} -> ${service.baseUrl}`);
  });
});
