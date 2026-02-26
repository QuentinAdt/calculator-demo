import express from 'express';
import compression from 'compression';
import crypto from 'crypto';
import { readFileSync } from 'fs';
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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ALLOWED_IPS = (process.env.ALLOWED_WEBHOOK_IPS || '116.202.8.41').split(',').map(s => s.trim());

const app = express();

// Compress all text-based responses (HTML, CSS, JS, JSON) to reduce transfer size
app.use(compression());

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
  // IP whitelist
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const normalizedIp = clientIp.replace(/^::ffff:/, '');
  if (!ALLOWED_IPS.includes(normalizedIp) && normalizedIp !== '127.0.0.1') {
    console.log(`[webhook] Rejected IP: ${normalizedIp}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Verify HMAC signature using raw body
  const signature = req.headers['x-webhook-signature'];
  if (WEBHOOK_SECRET && signature) {
    const bodyToVerify = req.rawBody || JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(bodyToVerify)
      .digest('hex');
    if (signature !== expected) {
      console.log('[webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  console.log(`[webhook] Received: ${req.body?.event} — ${req.body?.request?.category}`);
  res.json({ received: true });

  // Process asynchronously
  handleWebhook(req.body).catch(err => {
    console.error('[webhook] Processing error:', err.message);
  });
});

// Serve static files with tiered caching:
// - HTML: always revalidate (picks up auto-updater changes immediately)
// - CSS/JS/assets: cache 5 min, then revalidate via ETag/304
app.use(express.static(join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    } else {
      res.set('Cache-Control', 'public, max-age=300');
    }
  }
}));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Calculator demo running at http://0.0.0.0:${PORT}`);
});
