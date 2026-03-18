const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 8080;
const MAX_HISTORY = 30;

const app = express();
app.use(express.json());

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'whereisfood.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      area TEXT NOT NULL,
      time TEXT NOT NULL
    )
  `);
}

app.get('/api/history', async (req, res) => {
  try {
    const rows = await all(
      'SELECT id, name, type, area, time FROM history ORDER BY id DESC LIMIT ?',
      [MAX_HISTORY]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'failed_to_read_history' });
  }
});

app.post('/api/history', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const type = String(req.body?.type || '').trim();
    const area = String(req.body?.area || '').trim();
    const time = String(req.body?.time || '').trim() || new Date().toLocaleString('zh-CN');

    if (!name) {
      res.status(400).json({ error: 'name_required' });
      return;
    }

    await run(
      'INSERT INTO history (name, type, area, time) VALUES (?, ?, ?, ?)',
      [name.slice(0, 50), type.slice(0, 20), area.slice(0, 20), time]
    );

    await run(
      `
      DELETE FROM history
      WHERE id NOT IN (
        SELECT id FROM history ORDER BY id DESC LIMIT ?
      )
      `,
      [MAX_HISTORY]
    );

    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'failed_to_save_history' });
  }
});

app.delete('/api/history', async (req, res) => {
  try {
    await run('DELETE FROM history');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'failed_to_clear_history' });
  }
});

// 保存附近餐馆搜索结果到 llms/history/
const historyDir = path.join(__dirname, 'llms', 'history');
fs.mkdirSync(historyDir, { recursive: true });

app.post('/api/nearby-history', (req, res) => {
  try {
    const record = req.body;
    if (!record || !record.results) {
      res.status(400).json({ error: 'invalid_record' });
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `nearby_${ts}.json`;
    const filePath = path.join(historyDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    res.status(201).json({ ok: true, file: filename });
  } catch (error) {
    res.status(500).json({ error: 'failed_to_save_nearby_history' });
  }
});

// 本地开发：代理 /api/chat 到 DMXAPI（Vercel 上由 api/chat.js serverless function 处理）
const dmxKeyPath = path.join(__dirname, 'llms', 'dmxapi.txt');
app.post('/api/chat', async (req, res) => {
  let apiKey = '';
  try {
    apiKey = fs.readFileSync(dmxKeyPath, 'utf-8').trim();
  } catch {
    return res.status(500).json({ error: 'API key not found. Create llms/dmxapi.txt' });
  }
  const { messages, temperature = 0.3, max_tokens = 4096 } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages is required' });
  }
  try {
    const upstream = await fetch('https://www.dmxapi.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages, temperature, max_tokens })
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err.error?.message || `Upstream error (${upstream.status})` });
    }
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to reach DMXAPI: ' + e.message });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server started on http://localhost:${PORT}`);
      console.log(`Database: ${dbPath}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
