import express from 'express';
import crypto from 'crypto';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'zlib';
import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { handleWebhook } from './auto-updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env manually (no dotenv dependency)
try {
  const envContent = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch (err) {
  // Missing .env is expected (env vars may come from the host); only warn on real failures
  if (err.code !== 'ENOENT') {
    console.warn('[server] Could not read .env file:', err.message);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 3080;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.warn('[server] WEBHOOK_SECRET not set — webhook endpoint will reject all requests');
}
const ALLOWED_IPS = (process.env.ALLOWED_WEBHOOK_IPS || '116.202.8.41').split(',').map(s => s.trim());

const app = express();

// Suppress the default X-Powered-By header so the server does not advertise
// its technology stack, reducing information available to attackers.
app.disable('x-powered-by');

// Feedback widget origin — used in CSP to allow the lazy-loaded widget to function
const WIDGET_ORIGIN = 'https://*.feedbackloopai.ovh';

// Precompute security headers once at startup — avoids per-request object
// allocation and CSP string concatenation (10-element array join) on every
// incoming request, reducing GC pressure and shaving ~µs off each response.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' ${WIDGET_ORIGIN}`,
    `style-src 'self' 'unsafe-inline' ${WIDGET_ORIGIN}`,
    `connect-src 'self' ${WIDGET_ORIGIN}`,
    `img-src 'self' data: ${WIDGET_ORIGIN}`,
    `frame-src ${WIDGET_ORIGIN}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

// Security headers to harden against common web attacks
app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
});

// Parse JSON for webhook endpoint, keeping raw body for HMAC verification
app.use('/api/webhook', express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf-8');
  }
}));

// Rate limiting for webhook (simple in-memory with periodic cleanup)
const webhookHits = new Map();
function webhookRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000;
  const max = 10;
  const hits = webhookHits.get(ip) || [];
  const recent = hits.filter(t => now - t < windowMs);
  if (recent.length >= max) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  recent.push(now);
  webhookHits.set(ip, recent);
  next();
}

// Evict stale rate-limit entries to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of webhookHits) {
    const recent = hits.filter(t => now - t < 60000);
    if (recent.length === 0) {
      webhookHits.delete(ip);
    } else {
      webhookHits.set(ip, recent);
    }
  }
}, 300_000).unref();

// Webhook endpoint
app.post('/api/webhook', webhookRateLimit, (req, res) => {
  // Reject all requests when WEBHOOK_SECRET is not configured — without a valid
  // secret the HMAC check below cannot authenticate anything.  This prevents
  // crypto.createHmac from throwing on `undefined` and guards against an empty-
  // string secret that would let anyone forge a valid signature.
  if (!WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Webhook authentication not configured' });
  }

  // IP whitelist — use only req.ip (respects Express trust proxy setting) or
  // direct socket address; never trust the user-controlled X-Forwarded-For header
  const clientIp = req.ip || req.connection.remoteAddress;
  const normalizedIp = clientIp.replace(/^::ffff:/, '');
  if (!ALLOWED_IPS.includes(normalizedIp) && normalizedIp !== '127.0.0.1') {
    console.log(`[webhook] Rejected IP: ${normalizedIp}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Reject requests where the JSON body parser was skipped (e.g., missing or
  // non-JSON Content-Type).  Without this guard, the HMAC verification below
  // would call crypto.createHmac().update(undefined) and throw a TypeError.
  if (req.body === undefined) {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }

  // Verify HMAC signature using raw body — always enforced (WEBHOOK_SECRET is required at startup)
  const signature = req.headers['x-webhook-signature'];
  if (!signature) {
    console.log('[webhook] Missing signature');
    return res.status(401).json({ error: 'Missing signature' });
  }
  const bodyToVerify = req.rawBody || JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(bodyToVerify)
    .digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.log('[webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Validate payload structure before processing
  const { event, request: feedbackReq } = req.body || {};
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'Invalid payload: missing event' });
  }
  if (event === 'feedback.qualified') {
    if (!feedbackReq || typeof feedbackReq !== 'object' || Array.isArray(feedbackReq)) {
      return res.status(400).json({ error: 'Invalid payload: missing request' });
    }
    if (!['BUG', 'FEATURE', 'QUESTION'].includes(feedbackReq.category)) {
      return res.status(400).json({ error: 'Invalid payload: invalid category' });
    }
    // Validate request.id — it is interpolated into URLs for status updates.
    // Allow only safe identifier characters to prevent SSRF / path traversal.
    if (feedbackReq.id != null && !/^[a-zA-Z0-9_-]+$/.test(String(feedbackReq.id))) {
      return res.status(400).json({ error: 'Invalid payload: malformed request id' });
    }
  }

  console.log(`[webhook] Received: ${event} — ${feedbackReq?.category}`);
  res.json({ received: true });

  // Process asynchronously
  handleWebhook(req.body).catch(err => {
    console.error('[webhook] Processing error:', err instanceof Error ? err.stack : err);
  });
});

// Inline CSS into HTML to eliminate the render-blocking stylesheet request,
// improving First Contentful Paint (FCP) and Largest Contentful Paint (LCP).
// Cache is invalidated by file mtime changes rather than a fixed TTL, avoiding
// redundant disk reads and minification when files haven't changed.
const HTML_PATH = join(__dirname, 'public', 'index.html');
const CSS_PATH = join(__dirname, 'public', 'css', 'style.css');
const JS_DIR = join(__dirname, 'public', 'js');
const JS_FILES = ['calculator.js'];
// Grouped HTML cache — all fields are computed together and invalidated atomically.
// { html, gzip, brotli, etag, preloadHeader, checkedAt }
let htmlCache = null;

// Brotli compression options — quality 6 balances compression ratio and CPU cost
// for on-startup pre-compression of cached assets.
const BROTLI_OPTS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
};

// Mtime-based cache invalidation: only re-read and re-minify files when they
// actually change on disk. statSync is ~0.01ms per call (negligible vs full
// file reads + minification), and is throttled to at most once per second.
const MTIME_CHECK_MS = 1000;
let cachedMtimes = {};

function getFileMtime(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[server] Unexpected error stating ${filePath}:`, err.message);
    }
    return 0;
  }
}

function haveFilesChanged(paths) {
  for (const p of paths) {
    if (cachedMtimes[p] !== getFileMtime(p)) return true;
  }
  return false;
}

function recordMtimes(paths) {
  for (const p of paths) {
    cachedMtimes[p] = getFileMtime(p);
  }
}

// Lightweight runtime minification — no build step or dependencies needed.
// CSS: strip comments + collapse whitespace for inlined <style> blocks.
// JS: strip comments + blank lines for separate script responses.
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{}:;,]) ?/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function minifyJs(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Send pre-compressed content, preferring Brotli over gzip for ~15% smaller
// payloads. Centralises the Content-Encoding / Vary header logic so it stays
// consistent across all routes that serve pre-compressed payloads (HTML and JS).
function sendPrecompressed(req, res, contentType, { brotli, gzip, plain }) {
  if (brotli && req.acceptsEncodings('br')) {
    res.set('Content-Encoding', 'br');
    res.set('Vary', 'Accept-Encoding');
    res.type(contentType).end(brotli);
  } else if (gzip && req.acceptsEncodings('gzip')) {
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.type(contentType).end(gzip);
  } else {
    res.type(contentType).send(plain);
  }
}

// Cache minified JS files — invalidated by file mtime changes.
let cachedMinifiedJs = {};

function getMinifiedJs(filename) {
  const filePath = join(JS_DIR, filename);
  const now = Date.now();
  const cached = cachedMinifiedJs[filename];
  let knownMtime;
  if (cached) {
    // Throttle mtime checks to once per second per file
    if (now - cached.time < MTIME_CHECK_MS) return cached;
    knownMtime = getFileMtime(filePath);
    if (cached.mtime === knownMtime) {
      cached.time = now; // reset throttle timer
      return cached;
    }
  }
  try {
    const mtime = knownMtime ?? getFileMtime(filePath);
    const raw = readFileSync(filePath, 'utf-8');
    const content = minifyJs(raw);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const gzipped = gzipSync(content);
    const brotli = brotliCompressSync(content, BROTLI_OPTS);
    const entry = { content, gzipped, brotli, hash, time: now, mtime };
    cachedMinifiedJs[filename] = entry;
    return entry;
  } catch (err) {
    console.warn(`[server] Failed to read/minify ${filename}:`, err.message);
    return null;
  }
}

function getJsVersionHashes() {
  const hashes = {};
  for (const file of JS_FILES) {
    const entry = getMinifiedJs(file);
    if (entry) hashes[file] = entry.hash;
  }
  return hashes;
}

function getHtmlCache() {
  const now = Date.now();
  // Throttle mtime checks to once per second
  if (htmlCache && now - htmlCache.checkedAt < MTIME_CHECK_MS) {
    return htmlCache;
  }
  // Watch HTML, CSS, and all JS files — a change to any triggers a rebuild
  // (JS changes affect the version hashes embedded in HTML)
  const watchedPaths = [HTML_PATH, CSS_PATH, ...JS_FILES.map(f => join(JS_DIR, f))];
  if (htmlCache && !haveFilesChanged(watchedPaths)) {
    htmlCache.checkedAt = now;
    return htmlCache;
  }
  let inlinedHtml;
  try {
    const rawHtml = readFileSync(HTML_PATH, 'utf-8');
    try {
      const css = readFileSync(CSS_PATH, 'utf-8');
      inlinedHtml = rawHtml.replace(
        '<link rel="stylesheet" href="/css/style.css">',
        `<style>${minifyCss(css)}</style>`
      );
    } catch (err) {
      // CSS read failed — serve raw HTML (browser will fetch stylesheet separately)
      console.warn('[server] CSS inlining failed, falling back to external stylesheet:', err.message);
      inlinedHtml = rawHtml;
    }
  } catch (err) {
    console.error('[server] Failed to read index.html:', err.message);
    return null;
  }
  // Fingerprint JS URLs with content hashes for long-term immutable caching.
  // When auto-updater modifies a file, the mtime change triggers a rebuild
  // and browsers fetch the new version automatically.
  const jsHashes = getJsVersionHashes();
  for (const [file, hash] of Object.entries(jsHashes)) {
    inlinedHtml = inlinedHtml.replace(
      `/js/${file}`,
      `/js/${file}?v=${hash}`
    );
  }
  recordMtimes(watchedPaths);
  // Build cache atomically — prevents partial state if a step (e.g. compression) throws
  const calcHash = jsHashes['calculator.js'];
  htmlCache = {
    html: inlinedHtml,
    etag: '"' + crypto.createHash('md5').update(inlinedHtml).digest('hex').slice(0, 16) + '"',
    gzip: gzipSync(inlinedHtml),
    brotli: brotliCompressSync(inlinedHtml, BROTLI_OPTS),
    preloadHeader: calcHash
      ? `</js/calculator.js?v=${calcHash}>; rel=preload; as=script`
      : null,
    checkedAt: now,
  };
  return htmlCache;
}

// Serve minified JS with the same tiered caching strategy as raw files.
// Registered before express.static so minified content takes priority.
app.get('/js/:file', (req, res) => {
  const filename = req.params.file;
  if (!/^[\w.-]+\.js$/.test(filename)) return res.status(404).end();
  const entry = getMinifiedJs(filename);
  if (!entry) return res.status(404).end();
  if (req.query.v) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.set('Cache-Control', 'no-cache');
  }
  sendPrecompressed(req, res, 'js', { brotli: entry.brotli, gzip: entry.gzipped, plain: entry.content });
});

// Serve static files with tiered caching:
// - HTML: served via custom handler below (with inlined CSS)
// - JS (versioned ?v=hash): immutable 1-year cache (hash changes on file update)
// - JS (unversioned): always revalidate (picks up auto-updater patches immediately)
// - CSS/images/assets: cache 5 min, then revalidate via ETag/304
app.use(express.static(join(__dirname, 'public'), {
  index: false, // Don't auto-serve index.html — handled by custom route below
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.js')) {
      // Versioned JS (with ?v=<hash>) is immutable — the hash guarantees
      // content uniqueness so browsers can skip revalidation entirely.
      // Unversioned JS still revalidates for direct/legacy access.
      if (res.req && res.req.query && res.req.query.v) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.set('Cache-Control', 'no-cache');
      }
    } else {
      res.set('Cache-Control', 'public, max-age=300');
    }
  }
}));

// SPA fallback — serve index.html (with inlined CSS) for clean URL navigation, 404 for missing files
app.get('*', (req, res) => {
  // Requests with file extensions (e.g. /favicon.ico, /missing.js) are genuinely missing
  // from public/ — return 404 instead of wastefully serving the full HTML page
  if (/\.\w+$/.test(req.path)) {
    return res.status(404).end();
  }
  const cache = getHtmlCache();
  if (!cache) {
    return res.status(503).type('text').send('Service temporarily unavailable');
  }
  // Return 304 Not Modified when the browser's cached copy matches,
  // saving bandwidth (~5-8KB gzipped) on repeat visits.
  if (cache.etag && req.headers['if-none-match'] === cache.etag) {
    return res.status(304).end();
  }
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', cache.etag);
  if (cache.preloadHeader) res.set('Link', cache.preloadHeader);
  sendPrecompressed(req, res, 'html', { brotli: cache.brotli, gzip: cache.gzip, plain: cache.html });
});

// Global error handler — catches unhandled exceptions in route handlers.
// Prevents stack trace leakage to clients and returns a clean error response.
// Uses err.status/err.statusCode from Express middleware (e.g. body-parser
// JSON parse failures → 400, payload too large → 413) instead of blanket 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = typeof err.status === 'number' ? err.status
    : typeof err.statusCode === 'number' ? err.statusCode
    : 500;

  if (status >= 500) {
    console.error('[server] Unhandled error:', err instanceof Error ? err.stack : err);
    res.status(status).type('text').send('Internal server error');
  } else {
    // Client errors (4xx) from middleware (e.g. malformed JSON, oversized payload)
    // — log at warn level and expose the message only when marked safe by the middleware
    console.warn(`[server] Client error (${status} ${req.method} ${req.path}):`, err.message || err);
    const message = err.expose && err.message ? err.message : 'Bad request';
    res.status(status).type('text').send(message);
  }
});

// Catch unhandled promise rejections to prevent silent process crashes
// (e.g. from async webhook processing or other background tasks)
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});

// Catch uncaught synchronous exceptions that occur outside Express route handlers
// (e.g. in setInterval callbacks, event emitters). Log before exiting so the error
// is visible in monitoring rather than silently crashing.
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception — shutting down:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Calculator demo running at http://0.0.0.0:${PORT}`);
});

// Surface actionable error messages for common listen failures
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Stop the other process or set a different PORT.`);
  } else if (err.code === 'EACCES') {
    console.error(`[server] Permission denied for port ${PORT}. Use a port above 1024 or run with elevated privileges.`);
  } else {
    console.error(`[server] Failed to start: ${err.message}`);
  }
  process.exit(1);
});

// Graceful shutdown — stop accepting new connections and let in-flight requests
// finish before exiting. Prevents dropped requests during deploys/restarts.
function shutdown(signal) {
  console.log(`[server] ${signal} received — closing server gracefully`);
  server.close(() => {
    console.log('[server] All connections closed — exiting');
    process.exit(0);
  });
  // Force exit if connections linger beyond a reasonable deadline
  setTimeout(() => {
    console.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
