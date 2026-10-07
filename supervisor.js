// 감시자 (8편 안전장치). start.bat 이 이 파일을 실행한다. 서버(server.js)를 자식으로 켜고 지켜본다. 비서가 못 고치는 파일 (guard.js 의 IMMUTABLE).
//  - 켠 뒤 /health 가 30초 동안 계속 통과하고 작업 폴더가 깨끗하면 그 커밋에 git tag last-good 을 붙인다 (원격에는 올리지 않는다)
//  - 서버가 비정상으로 끝나면: 커밋 안 된 변경은 따로 커밋해 rescue/<시각> 브랜치에 보존 → last-good 으로 git reset --hard → 다시 켠다
//  - 세 번 연속 실패하면 멈추고 마지막 오류를 보여 준다
// 서버가 끝날 때의 종료 코드: 0 = 정상 종료(감시도 끝) · 10 = 재시작 요청(되돌리기·실패 횟수 없이 바로 다시 켬) · 11 = 포트 사용 중(되돌리지 않고 멈춤) · 그 밖 = 비정상
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const guard = require('./guard.js');

const ROOT = __dirname;
const PORT = Number(process.env.SANCHO_PORT) || 8790;
const DATA = process.env.SANCHO_DATA || path.join(ROOT, 'data');
const LOG = path.join(DATA, 'logs', 'supervisor.log');
const HEALTH_MS = (Number(process.env.SANCHO_HEALTH_SECS) || 30) * 1000; // 건강해야 하는 시간 (점검에서만 줄인다)
const POLL_MS = Number(process.env.SANCHO_HEALTH_POLL_MS) || 3000;
const MAX_FAILS = 3;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

fs.mkdirSync(path.dirname(LOG), { recursive: true });
try { if (fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.old`); } catch { /* 로그가 아직 없으면 그대로 */ }
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* 로그를 못 써도 감시는 계속 */ } };

const health = () => new Promise((ok) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => { res.resume(); ok(res.statusCode === 200); });
  r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
});

// last-good 붙이기: 건강하고, 작업 폴더가 깨끗하고, 불변 파일이 기존 last-good 과 같을 때만
function bless() {
  if (!guard.isRepo(ROOT)) return log('git 저장소가 아니어서 last-good 을 붙이지 않았어요.');
  if (guard.dirty(ROOT)) return log('작업 폴더에 커밋하지 않은 변경이 있어서 last-good 을 올리지 않았어요. (커밋한 뒤 서버를 다시 켜면 올라가요)');
  const core = guard.coreChanged(ROOT);
  if (core.length) return log(`불변 파일(${core.join(', ')})이 마지막 정상 버전과 달라서 last-good 을 자동으로 올리지 않았어요. 사람이 확인한 뒤 직접 git tag -f last-good 해 주세요.`);
  const now = guard.head(ROOT), cur = guard.git(ROOT, 'rev-parse', '-q', '--verify', 'refs/tags/last-good^{commit}').out.trim();
  if (cur === now) return;
  if (guard.git(ROOT, 'tag', '-f', 'last-good', 'HEAD').code === 0) log(`last-good → ${now.slice(0, 7)} (30초 동안 건강했어요)`);
}

// 비정상 종료 뒤 되돌리기: 변경은 rescue 브랜치에 보존하고 last-good 으로 돌아간다. → { branch } | null (되돌릴 게 없거나 못 함)
function rollback(tail) {
  if (!guard.isRepo(ROOT)) return null;
  if (!guard.hasTag(ROOT, 'last-good')) { log('last-good 이 아직 없어서 되돌릴 곳이 없어요.'); return null; }
  const lg = guard.git(ROOT, 'rev-parse', 'last-good^{commit}').out.trim(), isDirty = guard.dirty(ROOT);
  if (!isDirty && guard.head(ROOT) === lg) return null; // 이미 마지막 정상 버전이다: 코드 문제가 아닐 수 있다 (포트·데이터·환경)
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  if (isDirty && !guard.commitAll(ROOT, `자동 보존: 서버가 비정상 종료되기 직전의 변경 (${stamp})`, 'Sancho 감시자')) { log('변경을 보존(커밋)하지 못해서 되돌리지 않았어요. (지우지 않으려고)'); return null; }
  const branch = `rescue/${stamp}`;
  if (guard.git(ROOT, 'branch', branch, 'HEAD').code !== 0) { log('보존 브랜치를 만들지 못해서 되돌리지 않았어요.'); return null; }
  if (guard.git(ROOT, 'reset', '--hard', 'last-good').code !== 0) { log('last-good 으로 되돌리지 못했어요.'); return null; }
  log(`last-good(${lg.slice(0, 7)}) 으로 되돌렸어요. 되돌리기 전의 코드·변경은 "${branch}" 브랜치에 보존했어요.`);
  try { fs.writeFileSync(path.join(DATA, '.rollback.json'), JSON.stringify({ at: new Date().toISOString(), branch, error: tail })); } catch { /* 알림만 못 남긴다 */ }
  return { branch };
}

let stopping = false, current = null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; if (current) guard.killTree(current); setTimeout(() => process.exit(0), 300); }); // Ctrl+C·창 닫기는 비정상 종료로 세지 않는다

// 서버를 한 번 켜서 끝날 때까지: → { code, healthy, tail }
function runOnce() {
  return new Promise((ok) => {
    const chk = spawnSync(process.execPath, ['--check', 'server.js'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (chk.status !== 0) { log('server.js 에 문법 오류가 있어서 켜지 않았어요.'); return ok({ code: -2, healthy: false, tail: String(chk.stderr || '').trim().split('\n').slice(0, 12).join('\n') }); }
    const env = { ...process.env, SANCHO_SUPERVISED: '1' }; delete env.SANCHO_APP_ROOT; // 시험용 틈은 실제 운영 서버에 넘기지 않는다
    const lines = [], keep = (d) => { process.stdout.write(d); lines.push(...String(d).split('\n').filter(Boolean)); if (lines.length > 40) lines.splice(0, lines.length - 40); };
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    current = child; let exited = false, healthy = false;
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (e) => { lines.push(`서버를 켜지 못했어요: ${e.message}`); if (!child.pid) { exited = true; current = null; ok({ code: -1, healthy: false, tail: lines.join('\n') }); } });
    child.on('exit', (code, sig) => { exited = true; current = null; ok({ code: code ?? sig ?? -1, healthy, tail: lines.join('\n') }); });
    (async () => { // 건강 검사: 첫 응답 뒤로 HEALTH_MS 동안 한 번도 안 빠지고 통과해야 "건강"
      let since = 0, warned = false; const t0 = Date.now();
      while (!exited && !stopping) {
        if (await health()) { since = since || Date.now(); if (Date.now() - since >= HEALTH_MS) { healthy = true; log(`서버가 ${Math.round(HEALTH_MS / 1000)}초 동안 건강해요.`); bless(); return; } }
        else { since = 0; if (!warned && Date.now() - t0 > 20_000) { warned = true; log('건강 검사(/health)에 아직 응답하지 않아요.'); } }
        await sleep(POLL_MS);
      }
    })();
  });
}

async function main() {
  if (await health()) { log(`이미 켜진 서버가 있어요. (포트 ${PORT}) 한 번에 하나만 켤 수 있어서 감시자는 시작하지 않아요.`); return 0; }
  log(`감시자 시작 — 서버를 켭니다 (포트 ${PORT}).`);
  let fails = 0;
  for (;;) {
    const r = await runOnce();
    if (stopping || r.code === 0) { log('서버가 정상 종료됐어요. 감시를 끝냅니다.'); return 0; }
    if (r.code === 10) { log('서버가 재시작을 요청했어요(검사 통과). 다시 켭니다.'); continue; }
    if (r.code === 11) { log(`포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있어서 멈춥니다. (코드는 되돌리지 않았어요) 이미 켜진 Sancho 창이 있는지 확인해 주세요.`); return 11; }
    if (r.healthy) fails = 0; // 한동안 멀쩡했다가 죽은 것이면 "연속 실패"가 아니다
    fails++;
    log(`서버가 비정상으로 끝났어요 (종료 코드 ${r.code}) — 연속 ${fails}/${MAX_FAILS}번째.`);
    const rb = rollback(r.tail);
    if (fails >= MAX_FAILS) {
      log(`==== ${MAX_FAILS}번 연속 켜지지 못해서 멈춥니다 ====\n마지막 오류:\n${r.tail || '(출력 없음)'}\n${rb ? `되돌리기 전의 변경은 "${rb.branch}" 브랜치에 보존했고 마지막 정상 버전(last-good)으로 되돌려 두었어요.` : '되돌린 것은 없어요.'}\n자세한 기록: ${LOG}`);
      return 1;
    }
    log('다시 켭니다.');
  }
}
main().then((c) => { process.exitCode = c; }, (e) => { log(`감시자 오류: ${e.stack || e}`); process.exitCode = 1; });
