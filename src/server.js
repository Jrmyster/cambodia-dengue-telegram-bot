import express from 'express';
import { timingSafeEqual } from 'node:crypto';

function authenticated(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ bot, store, mode, webhookSecret, isReady = () => true }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get(['/', '/health', '/healthz'], (_req, res) => res.status(200).json({ status: 'alive' }));
  app.get('/readyz', (_req, res) => {
    try {
      const stats = store.stats();
      const ready = isReady() && (!stats.oldest || Date.now() - stats.oldest < 120000);
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
    } catch { res.status(503).json({ status: 'not_ready' }); }
  });
  if (mode === 'webhook') {
    app.post('/telegram/webhook', (req, res, next) => {
      if (!authenticated(req.get('X-Telegram-Bot-Api-Secret-Token'), webhookSecret)) return res.sendStatus(403);
      if (!isReady()) return res.sendStatus(503);
      if (!req.is('application/json')) return res.sendStatus(415);
      next();
    }, express.json({ limit: '64kb', strict: true }), async (req, res) => {
      if (!req.body || !Number.isSafeInteger(req.body.update_id) || req.body.update_id < 0) return res.sendStatus(400);
      try {
        // No Telegram response shortcut: HTTP 200 means the DB transaction committed.
        await bot.handleUpdate(req.body);
        res.sendStatus(200);
      } catch {
        console.error(JSON.stringify({ event: 'webhook_processing_failed' }));
        res.sendStatus(503);
      }
    });
  }
  app.use((err, _req, res, _next) => {
    res.sendStatus(err.type === 'entity.too.large' ? 413 : 400);
  });
  return app;
}
