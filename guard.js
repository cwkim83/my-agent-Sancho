// 관문·불변 층 (8편 안전장치). 비서가 고치지 못하는 파일이다 — 아래 IMMUTABLE 목록 참고.
// server.js(/api/restart · 자기 수정)와 supervisor.js(last-good 태그)가 같이 쓴다. 외부 패키지 없이 Node 내장 기능만.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
// 비서가 절대 못 고치는 파일·폴더 (끝이 / 이면 폴더 통째로). 안전장치 자체와 그것을 검사하는 시험, 메일 발송 문지기.
// 권한 규칙(immutableDenyRules)으로 막고, 그래도 바뀌면 coreChanged 가 last-good 과 비교해 잡는다 (명령 실행으로 우회하는 길까지 2차로 막는다)
const IMMUTABLE = ['start.bat', 'supervisor.js', 'guard.js', 'selftest.js', 'mailgate.js', 'test/'];
// 불변 검사 대상은 아니지만 비서가 건드리면 안 되는 곳 (권한 규칙·자기 수정 검사에만): git 기록, 비밀 보호(.gitignore), 개발용 지침·설정
const OFF_LIMITS = ['.git/', '.gitignore', '.claude/', 'CLAUDE.md'];
const PROTECTED = [...IMMUTABLE, ...OFF_LIMITS];

const norm = (p) => String(p).replace(/\\/g, '/');
// 상대 경로(git 이 알려 준 모양)가 보호 대상인가. 윈도우는 대소문자를 가리지 않으므로 소문자로 비교한다
const isProtected = (rel) => {
  const r = norm(rel).replace(/^\.\//, '').toLowerCase();
  return PROTECTED.some((p) => { const q = p.toLowerCase(); return q.endsWith('/') ? r.startsWith(q) || `${r}/` === q : r === q; });
};

// ---------- git ----------
function git(root, ...args) {
  try { return { code: 0, out: execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50e6, windowsHide: true }) }; }
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
// 비서의 수정을 버린다: 커밋 안 된 변경은 되돌리고 새로 생긴 파일은 지운다 (.gitignore 대상 data/ 는 안 건드림)
function revert(root) { return git(root, 'reset', '--hard', 'HEAD').code === 0 && git(root, 'clean', '-fdq').code === 0; }
// 바뀐 것을 모두 커밋한다 → 짧은 커밋 번호 (바뀐 게 없거나 실패하면 null)
function commitAll(root, message, who = 'Sancho 비서') {
  if (git(root, 'add', '-A').code !== 0) return null;
  const r = git(root, '-c', `user.name=${who}`, '-c', 'user.email=sancho@localhost', 'commit', '-q', '-m', message);
  return r.code === 0 ? git(root, 'rev-parse', '--short', 'HEAD').out.trim() : null;
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

// ---------- 한 번에 하나만: 재시작 검사·자기 수정이 겹치지 않게 ----------
let holder = null;
const lock = { take: (who) => (holder ? false : ((holder = who), true)), free: () => { holder = null; }, who: () => holder };

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
const lastLines = (s, n = 12) => String(s).trim().split('\n').slice(-n);
// 순서: ① 불변 파일이 last-good 과 같은지 ② 문법 검사 ③ selftest ④ 그동안 코드가 안 바뀌었는지.
// 돌려주는 것: { ok:true } | { ok:false, step:'core|check|selftest|changed', reason(쉬운 한국어), tail:[마지막 줄들] }
async function runGate({ root = ROOT, selftestMs = 10 * 60_000, onStep = () => {} } = {}) {
  const fail = (step, reason, tail = []) => ({ ok: false, step, reason, tail });
  let before; try { before = fingerprint(root); } catch (e) { return fail('check', `코드 폴더를 읽지 못했어요: ${e.message}`); }
  const core = coreChanged(root);
  if (core.length) return fail('core', `고칠 수 없는 파일이 마지막 정상 버전과 달라요: ${core.join(', ')} — 사람이 확인하고 커밋해야 해요.`);
  onStep('문법 검사');
  const files = [...fs.readdirSync(root).filter((f) => f.endsWith('.js') && fs.statSync(path.join(root, f)).isFile()),
    ...(fs.existsSync(path.join(root, 'public', 'm')) ? fs.readdirSync(path.join(root, 'public', 'm')).filter((f) => f.endsWith('.js')).map((f) => `public/m/${f}`) : [])];
  for (const f of files) {
    const r = await runStep(process.execPath, ['--check', f], { cwd: root, timeoutMs: 30_000 });
    if (r.code !== 0) return fail('check', `문법 오류: ${f} — ${(r.tail.split('\n').find((l) => /Error/.test(l)) || r.tail.trim().split('\n')[0] || '').slice(0, 160)}`, lastLines(r.tail));
  }
  onStep('selftest');
  const r = await runStep(process.execPath, ['selftest.js'], { cwd: root, timeoutMs: selftestMs });
  if (r.timedOut) return fail('selftest', `점검(selftest)이 ${Math.round(selftestMs / 60_000)}분 안에 끝나지 않아 멈췄어요.`, lastLines(r.tail));
  if (r.code !== 0) return fail('selftest', r.fails.length ? `점검(selftest) ${r.fails.length}개 실패: ${r.fails.slice(0, 5).join(' / ')}${r.fails.length > 5 ? ' …' : ''}` : `점검(selftest)이 실패로 끝났어요. ${lastLines(r.tail, 3).join(' ')}`.slice(0, 300), lastLines(r.tail));
  let after; try { after = fingerprint(root); } catch { after = ''; }
  if (after !== before) return fail('changed', '검사하는 동안 코드 파일이 바뀌었어요. 다시 시도해 주세요.');
  return { ok: true };
}

// ---------- 권한 규칙 (자기 수정 때 claude 에게 주는 허용·거부 목록) ----------
// claude 의 절대 경로 표기: 윈도우 C:\a\b → //c/a/b, 그 밖에는 /a/b → //a/b
function posixAbs(p) {
  const s = norm(path.resolve(p)), m = /^([A-Za-z]):(\/.*)?$/.exec(s);
  return m ? `//${m[1].toLowerCase()}${m[2] || ''}` : `/${s}`;
}
// 앱 폴더 전체를 읽고 고칠 수 있게 (아래 거부 규칙이 불변 파일을 뺀다)
const appAllowRules = (appRoot) => ['Read', 'Glob', 'Grep', 'Edit', 'Write'].map((t) => `${t}(${posixAbs(appRoot)}/**)`);
// 불변 파일·고치면 안 되는 곳을 고치지 못하게 (거부가 허용보다 먼저다 — 진짜 claude 로 확인)
const immutableDenyRules = (appRoot) => PROTECTED.flatMap((p) => {
  const abs = `${posixAbs(appRoot)}/${p.replace(/\/$/, '')}${p.endsWith('/') ? '/**' : ''}`;
  return [`Edit(${abs})`, `Write(${abs})`];
});

module.exports = { ROOT, IMMUTABLE, OFF_LIMITS, PROTECTED, isProtected, git, isRepo, head, hasTag, changedFiles, dirty, revert, commitAll, coreChanged, fingerprint, lock, runStep, killTree, cleanEnv, runGate, posixAbs, appAllowRules, immutableDenyRules };
