import express from 'express';
import compression from 'compression';
import crypto from 'crypto';
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
} catch {}

const PORT = parseInt(process.env.PORT, 10) || 3080;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('[server] WEBHOOK_SECRET environment variable is required — refusing to start without it');
  process.exit(1);
}
const ALLOWED_IPS = (process.env.ALLOWED_WEBHOOK_IPS || '116.202.8.41').split(',').map(s => s.trim());

const app = express();

// Compress all text-based responses (HTML, CSS, JS, JSON) to reduce transfer size
app.use(compression());

// Feedback widget origin — used in CSP to allow the lazy-loaded widget to function
const WIDGET_ORIGIN = 'https://*.feedbackloopai.ovh';

// Security headers to harden against common web attacks
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
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
    ].join('; '),
  });
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
  // IP whitelist — use only req.ip (respects Express trust proxy setting) or
  // direct socket address; never trust the user-controlled X-Forwarded-For header
  const clientIp = req.ip || req.connection.remoteAddress;
  const normalizedIp = clientIp.replace(/^::ffff:/, '');
  if (!ALLOWED_IPS.includes(normalizedIp) && normalizedIp !== '127.0.0.1') {
    console.log(`[webhook] Rejected IP: ${normalizedIp}`);
    return res.status(403).json({ error: 'Forbidden' });
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
    console.error('[webhook] Processing error:', err.message);
  });
});

// Inline CSS into HTML to eliminate the render-blocking stylesheet request,
// improving First Contentful Paint (FCP) and Largest Contentful Paint (LCP).
// Cache is invalidated by file mtime changes rather than a fixed TTL, avoiding
// redundant disk reads and minification when files haven't changed.
const HTML_PATH = join(__dirname, 'public', 'index.html');
const CSS_PATH = join(__dirname, 'public', 'css', 'style.css');
const JS_DIR = join(__dirname, 'public', 'js');
const JS_FILES = ['calculator.js', 'feedback-loader.js'];
let cachedInlinedHtml = null;
let cachedHtmlEtag = null;

// Mtime-based cache invalidation: only re-read and re-minify files when they
// actually change on disk. statSync is ~0.01ms per call (negligible vs full
// file reads + minification), and is throttled to at most once per second.
const MTIME_CHECK_MS = 1000;
let lastMtimeCheck = 0;
let cachedMtimes = {};

function getFileMtime(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
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

// Cache minified JS files — invalidated by file mtime changes.
let cachedMinifiedJs = {};

function getMinifiedJs(filename) {
  const filePath = join(JS_DIR, filename);
  const now = Date.now();
  const cached = cachedMinifiedJs[filename];
  if (cached) {
    // Throttle mtime checks to once per second per file
    if (now - cached.time < MTIME_CHECK_MS) return cached;
    const currentMtime = getFileMtime(filePath);
    if (cached.mtime === currentMtime) {
      cached.time = now; // reset throttle timer
      return cached;
    }
  }
  try {
    const mtime = getFileMtime(filePath);
    const raw = readFileSync(filePath, 'utf-8');
    const content = minifyJs(raw);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const entry = { content, hash, time: now, mtime };
    cachedMinifiedJs[filename] = entry;
    return entry;
  } catch {
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

function getInlinedHtml() {
  const now = Date.now();
  // Throttle mtime checks to once per second
  if (cachedInlinedHtml && now - lastMtimeCheck < MTIME_CHECK_MS) {
    return cachedInlinedHtml;
  }
  lastMtimeCheck = now;
  // Watch HTML, CSS, and all JS files — a change to any triggers a rebuild
  // (JS changes affect the version hashes embedded in HTML)
  const watchedPaths = [HTML_PATH, CSS_PATH, ...JS_FILES.map(f => join(JS_DIR, f))];
  if (cachedInlinedHtml && !haveFilesChanged(watchedPaths)) {
    return cachedInlinedHtml;
  }
  try {
    const html = readFileSync(HTML_PATH, 'utf-8');
    try {
      const css = readFileSync(CSS_PATH, 'utf-8');
      cachedInlinedHtml = html.replace(
        '<link rel="stylesheet" href="/css/style.css">',
        `<style>${minifyCss(css)}</style>`
      );
    } catch {
      // CSS read failed — serve raw HTML (browser will fetch stylesheet separately)
      cachedInlinedHtml = html;
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
    cachedInlinedHtml = cachedInlinedHtml.replace(
      `/js/${file}`,
      `/js/${file}?v=${hash}`
    );
  }
  recordMtimes(watchedPaths);
  // Compute ETag from the final HTML content for conditional 304 responses
  cachedHtmlEtag = '"' + crypto.createHash('md5').update(cachedInlinedHtml).digest('hex').slice(0, 16) + '"';
  return cachedInlinedHtml;
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
  res.type('js').send(entry.content);
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
  const html = getInlinedHtml();
  if (!html) {
    return res.status(503).type('text').send('Service temporarily unavailable');
  }
  // Return 304 Not Modified when the browser's cached copy matches,
  // saving bandwidth (~5-8KB gzipped) on repeat visits.
  if (cachedHtmlEtag && req.headers['if-none-match'] === cachedHtmlEtag) {
    return res.status(304).end();
  }
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', cachedHtmlEtag);
  res.type('html').send(html);
});

// Global error handler — catches unhandled exceptions in route handlers.
// Prevents stack trace leakage to clients and returns a clean error response.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).type('text').send('Internal server error');
});

// Catch unhandled promise rejections to prevent silent process crashes
// (e.g. from async webhook processing or other background tasks)
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
});

// Catch uncaught synchronous exceptions that occur outside Express route handlers
// (e.g. in setInterval callbacks, event emitters). Log before exiting so the error
// is visible in monitoring rather than silently crashing.
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception — shutting down:', err.message);
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
