const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// --- Postgres (optional: works without it too, just skips saving) ---
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      name TEXT,
      contact TEXT NOT NULL,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Migration-safe: adds the column if the table already existed from before this field was introduced
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS channels TEXT;`);
  console.log('DB ready: table "applications" checked/created');
}
ensureTable().catch((err) => console.error('DB init error:', err));

// --- middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- contact form endpoint ---
app.post('/api/contact', async (req, res) => {
  const name = (req.body.name || '').toString().trim().slice(0, 200);
  const contact = (req.body.contact || '').toString().trim().slice(0, 200);
  const message = (req.body.message || '').toString().trim().slice(0, 2000);
  const channels = Array.isArray(req.body.channels)
    ? req.body.channels.map(c => c.toString().trim()).filter(Boolean).slice(0, 10)
    : [];

  if (!contact) {
    return res.status(400).json({ ok: false, error: 'contact_required' });
  }

  // Save to Postgres (best-effort — a DB hiccup shouldn't block the Telegram notification)
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO applications (name, contact, message, channels) VALUES ($1, $2, $3, $4)',
        [name || null, contact, message || null, channels.length ? channels.join(', ') : null]
      );
    } catch (err) {
      console.error('DB insert error:', err);
    }
  }

  // Send to Telegram
  if (BOT_TOKEN && CHAT_ID) {
    const text = [
      '📩 Новая заявка с сайта ПОЛКА',
      name ? `Имя: ${name}` : null,
      `Контакт: ${contact}`,
      channels.length ? `Удобный способ связи: ${channels.join(', ')}` : null,
      message ? `Заявка: ${message}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text }),
      });
      if (!tgRes.ok) {
        console.error('Telegram API error:', await tgRes.text());
      }
    } catch (err) {
      console.error('Telegram send error:', err);
    }
  } else {
    console.warn('BOT_TOKEN / CHAT_ID not set — skipping Telegram notification');
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});