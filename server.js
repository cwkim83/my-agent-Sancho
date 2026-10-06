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
function watchJson(dir, re, prefix) { // dir 안의 <이름>.json 이 바뀌면 "<prefix><이름>" 이 바뀜을 알린다
  fs.watch(dir, (_, file) => {
    const m = re.exec(file || ''), key = m && prefix + m[1]; // 쓰는 중인 임시 파일(.tmp)은 무시
    if (!m || pending.has(key)) return;
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      for (const r of streams) r.write(`event: db\ndata: ${JSON.stringify({ name: key })}\n\n`);
    }, 50));
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

function readMemory() { try { return fs.readFileSync(MEMORY_FILE, 'utf8').split(/\r?\n/); } catch { return []; } }

// ---------- 두뇌: 이 PC 에 설치된 Claude Code (내 구독 로그인, API 키 없음) ----------
const SYSTEM_FILE = path.join(DATA_DIR, '.system.md'); // 비서의 성격·기억 규칙 (templates/system.md 에서 처음 한 번 복사)
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md'); // 비서의 기억 (한 줄에 사실 하나: "- 날짜 내용")
if (!fs.existsSync(SYSTEM_FILE)) fs.copyFileSync(path.join(__dirname, 'templates', 'system.md'), SYSTEM_FILE);
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '# 기억\n');
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
const PRIVATE_FILES = ['users.json', 'sessions.json', 'share.json']; // 비밀번호 해시·로그인 기록은 두뇌도 못 보게 막는다
const READONLY_FILES = ['.system.md', '.claude/**']; // 비서가 자기 지침(성격·스킬)을 스스로 고치지 못하게 막는다 (읽기만 가능)
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

// 실행할 때마다 두뇌에게 알려 주는 주인 이름·날짜·시각 (예약 시각을 말로 계산하려면 지금 시각을 알아야 한다)
const brainCtx = (name, d = new Date()) => `주인 이름: ${name}. 오늘 날짜: ${d.toLocaleDateString('sv-SE')} (${d.toLocaleDateString('ko-KR', { weekday: 'long' })}). 현재 시각: ${d.toTimeString().slice(0, 5)}.`;

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

function streamReply(res, chat, content, user) {
  if (running.has(chat.id)) return send(res, 409, { error: '이 대화는 아직 답하는 중입니다. 끝난 뒤에 보내 주세요.' });
  running.add(chat.id);
  chat.messages.push({ role: 'user', content, at: nowIso() });
  if (chat.title === '새 대화') chat.title = content.replace(/\s+/g, ' ').slice(0, 30);
  saveChat(chat);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const args = [...BRAIN_CMD.slice(1), ...(chat.sessionId ? ['--resume', chat.sessionId] : []), ...BRAIN_ARGS, '--append-system-prompt', brainCtx(user.name)];
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

// ---------- 예약 (data/schedule.json): 30초마다 시계를 보고, 때가 된 예약의 지시문을 새 세션의 두뇌에 보낸다 ----------
// 시각 계산·형식 검사는 scheduler.js. 여기는 파일 읽고 쓰기, 두뇌 실행, 일지(data/journal/<날짜>.md)·알림(notices) 쌓기만 한다.
const sched = require('./scheduler.js');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const JOURNAL_DIR = path.join(DATA_DIR, 'journal');
const TICK_MS = Number(process.env.SANCHO_TICK_MS) || 30_000; // 점검에서만 짧게 줄인다
const schedRunning = new Set(); // 지금 도는 예약 id — 같은 예약이 겹쳐 돌지 않게
const warned = new Set(); // 이미 알림으로 알린 문제 (30초마다 같은 알림이 쌓이지 않게)

function addNotice(title, body, level) { // 알림(data/db/notices.json)에 한 줄 — 열려 있는 대시보드는 파일 감시로 바로 따라 바뀐다
  let items; try { items = loadCollection('notices'); } catch { return console.error('data/db/notices.json 이 올바른 목록이 아니라 알림을 넣지 못했어요. (덮어쓰지 않았어요)'); }
  items.push({ id: crypto.randomBytes(4).toString('hex'), title, body, level, at: nowIso(), read: false });
  writeJson(dbFile('notices'), items);
}
function warnOnce(key, title, body) { if (!warned.has(key)) { warned.add(key); addNotice(title, body, '주의'); } }

function loadSchedule() { // 파일이 없으면 빈 목록, 깨져 있으면 예외 (모르고 덮어써서 예약을 잃지 않게)
  let raw; try { raw = fs.readFileSync(SCHEDULE_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const v = JSON.parse(raw.replace(/^﻿/, ''));
  if (!Array.isArray(v)) throw new Error('not an array');
  return v;
}

// 화면 없이 두뇌에 한 번 묻고 끝 결과만 받는다. 대화와 같은 두뇌·같은 도구 제한(BRAIN_ARGS), 새 세션(--resume 없음). 절대 reject 하지 않는다
// ponytail: 띄우고 줄 읽는 부분이 streamReply 와 닮았다. 대화는 점검이 촘촘해서 건드리지 않았다. 고칠 곳이 세 군데가 되면 spawnBrain 으로 합친다
function askBrainOnce(prompt, ctx) {
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
    try { child = spawn(BRAIN_CMD[0], [...BRAIN_CMD.slice(1), ...BRAIN_ARGS, '--append-system-prompt', ctx], { cwd: DATA_DIR, env: brainEnv(), windowsHide: true }); } catch (e) { spawnErr = e; return end(); }
    cap = setTimeout(() => { timedOut = true; killTree(child); }, BRAIN_MAX_MS);
    child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } });
    child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { spawnErr = e; end(); });
    child.on('close', end);
    child.stdin.end(prompt);
  });
}

async function runScheduled(e) {
  schedRunning.add(e.id); // 첫 await 전에 넣는다 (다음 점검이 끼어들기 전에)
  const name = String(e.이름 || e.id), t0 = new Date(), owner = readJson(USERS_FILE, [])[0];
  let r;
  try {
    r = await askBrainOnce(e.지시문, `${brainCtx(owner ? owner.name : '주인', t0)} 이 실행은 예약("${name}")이 시작했다. 주인은 지금 보고 있지 않아 되물을 수 없다. 허락이 필요한 일(삭제 등)은 하지 말고 못 한 일로 적는다. 끝에 결과를 짧게 요약한다.`);
  } catch (err) { r = { ok: false, text: `실행하지 못했어요: ${err.message}` }; }
  finally { schedRunning.delete(e.id); }
  try {
    const day = t0.toLocaleDateString('sv-SE'), file = path.join(JOURNAL_DIR, `${day}.md`), text = r.text || '(결과 글이 없어요)';
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    fs.appendFileSync(file, `${fs.existsSync(file) ? '' : `# ${day} 일지\n\n`}## ${t0.toTimeString().slice(0, 5)} ${r.ok ? '' : '⚠ '}${name}\n\n지시: ${e.지시문.replace(/\s+/g, ' ')}\n\n${text}\n\n`);
    addNotice(`${r.ok ? '예약 결과' : '예약 실패'}: ${name}`, text.replace(/\s+/g, ' ').slice(0, 120), r.ok ? '안내' : '주의');
  } catch (err) { console.error('예약 결과를 적지 못했어요:', err.message); }
}

function scheduleTick() {
  let list; try { list = loadSchedule(); warned.delete('file'); } catch { return warnOnce('file', '예약 파일을 읽지 못했어요', 'data/schedule.json 이 올바른 JSON 목록이 아니에요. 고칠 때까지 예약이 멈춰 있어요. (파일은 덮어쓰지 않았어요)'); }
  const now = new Date(); let dirty = false;
  for (const e of list) {
    const why = sched.check(e);
    if (why) { warnOnce(`${e && e.id}:${why}`, '예약 하나를 건너뛰었어요', `"${(e && (e.이름 || e.id)) || '이름 없음'}": ${why} data/schedule.json 에서 고쳐 주세요.`); continue; }
    if (e.켬 === false) continue;
    // 처음 보는 예약(마지막실행 없음)은 지금부터 센다 — 아침 9시 예약을 오후 3시에 만들었다고 바로 돌지 않게. 한 번만 하는 예약(once)은 시각이 지났으면 바로 돈다
    if (!e.마지막실행 && e.언제.종류 !== 'once') { e.마지막실행 = now.toISOString(); dirty = true; continue; }
    if (schedRunning.has(e.id) || !sched.isDue(e, now)) continue; // 실행 중이면 건너뛴다
    // 이번 회차는 "시작한 것"으로 지금 적는다 — 도중에 서버가 꺼지거나 실패해도 되풀이해 돌지 않는다 (실패는 알림으로 알린다)
    // ponytail: 여러 예약이 한꺼번에 때가 되면 claude 가 동시에 여러 개 뜬다. 한도에 자주 닿으면 한 줄로 세운다
    e.마지막실행 = now.toISOString(); dirty = true;
    runScheduled(e); // 끝나기를 기다리지 않는다
  }
  if (dirty) writeJson(SCHEDULE_FILE, list); // 읽기→쓰기 사이에 기다림이 없어서 비서가 고친 내용을 덮어쓸 틈이 거의 없다
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
    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { name: user.name, username: user.username });

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
      if (!id && req.method === 'GET') return send(res, 200, items);
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
  const tick = () => { try { scheduleTick(); } catch (e) { console.error('예약 점검 오류:', e); } }; // 오류가 나도 서버가 죽지 않게
  tick(); // 켜자마자 한 번: 꺼져 있는 동안 놓친 예약은 여기서 한 번 돈다
  setInterval(tick, TICK_MS);
});
