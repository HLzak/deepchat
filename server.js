const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'deepchat-data.json');

const DEFAULT_CODES = {
  'DEEP-DEV-9K2X-7M3P': { name: 'Разработчик', isAdmin: true,  color: '#2AABEE', username: 'admin' },
  'DEEP-USR-4F8N-2Q6R': { name: 'Пользователь 1', isAdmin: false, color: '#7bc862', username: 'user1' },
  'DEEP-USR-7T3W-5Y1C': { name: 'Пользователь 2', isAdmin: false, color: '#e17076', username: 'user2' }
};

let state = { users: {}, messages: [], sessions: {}, codes: {}, channels: {} };

function loadState(){
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e){}
  if(!state.codes || Object.keys(state.codes).length === 0){
    for(const [code, info] of Object.entries(DEFAULT_CODES)){
      state.codes[code] = { ...info, createdAt: Date.now(), banned: false };
    }
  }
  if(!state.channels) state.channels = {};
  // Автомиграция для старых пользователей
  for(const [code, u] of Object.entries(state.users || {})){
    if(!u.username){
      const base = (u.name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0,10) || 'user';
      let un = base, i = 1;
      while(Object.values(state.users).some(x => x.username === un)) { un = base + i++; }
      u.username = un;
    }
  }
  saveState();
}
function saveState(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch(e){}
}
loadState();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const RANDOM_COLORS = ['#2AABEE','#7bc862','#e17076','#65aadd','#a695e7','#ee7aae','#ffb84d','#4dc9b0'];

app.post('/api/login', (req, res) => {
  const { code } = req.body || {};
  if(!code || !state.codes[code]) return res.json({ ok: false, error: 'Неверный код' });
  const c = state.codes[code];
  if(c.banned) return res.json({ ok: false, error: 'Код заблокирован' });
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = code;
  if(!state.users[code]){
    state.users[code] = { code, name: c.name, username: c.username || 'user'+Math.floor(Math.random()*1000), color: c.color, isAdmin: c.isAdmin, createdAt: Date.now(), lastSeen: Date.now() };
  }
  state.users[code].lastSeen = Date.now();
  saveState();
  res.json({ ok: true, token, user: state.users[code] });
});

function auth(req, res, next){
  const token = req.headers['x-token'];
  if(!token || !state.sessions[token]) return res.status(401).json({ ok: false });
  req.code = state.sessions[token];
  next();
}

app.get('/api/users', auth, (req, res) => {
  const list = Object.values(state.users).map(u => ({
    code: u.code, name: u.name, username: u.username, color: u.color, isAdmin: u.isAdmin,
    online: isOnline(u.code), lastSeen: u.lastSeen
  }));
  res.json({ ok: true, users: list, me: state.users[req.code], channels: Object.values(state.channels) });
});

app.get('/api/messages/:withCode', auth, (req, res) => {
  const me = req.code, other = req.params.withCode;
  const msgs = state.messages.filter(m =>
    (m.from === me && m.to === other) || (m.from === other && m.to === me)
  ).slice(-500);
  res.json({ ok: true, messages: msgs });
});

app.post('/api/profile', auth, (req, res) => {
  const u = state.users[req.code];
  if(!u) return res.status(404).json({ ok:false });
  const { name, color, username } = req.body || {};
  if(name && String(name).trim().length > 0 && name.length <= 40) u.name = String(name).trim();
  if(color && /^#[0-9a-f]{6}$/i.test(color)) u.color = color;
  if(username && /^[a-zA-Z0-9_]{3,20}$/.test(username)){
    const exists = Object.values(state.users).some(x => x.code !== req.code && x.username === username);
    if(exists) return res.json({ ok: false, error: 'Юзернейм занят' });
    u.username = username;
  }
  saveState();
  broadcast({ type: 'user_update', user: u });
  res.json({ ok: true, user: u });
});

app.post('/api/logout', auth, (req, res) => {
  delete state.sessions[req.headers['x-token']];
  saveState();
  res.json({ ok: true });
});

// --- Admin ---
app.get('/api/admin/codes', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  res.json({ ok: true, codes: state.codes, users: state.users, messageCount: state.messages.length, channels: Object.values(state.channels) });
});

app.post('/api/admin/codes', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { name, isAdmin } = req.body || {};
  const code = 'DEEP-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  const username = 'user' + crypto.randomBytes(2).toString('hex');
  state.codes[code] = { name: name || 'Новый', isAdmin: !!isAdmin, color: RANDOM_COLORS[Math.floor(Math.random()*RANDOM_COLORS.length)], username, createdAt: Date.now(), banned: false };
  saveState();
  res.json({ ok: true, code });
});

app.post('/api/admin/ban', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { code, banned } = req.body || {};
  if(state.codes[code]) { state.codes[code].banned = !!banned; saveState(); }
  res.json({ ok: true });
});

app.post('/api/admin/delete', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { code } = req.body || {};
  if(code === req.code) return res.json({ ok: false, error: 'Нельзя удалить свой код' });
  delete state.codes[code];
  delete state.users[code];
  for(const [t, c] of Object.entries(state.sessions)) if(c === code) delete state.sessions[t];
  saveState();
  res.json({ ok: true });
});

app.post('/api/admin/channels', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { name } = req.body || {};
  if(!name) return res.status(400).json({ ok:false });
  const id = 'CH_' + crypto.randomBytes(2).toString('hex').toUpperCase();
  state.channels[id] = { id, name, createdAt: Date.now() };
  saveState();
  broadcast({ type: 'channels_update', channels: Object.values(state.channels) });
  res.json({ ok: true, channel: state.channels[id] });
});

app.post('/api/admin/clear', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  state.messages = [];
  saveState();
  res.json({ ok: true });
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map();

function isOnline(code){
  for(const c of clients.values()) if(c === code) return true;
  return false;
}
function broadcast(obj){
  const str = JSON.stringify(obj);
  for(const ws of clients.keys()) if(ws.readyState === 1) ws.send(str);
}

wss.on('connection', (ws) => {
  let code = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e){ return; }
    if(msg.type === 'auth'){
      if(!state.sessions[msg.token]) { ws.close(); return; }
      code = state.sessions[msg.token];
      clients.set(ws, code);
      broadcast({ type: 'presence', code, online: true });
      return;
    }
    if(!code) return;
    if(msg.type === 'send'){
      const { to, text } = msg;
      if(!to || !text || String(text).length > 4000) return;

      if(state.channels[to]){
        if(!state.users[code]?.isAdmin) return;
        const m = { id: crypto.randomBytes(8).toString('hex'), from: code, to, text: String(text), t: Date.now() };
        state.messages.push(m);
        saveState();
        const payload = JSON.stringify({ type: 'message', message: m });
        for(const ws2 of clients.keys()) if(ws2.readyState === 1) ws2.send(payload);
        return;
      }

      if(!state.users[to]) return;
      const m = { id: crypto.randomBytes(8).toString('hex'), from: code, to, text: String(text), t: Date.now() };
      state.messages.push(m);
      if(state.messages.length > 20000) state.messages = state.messages.slice(-10000);
      saveState();
      const payload = JSON.stringify({ type: 'message', message: m });
      for(const [ws2, c2] of clients.entries()){
        if((c2 === code || c2 === to) && ws2.readyState === 1) ws2.send(payload);
      }
    }
    if(msg.type === 'typing'){
      const payload = JSON.stringify({ type: 'typing', from: code, to: msg.to });
      for(const [ws2, c2] of clients.entries()){
        if(c2 === msg.to && ws2.readyState === 1) ws2.send(payload);
      }
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    if(code){ broadcast({ type: 'presence', code, online: false }); if(state.users[code]) state.users[code].lastSeen = Date.now(); }
  });
});

server.listen(PORT, () => console.log('DeepCHAT on port ' + PORT));
