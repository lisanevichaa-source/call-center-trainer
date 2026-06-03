const http = require('http');
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

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

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

  // SpeechKit STT (not used — Web Speech API handles STT in browser)
  if (parsed.pathname === '/api/stt') {
    return proxyRequest(req, res, 'stt.api.cloud.yandex.net',
      '/speech/v1/stt:recognize?lang=ru-RU&format=oggopus&sampleRateHertz=48000'
    );
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

  // Static files
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`🔑 GPT ключ: ${API_KEY_GPT ? API_KEY_GPT.slice(0,8) + '...' : '(не задан!)'}`);
  console.log(`📁 Folder ID: ${FOLDER_ID || '(не задан!)'}`);
});
