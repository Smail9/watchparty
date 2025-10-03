// server.js — Node.js watch party (Express + WebSocket)
const PORT = process.env.PORT || 8080;
const app = express();


// Sert les fichiers du dossier public (index.html, vidéos, etc.)
app.use(express.static(path.join(__dirname, 'public')));


const server = app.listen(PORT, () => {
console.log(`HTTP server running on http://localhost:${PORT}`);
});


// WebSocket server (chemin /watchparty)
const wss = new WebSocketServer({ server, path: '/watchparty' });


// rooms: Map<roomId, { clients:Set<ws>, state:{ playing:boolean, time:number, updatedAt:number } }>
const rooms = new Map();


function getOrCreateRoom(roomId) {
if (!rooms.has(roomId)) {
rooms.set(roomId, {
clients: new Set(),
state: { playing: false, time: 0, updatedAt: Date.now() }
});
}
return rooms.get(roomId);
}


function broadcast(room, payload, except) {
for (const client of room.clients) {
if (client !== except && client.readyState === 1 /*OPEN*/) {
try { client.send(JSON.stringify(payload)); } catch (_) {}
}
}
}


function applyAction(room, action) {
// action = { type: 'play'|'pause'|'seek'|'syncRequest', time:number }
const now = Date.now();
if (action.type === 'seek') {
room.state.time = action.time || 0;
room.state.updatedAt = now;
} else if (action.type === 'play') {
room.state.playing = true;
room.state.time = action.time || room.state.time;
room.state.updatedAt = now;
} else if (action.type === 'pause') {
room.state.playing = false;
room.state.time = action.time || room.state.time;
room.state.updatedAt = now;
}
}


wss.on('connection', (ws, req) => {
// Récupère le roomId depuis la query (?room=...)
const params = new URLSearchParams(req.url.split('?')[1] || '');
const roomId = params.get('room') || 'default';
const room = getOrCreateRoom(roomId);
room.clients.add(ws);
console.log(`[WS] client joined room: ${roomId} (clients=${room.clients.size})`);


// À la connexion, envoie l'état courant pour se caler
ws.send(JSON.stringify({ type: 'syncState', state: room.state }));


ws.on('message', (raw) => {
let msg;
try { msg = JSON.parse(raw); } catch { return; }


// msg = { type, time }
if (['play', 'pause', 'seek'].includes(msg.type)) {
applyAction(room, msg);
broadcast(room, msg, ws); // réplique aux autres
} else if (msg.type === 'syncRequest') {
ws.send(JSON.stringify({ type: 'syncState', state: room.state }));
}
});


ws.on('close', () => {
room.clients.delete(ws);
if (room.clients.size === 0) {
// Optionnel: nettoyer la room vide au bout d'un délai
setTimeout(() => {
if (room.clients.size === 0) rooms.delete(roomId);
}, 5 * 60 * 1000);
}
console.log(`[WS] client left room: ${roomId} (clients=${room.clients.size})`);
});
});