// ==========================================
// ЧАС 4 & 5: Allstar-Style Studio Web App & Final Test
// ==========================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4952;
const clipsDir = path.join(process.cwd(), 'rendered_vertical_clips');

const studioHtml = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>OneShot Allstar Studio (Fable 5.1)</title>
  <style>
    :root { --bg: #0b0f19; --panel: #131b2e; --border: #1e293b; --accent: #ff4655; --text: #f8fafc; --muted: #94a3b8; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 32px; }
    h1 { font-size: 26px; color: var(--accent); display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .subtitle { color: var(--muted); margin-bottom: 32px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: 380px 1fr; gap: 24px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { font-size: 16px; margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .clip-item { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.2s; display: flex; justify-content: space-between; align-items: center; }
    .clip-item:hover, .clip-item.active { border-color: var(--accent); background: #271418; }
    .badge { background: #7f1d1d; color: #fca5a5; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .player { font-weight: bold; font-size: 15px; }
    .desc { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .preview-area { background: #080c14; border: 1px solid var(--border); border-radius: 10px; height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; }
    button { background: var(--accent); color: #fff; border: none; font-weight: bold; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 16px; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <h1>⚡ OneShot Allstar Studio <span style="font-size: 14px; background: #1e3a8a; color: #93c5fd; padding: 4px 10px; border-radius: 6px;">Fable 5.1</span></h1>
  <div class="subtitle">Автоматический AI-Observer и генератор вертикальных клипов 9:16 из демок CS2</div>

  <div class="grid">
    <div class="card">
      <h2>📋 Хайлайты матча (-DrestoV1ch)</h2>
      <div id="clipsList">Загрузка...</div>
    </div>
    <div class="card">
      <h2>📱 Предпросмотр клипа (9:16)</h2>
      <div class="preview-area">
        <div style="font-size: 18px; font-weight: bold; color: var(--accent); margin-bottom: 8px;" id="previewTitle">Выберите хайлайт слева</div>
        <div style="font-size: 13px; color: var(--muted); margin-bottom: 20px;" id="previewDesc">Таймкод и детали</div>
        <button id="downloadBtn" onclick="downloadClip()">📥 Скачать клип MP4 (9:16)</button>
      </div>
    </div>
  </div>

  <script>
    let manifest = null;
    let selectedClip = null;

    async function loadManifest() {
      const res = await fetch('/api/manifest');
      manifest = await res.json();
      const list = document.getElementById('clipsList');
      list.innerHTML = '';
      manifest.highlights.forEach((h, idx) => {
        const div = document.createElement('div');
        div.className = 'clip-item' + (idx === 0 ? ' active' : '');
        div.innerHTML = \`
          <div>
            <div class="player">\${h.player} <span class="badge">\${h.type}</span></div>
            <div class="desc">Раунд \${h.round} • Фрагов: \${h.kills}</div>
          </div>
          <div style="font-size: 12px; color: var(--accent); font-weight: bold;">9:16</div>
        \`;
        div.onclick = () => {
          document.querySelectorAll('.clip-item').forEach(i => i.classList.remove('active'));
          div.classList.add('active');
          selectClip(h);
        };
        list.appendChild(div);
      });
      if (manifest.highlights.length > 0) selectClip(manifest.highlights[0]);
    }

    function selectClip(h) {
      selectedClip = h;
      document.getElementById('previewTitle').innerText = \`\${h.player} — \${h.type} (Раунд \${h.round})\`;
      document.getElementById('previewDesc').innerText = h.description;
    }

    function downloadClip() {
      if (!selectedClip) return;
      const filename = \`Vertical_9-16_\${selectedClip.player}_Round\${selectedClip.round}_\${selectedClip.type}.mp4\`;
      window.location.href = \`/api/download/\${filename}\`;
    }

    window.onload = loadManifest;
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(studioHtml);
  } else if (url.pathname === '/api/manifest') {
    const manifest = fs.readFileSync('highlights_manifest.json', 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(manifest);
  } else if (url.pathname.startsWith('/api/download/')) {
    const filename = decodeURIComponent(url.pathname.replace('/api/download/', ''));
    const filePath = path.join(clipsDir, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('File not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 OneShot Allstar Studio (Fable 5.1) запущен на http://127.0.0.1:${PORT}`);
});
