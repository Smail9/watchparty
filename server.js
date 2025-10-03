// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- Contenu statique + healthcheck ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ---------- Proxy HTTPS -> HTTP (évite mixed content) ---------- */
/* Si tu veux toujours utiliser l’URL http://vipvodle.top:8080/... */
app.use(
  '/video-remote',
  createProxyMiddleware({
    target: 'http://vipvodle.top:8080',
    changeOrigin: true,
    secure: false,
    // chemin exact de ta vidéo distante :
    pathRewrite: () =>
      '/movie/VOD0176173538414492/91735384144872/28620.mp4',
    // support du Range pour le seek :
    onProxyReq: (proxyReq, req) => {
      const range = req.headers['range'];
      if (range) proxyReq.setHeader('range', range);
      // certains serveurs aiment avoir un UA/Referer :
      proxyReq.setHeader('user-agent', 'Mozilla/5.0');
      proxyReq.setHeader('referer', 'https://watchparty-2.onrender.com/');
    },
  })
);

/* ---------- Démarrage HTTP ---------- */
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ---------- WebSocket /watchparty ---------- */
const wss = new WebSocketServer({ server, path: '/watchparty' });

/** État par salle : lecture/temps/source */
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
    if (client !== except && client.readyState === 1) {
      try { client.send(JSON.stringify(payload)); } catch {}
    }
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
    if (['play','pause','seek','setSource'].includes(msg.type)) {
      applyAction(room, msg);
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
