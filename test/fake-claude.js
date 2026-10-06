// 점검용 가짜 claude: 진짜 Claude Code 와 같은 모양(stream-json)의 줄을 흉내 낸다. 서버 점검(selftest.js)에서만 쓴다.
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => run(input.trim()));
const a = process.argv;
const ri = a.indexOf('--resume');
const sid = ri >= 0 ? a[ri + 1] : 'fake-' + Date.now();
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(msg) {
  out({ type: 'system', subtype: 'init' });
  if (msg === '/login') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
  if (msg === '/limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' }); process.exit(1);
  }
  if (msg === '/crash') { process.stderr.write('boom: 갑자기 죽음'); process.exit(3); } // 결과 없이 죽는 경우
  if (msg.startsWith('/wait')) { require('fs').appendFileSync('wait-runs.log', 'start\n'); await sleep(2500); } // 예약 겹침 점검용: 시작할 때마다 한 줄 적고 2.5초 걸린다
  if (msg === '/slow') { for (let i = 0; i < 300; i++) { delta('느림 '); await sleep(100); } }
  if (msg.includes('파일')) out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read', id: 't1' } } });
  const leak = (process.env.CLAUDECODE || process.env.ANTHROPIC_BASE_URL) ? 'LEAK' : 'clean';
  const fs = require('fs');
  const arg = (flag) => (a.indexOf(flag) >= 0 ? a[a.indexOf(flag) + 1] : null);
  const sysFile = arg('--append-system-prompt-file');
  const sysOk = sysFile && fs.existsSync(sysFile) && fs.readFileSync(sysFile, 'utf8').includes('Sancho') ? 'ok' : 'none';
  const deny = ['.system.md', '.claude/**'].every((f) => a.includes(`Edit(./${f})`) && a.includes(`Write(./${f})`)) && a.includes('Bash')
    && ['users.json', 'sessions.json', 'share.json'].every((f) => ['Read', 'Edit', 'Write'].every((t) => a.includes(`${t}(./${f})`))) ? 'ok' : 'none'; // 비밀번호·로그인 기록·공유 링크 파일은 읽지도 못하게
  // 허용 도구가 모두 data/ 안(./**)으로 묶여 있는지: 범위 없는 'Read' 같은 것이 하나라도 있으면 none
  const allowed = a.slice(a.indexOf('--allowedTools') + 1);
  const allowList = allowed.slice(0, allowed.findIndex((x) => x.startsWith('--')));
  const scope = allowList.length && allowList.every((t) => ['WebSearch', 'WebFetch'].includes(t) || /^(Read|Glob|Grep|Edit|Write)\(\.\/\*\*\)$/.test(t)) ? 'ok' : 'none';
  if (msg.startsWith('기억해:')) fs.appendFileSync('memory.md', `- 2000-01-01 ${msg.slice(4).trim()}\n`); // 진짜 비서가 하는 일을 흉내
  const reply = `에코: ${msg} | resume=${ri >= 0 ? a[ri + 1] : 'none'} | env=${leak} | cwd=${require('path').basename(process.cwd())} | stdin=ok | sys=${sysOk} | deny=${deny} | scope=${scope} | ctx=${arg('--append-system-prompt')}`;
  for (let i = 0; i < reply.length; i += 4) { delta(reply.slice(i, i + 4)); await sleep(5); }
  out({ type: 'result', subtype: 'success', is_error: false, result: reply });
}
