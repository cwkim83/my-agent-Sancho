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
  // 다른 웹사이트가 내 브라우저를 거쳐 계정을 먼저 만들지 못해야 한다
  const evil = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: JSON.stringify(body) });
  check('다른 사이트에서 온 계정 만들기는 403', (await evil('/api/auth/setup', { name: '해커', username: 'evil', password: 'evil-password' })).status === 403
    && (await (await fetch(BASE + '/api/auth/status')).json()).hasUsers === false);
  check('다른 사이트에서 온 로그인 시도는 403(잠금 걸기도 못 함)', (await evil('/api/auth/login', { username: 'tester', password: 'x' })).status === 403);
  check('이름에 줄바꿈 같은 특수 문자는 거절', (await post('/api/auth/setup', { name: '가\u0000나', username: 'abc', password: PW })).status === 400);
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
  check('같은 사이트(Origin 이 우리 주소)에서 온 로그인은 정상', (await fetch(BASE + '/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ username: 'tester', password: PW }) })).status === 200);
  for (const u of ['/', '/index.html', '/Index.html', '/INDEX.HTML', '/index.html.', '/index.html%20'])
    check(`로그인 없이 ${u} 로는 메인 화면이 안 열림`, !(await (await fetch(BASE + u)).text()).includes('id="who"'));
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
  // 로그인 없이는 어떤 API 도 안 열려야 한다 (진짜 있는 대화 번호로도)
  const guarded = [['GET', '/api/me'], ['GET', '/api/chats'], ['POST', '/api/chats'], ['GET', `/api/chats/${chatId}`],
    ['POST', `/api/chats/${chatId}/messages`], ['GET', '/api/memory'], ['POST', '/api/memory/delete']];
  for (const [m, u] of guarded)
    check(`로그인 없이 ${m} ${u.replace(chatId, '<대화>')} 는 401`, (await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'POST' ? '{"content":"x","i":1,"text":"- x"}' : undefined })).status === 401);
  check('두뇌의 파일 도구가 data/ 안(./**)으로만 허용됨', t1.includes('scope=ok'));
  // claude 가 결과 없이 죽어도 화면이 멈추지 않아야 한다
  const crashId = (await (await fetch(BASE + '/api/chats', { method: 'POST', headers: H })).json()).id;
  const crash = await ask(crashId, '/crash');
  check('claude 가 중간에 죽으면 안내 문구와 함께 답이 끝남(done)', crash.sse.includes('event: done') && textOf(crash.sse).includes('⚠ Claude 가 오류로 끝났습니다') && textOf(crash.sse).includes('boom'));
  check('죽은 뒤에도 같은 대화에 바로 다시 보낼 수 있음', (await ask(crashId, '다시')).r.status === 200);
  check('빈 메시지는 400', (await fetch(`${BASE}/api/chats/${chatId}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ content: '  ' }) })).status === 400);
  // 성격 · 기억
  const sys = fs.readFileSync(path.join(dir, '.system.md'), 'utf8');
  check('data/.system.md 가 만들어지고 Sancho·기억 규칙이 들어 있음', sys.includes('Sancho') && sys.includes('기억해:') && sys.includes('잊어:') && sys.includes('(기억함)') && sys.includes('memory.md'));
  check('data/memory.md 가 만들어짐', fs.existsSync(path.join(dir, 'memory.md')));
  const today = new Date().toLocaleDateString('sv-SE');
  check('claude 에 .system.md 를 --append-system-prompt-file 로 넘김', t1.includes('sys=ok'));
  check('실행할 때마다 주인 이름과 오늘 날짜를 알려 줌', t1.includes('주인 이름: 테스트') && t1.includes('오늘 날짜: ' + today));
  check('두뇌는 .system.md 를 못 고치고 명령 도구도 못 씀', t1.includes('deny=ok'));
  check('로그인 전 /api/memory 는 401', (await fetch(BASE + '/api/memory')).status === 401);
  const mem0 = await (await fetch(BASE + '/api/memory', { headers: H })).json();
  check('처음에는 기억이 비어 있음(제목 줄은 안 보임)', mem0.items.length === 0);
  await ask(chatB, '기억해: 보고서는 표로 받는다');
  const mem1 = (await (await fetch(BASE + '/api/memory', { headers: H })).json()).items;
  check('"기억해:" 로 적힌 줄이 기억 목록에 보임', mem1.length === 1 && mem1[0].text === '- 2000-01-01 보고서는 표로 받는다');
  check('다른 내용으로 지우려 하면 409(그 사이에 바뀜)', (await post('/api/memory/delete', { i: mem1[0].i, text: '- 다른 줄' }, ck)).status === 409);
  check('제목 줄(- 로 시작 안 함)은 지울 수 없음', (await post('/api/memory/delete', { i: 0, text: '# 기억' }, ck)).status === 409);
  check('삭제 버튼: 그 줄이 지워짐', (await post('/api/memory/delete', { i: mem1[0].i, text: mem1[0].text }, ck)).status === 200
    && (await (await fetch(BASE + '/api/memory', { headers: H })).json()).items.length === 0);
  check('삭제해도 파일의 제목 줄은 남음', fs.readFileSync(path.join(dir, 'memory.md'), 'utf8').startsWith('# 기억'));
  const rawToken = ck.split('=')[1];
  check('세션 파일에 쿠키 토큰 원문이 없음(해시만 저장)', !fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8').includes(rawToken));

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

// 서버를 켜고, 화면에 찍는 글(로그)을 모두 모아 둔다
function startServer(port, dataDir, env) {
  const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...env, SANCHO_PORT: String(port), SANCHO_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.log = '';
  s.ready = new Promise((ok) => {
    const add = (d) => { s.log += d; if (s.log.includes('실행 중')) ok(); };
    s.stdout.on('data', add); s.stderr.on('data', add);
  });
  return s;
}
const filesUnder = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(d, e.name)) : [path.join(d, e.name)]));

// claude 프로그램이 아예 없는 PC 를 흉내: PATH 를 빈 폴더로 바꾼 서버를 하나 더 켠다
async function runNoClaude() {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sancho-test2-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sancho-empty-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && k !== 'SANCHO_BRAIN_SCRIPT'));
  const s2 = startServer(8792, dir2, { ...env, PATH: empty });
  await s2.ready;
  const B2 = 'http://127.0.0.1:8792';
  const r = await fetch(B2 + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '둘', username: 'two', password: PW }) });
  const H2 = { 'Content-Type': 'application/json', Cookie: cookieOf(r) };
  const id = (await (await fetch(B2 + '/api/chats', { method: 'POST', headers: H2 })).json()).id;
  const t0 = Date.now();
  const sse = await (await fetch(`${B2}/api/chats/${id}/messages`, { method: 'POST', headers: H2, body: JSON.stringify({ content: '안녕' }), signal: AbortSignal.timeout(15000) })).text();
  check('claude 가 없는 PC 에서는 바로 쉬운 안내와 함께 끝남(멈추지 않음)', sse.includes('claude 프로그램을 찾을 수 없습니다') && sse.includes('event: done') && Date.now() - t0 < 10000);
  s2.kill();
  fs.rmSync(dir2, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true });
}

const srv = startServer(PORT, dir, { ...process.env, SANCHO_BRAIN_SCRIPT: path.join(__dirname, 'test', 'fake-claude.js'), CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'http://leak.invalid' });
srv.ready.then(async () => {
  try {
    await run();
    await runNoClaude();
    // 비밀번호 평문이 서버 로그나 data/ 의 어떤 파일에도 남지 않아야 한다
    check('서버 로그에 비밀번호 평문이 없음', !srv.log.includes(PW));
    const leaked = filesUnder(dir).filter((f) => fs.readFileSync(f, 'utf8').includes(PW));
    check('data/ 의 어떤 파일에도 비밀번호 평문이 없음', leaked.length === 0);
  } catch (e) { check('점검 중 예외: ' + e.message, false); }
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
});
