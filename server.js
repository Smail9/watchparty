// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- helpers ---------- */

function addCommonHeaders(proxyReq, refererOrigin, req) {
  const range = req.headers['range'];
  if (range) proxyReq.setHeader('range', range);  // seek
  proxyReq.setHeader('user-agent', req.headers['user-agent'] || 'Mozilla/5.0');
  if (refererOrigin) {
    proxyReq.setHeader('referer', refererOrigin.endsWith('/') ? refererOrigin : refererOrigin + '/');
  }
}

// Réécriture 30x : on *écrase* le Location dans proxyRes **et** dans res
function rewriteRedirectToProxy(proxyRes, req, res, baseOrigin) {
  const sc = proxyRes.statusCode || 0;
  if (![301,302,303,307,308].includes(sc)) return;

  const loc = proxyRes.headers['location'];
  if (!loc) return;

  try {
    const abs = new URL(loc, baseOrigin); // relative -> absolute
    const proxied = '/proxy?u=' + encodeURIComponent(abs.toString());

    // 1) muter le header sur la réponse upstream
    proxyRes.headers['location'] = proxied;

    // 2) s’assurer que le header envoyé au client est celui-ci
    try { res.setHeader('location', proxied); } catch {}

    // Parfois utile aussi :
    res.statusCode = sc; // préserver le code (sinon Express peut forcer 200)
  } catch {
    // noop
  }
}

function ensureVideoContentType(proxyRes) {
  const ct = proxyRes.headers['content-type'] || '';
  if (!ct || /octet-stream/i.test(ct)) {
    proxyRes.headers['content-type'] = 'video/mp4';
  }
}

/* ---------- statique + healthcheck ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ---------- /video-remote (URL fixe) ---------- */
const FIXED_ORIGIN = 'http://vipvodle.top:8080';
const FIXED_PATH   = '/movie/VOD0176173538414492/91735384144872/28620.mp4';

app.use(
  '/video-remote',
  createProxyMiddleware({
    target: FIXED_ORIGIN,
    changeOrigin: true,
    secure: false,
    pathRewrite: () => FIXED_PATH,
    onProxyReq: (proxyReq, req) => addCommonHeaders(proxyReq, FIXED_ORIGIN, req),
    onProxyRes: (proxyRes, req, res) => {
      rewriteRedirectToProxy(proxyRes, req, res, FIXED_ORIGIN);
      ensureVideoContentType(proxyRes);
    },
    followRedirects: false
  })
);

/* ---------- /proxy?u=<URL> (dynamique) ---------- */
app.get('/proxy', (req, _res, next) => {
  console.log('GET /proxy called with u=', req.query.u);
  next();
});

app.use('/proxy', (req, res, next) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');

  let targetURL;
  try { targetURL = new URL(raw); }
  catch { return res.status(400).send('Bad URL'); }

  const targetOrigin = targetURL.origin;
  const targetPathQS = targetURL.pathname + targetURL.search;

  return createProxyMiddleware({
    target: targetOrigin,
    changeOrigin: true,
    secure: false,
    pathRewrite: () => targetPathQS,
    onProxyReq: (proxyReq, req) => addCommonHeaders(proxyReq, targetOrigin, req),
    onProxyRes: (proxyRes, req, res) => {
      rewriteRedirectToProxy(proxyRes, req, res, targetOrigin);
      ensureVideoContentType(proxyRes);
    },
    followRedirects: false
  })(req, res, next);
});

/* ---------- serveur HTTP ---------- */
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ---------- WebSocket /watchparty ---------- */
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

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setSource') {
      applyAction(room, msg);
      broadcast(room, msg, null);
      return;
    }

    if (['play','pause','seek'].includes(msg.type)) {
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
