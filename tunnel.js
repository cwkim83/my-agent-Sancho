// 임시 인터넷 주소 만들기 (Cloudflare 퀵 터널): node tunnel.js
//   cloudflared tunnel --url http://127.0.0.1:8790 (+ 빈 --config, 아래 설명) 을 켜고, 나온 https 주소를 출력하며 data/tunnel.json 에 적는다 (설정 → 외부 접속 칸이 이 주소를 보여 준다).
//   끄기: 이 창에서 Ctrl+C, 또는 다른 창에서 node tunnel.js stop. 주소는 켤 때마다 바뀐다.
//   접속 토큰은 여기서 다루지 않는다 (설정 → 외부 접속에서 따로). 외부 접속이 꺼져 있으면 터널 주소로 와도 서버가 막는다.
//   cloudflared 가 없으면: winget install --id Cloudflare.cloudflared  (Cloudflare 가 서명한 정식 프로그램)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SANCHO_PORT) || 8790;
const DATA = process.env.SANCHO_DATA || path.join(__dirname, 'data');
const FILE = path.join(DATA, 'tunnel.json');

const readInfo = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const kill = (pid) => { // 윈도우는 자식 프로그램까지 같이 (/T)
  if (!pid) return;
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid); } catch { /* 이미 꺼져 있음 */ }
};

if (process.argv[2] === 'stop') {
  const t = readInfo();
  if (!t) { console.log('켜져 있는 터널이 없어요.'); process.exit(0); }
  kill(t.pid); if (t.wrapper !== process.pid) kill(t.wrapper);
  fs.rmSync(FILE, { force: true });
  console.log('터널을 껐어요.');
  process.exit(0);
}

const old = readInfo();
if (old && alive(old.pid)) { console.log(`이미 켜져 있어요: ${old.url}\n(끄려면 node tunnel.js stop)`); process.exit(0); }

const exe = [process.env.CLOUDFLARED, 'cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']
  .filter(Boolean).find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
if (!exe) { console.error('cloudflared 를 찾지 못했어요. 설치: winget install --id Cloudflare.cloudflared'); process.exit(1); }

// 빈 설정 파일을 --config 로 쓴다: 이 PC 에 ~/.cloudflared/config.yml(다른 터널용)이 있으면 --url 만으로 만든 임시 터널이 그 파일의 규칙을 따라 전부 404 가 된다.
// 빈 파일을 지정하면 그 파일을 읽지 않는다 (기존 설정은 건드리지 않는다)
const QUICK_CFG = path.join(DATA, 'tunnel-quick.yml');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(QUICK_CFG, '# 임시 터널 전용 빈 설정 (tunnel.js 가 만듭니다). 비워 두세요.\n');
const child = spawn(exe, ['tunnel', '--config', QUICK_CFG, '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let shown = false;
const onData = (d) => { // 주소는 cloudflared 가 stderr 에 한 번 적어 준다. 다른 로그는 화면에 내보내지 않는다
  const m = !shown && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
  if (!m) return;
  shown = true;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ url: m[0], pid: child.pid, wrapper: process.pid, startedAt: new Date().toISOString() }));
  console.log(`터널 주소: ${m[0]}\n끄려면 Ctrl+C 또는 node tunnel.js stop. 접속 토큰은 설정 → 외부 접속에서 따로 복사해 전해 주세요.`);
};
child.stdout.on('data', onData); child.stderr.on('data', onData);
child.on('exit', (code) => { fs.rmSync(FILE, { force: true }); console.log('터널이 꺼졌어요.'); process.exit(code || 0); });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { kill(child.pid); fs.rmSync(FILE, { force: true }); process.exit(0); });
