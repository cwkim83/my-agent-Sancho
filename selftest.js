// 자가 점검: node selftest.js  (임시 폴더·임시 포트로 서버를 따로 켜서 검사하므로 진짜 data/ 는 건드리지 않는다)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

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
    ['POST', `/api/chats/${chatId}/messages`], ['GET', '/api/memory'], ['POST', '/api/memory/delete'],
    ['GET', '/api/db/events'], ['PUT', '/api/db/events/a'], ['DELETE', '/api/db/events/a'], ['GET', '/api/events']];
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
  await runDb(ck);
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

// 업무 자료 저장소: data/db/<이름>.json 저장·수정·삭제·바뀜 알림, 화면용 도우미 public/m/db.js
async function runDb(ck) {
  const H = { 'Content-Type': 'application/json', Cookie: ck };
  const api = (method, url, body) => fetch(BASE + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const getList = async (name) => (await api('GET', `/api/db/${name}`)).json();
  const dbDir = path.join(dir, 'db');
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // 바뀜 알림 통로(/api/events)를 열어 두고, 오는 글을 heard 에 모은다
  const ac = new AbortController();
  const stream = await fetch(BASE + '/api/events', { headers: { Cookie: ck }, signal: ac.signal });
  check('/api/events 는 SSE 로 열림', (stream.headers.get('content-type') || '').startsWith('text/event-stream'));
  let heard = ''; const dec = new TextDecoder(); const rd = stream.body.getReader();
  (async () => { for (;;) { const r = await rd.read().catch(() => ({ done: true })); if (r.done) return; heard += dec.decode(r.value); } })();
  const changed = async (name) => { // "<이름> 이 바뀜" 알림이 올 때까지 최대 3초
    const re = new RegExp(`^event: db\\ndata: \\{"name":"${name}"\\}$`, 'm');
    for (let i = 0; i < 100 && !re.test(heard); i++) await sleep(30);
    const ok = re.test(heard); heard = ''; return ok;
  };
  const quiet = async () => { await sleep(200); heard = ''; }; // 앞선 알림이 다 올 때까지 기다렸다가 비운다

  check('처음에는 빈 목록([])', JSON.stringify(await getList('events')) === '[]');
  const put1 = await api('PUT', '/api/db/events/e1', { title: '회의', date: '2026-10-07' });
  check('저장(PUT): 새 항목이 id 와 함께 돌아옴', put1.status === 200 && (await put1.json()).id === 'e1');
  check('저장하면 알림: events 가 바뀜', await changed('events'));
  const file = JSON.parse(fs.readFileSync(path.join(dbDir, 'events.json'), 'utf8'));
  check('data/db/events.json 에 [{id, …}] 배열로 저장됨', Array.isArray(file) && file.length === 1 && file[0].id === 'e1' && file[0].title === '회의');
  await api('PUT', '/api/db/events/e1', { title: '회의(수정)', id: 'other' });
  await api('PUT', '/api/db/events/e2', { title: '점검' });
  const list = await getList('events');
  check('수정(같은 id 로 PUT): 개수는 그대로, 내용은 통째로 바뀜, 본문의 다른 id 는 무시',
    list.length === 2 && list[0].id === 'e1' && list[0].title === '회의(수정)' && !('date' in list[0]) && list[1].id === 'e2');
  check('저장 뒤 임시 파일(.tmp)이 안 남음', !fs.readdirSync(dbDir).some((f) => f.endsWith('.tmp')));
  await quiet();
  check('삭제(DELETE)', (await api('DELETE', '/api/db/events/e1')).status === 200 && (await getList('events')).map((x) => x.id).join() === 'e2');
  check('삭제하면 알림: events 가 바뀜', await changed('events'));
  check('없는 항목을 지우면 404', (await api('DELETE', '/api/db/events/e1')).status === 404);
  for (const u of ['/api/db/Events/a', '/api/db/..%2Fusers/a', '/api/db/events/a.b', '/api/db/events/a%2Fb'])
    check(`이상한 이름·id 는 저장 거절: PUT ${u}`, (await api('PUT', u, { x: 1 })).status === 404);
  check('내용이 객체가 아니면 400', (await api('PUT', '/api/db/events/e3', [1])).status === 400
    && (await fetch(BASE + '/api/db/events/e3', { method: 'PUT', headers: H, body: '{깨짐' })).status === 400);
  check('다른 사이트에서 온 저장 요청은 403', (await fetch(BASE + '/api/db/events/e3', { method: 'PUT', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' })).status === 403
    && (await getList('events')).length === 1);

  // AI 가 파일을 직접 고쳐도 화면이 따라 바뀐다
  await quiet();
  fs.writeFileSync(path.join(dbDir, 'tasks.json'), JSON.stringify([{ id: 't1', title: 'AI 가 직접 적음' }]));
  check('파일을 직접 고쳐도 알림: tasks 가 바뀜', await changed('tasks'));
  check('직접 고친 내용이 목록에 보임', (await getList('tasks'))[0].title === 'AI 가 직접 적음');
  await quiet();
  fs.writeFileSync(path.join(dbDir, 'zz.json.tmp'), 'x'); await sleep(250);
  check('임시 파일(.tmp)이 생겨도 알리지 않음', !heard.includes('event: db'));
  ac.abort();

  // 깨진 파일은 알려 주기만 하고 덮어쓰지 않는다
  fs.writeFileSync(path.join(dbDir, 'broken.json'), '{ 깨진 파일');
  check('깨진 파일은 500 으로 알리고, 저장해도 덮어쓰지 않음', (await api('GET', '/api/db/broken')).status === 500
    && (await api('PUT', '/api/db/broken/a', {})).status === 500 && fs.readFileSync(path.join(dbDir, 'broken.json'), 'utf8') === '{ 깨진 파일');
  fs.writeFileSync(path.join(dbDir, 'bom.json'), '﻿[{"id":"b"}]');
  check('메모장이 붙이는 BOM 이 있어도 읽힘', (await getList('bom'))[0].id === 'b');

  // 화면용 도우미 public/m/db.js (브라우저 대신 vm 에서 실행, EventSource 는 가짜로 대신해 서버 쪽 흉내)
  check('/m/db.js 는 로그인해야 받을 수 있음', (await fetch(BASE + '/m/db.js')).status === 401);
  const jsRes = await fetch(BASE + '/m/db.js', { headers: H });
  check('로그인하면 /m/db.js 가 자바스크립트로 내려옴', jsRes.status === 200 && (jsRes.headers.get('content-type') || '').startsWith('text/javascript'));
  check('폴더 주소(/m/)나 대문자(/M/db.js)로는 안 열림', (await fetch(BASE + '/m/', { headers: H })).status === 404 && (await fetch(BASE + '/M/db.js', { headers: H })).status === 404);
  const esList = [];
  class FakeES { constructor(u) { this.u = u; this.h = {}; esList.push(this); } addEventListener(t, f) { this.h[t] = f; } }
  const box = { window: {}, EventSource: FakeES, fetch: (u, o = {}) => fetch(BASE + u, { ...o, headers: { ...o.headers, Cookie: ck } }) };
  vm.runInNewContext(await jsRes.text(), box);
  const d = box.window.db;
  await d.save('notices', 'n1', { text: '안녕' });
  check('db.js: save 한 것이 list 에 보임', (await d.list('notices'))[0].text === '안녕');
  await d.save('notices', 'n1', { text: '바뀜' });
  const nl = await d.list('notices');
  check('db.js: 같은 id 로 save 하면 수정', nl.length === 1 && nl[0].text === '바뀜');
  await d.remove('notices', 'n1');
  check('db.js: remove 하면 목록에서 사라짐', (await d.list('notices')).length === 0);
  check('db.js: 서버가 거절하면 그 이유 문구로 오류를 던짐', await d.remove('notices', 'n1').then(() => false, (e) => e.message === '없는 항목입니다.'));
  const got = [];
  const stop = d.watch('events', () => got.push('e')); d.watch('tasks', () => got.push('t'));
  const es = esList[0];
  es.h.db({ data: '{"name":"events"}' });
  check('db.js: watch 는 /api/events 연결 하나를 나눠 쓰고, 이름이 같은 함수만 부름', esList.length === 1 && es.u === '/api/events' && got.join() === 'e');
  es.onopen(); es.onopen();
  check('db.js: 맨 처음 연결은 넘기고, 끊겼다 다시 이어지면 모두에게 알림', got.join() === 'e,e,t');
  stop(); es.h.db({ data: '{"name":"events"}' });
  check('db.js: watch 가 돌려준 함수로 끄면 더 안 불림', got.join() === 'e,e,t');
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
