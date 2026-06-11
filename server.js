const http = require('http');
const { Pool } = require('pg');

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_state TEXT NOT NULL DEFAULT 'start',
      states JSONB NOT NULL,
      archived BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    -- Add archived column if upgrading from old schema
    ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      employee_name TEXT NOT NULL,
      scenario_id INTEGER,
      scenario_name TEXT,
      score_coverage INTEGER,
      score_correctness INTEGER,
      score_standard INTEGER,
      turns JSONB,
      feedback TEXT,
      summary TEXT,
      good JSONB,
      improve JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed scenarios from scenarios.json if table is empty
  const { rows } = await pool.query('SELECT COUNT(*) FROM scenarios');
  if (parseInt(rows[0].count) === 0) {
    const scenarios = JSON.parse(fs.readFileSync(__dirname + '/scenarios.json', 'utf8'));
    for (const s of scenarios) {
      await pool.query(
        'INSERT INTO scenarios (name, description, start_state, states) VALUES ($1,$2,$3,$4)',
        [s.name, s.desc || '', s.startState || 'start', JSON.stringify(s.states)]
      );
    }
    console.log(`✅ Загружено ${scenarios.length} сценариев из scenarios.json`);
  }
  console.log('✅ База данных готова');
}
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY_GPT    = process.env.YC_API_KEY_GPT    || '';
const API_KEY_SPEECH = process.env.YC_API_KEY_SPEECH || API_KEY_GPT;
const FOLDER_ID      = process.env.YC_FOLDER_ID      || '';

if (!API_KEY_GPT || !FOLDER_ID) {
  console.warn('⚠  Задайте переменные окружения YC_API_KEY_GPT и YC_FOLDER_ID');
}

function proxyRequest(req, res, targetHost, targetPath) {
  const body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    const bodyData = Buffer.concat(body);
    const options = {
      hostname: targetHost,
      path: targetPath,
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Authorization': `Api-Key ${API_KEY_GPT}`,
        'x-folder-id': FOLDER_ID,
        'Content-Length': bodyData.length
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': proxyRes.headers['content-type'] || 'application/json'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    });

    proxyReq.write(bodyData);
    proxyReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  // Healthcheck for Railway
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  // YandexGPT
  if (parsed.pathname === '/api/gpt') {
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      let bodyData = Buffer.concat(body);
      try {
        const payload = JSON.parse(bodyData.toString());
        if (payload.modelUri) payload.modelUri = payload.modelUri.replace('placeholder', FOLDER_ID);
        bodyData = Buffer.from(JSON.stringify(payload));
      } catch(e) {}
      const options = {
        hostname: 'llm.api.cloud.yandex.net',
        path: '/foundationModels/v1/completion',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Api-Key ${API_KEY_GPT}`,
          'x-folder-id': FOLDER_ID,
          'Content-Length': bodyData.length
        }
      };
      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': proxyRes.headers['content-type'] || 'application/json' });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); });
      proxyReq.write(bodyData);
      proxyReq.end();
    });
    return;
  }

  // SpeechKit STT — proxy raw audio to Yandex (PCM format from browser)
  if (parsed.pathname === '/api/stt') {
    const body2 = [];
    req.on('data', chunk => body2.push(chunk));
    req.on('end', () => {
      const bodyData2 = Buffer.concat(body2);
      const sttPath = '/speech/v1/stt:recognize?lang=ru-RU&format=lpcm&sampleRateHertz=16000&profanityFilter=false';
      const opts2 = {
        hostname: 'stt.api.cloud.yandex.net',
        path: sttPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Authorization': `Api-Key ${API_KEY_SPEECH}`,
          'x-folder-id': FOLDER_ID,
          'Content-Length': bodyData2.length
        }
      };
      const pr2 = https.request(opts2, (r2) => {
        res.writeHead(r2.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        r2.pipe(res);
      });
      pr2.on('error', (e) => { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); });
      pr2.write(bodyData2);
      pr2.end();
    });
    return;
  }

  // SpeechKit TTS
  if (parsed.pathname === '/api/tts') {
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const bodyData = Buffer.concat(body);
      const ttsParams = new URLSearchParams(bodyData.toString());
      ttsParams.set('folderId', FOLDER_ID);
      const ttsBody = Buffer.from(ttsParams.toString());
      const options = {
        hostname: 'tts.api.cloud.yandex.net',
        path: '/speech/v1/tts:synthesize',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Api-Key ${API_KEY_SPEECH}`,
          'Content-Length': ttsBody.length
        }
      };
      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg' });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); });
      proxyReq.write(ttsBody);
      proxyReq.end();
    });
    return;
  }


  // ── Scenarios API ──────────────────────────────────────────────────────────
  if (parsed.pathname === '/api/scenarios' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM scenarios WHERE archived = FALSE ORDER BY id');
      const scenarios = rows.map(r => ({ id: r.id, name: r.name, desc: r.description, startState: r.start_state, states: r.states }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(scenarios));
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (parsed.pathname === '/api/scenarios' && req.method === 'POST') {
    const body = []; req.on('data', c => body.push(c));
    req.on('end', async () => {
      try {
        const s = JSON.parse(Buffer.concat(body).toString());
        const { rows } = await pool.query('INSERT INTO scenarios (name, description, start_state, states) VALUES ($1,$2,$3,$4) RETURNING *', [s.name, s.desc||'', s.startState||'start', JSON.stringify(s.states)]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(rows[0]));
      } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }

  const scenarioMatch = parsed.pathname.match(/^\/api\/scenarios\/(\d+)$/);
  if (scenarioMatch && req.method === 'PUT') {
    const body = []; req.on('data', c => body.push(c));
    req.on('end', async () => {
      try {
        const s = JSON.parse(Buffer.concat(body).toString());
        await pool.query('UPDATE scenarios SET name=$1, description=$2, start_state=$3, states=$4 WHERE id=$5', [s.name, s.desc||'', s.startState||'start', JSON.stringify(s.states), scenarioMatch[1]]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }

  if (scenarioMatch && req.method === 'DELETE') {
    // Archive instead of delete
    try {
      await pool.query('UPDATE scenarios SET archived = TRUE WHERE id=$1', [scenarioMatch[1]]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Unarchive scenario
  const unarchiveMatch = parsed.pathname.match(/^\/api\/scenarios\/(\d+)\/unarchive$/);
  if (unarchiveMatch && req.method === 'POST') {
    try {
      await pool.query('UPDATE scenarios SET archived = FALSE WHERE id=$1', [unarchiveMatch[1]]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET all scenarios including archived (for admin)
  if (parsed.pathname === '/api/scenarios/all' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM scenarios ORDER BY archived, id');
      const scenarios = rows.map(r => ({ id: r.id, name: r.name, desc: r.description, startState: r.start_state, states: r.states, archived: r.archived }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(scenarios));
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Sessions API ───────────────────────────────────────────────────────────
  if (parsed.pathname === '/api/sessions' && req.method === 'POST') {
    const body = []; req.on('data', c => body.push(c));
    req.on('end', async () => {
      try {
        const s = JSON.parse(Buffer.concat(body).toString());
        await pool.query(
          'INSERT INTO sessions (employee_name,scenario_id,scenario_name,score_coverage,score_correctness,score_standard,turns,feedback,summary,good,improve) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [s.employeeName, s.scenarioId||null, s.scenarioName, s.coverage, s.correctness, s.standard, JSON.stringify(s.turns), s.details||'', s.summary||'', JSON.stringify(s.good||[]), JSON.stringify(s.improve||[])]
        );
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }

  if (parsed.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(rows));
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (parsed.pathname === '/api/sessions/export' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
      const SEP = '\t';
      const esc = v => String(v ?? '').replace(/\t/g, ' ');
      const headers = ['ID','Сотрудник','Сценарий','Полнота %','Корректность %','Стандарт %','Дата'];
      const lines = [
        headers.join(SEP),
        ...rows.map(r => [
          r.id, esc(r.employee_name), esc(r.scenario_name),
          r.score_coverage, r.score_correctness, r.score_standard,
          new Date(r.created_at).toLocaleString('ru')
        ].join(SEP))
      ];
      const csv = lines.join('\n');
      res.writeHead(200, { 'Content-Type': 'text/tab-separated-values; charset=utf-8', 'Content-Disposition': 'attachment; filename="sessions.tsv"', 'Access-Control-Allow-Origin': '*' });
      return res.end('\ufeff' + csv);
    } catch(e) { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Static files
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname === '/admin' ? '/admin.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

initDB().catch(e => console.error('DB init error:', e));

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`🔑 GPT ключ: ${API_KEY_GPT ? API_KEY_GPT.slice(0,8) + '...' : '(не задан!)'}`);
  console.log(`📁 Folder ID: ${FOLDER_ID || '(не задан!)'}`);
});
