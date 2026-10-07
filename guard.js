// 관문·불변 층 (8편 안전장치). 비서가 고치지 못하는 파일이다 — 아래 IMMUTABLE 목록 참고.
// server.js(/api/restart · 자기 수정)와 supervisor.js(last-good 태그)가 같이 쓴다. 외부 패키지 없이 Node 내장 기능만.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
// 비서가 절대 못 고치는 파일·폴더 (끝이 / 이면 폴더 통째로). 안전장치 자체와 그것을 검사하는 시험, 메일 발송 문지기.
// 권한 규칙(immutableDenyRules)으로 막고, 그래도 바뀌면 coreChanged 가 last-good 과 비교해 잡는다
const IMMUTABLE = ['start.bat', 'supervisor.js', 'guard.js', 'selftest.js', 'mailgate.js', 'test/'];
// 불변 검사 대상은 아니지만 비서가 건드리면 안 되는 곳 (권한 규칙·자기 수정 검사에만): git 기록, 비밀 보호(.gitignore), 개발용 지침·설정
const OFF_LIMITS = ['.git/', '.gitignore', '.claude/', 'CLAUDE.md'];
const PROTECTED = [...IMMUTABLE, ...OFF_LIMITS];
// 어느 폴더에 있든 보호하는 이름 (8편 마무리): 하위 폴더의 .gitignore 로 파일을 git 에서 숨기거나(그러면 되돌리기·커밋 검사를 빠져나간다),
// 하위 저장소(.git)를 끼우거나, 하위 폴더에 claude 가 읽는 지침·설정(CLAUDE.md·.claude·.mcp.json)을 심지 못하게
const ANYWHERE = ['.git', '.gitignore', '.gitattributes', '.gitmodules', 'CLAUDE.md', 'CLAUDE.local.md', '.claude', '.mcp.json'];
const ANYWHERE_LC = ANYWHERE.map((s) => s.toLowerCase());

const norm = (p) => String(p).replace(/\\/g, '/');
// 상대 경로가 보호 대상인가 — 표기가 달라도 같은 파일이면 같게 본다 (8편 마무리):
//  \ 와 / · ./ · a/../ · 겹친 / · 맨 앞 / 를 정리하고, 윈도우처럼 대소문자를 가리지 않고, 이름 끝의 점·공백(윈도우가 무시함)도 뗀다.
//  앱 폴더 밖(../)이나 끝이 / 인 것(git 이 안을 보지 않는 하위 저장소)은 무엇인지 알 수 없으니 보호로 본다
function isProtected(rel) {
  const raw = norm(rel);
  if (raw.endsWith('/')) return true;
  const n = path.posix.normalize(raw.replace(/^\/+/, ''));
  if (n === '..' || n.startsWith('../')) return true;
  const parts = n.split('/').filter((s) => s && s !== '.').map((s) => s.replace(/[. ]+$/, '').toLowerCase()).filter(Boolean);
  if (parts.some((s) => ANYWHERE_LC.includes(s))) return true;
  const r = parts.join('/');
  return PROTECTED.some((p) => { const q = p.toLowerCase(); return q.endsWith('/') ? r.startsWith(q) || `${r}/` === q : r === q; });
}

// ---------- git ----------
// 우리가 돌리는 git 은 저장소의 훅·fsmonitor 를 쓰지 않는다 (8편 마무리: 누가 .git 에 심어 둔 명령이 자동 커밋·되돌리기 때 같이 돌지 않게 — 이 PC 에서 확인함)
const NO_HOOKS = path.join(os.tmpdir(), 'sancho-git-no-hooks'); // 만들지 않는 폴더 = 훅 없음
function git(root, ...args) {
  try { return { code: 0, out: execFileSync('git', ['-c', 'core.quotepath=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50e6, windowsHide: true }) }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || e.message) }; }
}
// 이 폴더가 git 저장소의 맨 위인가 (상위 폴더의 저장소를 잘못 만지지 않게)
const isRepo = (root) => { const r = git(root, 'rev-parse', '--is-inside-work-tree', '--show-prefix'); const l = r.out.split('\n'); return r.code === 0 && l[0] === 'true' && l[1] === ''; };
const head = (root) => git(root, 'rev-parse', 'HEAD').out.trim();
const hasTag = (root, tag) => git(root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`).code === 0;
// 커밋하지 않은 변경·새 파일 목록 (data/ 같은 .gitignore 대상은 빼고). 알 수 없으면 null
function changedFiles(root) {
  const r = git(root, 'status', '--porcelain', '-z', '-uall');
  if (r.code !== 0) return null;
  const parts = r.out.split('\0').filter(Boolean), out = [];
  for (let i = 0; i < parts.length; i++) { out.push(parts[i].slice(3)); if (parts[i][0] === 'R' || parts[i][0] === 'C') out.push(parts[++i]); } // 이름 바꾸기는 옛 이름도 함께
  return out;
}
const dirty = (root) => { const c = changedFiles(root); return c === null || c.length > 0; }; // 알 수 없으면 "깨끗하지 않음"(안전한 쪽)
// 비서의 수정을 버린다: 커밋 안 된 변경은 되돌리고 새로 생긴 파일은 지운다 (.gitignore 대상 data/ 는 안 건드림). 버리기 전에 preserve 로 남겨 둔다
function revert(root) { return git(root, 'reset', '--hard', 'HEAD').code === 0 && git(root, 'clean', '-fdq').code === 0; }
// 바뀐 것을 모두 커밋한다 → 짧은 커밋 번호 (바뀐 게 없거나 실패하면 null)
function commitAll(root, message, who = 'Sancho 비서') {
  if (git(root, 'add', '-A').code !== 0) return null;
  const r = git(root, '-c', `user.name=${who}`, '-c', 'user.email=sancho@localhost', 'commit', '-q', '-m', message);
  return r.code === 0 ? git(root, 'rev-parse', '--short', 'HEAD').out.trim() : null;
}
const stampNow = (d = new Date()) => { const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`; };
// 버리기 전에 보존 (8편 마무리): 지금 작업 폴더(커밋 안 한 변경·새 파일 포함)를 커밋 하나로 떠서 rescue/<label><시각> 브랜치에 남긴다.
// 지금 브랜치·HEAD 는 움직이지 않는다 (저수준 commit-tree 라 훅도 안 돈다). 깨끗하면 지금 HEAD 를 그대로 남긴다. → 브랜치 이름 | null(못 남김)
function preserve(root, label, message, who) {
  const h = head(root); if (!/^[0-9a-f]{40}$/.test(h)) return null;
  let sha = h;
  if (dirty(root)) {
    if (git(root, 'add', '-A').code !== 0) return null;
    const tree = git(root, 'write-tree').out.trim();
    const r = git(root, '-c', `user.name=${who}`, '-c', 'user.email=sancho@localhost', 'commit-tree', tree, '-p', h, '-m', message);
    sha = r.out.trim(); if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
  }
  const s = stampNow();
  for (let i = 0; i < 5; i++) { const b = `rescue/${label}${s}${i ? `-${i}` : ''}`; if (git(root, 'branch', b, sha).code === 0) return b; } // 같은 초에 두 번이면 -1, -2 …
  return null;
}
// 불변 파일 중 last-good(마지막 정상 버전)과 달라진 것. last-good 이 없거나 git 저장소가 아니면 비교할 곳이 없으니 []
function coreChanged(root) {
  if (!isRepo(root) || !hasTag(root, 'last-good')) return [];
  const paths = IMMUTABLE.map((p) => p.replace(/\/$/, ''));
  const diff = git(root, 'diff', '--name-only', 'last-good', '--', ...paths).out.split('\n');
  const added = git(root, 'ls-files', '-o', '--exclude-standard', '--', ...paths).out.split('\n'); // 불변 폴더에 새로 생긴 파일
  return [...new Set([...diff, ...added].map((s) => s.trim()).filter(Boolean))];
}

// ---------- 코드 지문: 검사하는 동안 코드가 몰래 바뀌지 않았는지 보려고 ----------
const SKIP_TOP = new Set(['data', '.git', '.old', 'node_modules', 'docs']);
function fingerprint(root) {
  const h = crypto.createHash('sha1');
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (rel === '' && SKIP_TOP.has(e.name)) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) { h.update(`${rel}${e.name}\0`); h.update(fs.readFileSync(path.join(d, e.name))); h.update('\0'); }
    }
  })(root, '');
  return h.digest('hex');
}

// ---------- 한 번에 하나만 ----------
// (서버 안) 재시작 검사·자기 수정 차례가 겹치지 않게
let holder = null;
const lock = { take: (who) => (holder ? false : ((holder = who), true)), free: () => { holder = null; }, who: () => holder };
// (프로세스 사이) 같은 앱 폴더의 관문이 겹치지 않게 — 서버의 관문과 감시자의 last-good 관문은 다른 프로그램이라 파일로 잠근다.
// 겹치면 selftest 의 시험 서버 포트가 부딪혀 멀쩡한 코드도 실패한다. 잠금 파일은 .git 안(앱 폴더마다 따로), 주인 프로세스가 끝났으면 넘겨받는다
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const gateLockFile = (root) => { const g = path.join(root, '.git'); return fs.existsSync(g) && fs.statSync(g).isDirectory() ? path.join(g, 'sancho-gate.lock') : path.join(os.tmpdir(), `sancho-gate-${crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)}.lock`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function takeGateLock(root, waitMs) { // → 푸는 함수 | null(기다려도 안 풀림)
  const f = gateLockFile(root), t0 = Date.now(), me = String(process.pid);
  for (;;) {
    try { fs.writeFileSync(f, me, { flag: 'wx' }); return () => { try { if (fs.readFileSync(f, 'utf8') === me) fs.rmSync(f); } catch { /* 이미 없음 */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') return () => {}; // 잠금 파일을 못 만드는 곳이면 잠금 없이 (검사는 한다)
      let pid = 0; try { pid = Number(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (!pid || !alive(pid)) { try { fs.rmSync(f); } catch { /* 다른 쪽이 먼저 치움 */ } continue; }
      if (Date.now() - t0 >= waitMs) return null;
      await sleep(500);
    }
  }
}

// ---------- 관문 ----------
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SANCHO_'))); // 서버의 SANCHO_* 설정이 시험 서버로 새지 않게
function killTree(child) { // 윈도우에서는 자식의 자식까지 같이 끈다
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill();
}
// 프로그램을 돌려 끝날 때까지 기다린다. 실패 줄("실패  …")을 따로 모으고 마지막 글도 남긴다
function runStep(cmd, args, { cwd, timeoutMs }) {
  return new Promise((ok) => {
    let tail = '', part = '', timedOut = false, child; const fails = [];
    try { child = spawn(cmd, args, { cwd, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return ok({ code: -1, tail: e.message, fails, timedOut }); }
    const add = (d) => {
      tail = (tail + d).slice(-4000); part += d;
      let k; while ((k = part.indexOf('\n')) >= 0) { const line = part.slice(0, k).trim(); part = part.slice(k + 1); if (line.startsWith('실패') && fails.length < 30) fails.push(line.replace(/^실패\s+/, '')); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', add); child.stderr.on('data', add);
    const t = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); ok({ code: -1, tail: String(e.message), fails, timedOut }); });
    child.on('close', (code) => { clearTimeout(t); ok({ code, tail, fails, timedOut }); });
  });
}
const lastLines = (s, n = 12) => String(s).trim().split('\n').map((l) => l.trim()).slice(-n); // (윈도우 출력의 \r 도 떼어 낸다)
// 순서: ① 불변 파일이 last-good 과 같은지 ② 문법 검사 ③ selftest ④ 그동안 코드가 안 바뀌었는지. 같은 앱 폴더의 관문은 한 번에 하나만 (waitMs 까지 기다림)
// 돌려주는 것: { ok:true } | { ok:false, step:'busy|core|check|selftest|changed', reason(쉬운 한국어), tail:[마지막 줄들] }
async function runGate({ root = ROOT, selftestMs = 10 * 60_000, waitMs = 15 * 60_000, onStep = () => {} } = {}) {
  const fail = (step, reason, tail = []) => ({ ok: false, step, reason, tail });
  const release = await takeGateLock(root, waitMs);
  if (!release) return fail('busy', '같은 앱 폴더의 다른 검사가 아직 끝나지 않았어요. 잠시 뒤에 다시 해 주세요.');
  try {
    let before; try { before = fingerprint(root); } catch (e) { return fail('check', `코드 폴더를 읽지 못했어요: ${e.message}`); }
    const core = coreChanged(root);
    if (core.length) return fail('core', `고칠 수 없는 파일이 마지막 정상 버전과 달라요: ${core.join(', ')} — 사람이 확인하고 커밋해야 해요.`);
    onStep('문법 검사');
    const files = [...fs.readdirSync(root).filter((f) => f.endsWith('.js') && fs.statSync(path.join(root, f)).isFile()),
      ...(fs.existsSync(path.join(root, 'public', 'm')) ? fs.readdirSync(path.join(root, 'public', 'm')).filter((f) => f.endsWith('.js')).map((f) => `public/m/${f}`) : [])];
    for (const f of files) {
      const r = await runStep(process.execPath, ['--check', f], { cwd: root, timeoutMs: 30_000 });
      if (r.code !== 0) { const L = lastLines(r.tail, 40); return fail('check', `문법 오류: ${f} — ${(L.find((l) => /Error/.test(l)) || L[0] || '').slice(0, 160)}`, L.slice(-12)); }
    }
    onStep('selftest');
    const r = await runStep(process.execPath, ['selftest.js'], { cwd: root, timeoutMs: selftestMs });
    if (r.timedOut) return fail('selftest', `점검(selftest)이 ${Math.round(selftestMs / 60_000)}분 안에 끝나지 않아 멈췄어요.`, lastLines(r.tail));
    if (r.code !== 0) return fail('selftest', r.fails.length ? `점검(selftest) ${r.fails.length}개 실패: ${r.fails.slice(0, 5).join(' / ')}${r.fails.length > 5 ? ' …' : ''}` : `점검(selftest)이 실패로 끝났어요. ${lastLines(r.tail, 3).join(' ')}`.slice(0, 300), lastLines(r.tail));
    let after; try { after = fingerprint(root); } catch { after = ''; }
    if (after !== before) return fail('changed', '검사하는 동안 코드 파일이 바뀌었어요. 다시 시도해 주세요.');
    return { ok: true };
  } finally { release(); }
}

// ---------- 권한 규칙 (자기 수정 때 claude 에게 주는 허용·거부 목록) ----------
// claude 의 절대 경로 표기: 윈도우 C:\a\b → //c/a/b, 그 밖에는 /a/b → //a/b
function posixAbs(p) {
  const s = norm(path.resolve(p)), m = /^([A-Za-z]):(\/.*)?$/.exec(s);
  return m ? `//${m[1].toLowerCase()}${m[2] || ''}` : `/${s}`;
}
// 앱 폴더 전체를 읽고 고칠 수 있게 (아래 거부 규칙이 불변 파일을 뺀다)
const appAllowRules = (appRoot) => ['Read', 'Glob', 'Grep', 'Edit', 'Write'].map((t) => `${t}(${posixAbs(appRoot)}/**)`);
// 불변 파일·고치면 안 되는 곳을 고치지 못하게 (거부가 허용보다 먼저다 — 진짜 claude 로 확인). 이 규칙은 1차 방어다:
// 경로를 다르게 적는 등으로 빠져나가도 서버가 답이 끝난 뒤 git 으로 바뀐 파일을 보고 isProtected 로 한 번 더 잡는다
const immutableDenyRules = (appRoot) => {
  const A = posixAbs(appRoot), rule = (abs) => [`Edit(${abs})`, `Write(${abs})`];
  return [...PROTECTED.flatMap((p) => rule(`${A}/${p.replace(/\/$/, '')}${p.endsWith('/') ? '/**' : ''}`)),
    ...ANYWHERE.flatMap((n) => [...rule(`${A}/**/${n}`), ...rule(`${A}/**/${n}/**`)])];
};

module.exports = { ROOT, IMMUTABLE, OFF_LIMITS, PROTECTED, ANYWHERE, isProtected, git, isRepo, head, hasTag, changedFiles, dirty, revert, commitAll, preserve, stampNow, coreChanged, fingerprint, lock, gateLockFile, runStep, killTree, cleanEnv, runGate, posixAbs, appAllowRules, immutableDenyRules };
