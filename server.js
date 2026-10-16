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

const GIFTS = [
  { id:'rose',    emoji:'🌹', name:'Роза',   price:5   },
  { id:'heart',   emoji:'❤️', name:'Сердце',  price:10  },
  { id:'cake',    emoji:'🎂', name:'Торт',    price:25  },
  { id:'bear',    emoji:'🧸', name:'Мишка',   price:50  },
  { id:'ring',    emoji:'💍', name:'Кольцо',  price:100 },
  { id:'rocket',  emoji:'🚀', name:'Ракета',  price:150 },
  { id:'diamond', emoji:'💎', name:'Алмаз',   price:250 },
  { id:'crown',   emoji:'👑', name:'Корона',  price:500 },
  { id:'trophy',  emoji:'🏆', name:'Кубок',   price:750 },
  { id:'star',    emoji:'⭐', name:'Звезда',  price:1000}
];

let state = { users: {}, messages: [], sessions: {}, codes: {}, chats: {}, gifts: [] };

function generatePhone(){
  let n = '';
  for(let i=0;i<8;i++) n += Math.floor(Math.random()*10);
  return '+888 ' + n.slice(0,4) + ' ' + n.slice(4,8);
}

const RANDOM_COLORS = ['#2AABEE','#7bc862','#e17076','#65aadd','#a695e7','#ee7aae','#ffb84d','#4dc9b0'];

function ensureUser(code){
  if(state.users[code]) return state.users[code];
  const c = state.codes[code];
  if(!c) return null;
  let un = c.username || 'user' + code.slice(-4).toLowerCase();
  while(Object.values(state.users).some(x => x.username === un && x.code !== code)) un = un + '1';
  state.users[code] = {
    code, name: c.name || 'Пользователь', username: un,
    color: c.color || RANDOM_COLORS[Math.floor(Math.random()*RANDOM_COLORS.length)],
    avatar: null, phone: generatePhone(),
    isAdmin: !!c.isAdmin, stars: c.isAdmin ? 'inf' : 0,
    createdAt: Date.now(), lastSeen: 0
  };
  return state.users[code];
}

function loadState(){
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e){}
  if(!state.codes || Object.keys(state.codes).length === 0){
    for(const [code, info] of Object.entries(DEFAULT_CODES)){
      state.codes[code] = { ...info, createdAt: Date.now(), banned: false };
    }
  }
  if(!state.chats) state.chats = {};
  if(!state.messages) state.messages = [];
  if(!state.users) state.users = {};
  if(!state.gifts) state.gifts = [];

  // КЛЮЧЕВОЕ: создаём профиль для КАЖДОГО кода сразу
  for(const code of Object.keys(state.codes)){
    ensureUser(code);
  }
  saveState();
}
function saveState(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch(e){}
}
loadState();

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { code } = req.body || {};
  if(!code || !state.codes[code]) return res.json({ ok: false, error: 'Неверный код' });
  const c = state.codes[code];
  if(c.banned) return res.json({ ok: false, error: 'Код заблокирован' });
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = code;
  const u = ensureUser(code);
  u.lastSeen = Date.now();
  saveState();
  res.json({ ok: true, token, user: u, gifts: GIFTS });
});

function auth(req, res, next){
  const token = req.headers['x-token'];
  if(!token || !state.sessions[token]) return res.status(401).json({ ok: false });
  req.code = state.sessions[token];
  next();
}

function isOnline(code){
  for(const c of clients.values()) if(c === code) return true;
  return false;
}

function myChats(code){
  return Object.values(state.chats).filter(c => {
    if(c.type === 'channel') return true;
    return c.creator === code || (c.members || []).includes(code);
  });
}

app.get('/api/users', auth, (req, res) => {
  const list = Object.values(state.users).map(u => ({
    code: u.code, name: u.name, username: u.username, color: u.color, avatar: u.avatar,
    isAdmin: u.isAdmin, phone: u.phone, stars: u.stars,
    online: isOnline(u.code), lastSeen: u.lastSeen
  }));
  res.json({ ok: true, users: list, me: state.users[req.code], chats: myChats(req.code), gifts: GIFTS });
});

app.get('/api/messages/:withId', auth, (req, res) => {
  const me = req.code, other = req.params.withId;
  if(state.chats[other]){
    const ch = state.chats[other];
    if(ch.type === 'group' && ch.creator !== me && !(ch.members||[]).includes(me)) return res.status(403).json({ ok: false });
    return res.json({ ok: true, messages: state.messages.filter(m => m.to === other).slice(-500) });
  }
  return res.json({ ok: true, messages: state.messages.filter(m =>
    (m.from === me && m.to === other) || (m.from === other && m.to === me)
  ).slice(-500) });
});

app.post('/api/profile', auth, (req, res) => {
  const u = state.users[req.code];
  if(!u) return res.status(404).json({ ok:false });
  const { name, color, username, avatar } = req.body || {};
  if(name && String(name).trim().length > 0 && name.length <= 40) u.name = String(name).trim();
  if(color && /^#[0-9a-f]{6}$/i.test(color)) u.color = color;
  if(avatar !== undefined){
    if(avatar === null) u.avatar = null;
    else if(typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length < 80000) u.avatar = avatar;
  }
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

// --- Gifts ---
app.post('/api/gifts/send', auth, (req, res) => {
  const { to, giftId } = req.body || {};
  const from = state.users[req.code], toUser = state.users[to];
  const gift = GIFTS.find(g => g.id === giftId);
  if(!gift || !toUser) return res.json({ ok: false, error: 'Неверный подарок' });
  if(from.stars !== 'inf' && from.stars < gift.price) return res.json({ ok: false, error: 'Недостаточно звёзд' });
  if(from.stars !== 'inf') from.stars -= gift.price;
  state.gifts.push({ id: crypto.randomBytes(6).toString('hex'), giftId, from: req.code, to, t: Date.now() });
  const m = { id: crypto.randomBytes(8).toString('hex'), from: req.code, to, type: 'gift', gift, t: Date.now() };
  state.messages.push(m);
  saveState();
  const payload = JSON.stringify({ type: 'message', message: m });
  for(const [ws2, c2] of clients.entries()){
    if((c2 === req.code || c2 === to) && ws2.readyState === 1) ws2.send(payload);
  }
  broadcast({ type: 'user_update', user: from });
  broadcast({ type: 'user_update', user: toUser });
  res.json({ ok: true, user: from });
});

app.get('/api/gifts/:code', auth, (req, res) => {
  res.json({ ok: true, gifts: state.gifts.filter(g => g.to === req.params.code).map(g => ({ ...g, gift: GIFTS.find(x => x.id === g.giftId) })) });
});

// --- Admin ---
app.get('/api/admin/codes', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  res.json({ ok: true, codes: state.codes, users: state.users, messageCount: state.messages.length, chats: Object.values(state.chats), giftsCount: state.gifts.length });
});

app.post('/api/admin/codes', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { name, isAdmin } = req.body || {};
  const code = 'DEEP-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  const username = 'user' + crypto.randomBytes(2).toString('hex');
  state.codes[code] = { name: name || 'Новый', isAdmin: !!isAdmin, color: RANDOM_COLORS[Math.floor(Math.random()*RANDOM_COLORS.length)], username, createdAt: Date.now(), banned: false };
  ensureUser(code); // сразу создаём профиль
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
  delete state.codes[code]; delete state.users[code];
  for(const [t, c] of Object.entries(state.sessions)) if(c === code) delete state.sessions[t];
  saveState();
  res.json({ ok: true });
});

app.post('/api/admin/stars', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  const { code, amount } = req.body || {};
  const u = state.users[code];
  if(!u) return res.json({ ok: false });
  u.stars = Math.max(0, (u.stars === 'inf' ? 0 : u.stars) + Number(amount || 0));
  saveState();
  broadcast({ type: 'user_update', user: u });
  res.json({ ok: true, user: u });
});

app.post('/api/admin/clear', auth, (req, res) => {
  if(!state.users[req.code]?.isAdmin) return res.status(403).json({ ok:false });
  state.messages = [];
  saveState();
  res.json({ ok: true });
});

// --- Chats ---
app.post('/api/chats', auth, (req, res) => {
  const { type, name, avatar, members } = req.body || {};
  if(!name || !name.trim()) return res.json({ ok: false, error: 'Введите название' });
  if(type !== 'channel' && type !== 'group') return res.json({ ok: false, error: 'Неверный тип' });
  const id = (type === 'channel' ? 'CH_' : 'GR_') + crypto.randomBytes(2).toString('hex').toUpperCase();
  const chat = { id, name: name.trim().slice(0, 50), type, creator: req.code,
    members: type === 'group' ? Array.from(new Set([req.code, ...(members||[])])) : [],
    avatar: (avatar && avatar.startsWith('data:image/') && avatar.length < 80000) ? avatar : null,
    createdAt: Date.now() };
  state.chats[id] = chat;
  saveState();
  broadcast({ type: 'chats_changed' });
  res.json({ ok: true, chat });
});

app.post('/api/chats/:id/update', auth, (req, res) => {
  const ch = state.chats[req.params.id];
  if(!ch) return res.json({ ok: false });
  if(ch.creator !== req.code && !state.users[req.code]?.isAdmin) return res.json({ ok: false, error: 'Нет доступа' });
  const { name, avatar, members } = req.body || {};
  if(name && name.trim()) ch.name = name.trim().slice(0, 50);
  if(avatar !== undefined){
    if(avatar === null) ch.avatar = null;
    else if(typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length < 80000) ch.avatar = avatar;
  }
  if(members && ch.type === 'group') ch.members = Array.from(new Set([ch.creator, ...members]));
  saveState(); broadcast({ type: 'chats_changed' });
  res.json({ ok: true, chat: ch });
});

app.post('/api/chats/:id/leave', auth, (req, res) => {
  const ch = state.chats[req.params.id];
  if(!ch || ch.type !== 'group') return res.json({ ok: false });
  if(ch.creator === req.code) return res.json({ ok: false, error: 'Создатель не может выйти' });
  ch.members = (ch.members || []).filter(c => c !== req.code);
  saveState(); broadcast({ type: 'chats_changed' });
  res.json({ ok: true });
});

app.delete('/api/chats/:id', auth, (req, res) => {
  const ch = state.chats[req.params.id];
  if(!ch) return res.json({ ok: false });
  if(ch.creator !== req.code && !state.users[req.code]?.isAdmin) return res.json({ ok: false, error: 'Нет доступа' });
  delete state.chats[req.params.id];
  state.messages = state.messages.filter(m => m.to !== req.params.id);
  saveState(); broadcast({ type: 'chats_changed' });
  res.json({ ok: true });
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });
const clients = new Map();

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
      const { to, text, media, mediaType, duration } = msg;
      if(!to) return;
      if(media && (typeof media !== 'string' || media.length > 2000000)) return;
      const m = { id: crypto.randomBytes(8).toString('hex'), from: code, to,
        text: text ? String(text).slice(0, 4000) : '',
        media: media || null, mediaType: mediaType || null, duration: duration || 0,
        type: media ? mediaType : 'text', t: Date.now() };
      if(state.chats[to]){
        const ch = state.chats[to];
        if(ch.type === 'channel' && ch.creator !== code) return;
        if(ch.type === 'group' && ch.creator !== code && !(ch.members||[]).includes(code)) return;
        state.messages.push(m); saveState();
        const payload = JSON.stringify({ type: 'message', message: m });
        for(const [ws2, c2] of clients.entries()){
          if(ws2.readyState !== 1) continue;
          if(ch.type === 'group'){
            if(c2 === ch.creator || (ch.members||[]).includes(c2)) ws2.send(payload);
          } else ws2.send(payload);
        }
        return;
      }
      if(!state.users[to]) return;
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
