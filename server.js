// Sancho 서버 — Node.js 내장 기능만 사용 (외부 패키지 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
function readBody(req, max = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
  });
}
// public/ (그 아래 폴더 포함)에 실제로 있는 파일 이름과 글자 하나까지(대소문자 포함) 똑같을 때만 내보낸다.
// 윈도우는 대소문자를 안 가려서 /Index.html 로 로그인 화면을 건너뛸 수 있었다.
function serveFile(res, urlPath) {
  let file = PUBLIC_DIR;
  for (const seg of urlPath.slice(1).split('/')) { // 폴더를 한 칸씩 내려가며 이름이 정확히 있는지 본다
    if (!fs.statSync(file).isDirectory() || !fs.readdirSync(file).includes(seg)) return send(res, 404, '없는 페이지입니다.');
    file = path.join(file, seg);
  }
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

// ---------- 업무 자료 저장소 (data/db/<이름>.json 한 파일 = 한 묶음, 안에는 [{id, ...}, ...] 배열) ----------
const DB_DIR = path.join(DATA_DIR, 'db');
fs.mkdirSync(DB_DIR, { recursive: true });
const dbFile = (name) => path.join(DB_DIR, `${name}.json`);
function loadCollection(name) { // 파일이 없으면 빈 목록, 깨져 있으면 예외 (모르고 덮어써서 자료를 잃지 않게)
  let raw;
  try { raw = fs.readFileSync(dbFile(name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const v = JSON.parse(raw.replace(/^﻿/, '')); // 메모장이 붙이는 BOM 은 무시
  if (!Array.isArray(v)) throw new Error('not an array');
  return v;
}
// 파일이 바뀌면(우리가 썼든 AI 가 직접 고쳤든) 열려 있는 화면(/api/events)에 "<이름> 이 바뀜"을 알린다
const streams = new Set();
const pending = new Map(); // 한 번 쓸 때 이벤트가 여러 번 오므로 50ms 안의 것은 하나로 합친다
fs.watch(DB_DIR, (_, file) => {
  const m = /^([a-z][a-z0-9_-]*)\.json$/.exec(file || ''); // 쓰는 중인 임시 파일(.tmp)은 무시
  if (!m || pending.has(m[1])) return;
  pending.set(m[1], setTimeout(() => {
    pending.delete(m[1]);
    for (const r of streams) r.write(`event: db\ndata: ${JSON.stringify({ name: m[1] })}\n\n`);
  }, 50));
}).on('error', (e) => console.error('data/db 감시 실패:', e.message));

function readMemory() { try { return fs.readFileSync(MEMORY_FILE, 'utf8').split(/\r?\n/); } catch { return []; } }

// ---------- 두뇌: 이 PC 에 설치된 Claude Code (내 구독 로그인, API 키 없음) ----------
const SYSTEM_FILE = path.join(DATA_DIR, '.system.md'); // 비서의 성격·기억 규칙 (templates/system.md 에서 처음 한 번 복사)
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md'); // 비서의 기억 (한 줄에 사실 하나: "- 날짜 내용")
if (!fs.existsSync(SYSTEM_FILE)) fs.copyFileSync(path.join(__dirname, 'templates', 'system.md'), SYSTEM_FILE);
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '# 기억\n');
const PRIVATE_FILES = ['users.json', 'sessions.json']; // 비밀번호 해시·로그인 기록은 두뇌도 못 보게 막는다
const READONLY_FILES = ['.system.md']; // 비서가 자기 지침을 스스로 고치지 못하게 막는다 (읽기만 가능)
const BRAIN_ARGS = [
  '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'sonnet',
  // 파일 도구는 data/ 안(./**)으로만 허용한다. 범위 없이 'Read' 만 쓰면 PC 의 모든 파일을 읽고 쓸 수 있다. 명령 실행은 아직 안 준다
  '--allowedTools', ...['Read', 'Glob', 'Grep', 'Edit', 'Write'].map((t) => `${t}(./**)`), 'WebSearch', 'WebFetch',
  '--disallowedTools', 'Bash', 'PowerShell', ...PRIVATE_FILES.flatMap((f) => ['Read', 'Edit', 'Write'].map((t) => `${t}(./${f})`)),
  ...READONLY_FILES.flatMap((f) => ['Edit', 'Write'].map((t) => `${t}(./${f})`)),
  '--append-system-prompt-file', SYSTEM_FILE,
];
// 테스트에서는 진짜 claude 대신 가짜 스크립트를 쓴다
const BRAIN_CMD = process.env.SANCHO_BRAIN_SCRIPT ? [process.execPath, process.env.SANCHO_BRAIN_SCRIPT] : ['claude'];
const TOOL_LABELS = { Read: '파일 읽는 중', Glob: '파일 찾는 중', Grep: '내용 검색 중', Edit: '파일 고치는 중', Write: '파일 쓰는 중',
  WebSearch: '웹 검색 중', WebFetch: '웹 페이지 읽는 중' };
const BRAIN_MAX_MS = 10 * 60 * 1000;
const running = new Set(); // 지금 답하는 중인 대화

// CLAUDE 로 시작하는 환경변수와 접속 주소·토큰을 지운다 (Claude Code 안에서 서버를 켜도 "로그인 안 됨"이 나지 않게)
function brainEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') || ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(k)) delete env[k];
  }
  return env;
}
function killTree(child) { // 윈도우에서는 자식의 자식까지 같이 끈다
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill();
}

function streamReply(res, chat, content, user) {
  if (running.has(chat.id)) return send(res, 409, { error: '이 대화는 아직 답하는 중입니다. 끝난 뒤에 보내 주세요.' });
  running.add(chat.id);
  chat.messages.push({ role: 'user', content, at: nowIso() });
  if (chat.title === '새 대화') chat.title = content.replace(/\s+/g, ' ').slice(0, 30);
  saveChat(chat);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const today = new Date();
  const ctx = `주인 이름: ${user.name}. 오늘 날짜: ${today.toLocaleDateString('sv-SE')} (${today.toLocaleDateString('ko-KR', { weekday: 'long' })}).`;
  const args = [...BRAIN_CMD.slice(1), ...(chat.sessionId ? ['--resume', chat.sessionId] : []), ...BRAIN_ARGS, '--append-system-prompt', ctx];
  let sent = '', errText = '', buf = '', result = null, limit = null, spawnErr = null, cap = null, child = null;
  let finished = false, aborted = false, timedOut = false;

  const emit = (text) => {
    if (!text) return;
    sent += text;
    if (!res.destroyed) res.write(`data: ${JSON.stringify({ t: text })}\n\n`);
  };
  const gap = () => (!sent || sent.endsWith('\n\n') ? '' : sent.endsWith('\n') ? '\n' : '\n\n');

  function onLine(line) {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id && (ev.type === 'system' || ev.type === 'result') && ev.session_id !== chat.sessionId) {
      chat.sessionId = ev.session_id; saveChat(chat); // 다음 말에 --resume 으로 이어가려고 저장
    }
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
      const e = ev.event || {};
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
        emit(`${gap()}⏺ ${TOOL_LABELS[e.content_block.name] || '도구 쓰는 중'}\n\n`);
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') emit(e.delta.text);
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') limit = ev.rate_limit_info;
    else if (ev.type === 'result') result = ev;
  }

  function explain() { // 실패 이유를 쉬운 한국어로
    if (spawnErr) return spawnErr.code === 'ENOENT'
      ? '이 PC 에서 claude 프로그램을 찾을 수 없습니다. Claude Code 가 설치되어 있는지 확인해 주세요.'
      : `claude 를 실행하지 못했습니다. (${spawnErr.message})`;
    if (timedOut) return '답이 너무 오래 걸려 중단했습니다. 질문을 나눠서 다시 해 보세요.';
    const raw = `${(result && result.result) || ''} ${errText}`;
    if (limit || /usage limit|rate limit|hit your limit|limit reached|too many requests|overloaded/i.test(raw)) {
      const when = limit && limit.resetsAt ? `${new Date(limit.resetsAt * 1000).toLocaleString('ko-KR')} 쯤` : '잠시 뒤';
      return `Claude 사용 한도에 닿았습니다. ${when} 다시 시도해 주세요.`;
    }
    if (/not logged in|\/login|authenticat|unauthorized|invalid api key|credentials/i.test(raw))
      return 'Claude Code 에 로그인되어 있지 않습니다. 명령 창에서 claude 를 한 번 실행해 로그인한 뒤 다시 시도해 주세요.';
    if (/no conversation found/i.test(raw)) {
      chat.sessionId = null;
      return '이전 대화의 기억을 찾지 못했습니다. 같은 말을 한 번 더 보내시면 새 기억으로 시작합니다.';
    }
    return `Claude 가 오류로 끝났습니다. ${raw.trim().slice(0, 200)}`;
  }

  function finish() {
    if (finished) return; finished = true; clearTimeout(cap);
    if (buf.trim()) onLine(buf);
    if (!aborted) {
      if (result && !result.is_error) { if (!sent.trim() && result.result) emit(result.result); }
      else emit(`${gap()}⚠ ${explain()}`);
    }
    if (!sent.trim()) sent = '(중지했습니다.)';
    chat.messages.push({ role: 'assistant', content: sent, at: nowIso() }); // 중지해도 지금까지 받은 만큼 저장
    saveChat(chat);
    running.delete(chat.id);
    if (!res.destroyed) { res.write('event: done\ndata: {}\n\n'); res.end(); }
  }

  // 실행 자체가 그 자리에서 실패해도 화면이 ■ 에 멈추지 않게 바로 마무리한다
  try { child = spawn(BRAIN_CMD[0], args, { cwd: DATA_DIR, env: brainEnv(), windowsHide: true }); } catch (e) { spawnErr = e; return finish(); }
  cap = setTimeout(() => { timedOut = true; killTree(child); }, BRAIN_MAX_MS);
  child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } });
  child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
  child.stdin.on('error', () => {});
  child.on('error', (e) => { spawnErr = e; finish(); });
  child.on('close', finish);
  child.stdin.end(content); // 사용자 말은 명령줄이 아니라 표준입력으로
  res.on('close', () => { if (!finished) { aborted = true; killTree(child); } }); // ■ 중지 → claude 끄기
}

// ---------- 요청 처리 ----------
async function handle(req, res) {
  // 다른 사이트가 우리 서버 주소를 가장해 접근하는 것을 막는다
  const okHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!okHosts.includes(req.headers.host)) return send(res, 403, '허용되지 않은 주소입니다.');
  // 다른 웹사이트가 내 브라우저를 거쳐 보내는 요청(계정 만들기·로그인·채팅)을 막는다. 브라우저는 이런 요청에 Origin 을 붙인다
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !okHosts.some((h) => origin === `http://${h}`)) return send(res, 403, { error: '다른 사이트에서 온 요청은 받지 않습니다.' });

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
      if (!name || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) return send(res, 400, { error: '이름을 1~50자로 적어 주세요. (줄바꿈 같은 특수 문자는 안 됩니다)' });
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

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': 연결됨\n\n');
      streams.add(res); res.on('close', () => streams.delete(res));
      return;
    }
    const dm = p.match(/^\/api\/db\/([a-z][a-z0-9_-]{0,39})(?:\/([A-Za-z0-9_-]{1,64}))?$/);
    if (dm) {
      const [, name, id] = dm;
      let items; try { items = loadCollection(name); } catch { return send(res, 500, { error: `data/db/${name}.json 이 올바른 목록(JSON 배열)이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.` }); }
      const at = () => items.findIndex((x) => x && String(x.id) === id);
      if (!id && req.method === 'GET') return send(res, 200, items);
      if (id && req.method === 'PUT') { // 같은 id 가 있으면 통째로 바꾸고, 없으면 추가
        let b; try { b = await readBody(req, 200_000); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: '저장할 내용은 JSON 객체여야 합니다.' });
        const item = { id, ...b }; item.id = id; // 주소의 id 가 항상 이긴다
        const i = at();
        if (i < 0) items.push(item); else items[i] = item;
        writeJson(dbFile(name), items);
        return send(res, 200, item);
      }
      if (id && req.method === 'DELETE') {
        const i = at();
        if (i < 0) return send(res, 404, { error: '없는 항목입니다.' });
        items.splice(i, 1);
        writeJson(dbFile(name), items);
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/memory' && req.method === 'GET') return send(res, 200, { items: readMemory().map((text, i) => ({ i, text })).filter((x) => x.text.startsWith('- ')) });
    if (p === '/api/memory/delete' && req.method === 'POST') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const raw = fs.readFileSync(MEMORY_FILE, 'utf8'), eol = raw.includes('\r\n') ? '\r\n' : '\n', lines = raw.split(/\r?\n/);
      if (!Number.isInteger(b.i) || lines[b.i] !== b.text || !b.text.startsWith('- ')) return send(res, 409, { error: '그 사이에 기억이 바뀌었습니다. 목록을 새로 불러와 주세요.' });
      lines.splice(b.i, 1);
      fs.writeFileSync(MEMORY_FILE + '.tmp', lines.join(eol)); fs.renameSync(MEMORY_FILE + '.tmp', MEMORY_FILE);
      return send(res, 200, { ok: true });
    }

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
        return streamReply(res, chat, content, user);
      }
    }
    return send(res, 404, { error: '없는 API 입니다.' });
  }

  if (req.method !== 'GET') return send(res, 405, '허용되지 않는 요청입니다.');
  if (p === '/' || PROTECTED_PAGES.has(p)) return serveFile(res, user ? '/index.html' : '/login.html');
  if (p.startsWith('/m/') && !user) return send(res, 401, '로그인이 필요합니다.'); // 업무 화면(public/m/)은 로그인한 사람만
  return serveFile(res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: '서버 오류' }); });
});
server.listen(PORT, HOST, () => console.log(`Sancho 서버 실행 중: http://${HOST}:${PORT}`));
