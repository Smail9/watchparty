// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch'); // v2.x

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- Statique + healthcheck ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ---------- Proxy générique /proxy?u=... ---------- */
app.use('/proxy', (req, res, next) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');
  let u; try { u = new URL(raw); } catch { return res.status(400).send('Bad URL'); }

  return createProxyMiddleware({
    target: u.origin,
    changeOrigin: true,
    secure: false,
    followRedirects: true,
    pathRewrite: () => u.pathname + u.search,
    onProxyReq: (proxyReq, req) => {
      const range = req.headers['range'];
      if (range) proxyReq.setHeader('range', range);
      proxyReq.setHeader('user-agent', req.headers['user-agent'] || 'Mozilla/5.0');
      proxyReq.setHeader('referer', 'https://' + req.headers.host + '/');
    },
  })(req, res, next);
});

/* ---------- HLS helper: /hls-avc?u=master.m3u8
   Récupère la master playlist et redirige vers la sous-playlist H.264 (avc1)
   S'il n'y a pas de STREAM-INF (donc url déjà variante), on renvoie vers /proxy?u=... tel quel. ---------- */
app.get('/hls-avc', async (req, res) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');
  let masterUrl; try { masterUrl = new URL(raw); } catch { return res.status(400).send('Bad URL'); }

  try {
    const r = await fetch(masterUrl.toString(), {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept': 'application/vnd.apple.mpegurl,text/plain;q=0.9,*/*;q=0.8',
        'referer': 'https://' + req.headers.host + '/'
      },
    });
    if (!r.ok) return res.status(502).send('Upstream error ' + r.status);
    const text = await r.text();

    if (!/^#EXTM3U/m.test(text)) {
      // Pas une playlist HLS; renvoyer tel quel via proxy
      return res.redirect(302, '/proxy?u=' + encodeURIComponent(masterUrl.toString()));
    }

    // Cherche des lignes STREAM-INF -> prend une avec avc1 si possible
    const lines = text.split(/\r?\n/);
    let bestAvc = null;
    let bestAvcHeight = -1;

    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.startsWith('#EXT-X-STREAM-INF')) {
        const codecsMatch = /CODECS="([^"]+)"/i.exec(L);
        const resMatch = /RESOLUTION=\s*(\d+)x(\d+)/i.exec(L);
        const next = (i + 1 < lines.length) ? lines[i + 1].trim() : null;

        if (next && !next.startsWith('#')) {
          const isAvc = codecsMatch && codecsMatch[1].toLowerCase().includes('avc1');
          const height = resMatch ? parseInt(resMatch[1] ? resMatch[2] : resMatch[1], 10) : 0;
          if (isAvc) {
            if (height > bestAvcHeight) {
              bestAvcHeight = height;
              bestAvc = new URL(next, masterUrl).toString();
            }
          }
        }
      }
    }

    if (bestAvc) {
      return res.redirect(302, '/proxy?u=' + encodeURIComponent(bestAvc));
    } else {
      // pas de STREAM-INF (variante) OU pas de avc1
      // si pas de STREAM-INF, c’est une sous-playlist -> on la sert telle quelle via proxy
      const hasStreamInf = /#EXT-X-STREAM-INF/i.test(text);
      if (!hasStreamInf) {
        return res.redirect(302, '/proxy?u=' + encodeURIComponent(masterUrl.toString()));
      }
      // master sans avc1 -> pas compatible
      return res.status(406).send('no_avc_variant'); // le front affichera un message clair
    }
  } catch (e) {
    console.error('[hls-avc] error', e);
    return res.status(500).send('hls_avc_error');
  }
});

/* ---------- Conversion simple TS -> "faux" HLS ---------- */
app.get('/ts2m3u8', (req, res) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');
  let abs; try { abs = new URL(raw); } catch { return res.status(400).send('Bad URL'); }
  const prox = '/proxy?u=' + encodeURIComponent(abs.toString());
  const body = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXTINF:9.99,`,
    prox,
    '#EXT-X-ENDLIST'
  ].join('\n');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(body);
});

/* ---------- WebSocket /watchparty ---------- */
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/watchparty' });
const rooms = new Map(); // roomId -> { clients:Set<ws>, state:{ playing, time, updatedAt, src } }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      state: { playing: false, time: 0, updatedAt: Date.now(), src: null },
    });
  }
  return rooms.get(roomId);
}
function broadcast(room, payload, except) {
  for (const client of room.clients) {
    if (client.readyState !== 1) continue;
    if (except && client === except) continue;
    try { client.send(JSON.stringify(payload)); } catch {}
  }
}
function applyAction(room, action) {
  const now = Date.now();
  if (action.type === 'setSource') {
    room.state.src = action.src || null;
    room.state.time = 0;
    room.state.playing = false;
    room.state.updatedAt = now;
    return;
  }
  if (action.type === 'seek') {
    room.state.time = action.time || 0;
    room.state.updatedAt = now;
  } else if (action.type === 'play') {
    room.state.playing = true;
    room.state.time = action.time ?? room.state.time;
    room.state.updatedAt = now;
  } else if (action.type === 'pause') {
    room.state.playing = false;
    room.state.time = action.time ?? room.state.time;
    room.state.updatedAt = now;
  }
}
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const roomId = params.get('room') || 'default';
  const room = getOrCreateRoom(roomId);
  room.clients.add(ws);

  ws.send(JSON.stringify({ type: 'syncState', state: room.state }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'setSource') {
      applyAction(room, msg);
      broadcast(room, msg, null);
    } else if (['play','pause','seek'].includes(msg.type)) {
      applyAction(room, msg);
      broadcast(room, msg, ws);
    } else if (msg.type === 'syncRequest') {
      ws.send(JSON.stringify({ type: 'syncState', state: room.state }));
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomId); }, 5 * 60 * 1000);
    }
  });
});
