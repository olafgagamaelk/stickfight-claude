"use strict";
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Room, TICK_DT } = require('./game.js');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(PORT, () => console.log('STIKKAOS server kører på port ' + PORT));
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  room.order.forEach(id => {
    const p = room.players.get(id);
    if (p && p._ws && p._ws.readyState === 1) p._ws.send(msg);
  });
}
function lobbyPayload(room) {
  return {
    t: 'lobby', code: room.code,
    players: room.order.map(id => { const p = room.players.get(id); return p && { id: p.id, name: p.name, color: p.color, ready: p.ready, connected: p.connected }; }).filter(Boolean)
  };
}

wss.on('connection', (ws) => {
  let room = null, playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.t === 'create') {
      const code = makeCode();
      room = new Room(code);
      room.public = msg.public !== false;
      rooms.set(code, room);
      const p = room.addPlayer(cryptoId(), (msg.name || '').trim());
      p._ws = ws; playerId = p.id;
      send(ws, { t: 'joined', id: p.id, code, you: p.idx });
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.t === 'listRooms') {
      const list = [];
      rooms.forEach(r => {
        if (r.public && r.state === 'LOBBY' && r.connectedCount() > 0 && r.connectedCount() < 4) {
          const host = r.players.get(r.order[0]);
          list.push({ code: r.code, host: host ? host.name : '?', count: r.connectedCount() });
        }
      });
      send(ws, { t: 'roomList', rooms: list });
      return;
    }

    if (msg.t === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', message: 'Ingen server fundet med den kode.' }); room = null; return; }
      if (room.state !== 'LOBBY') { send(ws, { t: 'error', message: 'Kampen er allerede i gang.' }); room = null; return; }
      if (room.connectedCount() >= 4) { send(ws, { t: 'error', message: 'Rummet er fuldt (max 4 spillere).' }); room = null; return; }
      const p = room.addPlayer(cryptoId(), (msg.name || '').trim());
      p._ws = ws; playerId = p.id;
      send(ws, { t: 'joined', id: p.id, code, you: p.idx });
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player) return;

    if (msg.t === 'ready') {
      player.ready = !!msg.ready;
      broadcast(room, lobbyPayload(room));
    } else if (msg.t === 'start') {
      const readyCount = room.order.filter(id => room.players.get(id) && room.players.get(id).ready).length;
      if (room.state === 'LOBBY' && room.order[0] === playerId && room.connectedCount() >= 2 && readyCount === room.connectedCount()) {
        room.startMatch();
      }
    } else if (msg.t === 'input') {
      player.input.left = !!msg.left; player.input.right = !!msg.right;
      player.input.jump = !!msg.jump; player.input.down = !!msg.down; player.input.attack = !!msg.attack;
    } else if (msg.t === 'continue') {
      if (room.state === 'SCOREBOARD') { room.resetRound(); room.state = 'COUNTDOWN'; room.stateTimer = 3.0; }
      else if (room.state === 'MATCHEND') { room.startMatch(); }
    } else if (msg.t === 'leave') {
      room.removePlayer(playerId);
      broadcast(room, lobbyPayload(room));
    }
  });

  ws.on('close', () => {
    if (room && playerId) {
      room.removePlayer(playerId);
      if (room.state === 'LOBBY') broadcast(room, lobbyPayload(room));
      if (room.connectedCount() === 0) rooms.delete(room.code);
    }
  });
});

// heartbeat to drop dead sockets
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 20000);

function cryptoId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

// fixed-tick simulation + broadcast loop, independent per room
setInterval(() => {
  rooms.forEach(room => {
    if (room.state === 'FIGHT' || room.state === 'COUNTDOWN' || room.state === 'ROUNDEND') {
      room.tick(TICK_DT);
      broadcast(room, { t: 'state', snap: room.snapshot(), events: room.events });
    }
  });
}, TICK_DT * 1000);

// clean up empty/stale rooms periodically
setInterval(() => {
  rooms.forEach((room, code) => { if (room.connectedCount() === 0) rooms.delete(code); });
}, 60000);
