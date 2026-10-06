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
  const mainHtml = await (await fetch(BASE + '/', { headers: { Cookie: ck } })).text();
  check('메인 화면이 db.js·cal.js·dash.js 를 불러오고 일정 메뉴에 달력(/m/calendar.html)을 띄움', ['/m/db.js', '/m/cal.js', '/m/dash.js'].every((f) => mainHtml.includes(`src="${f}"`)) && mainHtml.includes('/m/calendar.html')
    && ['오늘 브리핑', '이번 주 일정 정리', '마감 임박 알려줘', '새 프로젝트 등록'].every((q) => mainHtml.includes(q)));
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
    ['GET', '/api/db/events'], ['PUT', '/api/db/events/a'], ['DELETE', '/api/db/events/a'], ['GET', '/api/events'], ['POST', '/api/seed']];
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
  await runSeed(ck);
  await runDash(ck);
  await runCal(ck);
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

// 연습용 예시 데이터 (설정 화면 버튼이 부르는 POST /api/seed)
async function runSeed(ck) {
  const H = { 'Content-Type': 'application/json', Cookie: ck };
  const seed = (body) => fetch(BASE + '/api/seed', { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  const get = async (n) => (await fetch(`${BASE}/api/db/${n}`, { headers: H })).json();
  const dbDir = path.join(dir, 'db');
  const snapshot = () => ['events', 'projects', 'tasks', 'notices'].map((n) => fs.readFileSync(path.join(dbDir, `${n}.json`), 'utf8')).join('\n');
  for (const f of fs.readdirSync(dbDir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dbDir, f)); // 앞 검사가 남긴 자료를 치우고 빈 저장소에서 시작

  const r1 = await seed();
  const added = (await r1.json()).added || {};
  check('빈 저장소에는 바로 들어감: 일정 8·프로젝트 3·할 일 6·알림 2',
    r1.status === 200 && added.events === 8 && added.projects === 3 && added.tasks === 6 && added.notices === 2);
  const [events, projects, tasks, notices] = await Promise.all(['events', 'projects', 'tasks', 'notices'].map(get));
  check('저장소에 개수대로 들어 있음', events.length === 8 && projects.length === 3 && tasks.length === 6 && notices.length === 2);
  const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const ymd = (n) => { const d = new Date(mon); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const inWeek = (e, from) => e.date >= ymd(from) && e.date <= ymd(from + 6);
  check('일정: 이번 주 5개·다음 주 3개', events.filter((e) => inWeek(e, 0)).length === 5 && events.filter((e) => inWeek(e, 7)).length === 3);
  check('일정: 회의·출장·검사 입회가 모두 있음', ['회의', '출장', '검사 입회'].every((k) => events.some((e) => e.kind === k)));
  check('프로젝트: 열교환기 제작·압력용기 개조·공장 자동화', projects.map((p) => p.name).join() === '열교환기 제작,압력용기 개조,공장 자동화');
  check('할 일: 모두 마감일(YYYY-MM-DD)이 있음', tasks.every((t) => /^\d{4}-\d\d-\d\d$/.test(t.due)));
  const ids = new Set(projects.map((p) => p.id));
  check('일정·할 일이 가리키는 프로젝트가 실제로 있음', [...events, ...tasks].every((x) => x.projectId === null || ids.has(x.projectId)));
  check('가상 회사 "가나다전자" 기준', JSON.stringify([events, projects, tasks, notices]).includes('가나다전자'));

  const before = snapshot();
  const r2 = await seed(), j2 = await r2.json();
  check('이미 자료가 있으면 덮어쓰지 않고 409 로 되묻고(개수도 알려 줌), 파일은 그대로',
    r2.status === 409 && j2.exists.events === 8 && j2.exists.tasks === 6 && snapshot() === before);
  check('add 가 정확히 true 가 아니면 여전히 409', (await seed({ add: 'yes' })).status === 409 && snapshot() === before);
  await fetch(BASE + '/api/db/tasks/mine', { method: 'PUT', headers: H, body: JSON.stringify({ title: '내가 직접 적은 할 일' }) });
  const r3 = await seed({ add: true });
  const tasks3 = await get('tasks');
  check('확인(add:true)하면 예시만 더해지고, 내 자료는 그대로이며 예시가 겹쳐 쌓이지 않음',
    r3.status === 200 && tasks3.length === 7 && tasks3.some((t) => t.id === 'mine') && (await get('events')).length === 8);
  fs.writeFileSync(path.join(dbDir, 'events.json'), '{ 깨진 파일');
  const tasksFile = fs.readFileSync(path.join(dbDir, 'tasks.json'), 'utf8');
  check('자료 파일이 깨져 있으면 500 으로 알리고 아무것도 쓰지 않음',
    (await seed({ add: true })).status === 500 && fs.readFileSync(path.join(dbDir, 'tasks.json'), 'utf8') === tasksFile
    && fs.readFileSync(path.join(dbDir, 'events.json'), 'utf8') === '{ 깨진 파일');
}

// 대시보드 계산 (public/m/dash.js): 날짜를 2026-10-06 화요일로 고정해 같은 결과가 나오는지 본다
async function runDash(ck) {
  const box = { window: {} }; vm.createContext(box);
  for (const f of ['cal', 'dash']) vm.runInContext(await (await fetch(`${BASE}/m/${f}.js`, { headers: { Cookie: ck } })).text(), box); // dash.js 는 cal.js 를 먼저 불러와야 한다
  const { greeting, stats, dday } = box.window.dash;
  const at = (h, m = 0) => new Date(2026, 9, 6, h, m);
  const hi = (h, m) => greeting(at(h, m), '가나').split(',')[0];
  check('인사말: 아침(5~11시)·오후(12~17시)·저녁(18시~새벽 4시), 뒤에 "○○님"',
    hi(5) === '좋은 아침입니다' && hi(11, 59) === '좋은 아침입니다' && hi(12) === '좋은 오후입니다' && hi(17, 59) === '좋은 오후입니다'
    && hi(18) === '좋은 저녁입니다' && hi(2) === '좋은 저녁입니다' && greeting(at(9), '가나') === '좋은 아침입니다, 가나님');
  const data = {
    events: [
      { id: 'a', date: '2026-10-06', endDate: '2026-10-06', start: '14:00' },
      { id: 'b', date: '2026-10-05', endDate: '2026-10-07', start: '09:00' }, // 어제부터 내일까지(오늘에 걸침)
      { id: 'c', date: '2026-10-05', endDate: '2026-10-05', start: '08:00' }, // 어제
      { id: 'd', date: '2026-10-07', start: '08:00' }, // 내일
      { id: 'e', date: '2026-10-06', start: '08:30' }, // endDate 없음
      null, { id: 'f' }, // 깨진 항목
    ],
    projects: [{ status: '진행중' }, { status: '계획' }, { status: '진행중' }, null],
    tasks: [
      { id: 't1', due: '2026-10-05', status: '진행중' }, // 어제 마감(지남)
      { id: 't2', due: '2026-10-13', status: '할 일' }, // 딱 7일 뒤(포함)
      { id: 't3', due: '2026-10-14', status: '할 일' }, // 8일 뒤(제외)
      { id: 't4', due: '2026-10-06', status: '완료' }, // 완료(제외)
      { id: 't5', due: '2026-10-06', status: '할 일' },
      { id: 't6', status: '할 일' }, null, // 마감일 없음·깨진 항목
    ],
    notices: [{ read: false }, {}, { read: true }, null],
  };
  const s = stats(data, at(9));
  check('오늘 일정: 오늘 하루짜리+오늘에 걸친 것만, 시간순(어제·내일·깨진 항목 제외)', s.todayEvents.map((e) => e.id).join() === 'e,b,a');
  check('진행 중 프로젝트 수', s.activeProjects === 2);
  check('7일 안 마감 할 일: 지난 것 포함·딱 7일째 포함·8일째와 완료·마감일 없음 제외, 마감 빠른 순', s.dueSoon.map((t) => t.id).join() === 't1,t5,t2' && s.overdue === 1);
  check('안 읽은 알림 수(read 가 없으면 안 읽음)', s.unread === 2);
  const z = stats({}, at(9));
  check('자료가 하나도 없어도 멈추지 않고 0', z.todayEvents.length === 0 && z.activeProjects === 0 && z.dueSoon.length === 0 && z.unread === 0);
  check('D-day 글자: 지남·오늘·D-n', dday('2026-10-05', at(9)) === '1일 지남' && dday('2026-10-06', at(23, 59)) === '오늘' && dday('2026-10-09', at(9)) === 'D-3' && dday('엉터리', at(9)) === '');
}

// 달력 계산·일정 창 검사 (public/m/cal.js) + 달력 화면 파일
async function runCal(ck) {
  const get = (u) => fetch(BASE + u, { headers: { Cookie: ck } });
  check('로그인 전에는 /m/calendar.html 이 401', (await fetch(BASE + '/m/calendar.html')).status === 401);
  const html = await (await get('/m/calendar.html')).text();
  check('달력 화면: db.js·cal.js 를 쓰고 "✳ 비서에게 시키기" 가 정해진 문장을 부탁함',
    html.includes('src="/m/db.js"') && html.includes('src="/m/cal.js"') && html.includes('✳ 비서에게 시키기') && html.includes('이번 주 일정 중 겹치는 게 있는지 봐 줘'));
  check('달력 화면: 월/주 전환·오늘·이전/다음·종류 4가지(회의·출장·검사 입회·개인)', ['data-view="month"', 'data-view="week"', 'id="today"', 'id="prev"', 'id="next"'].every((x) => html.includes(x))
    && ["'회의'", "'출장'", "'검사 입회'", "'개인'"].every((k) => html.includes(k)));
  const box = { window: {} }; vm.createContext(box);
  vm.runInContext(await (await get('/m/cal.js')).text(), box);
  const c = box.window.cal;
  const m10 = c.monthGrid('2026-10-15'), m3 = c.monthGrid('2026-03-01'), m2 = c.monthGrid('2026-02-28');
  check('월 보기 칸: 2026-10 은 9/28(월)~11/1(일) 5줄', m10.length === 5 && m10[0][0] === '2026-09-28' && m10[4][6] === '2026-11-01' && m10.every((w) => w.length === 7));
  check('월 보기 칸: 2026-03 은 6줄(2/23~4/5), 2026-02 는 1/26~3/1 5줄', m3.length === 6 && m3[0][0] === '2026-02-23' && m3[5][6] === '2026-04-05' && m2.length === 5 && m2[0][0] === '2026-01-26' && m2[4][6] === '2026-03-01');
  check('주 보기: 월요일부터 일요일 (일요일을 눌러도 같은 주)', c.weekDays('2026-10-09').join() === '2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09,2026-10-10,2026-10-11'
    && c.weekStart('2026-10-11') === '2026-10-05' && c.weekStart('2026-10-05') === '2026-10-05');
  check('이전·다음: 달 경계·연 경계', c.addDays('2026-10-31', 1) === '2026-11-01' && c.addDays('2026-01-01', -1) === '2025-12-31'
    && c.addMonths('2026-01-31', 1) === '2026-02-01' && c.addMonths('2026-01-15', -1) === '2025-12-01');
  const events = [
    { id: 'a', date: '2026-10-06', endDate: '2026-10-06', start: '14:00' },
    { id: 'b', date: '2026-10-05', endDate: '2026-10-07', start: '09:00' }, // 사흘에 걸침
    { id: 'c', date: '2026-10-06', start: '08:30' }, // endDate 없음
    { id: 'd', date: '2026-10-08', start: '08:00' },
    null, { id: 'e' }, // 깨진 항목
  ];
  check('그 날의 일정: 여러 날 일정은 걸친 모든 날에 보이고(마지막 날 포함), 시작 시각 순, 깨진 항목은 건너뜀',
    c.eventsOn(events, '2026-10-06').map((e) => e.id).join() === 'c,b,a' && c.eventsOn(events, '2026-10-07').map((e) => e.id).join() === 'b'
    && c.eventsOn(events, '2026-10-08').map((e) => e.id).join() === 'd' && c.eventsOn(events, '2026-10-04').length === 0);
  check('할 일 마감일 점: 그 날 마감인 것만', c.dueOn([{ id: 1, due: '2026-10-06' }, { id: 2, due: '2026-10-07' }, null, { id: 3 }], '2026-10-06').map((t) => t.id).join() === '1');
  const ok = { title: '회의', date: '2026-10-09', endDate: '', start: '10:00', end: '11:00' };
  check('일정 창 검사: 정상은 통과', c.validate(ok) === '');
  check('일정 창 검사: 제목이 비면 안내', c.validate({ ...ok, title: '   ' }).includes('제목'));
  check('일정 창 검사: 날짜가 없으면 안내', c.validate({ ...ok, date: '' }).includes('날짜'));
  check('일정 창 검사: 끝 시각이 시작보다 빠르면 안내(하루짜리일 때만)', c.validate({ ...ok, end: '09:00' }).includes('끝 시각')
    && c.validate({ ...ok, endDate: '2026-10-10', end: '09:00' }) === '' && c.validate({ ...ok, start: '', end: '' }) === '');
  check('일정 창 검사: 종료 날짜가 시작 날짜보다 빠르면 안내', c.validate({ ...ok, endDate: '2026-10-08' }).includes('종료 날짜'));
  const f = { title: ' 열교환기 도면 검토 ', kind: '회의', date: '2026-10-09', endDate: '', start: '11:00', end: '12:00', place: ' 설계실 ', memo: '' };
  const made = c.toEvent(null, f, 'new-1');
  check('새 일정: 새 id·종료 날짜는 날짜와 같게·앞뒤 공백 제거', made.id === 'new-1' && made.title === '열교환기 도면 검토' && made.endDate === '2026-10-09' && made.place === '설계실' && made.start === '11:00');
  const edited = c.toEvent({ id: 7, projectId: 'demo-p1', title: '옛', date: '2026-10-09' }, f, 'ignored');
  check('일정 고치기: 기존 id(숫자여도 글자로)·창에 없는 필드(projectId)는 그대로', edited.id === '7' && edited.projectId === 'demo-p1' && edited.title === '열교환기 도면 검토');
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
