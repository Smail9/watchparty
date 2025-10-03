// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Servir /public (index.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck (utile pour Render)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});
const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy vers la vidéo distante (HTTP) -> évite le mixed content
app.use('/video-remote', createProxyMiddleware({
  target: 'http://vipvodle.top:8080',
  changeOrigin: true,
  secure: false,
  // on force le chemin de la vidéo
  pathRewrite: () => '/movie/VOD0176173538414492/91735384144872/28620.mp4',
  // on propage l'entête Range pour permettre le seek
  onProxyReq: (proxyReq, req) => {
    const range = req.headers['range'];
    if (range) proxyReq.setHeader('range', range);
  }
}));

// WebSocket sur /watchparty
const wss = new WebSocketServer({ server, path: '/watchparty' });

// Gestion des salles
const rooms = new Map(); // roomId -> { clients:Set<ws>, state:{ playing, time, updatedAt } }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
   // état initial
rooms.set(roomId, {
  clients: new Set(),
  state: { playing: false, time: 0, updatedAt: Date.now(), src: null }
});

// appliquer les actions
function applyAction(room, action) {
  const now = Date.now();
  if (action.type === 'setSource') {
    room.state.src = action.src;     // <= nouvelle source
    room.state.time = 0;
    room.state.updatedAt = now;
    room.state.playing = false;
    return;                           // on diffuse plus bas
  }
  // ... play/pause/seek comme avant
}

// dans wss.on('connection'): après avoir ajouté le client
ws.send(JSON.stringify({ type: 'syncState', state: room.state }));

ws.on('message', raw => {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (['play','pause','seek','setSource'].includes(msg.type)) {
    applyAction(room, msg);
    broadcast(room, msg, ws);
  } else if (msg.type === 'syncRequest') {
    ws.send(JSON.stringify({ type: 'syncState', state: room.state }));
  }
});




