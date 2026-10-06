// 자가 점검: node selftest.js  (임시 폴더·임시 포트로 서버를 따로 켜서 검사하므로 진짜 data/ 는 건드리지 않는다)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sancho-test-'));
const PW = 'test-password-123';
let pass = 0, failed = 0;

function check(name, cond) {
  console.log(`${cond ? '통과' : '실패'}  ${name}`);
  cond ? pass++ : failed++;
}
const post = (url, body, cookie) => fetch(BASE + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body || {}) });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

async function run() {
  // 로그인 기능
  check('로그인 전 /api/me 는 401', (await fetch(BASE + '/api/me')).status === 401);
  check('로그인 전 / 는 로그인 화면', (await (await fetch(BASE + '/')).text()).includes('id="form"'));
  check('계정이 없을 때 status.hasUsers=false', (await (await fetch(BASE + '/api/auth/status')).json()).hasUsers === false);
  check('짧은 비밀번호(7자)는 거절', (await post('/api/auth/setup', { name: '가', username: 'abc', password: '1234567' })).status === 400);
  const setup = await post('/api/auth/setup', { name: '테스트', username: 'Tester', password: PW });
  check('관리자 계정 만들기 성공', setup.status === 200);
  const sc = setup.headers.get('set-cookie') || '';
  check('세션 쿠키가 HttpOnly·30일', /HttpOnly/i.test(sc) && /Max-Age=2592000/.test(sc));
  check('계정이 있으면 두 번째 만들기는 403', (await post('/api/auth/setup', { name: 'x', username: 'second', password: PW })).status === 403);
  const stored = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  check('users.json 에 평문 비밀번호가 없음(scrypt 해시)', !stored.includes(PW) && stored.includes('scrypt$'));
  check('만든 직후 쿠키로 /api/me 가능', (await fetch(BASE + '/api/me', { headers: { Cookie: cookieOf(setup) } })).status === 200);

  const bad = await post('/api/auth/login', { username: 'tester', password: 'wrong-password' });
  check('틀린 비밀번호는 401', bad.status === 401);
  const login = await post('/api/auth/login', { username: 'TESTER', password: PW });
  check('올바른 비밀번호로 로그인(아이디 대소문자 무시)', login.status === 200);
  const ck = cookieOf(login);
  check('로그인 후 /api/me 가능', (await fetch(BASE + '/api/me', { headers: { Cookie: ck } })).status === 200);
  check('로그인 후 / 는 메인 화면', (await (await fetch(BASE + '/', { headers: { Cookie: ck } })).text()).includes('id="who"'));
  // 대화 (진짜 claude 대신 test/fake-claude.js 로 두뇌 연결 방식을 검사)
  const H = { 'Content-Type': 'application/json', Cookie: ck };
  const ask = async (id, content) => { const r = await fetch(`${BASE}/api/chats/${id}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ content }) }); return { r, sse: await r.text() }; };
  const textOf = (sse) => [...sse.matchAll(/^data: (\{"t":.*\})$/gm)].map((m) => JSON.parse(m[1]).t).join('');
  check('로그인 전 /api/chats 는 401', (await fetch(BASE + '/api/chats')).status === 401);
  const chatId = (await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id;
  check('새 대화 만들기', /^[0-9a-f-]{36}$/.test(chatId));
  const first = await ask(chatId, '안녕 파일 좀 봐줘');
  const t1 = textOf(first.sse);
  check('답이 SSE 로 오고 끝에 done 이벤트', (first.r.headers.get('content-type') || '').startsWith('text/event-stream') && first.sse.includes('event: done'));
  check('사용자 말이 표준입력으로 전달됨', t1.includes('에코: 안녕 파일 좀 봐줘') && t1.includes('stdin=ok'));
  check('도구를 쓰면 "⏺ 파일 읽는 중" 줄이 나옴', t1.includes('⏺ 파일 읽는 중'));
  check('CLAUDECODE·ANTHROPIC_BASE_URL 이 자식 claude 에 안 넘어감', t1.includes('env=clean'));
  check('작업 폴더(cwd)가 data/ 폴더', t1.includes('cwd=') && !t1.includes('cwd=undefined') && t1.includes(path.basename(dir)));
  check('첫 말에는 --resume 없음', t1.includes('resume=none'));
  const chat1 = await (await fetch(`${BASE}/api/chats/${chatId}`, { headers: H })).json();
  check('session_id 가 저장됨', /^fake-/.test(chat1.sessionId || ''));
  const second = await ask(chatId, '이어서');
  check('다음 말에는 저장한 session_id 로 --resume', textOf(second.sse).includes('resume=' + chat1.sessionId));
  const saved = await (await fetch(`${BASE}/api/chats/${chatId}`, { headers: H })).json();
  check('대화가 저장됨(말4개, 제목=첫 말)', saved.messages.length === 4 && saved.title.startsWith('안녕'));
  const chatB = (await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id;
  check('＋ 새 대화는 새 세션(--resume 없음)', textOf((await ask(chatB, '새로')).sse).includes('resume=none'));
  const login2 = await ask((await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id, '/login');
  check('로그인 안 됨이면 쉬운 한국어로 안내', textOf(login2.sse).includes('로그인되어 있지 않습니다'));
  const lim = await ask((await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id, '/limit');
  check('사용 한도면 쉬운 한국어로 안내', textOf(lim.sse).includes('사용 한도에 닿았습니다'));
  check('/md 확인용 장치는 없어짐', !textOf((await ask(chatB, '/md')).sse).includes('화면 확인용 예시'));
  check('없는 대화는 404', (await fetch(`${BASE}/api/chats/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, { headers: H })).status === 404);
  check('빈 메시지는 400', (await fetch(`${BASE}/api/chats/${chatId}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ content: '  ' }) })).status === 400);
  // ■ 중지: 연결을 끊으면 claude 가 꺼지고, 바로 다음 말을 보낼 수 있어야 한다
  const stopId = (await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id;
  const ac = new AbortController();
  const slow = await fetch(`${BASE}/api/chats/${stopId}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ content: '/slow' }), signal: ac.signal });
  await slow.body.getReader().read();
  const t0 = Date.now(); ac.abort();
  let again = { r: { status: 409 } };
  for (let i = 0; i < 40 && again.r.status === 409; i++) { await new Promise((ok) => setTimeout(ok, 150)); again = await ask(stopId, '중지 뒤 다시'); }
  check('중지하면 claude 가 꺼져 곧바로 다시 보낼 수 있음', again.r.status === 200 && Date.now() - t0 < 8000);
  const stopped = await (await fetch(`${BASE}/api/chats/${stopId}`, { headers: H })).json();
  check('중지해도 받은 만큼 저장됨', stopped.messages.length === 4 && stopped.messages[1].content.includes('느림'));
  check('이상한 Host 헤더는 403', await new Promise((ok) => {
    require('http').get({ host: '127.0.0.1', port: PORT, path: '/', headers: { Host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode === 403); });
  }));
  check('public 밖의 파일은 못 가져감', (await fetch(BASE + '/..%2Fserver.js')).status !== 200);
  await post('/api/auth/logout', {}, ck);
  check('로그아웃하면 같은 쿠키로 /api/me 는 401', (await fetch(BASE + '/api/me', { headers: { Cookie: ck } })).status === 401);

  // 잠금: 10번 넘게(11번) 틀리면 그 순간부터 10분 잠금 → 다음 시도는 429
  let last;
  for (let i = 0; i < 11; i++) last = await post('/api/auth/login', { username: 'lockme', password: 'nope' });
  check('11번 틀릴 때까지는 401', last.status === 401);
  check('그 다음 시도는 429(잠금)', (await post('/api/auth/login', { username: 'lockme', password: 'nope' })).status === 429);
  for (let i = 0; i < 11; i++) await post('/api/auth/login', { username: 'tester', password: 'wrong' });
  check('잠기면 맞는 비밀번호도 429', (await post('/api/auth/login', { username: 'tester', password: PW })).status === 429);
}

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, SANCHO_PORT: String(PORT), SANCHO_DATA: dir, SANCHO_BRAIN_SCRIPT: path.join(__dirname, 'test', 'fake-claude.js'), CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'http://leak.invalid' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.once('data', async () => {
  try { await run(); } catch (e) { check('점검 중 예외: ' + e.message, false); }
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
});
