// Sancho 서버 — Node.js 내장 기능만 사용 (외부 패키지 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.SANCHO_PORT) || 8790;
const HOST = '127.0.0.1'; // 이 PC 에서만 접속 가능
const DATA_DIR = process.env.SANCHO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const MAX_FAILS = 10; // 10번까지는 틀려도 되고, 11번째 틀리면 잠금
const LOCK_MS = 10 * 60 * 1000; // 10분
const COOKIE = 'sancho_session';
const PROTECTED_PAGES = new Set(['/index.html']); // 로그인해야 볼 수 있는 화면
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 파일 저장 (쓰다 끊겨도 깨지지 않게 임시파일 → 교체) ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- 비밀번호 (scrypt 해시, 평문 저장 금지) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [kind, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword('dummy-for-timing'); // 없는 아이디도 같은 시간이 걸리게

// ---------- 세션 (쿠키에는 무작위 토큰, 파일에는 토큰의 해시만) ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let sessions = readJson(SESSIONS_FILE, {}); // { 토큰해시: { userId, expires } }
function pruneSessions() {
  const now = Date.now();
  for (const k of Object.keys(sessions)) if (sessions[k].expires < now) delete sessions[k];
}
pruneSessions();
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[sha(token)] = { userId, expires: Date.now() + SESSION_MS };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}
function getToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
}
function currentUser(req) {
  const token = getToken(req);
  const s = token && sessions[sha(token)];
  if (!s || s.expires < Date.now()) return null;
  return readJson(USERS_FILE, []).find((u) => u.id === s.userId) || null;
}
const cookieHeader = (token, maxAge) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// ---------- 로그인 실패 잠금 ----------
const fails = new Map(); // 아이디 -> { count, lockedUntil }
function lockedLeftMs(username) {
  const f = fails.get(username);
  return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0;
}
function recordFail(username) {
  const f = fails.get(username) || { count: 0, lockedUntil: 0 };
  if (f.lockedUntil && f.lockedUntil <= Date.now()) { f.count = 0; f.lockedUntil = 0; }
  f.count += 1;
  if (f.count > MAX_FAILS) f.lockedUntil = Date.now() + LOCK_MS;
  fails.set(username, f);
}

// ---------- 도우미 ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10_000) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
  });
}
function serveFile(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, '접근할 수 없습니다.');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '없는 페이지입니다.');
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---------- 대화 (data/chats/<id>.json, 로그인한 본인 것만) ----------
const CHATS_DIR = path.join(DATA_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });
const nowIso = () => new Date().toISOString();
const chatFile = (id) => path.join(CHATS_DIR, `${id}.json`);
function saveChat(chat) { chat.updatedAt = nowIso(); writeJson(chatFile(chat.id), chat); }
function loadChat(id, userId) {
  const c = readJson(chatFile(id), null);
  return c && c.userId === userId ? c : null;
}
function listChats(userId) {
  return fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(CHATS_DIR, f), null))
    .filter((c) => c && c.userId === userId)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- 가짜 답 (두뇌 연결 전). 한 글자씩 SSE 로 흘려보낸다 ----------
const MD_SAMPLE = '## 화면 확인용 예시\n\n**굵게**, *기울임*, `코드` 도 보입니다.\n\n- 첫째 항목\n- 둘째 항목\n\n1. 하나\n2. 둘\n\n| 이름 | 상태 |\n|---|---|\n| 일정 | 준비 중 |\n| 메일 | 준비 중 |\n\n```js\nconsole.log("안녕");\n```\n\n> 인용문도 됩니다.';
const FAKE_REPLY = '준비 중입니다. (아직 두뇌가 연결되지 않았습니다.)';
const CHAR_DELAY_MS = 40;
function streamReply(res, chat, content) {
  const text = content === '/md' ? MD_SAMPLE : FAKE_REPLY; // '/md' 는 마크다운 표시 확인용
  chat.messages.push({ role: 'user', content, at: nowIso() });
  if (chat.title === '새 대화') chat.title = content.replace(/\s+/g, ' ').slice(0, 30);
  saveChat(chat);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const chars = Array.from(text);
  let i = 0, sent = '';
  const finish = () => { // 끝났든 중지했든 지금까지 받은 만큼 저장
    clearInterval(timer);
    chat.messages.push({ role: 'assistant', content: sent, at: nowIso() });
    saveChat(chat);
  };
  const timer = setInterval(() => {
    if (i >= chars.length) { finish(); res.write('event: done\ndata: {}\n\n'); res.end(); return; }
    sent += chars[i++];
    res.write(`data: ${JSON.stringify({ t: chars[i - 1] })}\n\n`);
  }, CHAR_DELAY_MS);
  res.on('close', () => { if (!res.writableFinished && i < chars.length) { i = chars.length; finish(); } });
}

// ---------- 요청 처리 ----------
async function handle(req, res) {
  // 다른 사이트가 우리 서버 주소를 가장해 접근하는 것을 막는다
  const okHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!okHosts.includes(req.headers.host)) return send(res, 403, '허용되지 않은 주소입니다.');

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const user = currentUser(req);

  if (p.startsWith('/api/')) {
    if (p === '/api/auth/status' && req.method === 'GET') {
      return send(res, 200, { hasUsers: readJson(USERS_FILE, []).length > 0, loggedIn: !!user });
    }
    if (req.method === 'POST' && p === '/api/auth/setup') {
      const users = readJson(USERS_FILE, []);
      if (users.length > 0) return send(res, 403, { error: '이미 관리자 계정이 있습니다.' });
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const name = String(b.name || '').trim();
      const username = String(b.username || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!name || name.length > 50) return send(res, 400, { error: '이름을 1~50자로 적어 주세요.' });
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return send(res, 400, { error: '아이디는 영문 소문자·숫자·_ . - 로 3~32자여야 합니다.' });
      if (password.length < 8) return send(res, 400, { error: '비밀번호는 8자 이상이어야 합니다.' });
      const u = { id: crypto.randomUUID(), name, username, role: 'admin', password: hashPassword(password), createdAt: new Date().toISOString() };
      writeJson(USERS_FILE, [u]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(u.id), SESSION_MS / 1000) });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const username = String(b.username || '').trim().toLowerCase();
      const left = lockedLeftMs(username);
      if (left) return send(res, 429, { error: `비밀번호를 너무 많이 틀렸습니다. ${Math.ceil(left / 60000)}분 뒤에 다시 시도하세요.` });
      const u = readJson(USERS_FILE, []).find((x) => x.username === username);
      const ok = verifyPassword(String(b.password || ''), u ? u.password : DUMMY_HASH) && !!u;
      if (!ok) { recordFail(username); return send(res, 401, { error: '아이디 또는 비밀번호가 맞지 않습니다.' }); }
      fails.delete(username);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(u.id), SESSION_MS / 1000) });
    }
    if (req.method === 'POST' && p === '/api/auth/logout') {
      const t = getToken(req);
      if (t && sessions[sha(t)]) { delete sessions[sha(t)]; writeJson(SESSIONS_FILE, sessions); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }
    // 여기부터는 로그인해야만 쓸 수 있다
    if (!user) return send(res, 401, { error: '로그인이 필요합니다.' });
    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { name: user.name, username: user.username });

    const cm = p.match(/^\/api\/chats(?:\/([0-9a-f-]{36}))?(\/messages)?$/);
    if (cm) {
      const [, id, isMsg] = cm;
      if (!id && req.method === 'GET') return send(res, 200, listChats(user.id));
      if (!id && req.method === 'POST') {
        const chat = { id: crypto.randomUUID(), userId: user.id, title: '새 대화', createdAt: nowIso(), updatedAt: nowIso(), messages: [] };
        saveChat(chat);
        return send(res, 200, { id: chat.id });
      }
      const chat = id && loadChat(id, user.id);
      if (!chat) return send(res, 404, { error: '없는 대화입니다.' });
      if (!isMsg && req.method === 'GET') return send(res, 200, chat);
      if (isMsg && req.method === 'POST') {
        let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
        const content = String(b.content || '').trim();
        if (!content) return send(res, 400, { error: '내용이 비어 있습니다.' });
        return streamReply(res, chat, content);
      }
    }
    return send(res, 404, { error: '없는 API 입니다.' });
  }

  if (req.method !== 'GET') return send(res, 405, '허용되지 않는 요청입니다.');
  if (p === '/' || PROTECTED_PAGES.has(p)) return serveFile(res, user ? '/index.html' : '/login.html');
  return serveFile(res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: '서버 오류' }); });
});
server.listen(PORT, HOST, () => console.log(`Sancho 서버 실행 중: http://${HOST}:${PORT}`));
