// server.js — Watch Party (Express + WebSocket, CommonJS)
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

/* ----------------- Helpers proxy ----------------- */
function addCommonHeaders(proxyReq, refererOrigin, req) {
  const range = req.headers['range'];
  if (range) proxyReq.setHeader('range', range);      // autoriser le seek
  proxyReq.setHeader('user-agent', req.headers['user-agent'] || 'Mozilla/5.0');
  if (refererOrigin) {
    proxyReq.setHeader('referer', refererOrigin.endsWith('/') ? refererOrigin : refererOrigin + '/');
  }
}

// Détermine et force un Content-Type cohérent (utile quand upstream renvoie octet-stream)
function ensureContentType(req, proxyRes, fallback = 'video/mp4') {
  const current = (proxyRes.headers['content-type'] || '').toLowerCase();
  if (current && !/octet-stream/.test(current)) return; // déjà correct

  // On essaye d’inférer depuis l’URL
  let pathname = '';
  try {
    if (req.path === '/proxy' && req.query.u) pathname = new URL(req.query.u).pathname;
    else if (req.path === '/video-remote') pathname = FIXED_PATH;
  } catch {}

  let ct = fallback;
  if (pathname.endsWith('.m3u8')) ct = 'application/vnd.apple.mpegurl';
  else if (pathname.endsWith('.ts')) ct = 'video/mp2t';
  else if (pathname.endsWith('.mp4')) ct = 'video/mp4';

  proxyRes.headers['content-type'] = ct;
}

/* ----------------- Statique + santé ----------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ----------------- /video-remote : URL fixe (exemple) ----------------- */
const FIXED_ORIGIN = 'http://vipvodle.top:8080';
const FIXED_PATH   = '/movie/VOD0176173538414492/91735384144872/28620.mp4';

app.use(
  '/video-remote',
  createProxyMiddleware({
    target: FIXED_ORIGIN,
    changeOrigin: true,
    secure: false,
    followRedirects: true,                      // suit 302 côté serveur
    pathRewrite: () => FIXED_PATH,
    onProxyReq: (proxyReq, req) => addCommonHeaders(proxyReq, FIXED_ORIGIN, req),
    onProxyRes: (proxyRes, req) => ensureContentType(req, proxyRes, 'video/mp4'),
  })
);

/* ----------------- /proxy?u=<URL> : proxy dynamique ----------------- */
app.get('/proxy', (req, _res, next) => { console.log('GET /proxy u=', req.query.u); next(); });

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
    followRedirects: true,                      // suit 302 côté serveur (tokens, etc.)
    pathRewrite: () => targetPathQS,
    onProxyReq: (proxyReq, req) => addCommonHeaders(proxyReq, targetOrigin, req),
    onProxyRes: (proxyRes, req) => ensureContentType(req, proxyRes, 'video/mp4'),
  })(req, res, next);
});

/* ----------------- /ts2m3u8?u=<URL.ts> : wrapper HLS pour .ts isolé ----------------- */
app.get('/ts2m3u8', (req, res) => {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('Missing u');
  let tsURL;
  try { tsURL = new URL(raw); }
  catch { return res.status(400).send('Bad URL'); }

  // On fait passer le segment .ts par le proxy (pour HTTPS, CORS, Range, etc.)
  const proxiedTs = '/proxy?u=' + encodeURIComponent(tsURL.toString());

  // Mini manifeste HLS "1 segment" — durée approximative (60s ici).
  // Ça suffit pour que hls.js lise un .ts isolé.
  const m3u8 =
`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:60.0,
${proxiedTs}
#EXT-X-ENDLIST
`;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(m3u8);
});

/* ----------------- HTTP server ----------------- */
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ----------------- WebSocket /watchparty ----------------- */
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
  for (const c of room.clients) {
    if (c.readyState !== 1) continue;
    if (except && c === except) continue;
    try { c.send(JSON.stringify(payload)); } catch {}
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
  if (action.type === 'seek') { room.state.time = action.time || 0; room.state.updatedAt = now; }
  else if (action.type === 'play') { room.state.playing = true; room.state.time = action.time ?? room.state.time; room.state.updatedAt = now; }
  else if (action.type === 'pause') { room.state.playing = false; room.state.time = action.time ?? room.state.time; room.state.updatedAt = now; }
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const roomId = params.get('room') || 'default';
  const room = getOrCreateRoom(roomId);
  room.clients.add(ws);

  ws.send(JSON.stringify({ type: 'syncState', state: room.state }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setSource') { applyAction(room, msg); broadcast(room, msg, null); return; }
    if (['play','pause','seek'].includes(msg.type)) { applyAction(room, msg); broadcast(room, msg, ws); }
    else if (msg.type === 'syncRequest') { ws.send(JSON.stringify({ type: 'syncState', state: room.state })); }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomId); }, 5*60*1000);
    }
  });
});
