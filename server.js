// Sancho 서버 — Node.js 내장 기능만 사용 (외부 패키지 없음)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.SANCHO_PORT) || 8790;
const HOST = '127.0.0.1'; // 이 PC 에서만 접속 가능
const DATA_DIR = process.env.SANCHO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_DIR = path.join(DATA_DIR, 'users'); // 사람마다 개인 폴더 data/users/<아이디>/ — 대화(chats/)·기억(memory.md)·예약(schedule.json)·일지(journal/). 업무 데이터(db/)는 모두가 함께 쓴다

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

// ---------- 사람들 (data/users.json) 과 개인 폴더 ----------
// 사람: { id, name, username, dept(부서), role('admin'|'user'), password(해시), mustChange(true 면 처음 로그인에 비밀번호를 바꿔야 함), createdAt }
const USER_RE = /^[a-z0-9_-][a-z0-9_.-]{1,30}[a-z0-9_-]$/; // 폴더 이름이 되므로 점으로 시작·끝나는 것(".." 같은)은 안 된다
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/; // 윈도우 장치 이름은 폴더로 못 만든다
const isAdmin = (u) => !!u && u.role === 'admin';
const userDir = (u) => { if (!USER_RE.test(u.username)) throw new Error(`아이디 "${u.username}" 은(는) 폴더 이름으로 쓸 수 없어요.`); return path.join(USERS_DIR, u.username); };
const userFile = (u, ...p) => path.join(userDir(u), ...p);
const pubUser = (u) => ({ username: u.username, name: u.name, dept: u.dept || '', role: isAdmin(u) ? 'admin' : 'user', mustChange: !!u.mustChange, createdAt: u.createdAt });
function usernameProblem(username) { // 아이디가 안 되는 이유(쉬운 한국어), 괜찮으면 ''
  if (!USER_RE.test(username) || RESERVED_NAME.test(username)) return '아이디는 영문 소문자·숫자·_ . - 로 3~32자이고, 점(.)으로 시작하거나 끝나면 안 됩니다. (con·nul 같은 윈도우 예약 이름도 안 됩니다)';
  return '';
}
const badText = (s, max) => !s || s.length > max || /[\u0000-\u001f\u007f]/.test(s); // 비었거나 너무 길거나 줄바꿈 같은 특수 문자가 있으면 true

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

// ---------- 대화 (data/users/<아이디>/chats/<id>.json — 사람마다 따로, 그 사람 폴더에서만 찾는다) ----------
const nowIso = () => new Date().toISOString();
const chatsDir = (u) => userFile(u, 'chats');
function saveChat(u, chat) { chat.updatedAt = nowIso(); fs.mkdirSync(chatsDir(u), { recursive: true }); writeJson(path.join(chatsDir(u), `${chat.id}.json`), chat); }
function loadChat(id, u) {
  const c = readJson(path.join(chatsDir(u), `${id}.json`), null);
  return c && c.userId === u.id ? c : null;
}
function listChats(u) {
  let names = []; try { names = fs.readdirSync(chatsDir(u)); } catch { /* 아직 대화가 없다 */ }
  return names.filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(chatsDir(u), f), null))
    .filter((c) => c && c.userId === u.id)
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
function emitDb(name) { for (const r of streams) r.write(`event: db\ndata: ${JSON.stringify({ name })}\n\n`); } // 열려 있는 화면에 "<이름> 이 바뀜"
function watchJson(dir, re, prefix) { // dir 안의 <이름>.json 이 바뀌면 "<prefix><이름>" 이 바뀜을 알린다
  fs.watch(dir, (_, file) => {
    const m = re.exec(file || ''), key = m && prefix + m[1]; // 쓰는 중인 임시 파일(.tmp)은 무시
    if (!m || pending.has(key)) return;
    pending.set(key, setTimeout(() => { pending.delete(key); emitDb(key); }, 50));
  }).on('error', (e) => console.error(`${dir} 감시 실패:`, e.message));
}
watchJson(DB_DIR, /^([a-z][a-z0-9_-]*)\.json$/, '');

// ---------- WBS 공정표 (data/wbs/<프로젝트id>.json — 프로젝트마다 파일 하나, 안에는 { bac, ac, items, actualLog } 객체) ----------
// 계산·검증은 화면이 쓰는 public/m/wbs-calc.js 와 같은 파일을 쓴다 (규칙이 두 군데 생기지 않게)
const wbsCalc = require('./public/m/wbs-calc.js');
const WBS_DIR = path.join(DATA_DIR, 'wbs');
fs.mkdirSync(WBS_DIR, { recursive: true });
const wbsFile = (pid) => path.join(WBS_DIR, `${pid}.json`);
const etagOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex'); // 파일 내용의 지문. 화면이 불러온 뒤 파일이 바뀌었는지 알아보는 데 쓴다
watchJson(WBS_DIR, /^([A-Za-z0-9_-]{1,64})\.json$/, 'wbs-'); // 화면은 db.watch('wbs-<프로젝트id>') 로 받는다

// ---------- Rev (저장 이력): data/wbs/_history/<프로젝트id>/<번호>_<날짜>_<시각>.json — 한 번 저장에 파일 하나 ----------
const MAX_REVS = 200; // 넘으면 더 안 쌓고 알린다 (묻지 않고 지우지 않는다)
const REV_FILE = /^(\d{4,6})_\d{4}-\d\d-\d\d_\d{6}\.json$/;
const revDir = (pid) => path.join(WBS_DIR, '_history', pid);
const revNames = (pid) => { try { return fs.readdirSync(revDir(pid)).filter((f) => REV_FILE.test(f)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
// ponytail: 목록을 부를 때마다 Rev 파일을 모두 읽는다(200개 한도라 괜찮다). 느려지면 목록 파일(index)을 따로 둔다
function listRevs(pid) {
  return revNames(pid).map((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(revDir(pid), f), 'utf8')); return { rev: Number(REV_FILE.exec(f)[1]), savedAt: String(j.savedAt || ''), note: String(j.note || ''), auto: !!j.auto, doc: j.snapshot }; }
    catch { return null; } // 깨진 Rev 파일은 건너뛴다
  }).filter(Boolean).sort((a, b) => a.rev - b.rev);
}
function writeRev(pid, doc, note, auto) { // 성공하면 { rev, savedAt }, 한도에 닿으면 { error }
  const names = revNames(pid);
  if (names.length >= MAX_REVS) return { error: `이 프로젝트의 Rev 가 ${MAX_REVS}개예요. 더 쌓지 않았어요. 오래된 Rev 파일(data/wbs/_history/${pid}/)을 정리한 뒤 다시 저장해 주세요.` };
  const rev = Math.max(0, ...names.map((f) => Number(REV_FILE.exec(f)[1]))) + 1, now = new Date();
  const file = `${String(rev).padStart(4, '0')}_${now.toLocaleDateString('sv-SE')}_${now.toTimeString().slice(0, 8).replace(/:/g, '')}.json`;
  fs.mkdirSync(revDir(pid), { recursive: true });
  writeJson(path.join(revDir(pid), file), { rev, savedAt: now.toISOString(), note, auto, snapshot: doc });
  return { rev, savedAt: now.toISOString() };
}

// ---------- 읽기 전용 공유 링크: 토큰의 해시만 data/share.json 에 둔다(파일을 읽어도 링크를 만들 수 없게). 링크는 만들 때 한 번만 보여 준다 ----------
const SHARE_FILE = path.join(DATA_DIR, 'share.json');
const SHARE_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const live = (e) => !!e && Date.parse(e.expiresAt) > Date.now();
const shareEntry = (token) => { const e = readJson(SHARE_FILE, {})[sha(token)]; return live(e) ? e : null; };
function publicWbs(pid) { // 공유 화면에 보내는 자료: 계약금액·실제 비용·메모는 화면에서 숨기는 게 아니라 서버가 아예 안 보낸다
  let doc; try { doc = JSON.parse(fs.readFileSync(wbsFile(pid), 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') doc = wbsCalc.emptyDoc(); else return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  // 빼는 칸을 고르는 게 아니라 보낼 칸만 고른다: 파일에 누가 모르는 칸(예: 단가)을 덧붙여도 새어 나가지 않게
  const items = (Array.isArray(doc.items) ? doc.items : []).map((it) => (it && typeof it === 'object' && !Array.isArray(it)
    ? Object.fromEntries(PUBLIC_ITEM_KEYS.filter((k) => k in it).map((k) => [k, it[k]])) : null));
  let name = pid; try { const p = loadCollection('projects').find((x) => x && x.id === pid); if (p && p.name) name = String(p.name); } catch { /* 이름을 못 읽어도 id 로 */ }
  return { name, doc: { bac: null, ac: null, items, actualLog: cleanLog(doc.actualLog) } };
}
const PUBLIC_ITEM_KEYS = ['code', 'type', 'name', 'owner', 'start', 'end', 'weight', 'progress'];
// actualLog 중 {날짜: 0~100 숫자} 모양인 것만 (공유로 보낼 때·되돌릴 때 이상한 값이 끼지 않게)
const cleanLog = (log) => Object.fromEntries(Object.entries(log && typeof log === 'object' ? log : {}).filter(([d, v]) => wbsCalc.isDate(d) && typeof v === 'number' && v >= 0 && v <= 100));

// /api/wbs/<프로젝트id>[/revs[/<번호>[/restore]] | /share] — 처리했으면 true (아니면 404 로 넘어간다)
async function wbsApi(req, res, pid, sub, revN, restore) {
  const M = req.method, done = (status, body) => { send(res, status, body); return true; };
  const bad = () => done(400, { error: '요청이 올바르지 않습니다.' });
  const readDoc = (file) => { // 파일 → { doc, etag } | { missing } | { broken }
    let raw; try { raw = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return { missing: true }; throw e; }
    try { return { doc: JSON.parse(raw.toString('utf8').replace(/^﻿/, '')), etag: etagOf(raw) }; } catch { return { broken: true }; }
  };
  const brokenMsg = `data/wbs/${pid}.json 이 올바른 JSON 이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.`;

  if (!sub) {
    if (M === 'GET') {
      const r = readDoc(wbsFile(pid));
      return r.missing ? done(200, { doc: wbsCalc.emptyDoc(), etag: 'none' }) : r.broken ? done(500, { error: brokenMsg }) : done(200, { doc: r.doc, etag: r.etag });
    }
    if (M === 'PUT') {
      // 저장: 본문을 먼저 다 받고, 그 다음 비교→쓰기를 await 없이 한 번에 한다 (db 저장과 같은 이유).
      // 화면이 불러온 뒤 다른 곳(다른 탭, 비서가 파일을 직접 고침)이 바꿨으면 etag 가 달라서 409 로 막는다 — 남의 수정을 조용히 덮어쓰지 않는다
      let b; try { b = await readBody(req, 1_000_000); } catch { return bad(); }
      if (!b || typeof b.etag !== 'string') return done(400, { error: '요청이 올바르지 않습니다. (etag 가 필요해요)' });
      const why = wbsCalc.validate(b.doc);
      if (why) return done(400, { error: why });
      let cur = null; try { cur = fs.readFileSync(wbsFile(pid)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (b.etag !== (cur ? etagOf(cur) : 'none')) return done(409, { error: '그 사이 다른 곳에서 먼저 바뀌어서 저장하지 않았어요. 최신 내용을 새로 불러옵니다.' });
      const doc = wbsCalc.normalize(b.doc, wbsCalc.today());
      writeJson(wbsFile(pid), doc);
      return done(200, { doc, etag: etagOf(fs.readFileSync(wbsFile(pid))) });
    }
    return false;
  }

  if (sub === 'revs') {
    if (!revN && M === 'GET') return done(200, { revs: listRevs(pid).map(({ rev, savedAt, note, auto }) => ({ rev, savedAt, note, auto })) });
    if (!revN && M === 'POST') { // 지금 저장된 공정표를 Rev 로 복사
      let b; try { b = await readBody(req); } catch { return bad(); }
      const note = String((b && b.note) ?? '').trim();
      if (note.length > 100) return done(400, { error: '설명은 100자까지예요.' });
      const r = readDoc(wbsFile(pid));
      if (r.missing) return done(400, { error: '저장할 공정표가 아직 없어요. 먼저 항목을 추가해 주세요.' });
      if (r.broken) return done(500, { error: brokenMsg });
      const w = writeRev(pid, r.doc, note, false);
      return w.error ? done(409, { error: w.error }) : done(200, w);
    }
    const rev = revN ? listRevs(pid).find((x) => x.rev === Number(revN)) : null;
    if (revN && !restore && M === 'GET') return rev ? done(200, rev) : done(404, { error: '없는 Rev 입니다.' });
    if (revN && restore && M === 'POST') { // 이 Rev 로 되돌리기: 먼저 지금 상태를 자동 Rev 로 저장하고, 그 다음 바꾼다
      if (!rev) return done(404, { error: '없는 Rev 입니다.' });
      const why = wbsCalc.validate(rev.doc);
      if (why) return done(400, { error: `이 Rev 는 형식이 맞지 않아 되돌릴 수 없어요: ${why}` });
      const cur = readDoc(wbsFile(pid));
      if (cur.broken) return done(500, { error: `${brokenMsg} (지금 상태를 저장할 수 없어 되돌리지 않았어요)` });
      let backupRev = null;
      if (!cur.missing) {
        const w = writeRev(pid, cur.doc, `되돌리기 전 자동 저장 (Rev ${rev.rev} 으로 되돌림)`, true);
        if (w.error) return done(409, { error: w.error });
        backupRev = w.rev;
      }
      // 되돌리는 건 계획(항목·금액)이다. 실제 진도 기록(actualLog)은 "그날 실제로 그랬다"는 사실이라 지금 것을 남기고 Rev 의 기록과 합친다 (오늘 값은 정리할 때 되돌린 상태로 다시 적힌다)
      const actualLog = { ...cleanLog(rev.doc.actualLog), ...(cur.missing ? {} : cleanLog(cur.doc.actualLog)) };
      const doc = wbsCalc.normalize({ ...rev.doc, actualLog }, wbsCalc.today());
      writeJson(wbsFile(pid), doc);
      return done(200, { doc, etag: etagOf(fs.readFileSync(wbsFile(pid))), backupRev });
    }
    return false;
  }

  if (sub === 'share' && !revN) {
    const all = readJson(SHARE_FILE, {}), mine = Object.entries(all).filter(([, e]) => e && e.pid === pid);
    for (const [h, e] of Object.entries(all)) if (!live(e)) delete all[h]; // 기한이 지난 것은 치운다
    if (M === 'GET') { const e = mine.map(([, x]) => x).find(live); return done(200, e ? { active: true, createdAt: e.createdAt, expiresAt: e.expiresAt } : { active: false }); }
    if (M === 'POST') { // 새 링크를 만들면 이 프로젝트의 이전 링크는 끊긴다
      const token = crypto.randomBytes(24).toString('base64url'), now = Date.now();
      for (const [h] of mine) delete all[h];
      all[sha(token)] = { pid, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_MS).toISOString() };
      writeJson(SHARE_FILE, all);
      return done(200, { path: `/s/${token}`, expiresAt: all[sha(token)].expiresAt });
    }
    if (M === 'DELETE') { for (const [h] of mine) delete all[h]; writeJson(SHARE_FILE, all); return done(200, { ok: true, removed: mine.length }); }
  }
  return false;
}

// ---------- 연습용 예시 데이터 (가상 회사 "가나다전자", 실제 회사·사람 이름은 쓰지 않는다) ----------
// 날짜는 "지금"을 기준으로 잡아서 언제 넣어도 이번 주·다음 주로 보인다
function sampleData(now = new Date()) {
  const shift = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); // 이번 주 월요일
  const w = (n) => shift(mon, n); // 이번 주 월요일 + n일 (7 이상이면 다음 주)
  const t = (n) => shift(now, n); // 오늘 + n일
  return {
    events: [
      { id: 'demo-e1', title: '주간 업무 회의', kind: '회의', date: w(0), endDate: w(0), start: '09:30', end: '10:30', place: '본사 3층 회의실', projectId: null },
      { id: 'demo-e2', title: '열교환기 설계 검토 회의', kind: '회의', date: w(1), endDate: w(1), start: '14:00', end: '15:30', place: '본사 2층 설계실', projectId: 'demo-p1' },
      { id: 'demo-e3', title: '압력용기 수압시험 입회', kind: '검사 입회', date: w(2), endDate: w(2), start: '10:00', end: '15:00', place: '협력 제작사 시험장', projectId: 'demo-p2' },
      { id: 'demo-e4', title: '공장 자동화 현장 실사', kind: '출장', date: w(3), endDate: w(3), start: '08:30', end: '17:30', place: '가나다전자 제2공장', projectId: 'demo-p3' },
      { id: 'demo-e5', title: '열교환기 용접부 비파괴검사 입회', kind: '검사 입회', date: w(4), endDate: w(4), start: '10:00', end: '12:00', place: '협력 제작사 검사실', projectId: 'demo-p1' },
      { id: 'demo-e6', title: '주간 업무 회의', kind: '회의', date: w(7), endDate: w(7), start: '09:30', end: '10:30', place: '본사 3층 회의실', projectId: null },
      { id: 'demo-e7', title: '압력용기 개조 범위 협의', kind: '출장', date: w(9), endDate: w(10), start: '08:00', end: '18:00', place: '고객사 현장 (라마바화학)', projectId: 'demo-p2' },
      { id: 'demo-e8', title: '자동화 설비 납품 검사 입회', kind: '검사 입회', date: w(11), endDate: w(11), start: '13:00', end: '17:00', place: '협력 제작사 조립장', projectId: 'demo-p3' },
    ],
    projects: [
      { id: 'demo-p1', name: '열교환기 제작', client: '라마바화학', status: '진행중', progress: 55, start: t(-60), due: t(45), owner: '김가나' },
      { id: 'demo-p2', name: '압력용기 개조', client: '사아자에너지', status: '진행중', progress: 30, start: t(-30), due: t(80), owner: '이다라' },
      { id: 'demo-p3', name: '공장 자동화', client: '가나다전자 생산팀', status: '계획', progress: 0, start: t(14), due: t(120), owner: '박마바' },
    ],
    tasks: [
      { id: 'demo-t1', title: '열교환기 제작도면 최종 확인', projectId: 'demo-p1', due: t(-1), status: '진행중', owner: '김가나' },
      { id: 'demo-t2', title: '용접 절차서 승인 요청', projectId: 'demo-p1', due: t(0), status: '할 일', owner: '김가나' },
      { id: 'demo-t3', title: '수압시험 입회 보고서 작성', projectId: 'demo-p2', due: t(2), status: '할 일', owner: '이다라' },
      { id: 'demo-t4', title: '개조 범위 견적서 제출', projectId: 'demo-p2', due: t(5), status: '진행중', owner: '이다라' },
      { id: 'demo-t5', title: '자동화 업체 3곳 견적 비교표 작성', projectId: 'demo-p3', due: t(9), status: '할 일', owner: '박마바' },
      { id: 'demo-t6', title: '지난주 업무 보고 정리', projectId: null, due: t(-3), status: '완료', owner: '김가나' },
    ],
    notices: [
      { id: 'demo-n1', title: '마감이 지난 할 일이 1건 있습니다', body: '열교환기 제작도면 최종 확인', level: '주의', at: now.toISOString(), read: false },
      { id: 'demo-n2', title: '연습용 예시 데이터가 들어 있습니다', body: '가상 회사 "가나다전자" 기준의 예시이며 실제 업무 자료가 아닙니다.', level: '안내', at: now.toISOString(), read: false },
    ],
  };
}

// 예시 공정표: 열교환기 제작(demo-p1). 대단락 5개(설계·구매·제작·검사·출하)와 작업들. 지연·진행·대기·완료가 골고루 보이게 잡았다
function sampleWbs(now = new Date()) {
  const t = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); }; // 오늘 + n일
  const par = (code, name, weight) => ({ code, name, owner: '', weight, memo: '' });
  const task = (code, name, owner, a, b, weight, progress) => ({ code, name, owner, start: t(a), end: t(b), weight, progress, memo: '' });
  return {
    'demo-p1': {
      bac: 1200000000, ac: 520000000,
      items: [
        par('1', '설계', 15),
        task('1.1', '기본설계', '김가나', -60, -46, 1, 100), task('1.2', '상세설계·제작도면', '김가나', -45, -31, 2, 100), task('1.3', '고객 도면 승인', '김가나', -30, -24, 1, 100),
        par('2', '구매', 15),
        task('2.1', '판재·튜브 발주', '이다라', -35, -26, 1, 100), task('2.2', '자재 입고', '이다라', -25, -12, 2, 100), task('2.3', '용접재료·부속품 구매', '이다라', -20, -3, 1, 80),
        par('3', '제작', 40),
        task('3.1', '판재 가공·성형', '박마바', -22, -9, 2, 100), task('3.2', '튜브 삽입·확관', '박마바', -10, 8, 3, 70), task('3.3', '용접', '박마바', -2, 14, 3, 5),
        task('3.4', '열처리', '박마바', 12, 20, 1, 0),
        par('4', '검사', 20),
        task('4.1', '비파괴검사', '김가나', 18, 28, 1, 0), task('4.2', '수압시험', '김가나', 29, 34, 2, 0), task('4.3', '최종 치수·외관 검사', '김가나', 35, 39, 1, 0),
        par('5', '출하', 10),
        task('5.1', '도장·포장', '이다라', 37, 42, 1, 0), task('5.2', '출하·운송', '이다라', 43, 45, 1, 0),
      ],
    },
  };
}

const memoryFile = (u) => userFile(u, 'memory.md'); // 그 사람의 기억 (한 줄에 사실 하나: "- 날짜 내용")
function readMemory(u) { try { return fs.readFileSync(memoryFile(u), 'utf8').split(/\r?\n/); } catch { return []; } }

// ---------- 개인 폴더 만들기 · 옛 구조에서 옮기기 ----------
const watchedUsers = new Set();
function ensureUserDir(u) { // 개인 폴더·대화 폴더·기억 파일(없을 때만)을 만들고, 예약 파일이 바뀌면 화면에 알리게 지켜본다
  fs.mkdirSync(path.join(userDir(u), 'chats'), { recursive: true });
  if (!fs.existsSync(memoryFile(u))) fs.writeFileSync(memoryFile(u), '# 기억\n');
  if (!watchedUsers.has(u.username)) { watchedUsers.add(u.username); watchJson(userDir(u), /^(schedule)\.json$/, ''); } // 화면의 예약 칸은 db.watch('schedule') 로 받는다 (비서가 파일을 직접 고쳐도 따라 바뀌게)
}
// 여러 사람이 쓰기 전의 구조(data/chats·memory.md·schedule.json·schedule-running.json·journal/)를 첫 관리자(주인)의 개인 폴더로 옮긴다.
// 옮기기만 하고 지우지 않는다. 이미 있는 파일은 덮어쓰지 않는다. 대화는 만든 사람(userId)의 폴더로 간다
function migrateLegacy() {
  const users = readJson(USERS_FILE, []), owner = users[0];
  if (!owner) return;
  const moveFree = (from, to) => { if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); } };
  const moveDir = (dir, to) => { // 폴더 안 파일을 하나씩 옮기고, 비었으면 빈 폴더만 치운다
    let names = []; try { names = fs.readdirSync(dir); } catch { return; }
    for (const f of names) to(f) && moveFree(path.join(dir, f), to(f));
    try { fs.rmdirSync(dir); } catch { /* 남은 파일이 있으면 그대로 둔다 */ }
  };
  moveDir(path.join(DATA_DIR, 'chats'), (f) => { // 대화 한 개 = 파일 하나
    if (!f.endsWith('.json')) return null;
    const c = readJson(path.join(DATA_DIR, 'chats', f), null), u = (c && users.find((x) => x.id === c.userId)) || owner;
    return userFile(u, 'chats', f);
  });
  for (const f of ['memory.md', 'schedule.json', 'schedule-running.json']) moveFree(path.join(DATA_DIR, f), userFile(owner, f));
  moveDir(path.join(DATA_DIR, 'journal'), (f) => userFile(owner, 'journal', f));
}

// ---------- 두뇌: 이 PC 에 설치된 Claude Code (내 구독 로그인, API 키 없음) ----------
const SYSTEM_FILE = path.join(DATA_DIR, '.system.md'); // 비서의 성격·기억 규칙 (templates/system.md 에서 처음 한 번 복사)
if (!fs.existsSync(SYSTEM_FILE)) fs.copyFileSync(path.join(__dirname, 'templates', 'system.md'), SYSTEM_FILE);
try { migrateLegacy(); } catch (e) { console.error('옛 자료를 개인 폴더로 옮기지 못했어요:', e.message); }
for (const u of readJson(USERS_FILE, [])) { try { ensureUserDir(u); } catch (e) { console.error(`${u.username} 의 개인 폴더를 만들지 못했어요:`, e.message); } }
// 비서에게 업무 규칙을 가르치는 스킬들(platform: data/db 형식, wbs: 공정표). 두뇌의 작업 폴더가 data/ 라서 data/.claude/skills/<이름>/SKILL.md 에 둔다.
// 원본은 templates/skills/ 쪽이다. 서버를 켤 때 내용이 다르거나 없으면 다시 복사해, 새 규칙(예: WBS)이 기존 설치에도 반영된다 (비서는 이 파일을 못 고친다)
const SKILLS_SRC = path.join(__dirname, 'templates', 'skills');
for (const name of fs.readdirSync(SKILLS_SRC)) {
  const src = path.join(SKILLS_SRC, name, 'SKILL.md'), dst = path.join(DATA_DIR, '.claude', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(src)) continue;
  if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== fs.readFileSync(src, 'utf8')) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}
// 새 기능의 행동 지침은 templates/system-add/*.md 에 둔다. 파일 첫 줄의 마커(<!-- … -->)가 .system.md 에 아직 없을 때만 맨 끝에 덧붙인다 —
// 주인이 손본 .system.md(성격 등)는 지우지 않고 새 규칙만 더해진다
const ADD_DIR = path.join(__dirname, 'templates', 'system-add');
for (const f of fs.existsSync(ADD_DIR) ? fs.readdirSync(ADD_DIR).sort() : []) {
  const text = fs.readFileSync(path.join(ADD_DIR, f), 'utf8'), marker = text.split(/\r?\n/)[0].trim(), cur = fs.readFileSync(SYSTEM_FILE, 'utf8');
  if (marker.startsWith('<!--') && !cur.includes(marker)) fs.appendFileSync(SYSTEM_FILE, (cur.endsWith('\n') ? '' : '\n') + '\n' + text);
}
const PRIVATE_FILES = ['users.json', 'sessions.json', 'share.json', 'settings.json', '임시비밀번호.txt']; // 비밀번호 해시·로그인 기록·공유 링크·텔레그램 봇 토큰·연습용 임시 비밀번호는 두뇌도 못 보게 막는다
// 비서가 고치지 못하는 파일 (읽기만 가능): 자기 지침(성격·스킬), 그리고 claude 가 작업 폴더에서 몰래 읽는 지침·설정 파일 이름들
const READONLY_FILES = ['.system.md', '.claude/**', 'CLAUDE.md', 'CLAUDE.local.md', '**/CLAUDE.md', '**/CLAUDE.local.md', '.mcp.json'];
// 5편 점검: claude 는 작업 폴더(data/)의 CLAUDE.local.md 를 숨은 지침으로, .claude/settings*.json 을 설정(훅·허용 규칙)으로 읽는다 (진짜 claude 로 확인:
// 숨은 지침을 그대로 따랐고, 훅은 켤 때마다 명령을 돌렸고, 허용 규칙은 data 밖 파일까지 읽게 했다). 비서나 메일 속 지시가 이런 파일을 심으면 권한을 꺼도 남는다.
// → claude 를 띄우기 직전에 있으면 이름을 바꿔(지우지 않고) 꺼 두고 알림으로 알린다. 꺼 두지 못하면 실행하지 않는다
const PLANTED = ['CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
function disarmPlanted() { // 문제가 있으면 쉬운 한국어 이유, 없으면 ''
  for (const rel of PLANTED) {
    const f = path.join(DATA_DIR, rel);
    if (!fs.existsSync(f)) continue;
    const to = `${f}.꺼둠-${Date.now()}`;
    try { fs.renameSync(f, to); } catch { return `data/${rel} 을(를) 꺼 두지 못해서 실행하지 않았어요. 그 파일을 확인해 주세요.`; }
    addNotice('비서 설정 파일을 꺼 두었어요', `data/${rel} 이(가) 생겨 있어서 이름을 바꿔(${path.basename(to)}) 꺼 두었어요. 이 파일은 비서에게 숨은 지시나 넓은 권한을 줄 수 있어요. 직접 만든 게 아니면 내용을 확인하고 지워 주세요.`, '주의');
  }
  return '';
}
const BRAIN_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch'];

// ---------- 권한 (설정 → 권한): data/settings.json 의 "권한". 기본은 전부 꺼짐 ----------
// settings.json 은 두뇌가 못 읽는 파일(PRIVATE_FILES)이라 비서가 스스로 권한을 켤 수 없다. 켜고 끄는 건 주인이 설정 화면에서만
const PERM_KEYS = ['연결된앱', '명령실행', '홈폴더'];
const permsOf = (st) => Object.fromEntries(PERM_KEYS.map((k) => [k, !!(st && st.권한 && st.권한[k] === true)])); // { 연결된앱, 명령실행, 홈폴더 } 모두 true/false (true 가 아니면 꺼짐)
function readPerms() { try { return permsOf(loadSettings()); } catch { return permsOf(null); } } // 파일이 없거나 깨졌으면 전부 꺼짐 (안전한 쪽)
// 이 스위치들은 주인(관리자)의 Gmail·이 PC 를 여는 열쇠라서 관리자의 비서에게만 적용한다. 일반 사용자의 비서는 스위치가 켜져 있어도 늘 꺼짐
const permsFor = (u) => (isAdmin(u) ? readPerms() : permsOf(null));
// 연결된 앱(Gmail·캘린더·드라이브)의 도구 이름. 이 PC 의 claude 2.1.291 이 시작할 때 알려 준 이름 그대로다 (mcp__claude_ai_<서버>__<도구>).
// use: 켜면 바로 쓰는 것(읽기·초안·일정/문서 만들기·고치기) / send: 메일 보내기, 주인이 "보낼까요?"에 "네" 한 바로 그 차례에만 / block: 늘 막음(삭제·휴지통·공유·덮어쓰기·초대 응답·스팸·꼬리표)
// 목록에 없는 새 도구는 허용 목록에 없으니 저절로 막힌다
const APP_TOOLS = {
  Gmail: {
    use: ['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft', 'create_draft', 'update_draft'],
    send: ['send_message', 'reply', 'forward'],
    block: ['apply_sensitive_message_label', 'apply_sensitive_thread_label', 'create_label', 'delete_draft', 'delete_label', 'label_message', 'label_thread', 'mark_message_spam',
      'mark_thread_spam', 'trash_message', 'trash_thread', 'unlabel_message', 'unlabel_thread', 'unmark_message_spam', 'unmark_thread_spam', 'untrash_message', 'untrash_thread',
      'update_label', 'update_message_labels'],
  },
  // 캘린더 만들기·고치기는 참석자를 넣으면 구글이 초대 메일을 보낸다 (5편 점검) → 메일처럼 주인의 확인("등록할까요?"→"네") 뒤에만
  Google_Calendar: { use: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'], confirm: ['create_event', 'update_event'], block: ['delete_event', 'respond_to_event'] },
  Google_Drive: { use: ['search_files', 'list_recent_files', 'get_file_metadata', 'get_file_permissions', 'read_file_content', 'download_file_content', 'create_file', 'copy_file'],
    block: ['share_file', 'trash_file', 'update_file'] },
};
const appNames = (kind) => Object.entries(APP_TOOLS).flatMap(([srv, g]) => (g[kind] || []).map((t) => `mcp__claude_ai_${srv}__${t}`));
const SHELL_TOOLS = process.platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash'];
const HOME_SECRETS = ['.ssh/**', '.aws/**', '.gnupg/**', '.claude/**', '.claude.json', 'AppData/**']; // 홈 폴더를 읽게 해도 로그인 열쇠가 있는 곳은 늘 막는다

// 확인 문: 직전에 비서가 "보낼까요?"(메일) 또는 "등록할까요?"(구글 캘린더) 라고 물었고, 주인이 "네"·"보내 줘" 처럼 짧게 답했을 때만
// 그 한 차례에 그 도구를 연다 ("네 근데 제목 바꿔" 처럼 다른 말이 섞이면 열지 않는다 — 비서가 고친 뒤 다시 묻는다).
// 5편 점검: 도구를 열기만 하면 그 차례에 메일을 여러 통, 보여 주지 않은 주소로도 보낼 수 있었다 → 문지기(mailgate.js, claude 의 PreToolUse 훅)가
// 보내기 직전에 받는 사람이 비서가 보여 준 주소 안에 있는지 보고, 메일은 한 통만 통과시킨다
const MAIL_YES = /^(?:(?:네|넵|예|응|그래|좋아요?|오케이|ok|okay|yes|y)[\s,.!~]*)?(?:(?:보내|발송|등록)(?:해)?\s*(?:줘|주세요|요|라|봐)?[\s,.!~]*)?$/i;
const GATES = { send: { ask: '보낼까요?', tools: appNames('send'), once: true }, calendar: { ask: '등록할까요?', tools: appNames('confirm'), once: false } };
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const GATE_SCRIPT = path.join(__dirname, 'mailgate.js').replace(/\\/g, '/');
function confirmedGate(chat, content) { // null | { kind, tools, once, emails(비서가 보여 준 주소들) }
  const last = chat.messages[chat.messages.length - 1], s = content.trim();
  if (!last || last.role !== 'assistant' || !s || !MAIL_YES.test(s)) return null;
  const kind = Object.keys(GATES).find((k) => last.content.includes(GATES[k].ask));
  return kind ? { kind, tools: GATES[kind].tools, once: GATES[kind].once, emails: [...new Set((last.content.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))] } : null;
}

// unattended: 주인이 보고 있지 않은 실행(예약·메일정리 단추). 메일 속 지시 같은 것 때문에 명령이 돌지 않게 명령 실행 도구는 권한이 켜져 있어도 주지 않는다 (5편 점검)
// 다른 사람의 개인 폴더(대화·기억·예약)는 읽지도 고치지도 못하게 한다 — 사람마다 따로라는 약속이 비서를 통해 새지 않게
const othersDeny = (u) => readJson(USERS_FILE, []).filter((o) => o.username !== u.username && USER_RE.test(o.username))
  .flatMap((o) => ['Read', 'Edit', 'Write'].map((t) => `${t}(./users/${o.username}/**)`));
function brainArgs({ gate = null, unattended = false, user } = {}) { // claude 를 띄울 때마다 지금 권한으로 새로 만든다 (스위치를 바꾸면 다음 말부터 적용)
  const P = permsFor(user), apps = P.연결된앱, sh = P.명령실행 && !unattended ? SHELL_TOOLS : [];
  const gated = apps && gate ? gate.tools : [], held = [...appNames('send'), ...appNames('confirm')].filter((t) => !gated.includes(t));
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'sonnet',
    // 비서는 이 PC 의 Claude Code 를 그대로 쓰지만, 개발할 때의 것은 싣지 않는다 (4편 점검에서 찾음):
    //  - 주인 PC 의 설정(user)·상위 폴더의 개발용 CLAUDE.md(project)·플러그인 훅·전역 스킬 → 'local' 만 읽는다. 상위 my-agent 를 "프로젝트"로 착각해 스킬 문서를 엉뚱한 곳에서 찾던 원인
    //  - 메일·슬랙·드라이브 같은 커넥터(MCP) → 하나도 싣지 않는다 (밖으로 보내는 통로가 되지 않게)
    //  - 쓸 수 있는 도구 자체를 7개(+ 권한으로 켠 것)로 고정한다 (예약 만들기·알림 보내기 같은 Claude Code 기본 도구도 빼려고)
    // 연결된 앱을 켜면 예외: 연결된 앱은 'user' 설정을 읽어야만 나타나고 --strict-mcp-config 는 그것까지 막는다 (이 PC 에서 직접 확인).
    // 그래서 user 를 읽되 훅은 끄고(disableAllHooks), 허용 목록에 있는 도구만 쓰게 한다 — 나머지 커넥터·플러그인 도구는 허용 목록에 없어 거절된다
    // 연결된 앱을 켜면 ToolSearch(도구 찾기, 읽기만)도 더한다: 다른 커넥터 도구 60여 개의 설명이 통째로 실려 대화 시작마다 토큰이 12배(6.6천 → 8만)로 늘던 것을, 이름만 싣고 필요할 때 찾아 쓰게 해서 1.2만으로 줄인다 (이 PC 에서 측정)
    '--setting-sources', apps ? 'user,local' : 'local', '--disable-slash-commands', '--tools', [...BRAIN_TOOLS, ...(apps ? ['ToolSearch'] : []), ...sh].join(','),
    ...(apps ? [] : ['--strict-mcp-config']),
    // 훅은 늘 끈다 (사용자·플러그인·심어진 훅이 돌지 않게). 주인이 "네" 한 그 차례에만 우리 문지기(mailgate.js)를 훅으로 건다
    '--settings', JSON.stringify(gated.length ? { hooks: { PreToolUse: [{ matcher: gated.join('|'), hooks: [{ type: 'command', command: `node "${GATE_SCRIPT}"` }] }] } } : { disableAllHooks: true }),
    // 파일 도구는 data/ 안(./**)으로만 허용한다. 범위 없이 'Read' 만 쓰면 PC 의 모든 파일을 읽고 쓸 수 있다. 명령 실행은 권한을 켰을 때만
    '--allowedTools', ...['Read', 'Glob', 'Grep', 'Edit', 'Write'].map((t) => `${t}(./**)`), 'WebSearch', 'WebFetch', ...sh,
    ...(P.홈폴더 ? ['Read', 'Glob', 'Grep'].map((t) => `${t}(~/**)`) : []), // 홈 폴더는 읽기만 (고치기·쓰기는 ./** 밖이라 안 됨)
    ...(apps ? [...appNames('use'), ...gated] : []),
    '--disallowedTools', ...(P.명령실행 ? [] : ['Bash', 'PowerShell']), ...PRIVATE_FILES.flatMap((f) => ['Read', 'Edit', 'Write'].map((t) => `${t}(./${f})`)),
    ...READONLY_FILES.flatMap((f) => ['Edit', 'Write'].map((t) => `${t}(./${f})`)), ...othersDeny(user),
    // 명령을 켜면 셸로 비밀 파일을 열거나 지침을 고칠 수 있다. 이름이 드러난 명령은 막는다 (ponytail: 이름을 돌려 쓰는 꼼수까지는 못 막는다 — 8편 안전장치에서 더 조인다)
    // 'claude' 가 든 명령도 막는다: 명령 창에서 claude 를 또 띄우면 이 모든 제한이 없는 비서가 되어 메일까지 보낼 수 있다 (5편 점검)
    ...sh.flatMap((t) => [...PRIVATE_FILES, '.system.md', '.claude', 'claude', 'CLAUDE'].map((f) => `${t}(*${f}*)`)),
    ...(P.홈폴더 ? HOME_SECRETS.flatMap((f) => ['Read', 'Glob', 'Grep'].map((t) => `${t}(~/${f})`)) : []),
    ...(apps ? [...appNames('block'), ...held] : []),
    ...(P.홈폴더 ? ['--add-dir', os.homedir()] : []),
    '--append-system-prompt-file', SYSTEM_FILE,
  ];
}
// 테스트에서는 진짜 claude 대신 가짜 스크립트를 쓴다
const BRAIN_CMD = process.env.SANCHO_BRAIN_SCRIPT ? [process.execPath, process.env.SANCHO_BRAIN_SCRIPT] : ['claude'];
const TOOL_LABELS = { Read: '파일 읽는 중', Glob: '파일 찾는 중', Grep: '내용 검색 중', Edit: '파일 고치는 중', Write: '파일 쓰는 중',
  WebSearch: '웹 검색 중', WebFetch: '웹 페이지 읽는 중', Bash: '명령 실행 중', PowerShell: '명령 실행 중' };
const APP_LABELS = { Gmail: '메일 확인 중', Google_Calendar: '캘린더 확인 중', Google_Drive: '드라이브 확인 중' };
function toolLabel(name) { // 연결된 앱은 어느 앱인지 보이게 (메일 보내기는 따로 눈에 띄게)
  const m = /^mcp__claude_ai_(Gmail|Google_Calendar|Google_Drive)__(.+)$/.exec(name || '');
  return m ? (appNames('send').includes(name) ? '메일 보내는 중' : APP_LABELS[m[1]]) : TOOL_LABELS[name] || '도구 쓰는 중';
}
const BRAIN_MAX_MS = Number(process.env.SANCHO_BRAIN_MAX_MS) || 10 * 60 * 1000; // 점검에서만 짧게 줄인다
const EXIT_GRACE_MS = 1500; // claude 가 끝난 뒤 남은 출력을 기다리는 시간 (그 뒤엔 출력 통로가 안 닫혀도 마무리)
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

// 실행할 때마다 두뇌에게 알려 주는 주인 이름·날짜·시각 (예약 시각을 말로 계산하려면 지금 시각을 알아야 한다)
// 스킬 문서의 정확한 위치도 알려 준다: 예전에는 상위 my-agent 폴더에서 찾다가 "읽기 권한 없음"으로 못 읽었다
const SKILL_HINT = `작업 폴더: ${DATA_DIR}. 스킬 문서(platform·wbs·mail·office-docs)는 작업 폴더 안 .claude/skills/<이름>/SKILL.md 에 있으니 Read 도구로 읽는다 (예: ${path.join(DATA_DIR, '.claude', 'skills', 'platform', 'SKILL.md')}). 작업 폴더 밖은 읽을 수 없다.`;
// 여러 사람이 쓰므로 누구의 비서인지도 알려 준다: 개인 폴더(기억·예약·일지가 있는 곳)와 역할. 지침에 적힌 memory.md·schedule.json·journal/ 은 이 폴더 안의 것이다
const userHint = (u) => `이 사람의 개인 폴더: users/${u.username}/ (작업 폴더 기준). 지침의 memory.md·schedule.json·journal/ 은 모두 이 폴더 안의 것이다: users/${u.username}/memory.md · users/${u.username}/schedule.json · users/${u.username}/journal/<날짜>.md. data/ 바로 아래의 memory.md·schedule.json·journal/ 은 쓰지 않는다. 다른 사람의 폴더(users/ 아래 다른 이름)는 열지 않는다. 역할: ${isAdmin(u) ? '관리자' : '일반 사용자'}${u.dept ? `, 부서: ${u.dept}` : ''}.`;
const brainCtx = (u, d = new Date()) => `주인 이름: ${u.name}. 오늘 날짜: ${d.toLocaleDateString('sv-SE')} (${d.toLocaleDateString('ko-KR', { weekday: 'long' })}). 현재 시각: ${d.toTimeString().slice(0, 5)}. ${userHint(u)} ${SKILL_HINT}`;

// 두뇌가 실패했을 때 이유를 쉬운 한국어로 — 대화(streamReply)와 예약(askBrainOnce)이 같이 쓴다
const STALE_SESSION_MSG = '이전 대화의 기억을 찾지 못했습니다. 같은 말을 한 번 더 보내시면 새 기억으로 시작합니다.';
function explainBrain({ spawnErr, timedOut, result, errText, limit }) {
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
  if (/no conversation found/i.test(raw)) return STALE_SESSION_MSG;
  return `Claude 가 오류로 끝났습니다. ${raw.trim().slice(0, 200)}`;
}

// ---------- 파일: 첨부(data/uploads/) · 비서가 만든 문서(data/파일함/) ----------
// 첨부: 화면의 ＋·끌어다 놓기·붙여넣기가 POST /api/uploads 로 올리면 data/uploads/ 에 저장하고, 말을 보낼 때 그 경로를 비서에게 넘긴다 (이미지·PDF·CSV 는 Read 로 읽힌다).
// 문서: 비서가 엑셀·워드·PPT 를 만들어 data/파일함/ 에 저장하면, 서버가 대화 전후의 폴더를 비교해 새로 생긴 파일을 채팅에 파일 카드(보기·열기·받기)로 알린다.
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads'), BOX_DIR = path.join(DATA_DIR, '파일함'), BOXES = { uploads: UPLOADS_DIR, 파일함: BOX_DIR };
for (const d of Object.values(BOXES)) fs.mkdirSync(d, { recursive: true });
const officeview = require('./officeview.js');
const UPLOAD_MAX = Number(process.env.SANCHO_UPLOAD_MAX) || 25 * 1024 * 1024; // 점검에서만 줄인다
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|ps1|psm1|vbs|vbe|wsf|lnk|reg|dll|jar|hta|cpl)$/i; // 더블클릭하면 실행되는 것은 올리지 못하게
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const INLINE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']); // 브라우저가 그 자리에서 보여 줘도 안전한 것만. html·svg 는 우리 사이트 권한으로 돌 수 있어 늘 내려받기로만
const OPEN_EXT = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'csv', 'pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp']); // "열기"로 이 PC 의 프로그램에 맡겨도 되는 것 (실행 파일은 안 됨)
const OPEN_CMD = process.env.SANCHO_OPEN_SCRIPT ? [process.execPath, process.env.SANCHO_OPEN_SCRIPT] : process.platform === 'win32' ? ['explorer.exe'] : process.platform === 'darwin' ? ['open'] : ['xdg-open'];
const extOf = (n) => path.extname(n).slice(1).toLowerCase();
const shownName = (f) => f.replace(/^\d{8}-\d{6}-[0-9a-f]{4}_/, ''); // 저장할 때 붙인 "날짜-시각-무작위_" 를 뗀 원래 이름
const mimeOf = (n) => MIME[extOf(n)] || 'application/octet-stream';
function safeName(raw) { // 폴더 부분·이상한 글자·너무 긴 이름을 걷어 낸 파일 이름
  let n = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) n = '파일';
  if (n.length > 100) { const e = path.extname(n).slice(0, 12); n = n.slice(0, 100 - e.length) + e; }
  return n;
}
const BOX_REAL = Object.fromEntries(Object.entries(BOXES).map(([k, d]) => [k, fs.realpathSync(d)])); // 서버를 켤 때의 진짜 위치
function boxFile(box, name) { // 그 폴더에 정확히 그 이름의 파일이 있을 때만 전체 경로를 돌려준다 (폴더 밖으로 못 나가고 숨김 파일은 없는 것으로)
  const dir = Object.hasOwn(BOXES, box) ? BOXES[box] : null;
  if (!dir || !name || name.startsWith('.') || /[\\/]/.test(name)) return null;
  try {
    if (!fs.readdirSync(dir).includes(name)) return null;
    // 5편 점검: 폴더 안에 다른 파일을 가리키는 연결(심볼릭·하드 링크)을 두거나 폴더 자체를 다른 곳으로 바꿔치기(정션)하면
    // 받기 주소로 data 밖이나 비밀 파일(users.json 등)이 샜다 → 진짜 그 폴더 안에 있는 보통 파일만 내보낸다
    const full = path.join(dir, name), st = fs.lstatSync(full);
    if (!st.isFile() || st.nlink > 1 || path.dirname(fs.realpathSync(full)) !== BOX_REAL[box]) return null;
    return full;
  } catch { return null; }
}
const fileInfo = (box, file) => ({ box, file, name: shownName(file), size: fs.statSync(path.join(BOXES[box], file)).size, ext: extOf(file) });
// 파일함의 지문 { 이름 → 수정시각:크기 }: 대화 전후로 비교해 "이번 대화에서 새로 생기거나 바뀐" 파일을 찾는다
// ponytail: 같은 시간에 다른 대화·예약이 만든 파일도 함께 잡힌다. 문제가 되면 대화마다 하위 폴더를 둔다
function boxSnap() {
  const m = new Map();
  try { for (const f of fs.readdirSync(BOX_DIR, { withFileTypes: true })) if (f.isFile() && !f.name.startsWith('.') && !f.name.startsWith('~$') && !f.name.endsWith('.tmp')) { const s = fs.statSync(path.join(BOX_DIR, f.name)); m.set(f.name, `${s.mtimeMs}:${s.size}`); } } catch { /* 폴더를 못 읽으면 없는 것으로 */ }
  return m;
}
const boxNew = (before) => [...boxSnap()].filter(([n, sig]) => before.get(n) !== sig).map(([n]) => fileInfo('파일함', n));
function readRaw(req, max) { // 파일 내용 그대로 받기. 한도를 넘으면 끝까지 흘려보내고(연결이 끊기지 않게) null
  return new Promise((resolve, reject) => {
    let size = 0, big = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) big = true; else if (!big) chunks.push(c); });
    req.on('end', () => resolve(big ? null : Buffer.concat(chunks))).on('error', reject);
  });
}
// POST /api/uploads?name=<파일이름> (본문은 파일 내용 그대로) → { file, name, size, type }. file 이 data/uploads/ 안의 저장 이름이고 대화에 붙일 때 쓴다
async function uploadApi(req, res) {
  if (req.method !== 'POST') return false;
  const name = safeName(new URL(req.url, 'http://x').searchParams.get('name'));
  const buf = await readRaw(req, UPLOAD_MAX).catch(() => undefined);
  if (buf === undefined) return send(res, 400, { error: '파일을 받지 못했어요. 다시 시도해 주세요.' }), true;
  if (buf === null) return send(res, 413, { error: `파일이 너무 커요. ${Math.floor(UPLOAD_MAX / 1048576) || '1 미만의 '}MB 까지 올릴 수 있어요.` }), true;
  if (BLOCKED_EXT.test(name)) return send(res, 400, { error: '실행 파일 같은 종류는 첨부할 수 없어요.' }), true;
  if (!buf.length) return send(res, 400, { error: '빈 파일이에요.' }), true;
  const now = new Date(), file = `${now.toLocaleDateString('sv-SE').replace(/-/g, '')}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}-${crypto.randomBytes(2).toString('hex')}_${name}`;
  if (fs.realpathSync(UPLOADS_DIR) !== BOX_REAL.uploads) return send(res, 500, { error: 'data/uploads 폴더가 다른 곳으로 바뀌어 있어서 저장하지 않았어요. 폴더를 확인해 주세요.' }), true; // 바꿔치기된 폴더로는 쓰지 않는다
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buf, { flag: 'wx' }); // 같은 이름이 이미 있으면 덮어쓰지 않고 실패
  return send(res, 200, { file, name, size: buf.length, type: mimeOf(name) }), true;
}
// GET /api/files/<uploads|파일함>/<이름>[?dl=1 | ?view=1] — 로그인한 사람만. 기본은 그 자리에서 보기(이미지·PDF 만), 나머지는 내려받기, view=1 은 미리보기용 글·표
function fileApi(res, box, name, q) {
  const full = boxFile(box, name);
  if (!full) return send(res, 404, { error: '없는 파일이에요.' });
  const ext = extOf(name);
  if (q.get('view')) {
    let v; try { v = officeview.viewFile(full, ext); } catch { v = { kind: 'none', error: '이 파일은 미리보기를 만들지 못했어요. ⬇ 받기나 열기를 써 주세요.' }; }
    if (v.kind === 'image' || v.kind === 'pdf') v.url = `/api/files/${encodeURIComponent(box)}/${encodeURIComponent(name)}`;
    return send(res, 200, v);
  }
  const disp = shownName(name), attach = !!q.get('dl') || !INLINE_EXT.has(ext);
  res.writeHead(200, { 'Content-Type': mimeOf(name), 'Content-Length': fs.statSync(full).size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    'Content-Disposition': `${attach ? 'attachment' : 'inline'}; filename="${disp.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(disp)}` });
  fs.createReadStream(full).pipe(res);
}
// POST /api/files/open { box, name } — 이 PC 에 설치된 프로그램(워드·엑셀 등)으로 연다. 폴더 안의 문서·그림 형식만 (실행 파일은 안 됨)
async function openApi(req, res) {
  let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
  const full = boxFile(String(b.box || ''), String(b.name || ''));
  if (!full) return send(res, 404, { error: '없는 파일이에요.' });
  if (!OPEN_EXT.has(extOf(full))) return send(res, 400, { error: '이 형식은 열 수 없어요. ⬇ 받기를 써 주세요.' });
  const [cmd, ...a] = OPEN_CMD;
  const err = await new Promise((ok) => { try { const c = spawn(cmd, [...a, full], { detached: true, stdio: 'ignore' }); c.once('error', ok); c.once('spawn', () => { c.unref(); ok(null); }); } catch (e) { ok(e); } });
  return err ? send(res, 500, { error: '이 PC 에서 파일을 열지 못했어요. ⬇ 받기로 내려받아 열어 주세요.' }) : send(res, 200, { ok: true });
}
const ATTACH_NOTE = (atts) => `\n\n[첨부한 파일] 아래 파일을 도구로 읽고 답한다 (경로는 작업 폴더 기준). 이미지·PDF·텍스트·CSV 는 Read 로 바로 읽힌다. 엑셀·워드는 office-docs 스킬(.claude/skills/office-docs/SKILL.md)의 방법으로 읽는다.\n${atts.map((a) => `- uploads/${a.file} (원래 이름: ${a.name})`).join('\n')}`;

function streamReply(res, chat, content, user, atts = []) {
  if (running.has(chat.id)) return send(res, 409, { error: '이 대화는 아직 답하는 중입니다. 끝난 뒤에 보내 주세요.' });
  running.add(chat.id);
  const gate = confirmedGate(chat, content); // 새 말을 대화에 넣기 전에 본다: 바로 앞이 비서의 "보낼까요?"·"등록할까요?" 였는지
  // 문지기에게 넘길 확인 내용(보여 준 주소·한 통만). data 밖 임시 폴더에 둬서 비서의 파일 도구로는 못 고친다. 이번 차례가 끝나면 지운다
  const gateFile = gate ? path.join(os.tmpdir(), `sancho-gate-${crypto.randomBytes(8).toString('hex')}.json`) : null;
  if (gateFile) fs.writeFileSync(gateFile, JSON.stringify({ tools: gate.tools, emails: gate.emails, once: gate.once }));
  const boxBefore = boxSnap();
  chat.messages.push({ role: 'user', content, at: nowIso(), ...(atts.length ? { attachments: atts } : {}) });
  if (chat.title === '새 대화') chat.title = content.replace(/\s+/g, ' ').slice(0, 30);
  saveChat(user, chat);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const args = [...BRAIN_CMD.slice(1), ...(chat.sessionId ? ['--resume', chat.sessionId] : []), ...brainArgs({ gate, user }), '--append-system-prompt', brainCtx(user)];
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
      chat.sessionId = ev.session_id; saveChat(user, chat); // 다음 말에 --resume 으로 이어가려고 저장
    }
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
      const e = ev.event || {};
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
        emit(`${gap()}⏺ ${toolLabel(e.content_block.name)}\n\n`);
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') emit(e.delta.text);
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') limit = ev.rate_limit_info;
    else if (ev.type === 'result') result = ev;
  }

  function explain() {
    const why = explainBrain({ spawnErr, timedOut, result, errText, limit });
    if (why === STALE_SESSION_MSG) chat.sessionId = null; // 다음 말은 새 기억으로 시작
    return why;
  }

  function finish() {
    if (finished) return; finished = true; clearTimeout(cap);
    if (buf.trim()) onLine(buf);
    if (!aborted) {
      if (result && !result.is_error) { if (!sent.trim() && result.result) emit(result.result); }
      else emit(`${gap()}⚠ ${explain()}`);
    }
    if (!sent.trim()) sent = '(중지했습니다.)';
    let files = []; try { files = boxNew(boxBefore); } catch { /* 파일함을 못 읽으면 카드만 없다 */ }
    chat.messages.push({ role: 'assistant', content: sent, at: nowIso(), ...(files.length ? { files } : {}) }); // 중지해도 지금까지 받은 만큼 저장
    saveChat(user, chat);
    running.delete(chat.id);
    if (gateFile) for (const f of [gateFile, `${gateFile}.used`]) fs.rmSync(f, { force: true });
    if (!res.destroyed) { if (files.length) res.write(`event: files\ndata: ${JSON.stringify(files)}\n\n`); res.write('event: done\ndata: {}\n\n'); res.end(); }
  }

  // 실행 자체가 그 자리에서 실패해도 화면이 ■ 에 멈추지 않게 바로 마무리한다
  const planted = disarmPlanted(); // 심어진 지침·설정 파일이 있으면 꺼 두고, 못 끄면 실행하지 않는다
  if (planted) { spawnErr = new Error(planted); return finish(); }
  try { child = spawn(BRAIN_CMD[0], args, { cwd: DATA_DIR, env: { ...brainEnv(), ...(gateFile ? { SANCHO_GATE: gateFile } : {}) }, windowsHide: true }); } catch (e) { spawnErr = e; return finish(); }
  cap = setTimeout(() => { timedOut = true; killTree(child); }, BRAIN_MAX_MS);
  child.stdout.setEncoding('utf8'); // 조각 경계에서 한글(3바이트)이 깨지지 않게
  child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } });
  child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
  child.stdin.on('error', () => {});
  child.on('error', (e) => { spawnErr = e; finish(); });
  child.on('close', finish);
  // 5편 점검: claude 가 끝났는데 claude 가 띄운 프로그램(멈춘 python 등)이 출력 통로를 붙잡고 남으면 'close' 가 오지 않아 화면이 ■ 에 멈췄다.
  // claude 자체가 끝나면(exit) 남은 출력을 1.5초 더 받고 마무리한다
  child.on('exit', () => setTimeout(finish, EXIT_GRACE_MS));
  child.stdin.end(atts.length ? content + ATTACH_NOTE(atts) : content); // 사용자 말은 명령줄이 아니라 표준입력으로 (첨부가 있으면 파일 경로를 덧붙여)
  res.on('close', () => { if (!finished) { aborted = true; killTree(child); } }); // ■ 중지 → claude 끄기
}

// ---------- 예약 (data/users/<아이디>/schedule.json — 사람마다 따로): 30초마다 시계를 보고, 때가 된 예약의 지시문을 그 사람의 새 세션 두뇌에 보낸다 ----------
// 시각 계산·형식 검사는 scheduler.js. 여기는 파일 읽고 쓰기, 두뇌 실행, 일지(그 사람 폴더의 journal/<날짜>.md)·알림(notices) 쌓기만 한다.
const sched = require('./scheduler.js');
const scheduleFile = (u) => userFile(u, 'schedule.json');
const runningFile = (u) => userFile(u, 'schedule-running.json');
const skey = (u, id) => `${u.username}/${id}`; // 사람이 달라도 예약 id 가 같을 수 있어서 "아이디/예약id" 로 센다
const TICK_MS = Number(process.env.SANCHO_TICK_MS) || 30_000; // 점검에서만 짧게 줄인다
const schedRunning = new Set(); // 지금 도는 예약(skey) — 같은 예약이 겹쳐 돌지 않게
const warned = new Set(); // 이미 알림으로 알린 문제 (30초마다 같은 알림이 쌓이지 않게)
const wasOff = new Set(); // 꺼 둔 걸 본 예약(skey) — 다시 켜진 순간을 알아보려고
// 지금 도는 예약 { id: { 이름, 시작 } } (사람 폴더의 schedule-running.json) — 도는 도중에 서버(컴퓨터)가 꺼졌는지 다음에 켤 때 알아보려고
const markRunning = (u, id, info) => { const m = readJson(runningFile(u), {}); if (info) m[id] = info; else delete m[id]; writeJson(runningFile(u), m); };
const CLOCK_SLACK_MS = 10 * 60 * 1000; // 마지막실행이 지금보다 이만큼 넘게 "미래"면 시계가 되돌아간 것으로 본다
const DETAIL_MAX = 20_000; // 알림에 담는 결과 전체의 한도. 화면이 알림을 고쳐 저장할 때 보내는 크기 제한(200KB)을 넘지 않게. 전체는 일지에 있다
// 알림(data/db/notices.json)에 한 줄 — 열려 있는 대시보드는 파일 감시로 바로 따라 바뀐다. detail 은 "누르면 보이는 결과 전체".
// owner(아이디)가 있으면 그 사람에게만 보인다 (예약 결과에는 개인 내용이 있어서). 없으면 모두에게 보이는 공지
function addNotice(title, body, level, detail, owner) {
  let items; try { items = loadCollection('notices'); } catch { return console.error('data/db/notices.json 이 올바른 목록이 아니라 알림을 넣지 못했어요. (덮어쓰지 않았어요)'); }
  const n = { id: crypto.randomBytes(4).toString('hex'), title, body, level, at: nowIso(), read: false, ...(owner ? { owner } : {}) };
  if (detail) n.detail = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}\n\n…(길어서 여기까지만 담았어요. 전체는 일지 파일에 있어요.)` : detail;
  items.push(n);
  writeJson(dbFile('notices'), items);
}
function warnOnce(key, title, body, owner) { if (!warned.has(key)) { warned.add(key); addNotice(title, body, '주의', undefined, owner); } }

function loadSchedule(u) { // 파일이 없으면 빈 목록, 깨져 있으면 예외 (모르고 덮어써서 예약을 잃지 않게)
  let raw; try { raw = fs.readFileSync(scheduleFile(u), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const v = JSON.parse(raw.replace(/^﻿/, ''));
  if (!Array.isArray(v)) throw new Error('not an array');
  return v;
}

// 화면 없이 두뇌에 한 번 묻고 끝 결과만 받는다. 대화와 같은 두뇌·같은 도구 제한(brainArgs), 새 세션(--resume 없음). 절대 reject 하지 않는다
// 주인이 없으니 메일 보내기·캘린더 등록은 늘 막히고(확인 문 없음), 명령 실행 도구도 주지 않는다 (unattended)
// ponytail: 띄우고 줄 읽는 부분이 streamReply 와 닮았다. 대화는 점검이 촘촘해서 건드리지 않았다. 고칠 곳이 세 군데가 되면 spawnBrain 으로 합친다
function askBrainOnce(prompt, ctx, user) {
  return new Promise((resolve) => {
    let buf = '', errText = '', result = null, limit = null, spawnErr = null, timedOut = false, child = null, cap = null, settled = false;
    const onLine = (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'result') result = ev;
      else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') limit = ev.rate_limit_info;
    };
    const end = () => {
      if (settled) return; settled = true; clearTimeout(cap);
      if (buf.trim()) onLine(buf);
      resolve(result && !result.is_error ? { ok: true, text: String(result.result || '').trim() } : { ok: false, text: explainBrain({ spawnErr, timedOut, result, errText, limit }) });
    };
    const planted = disarmPlanted();
    if (planted) { spawnErr = new Error(planted); return end(); }
    try { child = spawn(BRAIN_CMD[0], [...BRAIN_CMD.slice(1), ...brainArgs({ unattended: true, user }), '--append-system-prompt', ctx], { cwd: DATA_DIR, env: brainEnv(), windowsHide: true }); } catch (e) { spawnErr = e; return end(); }
    cap = setTimeout(() => { timedOut = true; killTree(child); }, BRAIN_MAX_MS);
    child.stdout.setEncoding('utf8'); // 조각 경계에서 한글(3바이트)이 깨지지 않게
    child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } });
    child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { spawnErr = e; end(); });
    child.on('close', end);
    child.on('exit', () => setTimeout(end, EXIT_GRACE_MS)); // 남은 프로그램이 출력 통로를 붙잡아도 멈추지 않게 (대화와 같은 이유)
    child.stdin.end(prompt);
  });
}

// ---------- 텔레그램 배달 (선택): data/settings.json 의 { telegram: { botToken, chatId } } ----------
// 봇 토큰은 비밀번호와 같다: 이 파일에만 있고, 화면에는 "****" 로만 보내고(서버가 값을 아예 안 보냄), 두뇌는 이 파일을 못 읽고(PRIVATE_FILES),
// 로그·알림·일지·오류 글에도 안 남긴다. 예약에 "휴대폰": true 가 있을 때만, 결과 요약(400자까지)만 텔레그램 서버로 나간다 (회사 밖으로 나가는 유일한 통로)
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TG_API = (process.env.SANCHO_TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, ''); // 점검에서만 가짜 서버 주소로 바꾼다
const TG_SUMMARY_MAX = 400;
const TG_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/, TG_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
function loadSettings() { // 파일이 없으면 빈 설정, 깨져 있으면 예외 (모르고 덮어써서 지우지 않게)
  let raw; try { raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const v = JSON.parse(raw.replace(/^﻿/, ''));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v;
}
function tgConf() { // 둘 다 있으면 { token, chatId }, 아니면 null
  try {
    const t = loadSettings().telegram || {}, token = String(t.botToken ?? ''), chatId = String(t.chatId ?? '');
    return token && chatId ? { token, chatId } : null;
  } catch { return null; }
}
function explainTelegram(status, desc) { // 텔레그램이 거절한 이유를 쉬운 한국어로
  const d = String(desc || '');
  if (status === 401 || status === 404) return '봇 토큰이 맞지 않아요. BotFather 가 준 긴 글자를 다시 붙여 넣어 주세요.';
  if (/chat not found/i.test(d)) return '채팅 ID 가 맞지 않아요. 숫자를 다시 확인해 주세요.';
  if (status === 403) return '봇이 메시지를 보낼 수 없어요. 휴대폰 텔레그램에서 내 봇을 열고 시작(Start)을 먼저 눌러 주세요.';
  if (status === 429) return '텔레그램이 너무 자주 보낸다며 잠시 막았어요. 조금 뒤에 다시 해 주세요.';
  return `텔레그램이 거절했어요. (${status}${d ? `: ${d.slice(0, 100)}` : ''})`;
}
async function sendTelegram(text) { // { ok: true } | { ok: false, error: 쉬운 한국어 이유 } — 절대 던지지 않고, 토큰을 글에 남기지 않는다(오류 글에 주소를 넣지 않는다)
  const c = tgConf();
  if (!c) return { ok: false, error: '텔레그램 설정(봇 토큰·채팅 ID)이 비어 있어요. 설정 화면의 "텔레그램 배달"에서 입력해 주세요.' };
  try {
    const r = await fetch(`${TG_API}/bot${c.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c.chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok ? { ok: true } : { ok: false, error: explainTelegram(r.status, j.description) };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '텔레그램이 10초 안에 답하지 않았어요. 인터넷 연결을 확인해 주세요.' : '텔레그램에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.' };
  }
}
// 폰 화면에 읽기 좋게: 마크다운 기호(굵게·제목·표 구분줄)를 걷어 내고 N자까지만
const plainSummary = (t, max) => { const s = t.replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '').replace(/^[\s|:-]*-{3,}[\s|:-]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim(); return s.length > max ? `${s.slice(0, max)}…` : s; };

// /api/settings[/telegram[/test]|/permissions] — 설정 화면이 쓴다. 처리했으면 true
//   GET /api/settings → { telegram: { token: "****"|"", chatId: "****"|"" }, permissions: { 연결된앱, 명령실행, 홈폴더 } }  (텔레그램 값 자체는 절대 안 보낸다)
//   PUT /api/settings/telegram { token?, chatId? } (비운 칸은 그대로 둠) · DELETE → 지움 · POST /test → 시험 메시지 한 통
//   PUT /api/settings/permissions { 연결된앱?, 명령실행?, 홈폴더? } (true/false 만, 보낸 칸만 바뀜) → { permissions }
async function settingsApi(req, res, sub, test) {
  const M = req.method, done = (status, body) => { send(res, status, body); return true; };
  let b = {};
  if (sub && !test && M === 'PUT') { try { b = await readBody(req); } catch { return done(400, { error: '요청이 올바르지 않습니다.' }); } }
  // 여기부터는 await 없이: 읽기→고치기→쓰기를 한 번에
  let st; try { st = loadSettings(); } catch { return done(500, { error: 'data/settings.json 이 올바른 JSON 이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.' }); }
  const t = st.telegram && typeof st.telegram === 'object' ? st.telegram : {};
  if (!sub) return M === 'GET' ? done(200, { telegram: { token: t.botToken ? '****' : '', chatId: t.chatId ? '****' : '' }, permissions: permsOf(st) }) : false;
  if (sub === 'permissions') {
    if (M !== 'PUT' || test) return false;
    const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
    if (!keys.length || !keys.every((k) => PERM_KEYS.includes(k) && typeof b[k] === 'boolean')) return done(400, { error: `바꿀 권한을 true/false 로 보내 주세요. (${PERM_KEYS.join('·')})` });
    st.권한 = { ...permsOf(st), ...b }; writeJson(SETTINGS_FILE, st);
    return done(200, { permissions: permsOf(st) });
  }
  if (!test && M === 'PUT') {
    const token = typeof b.token === 'string' ? b.token.trim() : '', chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
    if (!token && !chatId) return done(400, { error: '바꿀 값을 입력해 주세요.' });
    if (token && !TG_TOKEN.test(token)) return done(400, { error: '봇 토큰 모양이 맞지 않아요. "숫자:영문자…" 로 이어진 긴 글자예요. BotFather 가 준 것을 그대로 붙여 넣어 주세요.' });
    if (chatId && !TG_CHAT.test(chatId)) return done(400, { error: '채팅 ID 는 숫자예요. (예: 123456789 — 그룹은 -로 시작할 수 있어요)' });
    st.telegram = { botToken: token || t.botToken || '', chatId: chatId || t.chatId || '' };
    writeJson(SETTINGS_FILE, st); emitDb('schedule'); // 예약 칸의 "텔레그램 설정 필요" 표시가 따라 바뀌게
    return done(200, { ok: true });
  }
  if (!test && M === 'DELETE') { delete st.telegram; writeJson(SETTINGS_FILE, st); emitDb('schedule'); return done(200, { ok: true }); }
  if (test && M === 'POST') {
    if (!tgConf()) return done(400, { error: '봇 토큰과 채팅 ID 가 아직 비어 있어요. 도움말대로 봇을 만든 뒤 두 칸을 입력하고 [저장]을 눌러 주세요.' });
    const r = await sendTelegram('Sancho 시험 메시지예요. 이 글이 보이면 텔레그램 연결이 잘 된 거예요. 🎉');
    return r.ok ? done(200, { ok: true }) : done(502, { error: r.error });
  }
  return false;
}

async function runScheduled(e, u) { // u: 이 예약의 주인. 그 사람의 두뇌·일지·알림으로 돈다
  const key = skey(u, e.id);
  schedRunning.add(key); // 첫 await 전에 넣는다 (다음 점검이 끼어들기 전에)
  emitDb('schedule'); // 화면의 예약 칸이 "실행 중"을 보이게
  const name = String(e.이름 || e.id), t0 = new Date();
  markRunning(u, e.id, { 이름: name, 시작: t0.toISOString() }); // 끝나면 지운다. 남아 있으면 도중에 꺼진 것
  let r;
  try {
    r = await askBrainOnce(e.지시문, `${brainCtx(u, t0)} 이 실행은 예약("${name}")이 시작했다. 주인은 지금 보고 있지 않아 되물을 수 없다. 허락이 필요한 일(삭제 등)은 하지 말고 못 한 일로 적는다. 끝에 결과를 짧게 요약한다.`, u);
  } catch (err) { r = { ok: false, text: `실행하지 못했어요: ${err.message}` }; }
  finally { schedRunning.delete(key); markRunning(u, e.id, null); emitDb('schedule'); }
  const day = t0.toLocaleDateString('sv-SE'), file = userFile(u, 'journal', `${day}.md`), text = r.text || '(결과 글이 없어요)', title = `${r.ok ? '예약 결과' : '예약 실패'}: ${name}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${fs.existsSync(file) ? '' : `# ${day} 일지\n\n`}## ${t0.toTimeString().slice(0, 5)} ${r.ok ? '' : '⚠ '}${name}\n\n지시: ${e.지시문.replace(/\s+/g, ' ')}\n\n${text}\n\n`);
    addNotice(title, text.replace(/\s+/g, ' ').slice(0, 120), r.ok ? '안내' : '주의', text, u.username);
  } catch (err) { console.error('예약 결과를 적지 못했어요:', err.message); }
  // 텔레그램은 관리자의 휴대폰 하나에 연결돼 있어서, 다른 사람의 예약 결과를 거기로 보내지 않는다
  if (e.휴대폰 === true && isAdmin(u)) { // "휴대폰으로도 보내기"를 켠 예약만: 결과 요약을 텔레그램으로. 못 보내도 예약 결과는 이미 알림·일지에 있으니, 이유만 하루에 한 번 알린다
    const s = await sendTelegram(`${r.ok ? '🔔' : '⚠'} ${title}\n\n${plainSummary(text, TG_SUMMARY_MAX)}\n\n(전체는 컴퓨터의 알림에서 볼 수 있어요)`);
    if (!s.ok) warnOnce(`tg:${day}:${s.error}`, '텔레그램으로 보내지 못했어요', `"${name}": ${s.error}`, u.username);
  }
}

function scheduleTick() { // 사람마다 자기 예약 파일을 본다. 한 사람의 파일이 이상해도 다른 사람 것은 계속 돈다
  for (const u of readJson(USERS_FILE, [])) { try { scheduleTickFor(u); } catch (e) { console.error(`${u && u.username} 의 예약 점검 오류:`, e.message); } }
}
function scheduleTickFor(u) {
  const rel = `data/users/${u.username}/schedule.json`;
  let list; try { list = loadSchedule(u); warned.delete(`${u.username}:file`); } catch { return warnOnce(`${u.username}:file`, '예약 파일을 읽지 못했어요', `${rel} 이 올바른 JSON 목록이 아니에요. 고칠 때까지 예약이 멈춰 있어요. (파일은 덮어쓰지 않았어요)`, u.username); }
  const now = new Date(); let dirty = false;
  for (const e of list) {
    const why = sched.check(e);
    if (why) { warnOnce(`${u.username}:${e && e.id}:${why}`, '예약 하나를 건너뛰었어요', `"${(e && (e.이름 || e.id)) || '이름 없음'}": ${why} ${rel} 에서 고쳐 주세요.`, u.username); continue; }
    const key = skey(u, e.id);
    if (e.켬 === false) { wasOff.add(key); continue; }
    // 쉬던 예약을 다시 켰다(화면 스위치든 비서가 파일을 고쳤든): 지금부터 센다 — 쉬는 동안 놓친 회차가 켜자마자 돌지 않게
    // 마지막실행이 한참 미래다(컴퓨터 시계를 앞으로 잘못 맞췄다가 고침): 그대로 두면 그 시각까지 조용히 안 도니, 지금부터 다시 센다
    if (wasOff.delete(key) || Date.parse(e.마지막실행) - now > CLOCK_SLACK_MS) { e.마지막실행 = now.toISOString(); dirty = true; continue; }
    // 처음 보는 예약(마지막실행 없음)은 지금부터 센다 — 아침 9시 예약을 오후 3시에 만들었다고 바로 돌지 않게. 한 번만 하는 예약(once)은 시각이 지났으면 바로 돈다
    if (!e.마지막실행 && e.언제.종류 !== 'once') { e.마지막실행 = now.toISOString(); dirty = true; continue; }
    if (schedRunning.has(key) || !sched.isDue(e, now)) continue; // 실행 중이면 건너뛴다
    // 이번 회차는 "시작한 것"으로 지금 적는다 — 도중에 서버가 꺼지거나 실패해도 되풀이해 돌지 않는다 (실패는 알림으로 알린다)
    // ponytail: 여러 예약이 한꺼번에 때가 되면 claude 가 동시에 여러 개 뜬다. 한도에 자주 닿으면 한 줄로 세운다
    e.마지막실행 = now.toISOString(); dirty = true;
    runScheduled(e, u); // 끝나기를 기다리지 않는다
  }
  if (dirty) writeJson(scheduleFile(u), list); // 읽기→쓰기 사이에 기다림이 없어서 비서가 고친 내용을 덮어쓸 틈이 거의 없다
}

// /api/schedule[/<id>[/enable|/run]] — 화면의 예약 칸이 쓴다. 처리했으면 true (아니면 404 로 넘어간다)
//   GET /api/schedule → { items: [예약 + error(형식 이유|null) + running] }   DELETE /<id> → 지우기
//   POST /<id>/enable { on: true|false } → 켬/끔   POST /<id>/run → 지금 한 번 실행 (끝나기를 기다리지 않고 바로 답한다. 결과는 알림으로)
async function scheduleApi(req, res, id, act, user) { // 로그인한 사람 자신의 예약만 본다
  const M = req.method, done = (status, body) => { send(res, status, body); return true; };
  let b = {};
  if (id && (act === 'enable' || act === 'phone') && M === 'POST') { try { b = await readBody(req); } catch { return done(400, { error: '요청이 올바르지 않습니다.' }); } }
  // 여기부터는 await 없이 한 번에: 읽기→고치기→쓰기 사이에 서버 시계(scheduleTick)가 끼어들지 못한다
  if (act === 'phone' && !isAdmin(user)) return done(403, { error: '휴대폰(텔레그램) 배달은 관리자만 쓸 수 있어요.' }); // 텔레그램은 관리자의 휴대폰 하나에 연결돼 있다
  let list; try { list = loadSchedule(user); } catch { return done(500, { error: `data/users/${user.username}/schedule.json 이 올바른 JSON 목록이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.` }); }
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!id) return M === 'GET' ? done(200, { telegram: isAdmin(user) && !!tgConf(), items: list.map((e) => ({ ...(isObj(e) ? e : {}), error: sched.check(e), running: isObj(e) && schedRunning.has(skey(user, e.id)) })) }) : false; // telegram: 연결 설정이 있는지(값은 안 보냄)
  const i = list.findIndex((e) => isObj(e) && e.id === id);
  if (i < 0) return done(404, { error: '없는 예약입니다.' });
  const e = list[i];
  if (!act && M === 'DELETE') { list.splice(i, 1); writeJson(scheduleFile(user), list); return done(200, { ok: true }); } // 지우기 전 확인은 화면이 한다
  if ((act === 'enable' || act === 'phone') && M === 'POST') { // 켬/끔, 휴대폰(텔레그램)으로도 보내기 체크
    if (typeof b.on !== 'boolean') return done(400, { error: 'on 은 true 또는 false 여야 합니다.' });
    e[act === 'enable' ? '켬' : '휴대폰'] = b.on; writeJson(scheduleFile(user), list); // 다시 켠 순간 "지금부터 센다"는 서버 시계(scheduleTick)가 챙긴다
    return done(200, { ok: true });
  }
  if (act === 'run' && M === 'POST') { // 지금 한 번 — 예약 시각·마지막실행은 건드리지 않는다 (시험 삼아 돌려 보는 용도). 꺼 둔 예약도 돌릴 수 있다
    const why = sched.check(e);
    if (why) return done(400, { error: `이 예약은 형식이 맞지 않아 실행할 수 없어요: ${why}` });
    if (schedRunning.has(skey(user, id))) return done(409, { error: '이미 실행 중이에요. 끝나면 알림으로 알려 드려요.' });
    runScheduled(e, user); // 기다리지 않는다
    return done(200, { ok: true });
  }
  return false;
}

// ---------- 메일정리 (data/db/mails.json) ----------
// 화면의 "메일 정리하기"·"답장 초안 만들기" 단추가 비서(두뇌)에게 일을 시키고, 끝나면 서버가 결과 파일을 검사해 다듬는다.
// 연습 모드(연결된 앱 꺼짐): 가상 메일 templates/sample-mails.json 을 data/db/sample-mails.json 으로 한 번 복사해 두고(있으면 그대로) 비서가 그걸 읽는다.
// 실제 모드(연결된 앱 켜짐): 비서가 Gmail 을 읽는다. 어느 쪽이든 원문은 저장하지 않고 요약만, 메일은 보내지 않고 초안까지만.
const SAMPLE_MAILS = path.join(DB_DIR, 'sample-mails.json');
if (!fs.existsSync(SAMPLE_MAILS)) fs.copyFileSync(path.join(__dirname, 'templates', 'sample-mails.json'), SAMPLE_MAILS);
const mailJob = { running: null, last: null }; // running: 'organize' | 'draft' | null — 한 번에 하나만 / last: { kind, ok, text, at, mode } 마지막 결과 (화면이 보여 준다)
const mailMode = (u) => (permsFor(u).연결된앱 ? 'Gmail' : '연습'); // 관리자의 Gmail 은 관리자의 비서만 읽는다

// 비서가 쓴 mails.json 다듬기: 아는 칸만 남기고 글자 수를 자른다. "본문"·"원문" 같은 모르는 칸이나 긴 글이 끼어도 여기서 지워져서 원문이 파일에 남지 않는다
const MAIL_LEN = { 원본id: 120, 보낸사람: 60, 제목: 120, 요약: 160, 할일: 160, 일정장소: 80, 초안위치: 40, 일정id: 64, 할일id: 64 };
const MAIL_KINDS = ['긴급', '업무', '광고'], EVENT_KINDS = ['회의', '출장', '검사 입회', '개인'];
const mailClip = (v, n, oneLine = true) => { const s = String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''); return (oneLine ? s.replace(/\s+/g, ' ') : s).trim().slice(0, n); };
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && new Date(`${s}T00:00:00`).toLocaleDateString('sv-SE') === s; // "2026-02-31" 같은 없는 날은 아님
const isHm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
function cleanMail(m, mode) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const s = (k) => mailClip(m[k], MAIL_LEN[k]);
  return {
    id: /^[A-Za-z0-9_-]{1,64}$/.test(String(m.id)) ? String(m.id) : crypto.randomBytes(4).toString('hex'),
    출처: ['연습', 'Gmail'].includes(m.출처) ? m.출처 : mode, 원본id: s('원본id'), 보낸사람: s('보낸사람'), 제목: s('제목'), 받은날: isYmd(m.받은날) ? m.받은날 : '',
    분류: MAIL_KINDS.includes(m.분류) ? m.분류 : '업무', 요약: s('요약'), 할일: s('할일'), 마감일: isYmd(m.마감일) ? m.마감일 : '',
    일정날짜: isYmd(m.일정날짜) ? m.일정날짜 : '', 일정시작: isHm(m.일정시작) ? m.일정시작 : '', 일정장소: s('일정장소'), 일정종류: EVENT_KINDS.includes(m.일정종류) ? m.일정종류 : '',
    상태: m.상태 === '처리됨' ? '처리됨' : '새것', 초안: mailClip(m.초안, 2000, false), 초안위치: s('초안위치'), 일정id: s('일정id'), 할일id: s('할일id'),
  };
}
// 비서가 mails.json 을 쓴 뒤에 부른다. 문제가 있으면 쉬운 한국어 이유를, 괜찮으면 '' 를 돌려준다.
// 다듬는 것 외에: 비서가 지워 버린 기존 항목(처리됨 표시·등록 기록이 든 것)은 되살리고, 같은 메일(원본id)이 두 번 적혔으면 앞의 것만 남긴다
function fixMails(before, mode) {
  let cur; try { cur = loadCollection('mails'); } catch { return 'data/db/mails.json 이 올바른 목록이 아니에요. 덮어쓰지 않았으니 파일을 확인해 주세요.'; }
  const ids = new Set(), froms = new Set(), out = [];
  for (const m of [...cur, ...before.filter((b) => b && !cur.some((c) => c && c.id === b.id))]) {
    const c = cleanMail(m, mode);
    if (!c || ids.has(c.id) || (c.원본id && froms.has(c.원본id))) continue;
    ids.add(c.id); if (c.원본id) froms.add(c.원본id); out.push(c);
  }
  let old = null; try { old = fs.readFileSync(dbFile('mails'), 'utf8'); } catch { /* 파일이 없다 */ }
  if (old === null && !out.length) return ''; // 아무것도 없으면 빈 파일도 만들지 않는다
  if (JSON.stringify(out, null, 2) !== old) writeJson(dbFile('mails'), out);
  return '';
}
const MAIL_ASK = {
  organize: (mode) => `[메일 정리] ${mode === '연습'
    ? '연습 모드다. 연결된 앱이 꺼져 있으니 실제 메일함은 쓰지 않는다. mail 스킬(.claude/skills/mail/SKILL.md)을 먼저 읽고 그 문서의 "메일 정리하기"를 연습 모드로 한다: data/db/sample-mails.json 의 가상 메일 중 최근 2일(며칠전이 0 또는 1)인 것을 읽고'
    : '실제 메일함 모드다. mail 스킬(.claude/skills/mail/SKILL.md)을 먼저 읽고 그 문서의 "메일 정리하기"를 실제 모드로 한다: Gmail 도구로 최근 2일 받은편지함 메일(검색어 in:inbox newer_than:2d)을 읽고'}`
    + ' 긴급·업무·광고로 나눠, 요약 한 줄·할 일·마감일을 data/db/mails.json 에 적는다. 메일 원문은 저장하지 않고 요약만 적는다. 메일은 보내지 않는다.',
  draft: (mode, m) => `[답장 초안] ${mode === '연습'
    ? '연습 모드다. Gmail 은 쓰지 않는다. mail 스킬(.claude/skills/mail/SKILL.md)의 "답장 초안 만들기"를 연습 모드로 한다:'
    : '실제 메일함 모드다. mail 스킬(.claude/skills/mail/SKILL.md)의 "답장 초안 만들기"를 실제 모드로 한다: Gmail 의 create_draft 로 임시보관함에 넣기만 하고 절대 보내지 않는다.'}`
    + ` data/db/mails.json 에서 id 가 "${m.id}" 인 메일(원본id ${JSON.stringify(m.원본id)})의 답장 초안을 만들어 그 항목의 "초안"·"초안위치" 칸에 적는다. 메일은 보내지 않는다.`,
};
async function runMail(kind, prompt, mode, before, user, id) { // 끝나기를 기다리지 않고 불러도 된다. 절대 던지지 않는다. running 은 첫 await 전에 켠다 (두 번 눌러도 하나만 돈다)
  mailJob.running = kind;
  let r;
  try { r = await askBrainOnce(prompt, `${brainCtx(user)} 이 실행은 메일정리 화면의 단추가 시작했다. 주인은 화면에서 기다리고 있어 되물을 수 없다. 끝나면 한 줄로 결과만 보고한다.`, user); }
  catch (err) { r = { ok: false, text: `실행하지 못했어요: ${err.message}` }; }
  let ok = r.ok, text = r.text || (r.ok ? '(보고 글이 없어요)' : '');
  try {
    const bad = fixMails(before, mode); // 비서가 실패했어도 쓰다 만 파일은 다듬는다
    if (bad && ok) { ok = false; text = bad; }
    if (ok && kind === 'draft' && !(loadCollection('mails').find((m) => m.id === id) || {}).초안) { ok = false; text = '초안이 적히지 않았어요. 한 번 더 눌러 보세요.'; }
  } catch (e) { if (ok) { ok = false; text = `결과를 다듬지 못했어요: ${e.message}`; } }
  mailJob.last = { kind, ok, text: mailClip(String(text).trim().split('\n')[0], 200), at: nowIso(), mode }; // 비서가 길게 보고해도 첫 줄만 (화면 한 줄에 들어가게)
  mailJob.running = null;
  emitDb('mails');
}
// /api/mail/status · organize · draft — 메일정리 화면이 쓴다. 처리했으면 true
//   GET status → { mode: "연습"|"Gmail", running, last } · POST organize → 시작(끝나기를 기다리지 않고 바로 답함) · POST draft { id } → 그 메일의 답장 초안
async function mailApi(req, res, act, user) {
  const M = req.method, done = (status, body) => { send(res, status, body); return true; };
  if (act === 'status') return M === 'GET' ? done(200, { mode: mailMode(user), running: mailJob.running, last: mailJob.last }) : false;
  if (M !== 'POST') return false;
  let b = {}; if (act === 'draft') { try { b = await readBody(req); } catch { return done(400, { error: '요청이 올바르지 않습니다.' }); } }
  // 여기부터는 await 없이: 실행 중인지 보고 → 시작
  if (mailJob.running) return done(409, { error: '지금 다른 메일 작업이 돌고 있어요. 끝난 뒤에 눌러 주세요.' });
  let before; try { before = loadCollection('mails'); } catch { return done(500, { error: 'data/db/mails.json 이 올바른 목록이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.' }); }
  const mode = mailMode(user);
  if (mode === '연습' && !fs.existsSync(SAMPLE_MAILS)) fs.copyFileSync(path.join(__dirname, 'templates', 'sample-mails.json'), SAMPLE_MAILS); // 지웠으면 다시 둔다
  let prompt, id = '';
  if (act === 'draft') {
    id = String(b.id || '');
    const m = /^[A-Za-z0-9_-]{1,64}$/.test(id) && before.find((x) => x && x.id === id);
    if (!m) return done(404, { error: '없는 메일입니다. 목록을 새로 불러와 주세요.' });
    prompt = MAIL_ASK.draft(mode, m);
  } else prompt = MAIL_ASK.organize(mode);
  runMail(act, prompt, mode, before, user, id);
  return done(200, { ok: true, mode });
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
      if (usernameProblem(username)) return send(res, 400, { error: usernameProblem(username) });
      if (password.length < 8) return send(res, 400, { error: '비밀번호는 8자 이상이어야 합니다.' });
      const u = { id: crypto.randomUUID(), name, username, dept: '', role: 'admin', password: hashPassword(password), createdAt: new Date().toISOString() };
      writeJson(USERS_FILE, [u]);
      ensureUserDir(u);
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
      return send(res, 200, { ok: true, mustChange: !!u.mustChange }, { 'Set-Cookie': cookieHeader(createSession(u.id), SESSION_MS / 1000) });
    }
    if (req.method === 'POST' && p === '/api/auth/logout') {
      const t = getToken(req);
      if (t && sessions[sha(t)]) { delete sessions[sha(t)]; writeJson(SESSIONS_FILE, sessions); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }
    // 읽기 전용 공유 링크의 자료: 로그인 없이 열린다. 길고 무작위인 토큰을 아는 사람만, 그 프로젝트의 공정표를(금액·메모 빼고) 읽을 수만 있다
    const sm = p.match(/^\/api\/share\/([A-Za-z0-9_-]{20,64})$/);
    if (sm && req.method === 'GET') {
      const e = shareEntry(sm[1]);
      if (!e) return send(res, 404, { error: '없거나 끊긴 링크입니다.' });
      const r = publicWbs(e.pid);
      return r ? send(res, 200, r) : send(res, 500, { error: '공정표 파일을 읽지 못했어요.' });
    }
    // 여기부터는 로그인해야만 쓸 수 있다
    if (!user) return send(res, 401, { error: '로그인이 필요합니다.' });
    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { name: user.name, username: user.username, dept: user.dept || '', role: isAdmin(user) ? 'admin' : 'user', mustChange: !!user.mustChange });
    // 관리자가 정해 준 임시 비밀번호로 처음 들어온 사람은 비밀번호를 바꾸기 전에는 아무것도 못 한다 (바꾸기·내 정보·로그아웃만)
    if (user.mustChange && p !== '/api/auth/password') return send(res, 403, { error: '먼저 비밀번호를 바꿔 주세요.', mustChange: true });
    if (req.method === 'POST' && p === '/api/auth/password') { // { current, next } — 맞는 현재 비밀번호를 대야 한다. 바꾸면 이 사람의 다른 로그인(다른 기기·브라우저)은 모두 풀린다
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const left = lockedLeftMs(user.username);
      if (left) return send(res, 429, { error: `비밀번호를 너무 많이 틀렸습니다. ${Math.ceil(left / 60000)}분 뒤에 다시 시도하세요.` });
      const users = readJson(USERS_FILE, []), me = users.find((x) => x.id === user.id), cur = String(b.current || ''), next = String(b.next || '');
      if (!me || !verifyPassword(cur, me.password)) { recordFail(user.username); return send(res, 401, { error: '지금 비밀번호가 맞지 않습니다.' }); }
      if (next.length < 8) return send(res, 400, { error: '새 비밀번호는 8자 이상이어야 합니다.' });
      if (next === cur) return send(res, 400, { error: '지금 비밀번호와 다른 것으로 정해 주세요.' });
      fails.delete(user.username);
      me.password = hashPassword(next); delete me.mustChange;
      writeJson(USERS_FILE, users);
      const mine = sha(getToken(req));
      for (const [h, ss] of Object.entries(sessions)) if (ss.userId === me.id && h !== mine) delete sessions[h];
      writeJson(SESSIONS_FILE, sessions);
      return send(res, 200, { ok: true });
    }

    // 사용자 관리·설정·예시 데이터는 관리자만 (일반 사용자는 화면에서도 안 보인다)
    const adminOnly = /^\/api\/(users|settings|seed)(\/|$)/.test(p);
    if (adminOnly && !isAdmin(user)) return send(res, 403, { error: '관리자만 쓸 수 있어요.' });
    // GET /api/users → 사람 목록(비밀번호 없이) · POST /api/users { name, username, password(임시), dept, role } → 새 계정. 임시 비밀번호로는 처음 로그인할 때 바꿔야 한다
    if (p === '/api/users') {
      if (req.method === 'GET') return send(res, 200, readJson(USERS_FILE, []).map(pubUser));
      if (req.method === 'POST') {
        let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
        const name = String(b.name || '').trim(), username = String(b.username || '').trim().toLowerCase(), password = String(b.password || ''), dept = String(b.dept || '').trim(), role = b.role === undefined ? 'user' : b.role;
        if (badText(name, 50)) return send(res, 400, { error: '이름을 1~50자로 적어 주세요. (줄바꿈 같은 특수 문자는 안 됩니다)' });
        if (usernameProblem(username)) return send(res, 400, { error: usernameProblem(username) });
        if (password.length < 8) return send(res, 400, { error: '임시 비밀번호는 8자 이상이어야 합니다.' });
        if (dept && badText(dept, 30)) return send(res, 400, { error: '부서는 30자까지, 줄바꿈 없이 적어 주세요.' });
        if (role !== 'admin' && role !== 'user') return send(res, 400, { error: '역할은 관리자 또는 일반이에요.' });
        // 읽기→쓰기 사이에 await 가 없어서 같은 아이디가 동시에 두 번 만들어지지 않는다
        const users = readJson(USERS_FILE, []);
        if (users.some((x) => x.username === username)) return send(res, 409, { error: '이미 있는 아이디입니다.' });
        const u = { id: crypto.randomUUID(), name, username, dept, role, password: hashPassword(password), mustChange: true, createdAt: nowIso() };
        users.push(u); writeJson(USERS_FILE, users);
        ensureUserDir(u);
        return send(res, 200, { ok: true, user: pubUser(u) });
      }
      return send(res, 405, { error: '허용되지 않는 요청입니다.' });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': 연결됨\n\n');
      streams.add(res); res.on('close', () => streams.delete(res));
      return;
    }
    const dm = p.match(/^\/api\/db\/([a-z][a-z0-9_-]{0,39})(?:\/([A-Za-z0-9_-]{1,64}))?$/);
    if (dm && !/^(con|prn|aux|nul|com\d|lpt\d)$/.test(dm[1])) { // 윈도우 장치 이름(nul 등)은 파일이 아니라서 거절
      const [, name, id] = dm;
      // 본문을 먼저 다 받고, 그 다음 읽기→고치기→쓰기를 await 없이 한 번에 한다.
      // 읽은 뒤 본문을 기다리면 그 틈에 끝난 다른 저장(또는 비서가 고친 내용)을 옛 내용으로 덮어써 버린다
      let b;
      if (id && req.method === 'PUT') {
        try { b = await readBody(req, 200_000); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: '저장할 내용은 JSON 객체여야 합니다.' });
      }
      let items; try { items = loadCollection(name); } catch { return send(res, 500, { error: `data/db/${name}.json 이 올바른 목록(JSON 배열)이 아닙니다. 덮어쓰지 않았으니 파일을 확인해 주세요.` }); }
      const at = () => items.findIndex((x) => x && String(x.id) === id);
      // 업무 데이터는 함께 쓰지만, 알림 중 owner(아이디)가 적힌 것(예약 결과 같은 개인 내용)은 그 사람에게만 보인다
      if (!id && req.method === 'GET') return send(res, 200, name === 'notices' ? items.filter((n) => !n || !n.owner || n.owner === user.username) : items);
      // ponytail: 서버 안의 저장끼리는 이제 안 겹친다. 비서(다른 프로그램)가 파일을 쓰는 바로 그 순간과는 잠금이 없어 겹칠 수 있다. 자주 생기면 파일 잠금을 둔다
      if (id && req.method === 'PUT') { // 같은 id 가 있으면 통째로 바꾸고, 없으면 추가
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

    const wm = p.match(/^\/api\/wbs\/([A-Za-z0-9_-]{1,64})(?:\/(revs|share)(?:\/(\d{1,6})(\/restore)?)?)?$/);
    if (wm && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(wm[1]) && await wbsApi(req, res, wm[1], wm[2], wm[3], wm[4])) return;

    const qm = p.match(/^\/api\/schedule(?:\/([A-Za-z0-9_-]{1,64})(?:\/(enable|phone|run))?)?$/);
    if (qm && await scheduleApi(req, res, qm[1], qm[2], user)) return;
    const gm = p.match(/^\/api\/settings(?:\/(telegram|permissions)(?:\/(test))?)?$/);
    if (gm && await settingsApi(req, res, gm[1], gm[2])) return;
    const mm = p.match(/^\/api\/mail\/(organize|draft|status)$/);
    if (mm && await mailApi(req, res, mm[1], user)) return;
    if (p === '/api/uploads' && await uploadApi(req, res)) return;
    if (p === '/api/files/open' && req.method === 'POST') return openApi(req, res);
    const fm = p.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
    if (fm && req.method === 'GET') {
      let box, name; try { box = decodeURIComponent(fm[1]); name = decodeURIComponent(fm[2]); } catch { return send(res, 400, { error: '주소가 올바르지 않습니다.' }); }
      return fileApi(res, box, name, url.searchParams);
    }

    if (p === '/api/seed' && req.method === 'POST') { // 설정 화면의 "예시 데이터 넣기"
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const sample = sampleData(), names = Object.keys(sample), cur = {};
      try { for (const n of names) cur[n] = loadCollection(n); } catch { return send(res, 500, { error: '자료 파일이 깨져 있어 예시를 넣지 못했습니다. data/db 를 확인해 주세요.' }); }
      const exists = Object.fromEntries(names.filter((n) => cur[n].length).map((n) => [n, cur[n].length]));
      // 이미 자료가 있으면 아무것도 쓰지 않고 되묻는다. 화면이 "추가"를 확인받아 add:true 로 다시 보내야 넣는다
      if (Object.keys(exists).length && b.add !== true) return send(res, 409, { error: '이미 자료가 있습니다. 기존 자료는 그대로 두고 예시만 추가할까요?', exists });
      for (const n of names) { // 같은 id(demo-…)의 예시만 바꾸고, 나머지 자료는 지우거나 바꾸지 않는다
        for (const item of sample[n]) {
          const i = cur[n].findIndex((x) => x && x.id === item.id);
          if (i < 0) cur[n].push(item); else cur[n][i] = item;
        }
        writeJson(dbFile(n), cur[n]);
      }
      for (const [pid, doc] of Object.entries(sampleWbs())) // WBS 예시는 그 프로젝트의 파일이 아직 없을 때만 만든다 (내가 고친 공정표를 덮어쓰지 않는다)
        if (!fs.existsSync(wbsFile(pid))) writeJson(wbsFile(pid), wbsCalc.normalize({ ...doc, actualLog: wbsCalc.sampleLog(doc, wbsCalc.today()) }, wbsCalc.today()));
      return send(res, 200, { ok: true, added: Object.fromEntries(names.map((n) => [n, sample[n].length])) });
    }

    if (p === '/api/memory' && req.method === 'GET') return send(res, 200, { items: readMemory(user).map((text, i) => ({ i, text })).filter((x) => x.text.startsWith('- ')) });
    if (p === '/api/memory/delete' && req.method === 'POST') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
      const raw = fs.readFileSync(memoryFile(user), 'utf8'), eol = raw.includes('\r\n') ? '\r\n' : '\n', lines = raw.split(/\r?\n/);
      if (!Number.isInteger(b.i) || lines[b.i] !== b.text || !b.text.startsWith('- ')) return send(res, 409, { error: '그 사이에 기억이 바뀌었습니다. 목록을 새로 불러와 주세요.' });
      lines.splice(b.i, 1);
      fs.writeFileSync(memoryFile(user) + '.tmp', lines.join(eol)); fs.renameSync(memoryFile(user) + '.tmp', memoryFile(user));
      return send(res, 200, { ok: true });
    }

    const cm = p.match(/^\/api\/chats(?:\/([0-9a-f-]{36}))?(\/messages)?$/);
    if (cm) {
      const [, id, isMsg] = cm;
      if (!id && req.method === 'GET') return send(res, 200, listChats(user));
      if (!id && req.method === 'POST') {
        const chat = { id: crypto.randomUUID(), userId: user.id, title: '새 대화', createdAt: nowIso(), updatedAt: nowIso(), messages: [] };
        saveChat(user, chat);
        return send(res, 200, { id: chat.id });
      }
      const chat = id && loadChat(id, user);
      if (!chat) return send(res, 404, { error: '없는 대화입니다.' });
      if (!isMsg && req.method === 'GET') return send(res, 200, chat);
      if (isMsg && req.method === 'POST') {
        let b; try { b = await readBody(req); } catch { return send(res, 400, { error: '요청이 올바르지 않습니다.' }); }
        const atts = []; // 첨부: 먼저 올려 둔 파일(data/uploads/ 의 저장 이름)만. 없는 이름·이상한 이름은 거절한다
        if (b.attachments !== undefined) {
          if (!Array.isArray(b.attachments) || b.attachments.length > 10) return send(res, 400, { error: '첨부는 10개까지 보낼 수 있어요.' });
          for (const f of new Set(b.attachments.map(String))) {
            const full = boxFile('uploads', f);
            if (!full) return send(res, 400, { error: '첨부한 파일을 찾지 못했어요. 다시 첨부해 주세요.' });
            atts.push({ file: f, name: shownName(f), size: fs.statSync(full).size, type: mimeOf(f) });
          }
        }
        let content = String(b.content || '').trim();
        if (!content && !atts.length) return send(res, 400, { error: '내용이 비어 있습니다.' });
        if (!content) content = '첨부한 파일을 읽어 줘.';
        return streamReply(res, chat, content, user, atts);
      }
    }
    return send(res, 404, { error: '없는 API 입니다.' });
  }

  if (req.method !== 'GET') return send(res, 405, '허용되지 않는 요청입니다.');
  if (p === '/' || PROTECTED_PAGES.has(p)) return serveFile(res, user ? '/index.html' : '/login.html');
  const sp = p.match(/^\/s\/([A-Za-z0-9_-]{20,64})$/); // 공유 화면: 같은 WBS 화면을 읽기 전용으로. 화면 파일은 /m/ 에 있어서 여기서 직접 내보낸다
  if (sp) {
    if (!shareEntry(sp[1])) return send(res, 404, '없거나 끊긴 링크입니다.');
    return fs.readFile(path.join(PUBLIC_DIR, 'm', 'wbs.html'), (err, data) => {
      if (err) return send(res, 404, '없는 페이지입니다.');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
      res.end(data);
    });
  }
  if (p.startsWith('/m/') && !user && p !== '/m/wbs-calc.js') return send(res, 401, '로그인이 필요합니다.'); // 업무 화면(public/m/)은 로그인한 사람만 (계산 코드 wbs-calc.js 만 공유 화면이 쓰도록 예외)
  return serveFile(res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: '서버 오류' }); });
});
server.listen(PORT, HOST, () => {
  console.log(`Sancho 서버 실행 중: http://${HOST}:${PORT}`);
  // 지난번에 도는 도중에 서버(컴퓨터)가 꺼진 예약: 결과 없이 끝났음을 알린다. 그 회차는 다시 돌리지 않는다(마지막실행이 이미 적혀 있다)
  try {
    for (const u of readJson(USERS_FILE, [])) { // 사람마다 자기 실행 중 기록을 본다 (알림도 그 사람에게만)
      const m = readJson(runningFile(u), {});
      for (const [id, x] of Object.entries(m)) addNotice(`예약이 중간에 끊겼어요: ${(x && x.이름) || id}`,
        `${x && x.시작 ? `${new Date(x.시작).toLocaleString('ko-KR')} 에 ` : ''}시작한 실행이 서버(컴퓨터)가 꺼지면서 끝나지 못했어요. 이 회차는 다시 돌리지 않아요. 필요하면 예약 칸의 ▶ 로 다시 실행해 주세요.`, '주의', undefined, u.username);
      if (Object.keys(m).length) writeJson(runningFile(u), {});
    }
  } catch (e) { console.error('끊긴 예약 확인 오류:', e.message); }
  const tick = () => { try { scheduleTick(); } catch (e) { console.error('예약 점검 오류:', e); } }; // 오류가 나도 서버가 죽지 않게
  tick(); // 켜자마자 한 번: 꺼져 있는 동안 놓친 예약은 여기서 한 번 돈다
  setInterval(tick, TICK_MS);
});
