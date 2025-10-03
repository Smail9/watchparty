// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- Statique + healthcheck ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ---------- Proxy fixe: /video-remote (HTTP -> via HTTPS) ---------- */
/* Change seulement le chemin dans pathRewrite si tu veux une autre vidéo par défaut */
app.use(
  '/video-remote',
  createProxyMiddleware({
    target: 'http://vipvodle.top:8080',
    changeOrigin: true,
    secure: false,
    pathRewrite: () =>
      '/movie/VOD0176173538414492/91735384144872/28620.mp4',
    onProxyReq: (proxyReq, req) => {
      const range = req.headers['range'];
      if (range) proxyReq.setHeader('range', range); // seek
      proxyReq.setHeader('user-agent', 'Mozilla/5.0');
      proxyReq.setHeader('referer', 'https://' + req.headers.host + '/');
    },
    onProxyRes: (proxyRes) => {
      // Si le serveur source met octet-stream (ou rien), force un type vidéo
      const ct = proxyRes.headers['content-type'] || '';
      if (!ct || /octet-stream/i.test(ct)) {
        proxyRes.headers['content-type'] = 'video/mp4';
      }
    }
  })
);

/* ---------- Proxy dynamique: /proxy?u=<URL complète> ---------- */
/* Permet d’utiliser n’importe quel lien HTTP/HTTPS dans l’UI */
app.get('/proxy', (req, _res, next) => {              // petit log utile
  console.log('GET /proxy called with u=', req.query.u);
  next();
});
app.use('/proxy', (req, res, next) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');

  let u;
  try { u = new URL(raw); }
  catch { return res.status(400).send('Bad URL'); }

  return createProxyMiddleware({
    target: u.origin,                  // ex: http://vipvodle.top:8080
    changeOrigin: true,
    secure: false,
    pathRewrite: () => u.pathname + u.search,
    onProxyReq: (proxyReq, req) => {
      const range = req.headers['range'];
      if (range) proxyReq.setHeader('range', range);  // pour le seek
      proxyReq.setHeader('user-agent', 'Mozilla/5.0');
      proxyReq.setHeader('referer', 'https://' + req.headers.host + '/');
    },
    onProxyRes: (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      if (!ct || /octet-stream/i.test(ct)) {
        proxyRes.headers['content-type'] = 'video/mp4';
      }
    }
  })(req, res, next);
});

/* ---------- Démarrage HTTP ---------- */
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ---------- WebSocket /watchparty ---------- */
const wss = new WebSocketServer({ server, path: '/watchparty' });

// État par salle : lecture/temps/source
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

function broadcast(room, payload, except /* peut être null */) {
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

  // état complet (inclut src)
  ws.send(JSON.stringify({ type: 'syncState', state: room.state }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setSource') {
      applyAction(room, msg);
      // on notifie TOUT LE MONDE (y compris l'émetteur) pour refléter la nouvelle source
      broadcast(room, msg, null);
      return;
    }

    if (['play','pause','seek'].includes(msg.type)) {
      applyAction(room, msg);
      // pour play/pause/seek on exclut l'émetteur
      broadcast(room, msg, ws);
    } else if (msg.type === 'syncRequest') {
      ws.send(JSON.stringify({ type: 'syncState', state: room.state }));
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomId); }, 5*60*1000);
    }
  });
});
