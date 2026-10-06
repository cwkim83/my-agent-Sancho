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
    ['GET', '/api/db/events'], ['PUT', '/api/db/events/a'], ['DELETE', '/api/db/events/a'], ['GET', '/api/events'], ['POST', '/api/seed'],
    ['GET', '/api/wbs/p1'], ['PUT', '/api/wbs/p1'], ['GET', '/api/wbs/p1/revs'], ['POST', '/api/wbs/p1/revs'], ['GET', '/api/wbs/p1/revs/1'], ['POST', '/api/wbs/p1/revs/1/restore'],
    ['GET', '/api/wbs/p1/share'], ['POST', '/api/wbs/p1/share'], ['DELETE', '/api/wbs/p1/share']];
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
  check('.system.md 에 업무 데이터 규칙이 있음(스킬 형식대로 직접 고침·무작위 id·한 줄 보고·날짜 정확히 계산·삭제는 먼저 물음)',
    ['platform 스킬', 'data/db/*.json 을 직접 고친다', '짧은 무작위 문자열', '한 줄로 알려', '오늘 날짜를 기준으로 정확히', '다음 주 화요일', '먼저 물어보고'].every((w) => sys.includes(w)));
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'platform', 'SKILL.md'), 'utf8');
  check('data/.claude/skills/platform/SKILL.md 가 만들어짐(이름 platform, 세 파일 위치·id 규칙·삭제는 먼저 물음)',
    /^---\r?\nname: platform\r?\n/.test(skill) && ['data/db/events.json', 'data/db/tasks.json', 'data/db/projects.json', '짧은 무작위', '먼저 물어보고'].every((w) => skill.includes(w)));
  check('스킬에 날짜 계산법이 있음(월요일 시작·내일·이번 주·다음 주·월말·시각 말)',
    ['월요일부터 일요일', '`내일`', '`이번 주 ○요일`', '`다음 주 ○요일`', '월말', '`오후 세 시` → `15:00`'].every((w) => skill.includes(w)));
  const today = new Date().toLocaleDateString('sv-SE');
  check('claude 에 .system.md 를 --append-system-prompt-file 로 넘김', t1.includes('sys=ok'));
  check('실행할 때마다 주인 이름과 오늘 날짜를 알려 줌', t1.includes('주인 이름: 테스트') && t1.includes('오늘 날짜: ' + today));
  check('두뇌는 .system.md 와 .claude/(스킬)를 못 고치고, 명령 도구도 못 쓰고, 비밀번호·로그인 기록·공유 링크 파일(users·sessions·share.json)은 읽지도 못함', t1.includes('deny=ok'));
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
  await runProjects(ck);
  await runWbs(ck);
  runSkills();
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

  // 동시 저장: 본문이 늦게 오는 저장 사이에 다른 저장이 끝나도 둘 다 남아야 한다 (예전엔 늦은 쪽이 옛 목록으로 덮어써 하나가 사라졌다)
  const slowBody = JSON.stringify({ title: '느린 저장' });
  const slow = new Promise((ok) => {
    const q = require('http').request({ host: '127.0.0.1', port: PORT, method: 'PUT', path: '/api/db/race/slow',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(slowBody), Cookie: ck } }, (r) => { r.resume(); ok(r.statusCode); });
    q.write(slowBody.slice(0, 5)); // 본문 앞부분만 보내고 잠시 멈춘다
    setTimeout(() => q.end(slowBody.slice(5)), 300);
  });
  await sleep(80);
  const fastOk = (await api('PUT', '/api/db/race/fast', { title: '빠른 저장' })).status === 200;
  check('동시 저장: 늦게 끝나는 저장 사이에 다른 저장이 끝나도 둘 다 남음', fastOk && (await slow) === 200
    && (await getList('race')).map((x) => x.id).sort().join() === 'fast,slow');
  const many = await Promise.all(Array.from({ length: 30 }, (_, i) => api('PUT', `/api/db/race2/r${i}`, { i })));
  check('동시 저장: 30개를 한꺼번에 저장해도 30개 모두 남고 파일이 안 깨짐', many.every((r) => r.status === 200) && (await getList('race2')).length === 30
    && !fs.readdirSync(dbDir).some((f) => f.endsWith('.tmp')));
  check('윈도우 장치 이름(nul·con 등)은 묶음 이름으로 못 씀', (await api('PUT', '/api/db/nul/x', { x: 1 })).status === 404 && (await api('GET', '/api/db/con')).status === 404);

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

  const skillText = fs.readFileSync(path.join(dir, '.claude', 'skills', 'platform', 'SKILL.md'), 'utf8');
  const undocumented = [];
  for (const [n, rows] of Object.entries({ events, projects, tasks, notices }))
    for (const k of new Set(rows.flatMap(Object.keys))) if (!skillText.includes('`' + k + '`')) undocumented.push(n + '.' + k);
  check('스킬 문서에 화면이 쓰는 모든 필드가 적혀 있음(문서와 화면이 어긋나지 않음)' + (undocumented.length ? ' — 빠진 것: ' + undocumented.join() : ''), !undocumented.length);
  check('서버를 켜면 data 의 옛 스킬 문서가 templates 의 새 내용으로 바뀜(새 규칙이 기존 설치에도 반영)',
    skillText === fs.readFileSync(path.join(__dirname, 'templates', 'skills', 'platform', 'SKILL.md'), 'utf8'));

  // 예시 공정표: 열교환기 제작(demo-p1)
  const wbsCalc = require('./public/m/wbs-calc.js');
  const wdoc = JSON.parse(fs.readFileSync(path.join(dir, 'wbs', 'demo-p1.json'), 'utf8'));
  const wc = wbsCalc.compute(wdoc, wbsCalc.today());
  check('예시 공정표(data/wbs/demo-p1.json): 대단락 5개(설계·구매·제작·검사·출하)와 작업 15개, 형식 오류 없음',
    wbsCalc.validate(wdoc) === '' && wc.problems.length === 0 && wc.rows.filter((r) => !r.leaf).map((r) => r.name).join() === '설계,구매,제작,검사,출하' && wc.rows.filter((r) => r.leaf).length === 15);
  check('예시 공정표: 완료·진행·지연·대기가 모두 보이고, 지연 작업은 2개이고, 계약금액이 들어 있음',
    ['완료', '진행', '지연', '대기'].every((s) => wc.rows.some((r) => r.status === s)) && wc.evms.late === 2 && wdoc.bac === 1200000000 && typeof wdoc.actualLog[wbsCalc.today()] === 'number');
  check('예시 공정표가 가리키는 프로젝트(demo-p1)가 실제로 있음', ids.has('demo-p1'));
  const logDays = Object.keys(wdoc.actualLog).sort();
  check('예시 공정표에는 S-곡선용 과거 기록이 주 단위로 쌓여 있고(8개 이상), 줄어들지 않음', logDays.length >= 8 && logDays.every((d, i) => i === 0 || wdoc.actualLog[d] >= wdoc.actualLog[logDays[i - 1]]));
  const wkeys = new Set([...Object.keys(wdoc), ...wdoc.items.flatMap(Object.keys)]);
  const wbsSkillText = fs.readFileSync(path.join(dir, '.claude', 'skills', 'wbs', 'SKILL.md'), 'utf8');
  check('wbs 스킬 문서에 공정표 파일의 모든 필드가 적혀 있음', [...wkeys].every((k) => wbsSkillText.includes('`' + k + '`')) && wbsSkillText.includes('data/wbs/<프로젝트 id>.json'));

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
  const wg = await (await fetch(BASE + '/api/wbs/demo-p1', { headers: H })).json();
  await fetch(BASE + '/api/wbs/demo-p1', { method: 'PUT', headers: H, body: JSON.stringify({ etag: wg.etag, doc: { ...wg.doc, bac: 777 } }) });
  await seed({ add: true });
  check('예시를 다시 넣어도 이미 있는 공정표는 덮어쓰지 않음(내가 고친 계약금액이 그대로)', (await (await fetch(BASE + '/api/wbs/demo-p1', { headers: H })).json()).doc.bac === 777);
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
  const junk = [null, 0, 'x', [], true, {}];
  let js;
  try { js = stats({ events: junk, projects: junk, tasks: [...junk, { id: 'w', due: '10/7', status: '할 일' }], notices: [...junk, { read: false }] }, at(9)); } catch (e) { js = '예외: ' + e.message; }
  check('대시보드: 이상한 자료가 섞여도 계산이 멈추지 않음', typeof js === 'object');
  check('대시보드: 마감일 모양이 틀린 할 일("10/7")은 7일 안 마감에 안 셈', typeof js === 'object' && js.dueSoon.length === 0);
  check('대시보드: 알림 파일에 숫자·글자가 섞여도 안 읽은 알림은 진짜 항목만 셈', typeof js === 'object' && js.unread === 2);
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

  // 비서가 형식을 어겨 쓴 항목: 화면이 멈추지 않고 건너뛰되, 무엇이 문제인지 찾아 알려 준다
  check('날짜·시각 모양 검사: 없는 날(2/31)·숫자 날짜·한 자리 시·24시는 틀림',
    c.isDate('2026-10-06') && !c.isDate('2026-02-31') && !c.isDate(20261006) && !c.isDate('2026/10/06') && c.isTime('09:00') && !c.isTime('9:00') && !c.isTime('24:00'));
  const weird = [null, 0, 'x', [], true, { id: 1, title: 2, date: 20261006 }, { id: 'a', date: '2026/10/06', title: '슬래시' },
    { id: 'b', date: '10월 6일', title: '한글 날짜' }, { id: 'c', date: '2026-10-06', endDate: '2026-10-05', title: '끝이 빠름' },
    { id: 'd', date: '2026-10-06', start: '9:00', title: '한 자리 시' }, { id: 'e', date: '2026-02-31', title: '없는 날' },
    { id: '한글', date: '2026-10-06', title: '이상한 id' }, { id: 'ok', date: '2026-10-06', start: '10:00', title: '정상' }];
  let probs, on6;
  try { probs = c.problems(weird, [{ id: 't', due: '10/7', title: '마감 모양' }, 'y']); on6 = c.eventsOn(weird, '2026-10-06').map((e) => e.id).join(); } catch (e) { probs = '예외: ' + e.message; }
  check('형식이 틀린 항목이 섞여도 계산이 멈추지 않음', Array.isArray(probs));
  check('형식 검사: 틀린 일정 12개·할 일 2개를 모두 찾고, 정상 항목은 안 잡음', Array.isArray(probs) && probs.length === 14 && !probs.some((p) => p.includes('정상'))
    && ['일정 "슬래시": 날짜가', '일정 "없는 날": 날짜가', '일정 "끝이 빠름": 끝 날짜가', '일정 "한 자리 시": 시각이', '일정 "이상한 id": id 가', '할 일 "마감 모양": 마감일이'].every((w) => probs.some((p) => p.startsWith(w))));
  check('달력: 날짜 모양이 틀린 일정은 빼고, 끝 날짜만 이상한 일정은 시작 날짜 하루짜리로 보여 줌', on6 === 'c,한글,ok,d');
}

// 프로젝트 계산·새 프로젝트 창·연간 간트 자리 검사 (public/m/proj.js) + 프로젝트 화면 파일
async function runProjects(ck) {
  const get = (u) => fetch(BASE + u, { headers: { Cookie: ck } });
  check('로그인 전에는 /m/projects.html·/m/proj.js 가 401', (await fetch(BASE + '/m/projects.html')).status === 401 && (await fetch(BASE + '/m/proj.js')).status === 401);
  const main = await (await get('/')).text();
  check('메인 화면: 프로젝트 메뉴에 /m/projects.html 을 띄우고, "#WBS/<id>" 처럼 메뉴 뒤에 붙은 /… 는 메뉴 이름으로 보지 않음', main.includes('/m/projects.html') && main.includes(".split('/'); // \"#WBS/"));
  const html = await (await get('/m/projects.html')).text();
  check('프로젝트 화면: db.js·cal.js·proj.js 를 쓰고, "+ 새 프로젝트"·연간 통합 간트가 있고, 카드·막대를 누르면 #WBS/<id> 로 가고, 파일이 바뀌면 다시 그림',
    ['src="/m/db.js"', 'src="/m/cal.js"', 'src="/m/proj.js"', '+ 새 프로젝트', '연간 통합 간트', "'#WBS/'", "db.watch('projects'"].every((x) => html.includes(x)));
  const box = { window: {} }; vm.createContext(box);
  for (const f of ['cal', 'proj']) vm.runInContext(await (await get(`/m/${f}.js`)).text(), box); // proj.js 는 cal.js 를 먼저 불러와야 한다
  const p = box.window.proj, near = (a, b) => Math.abs(a - b) < 1e-9;

  // 연간 간트: 한 해(1/1~12/31)를 가로 100% 로 보고 막대 자리를 %로 구한다
  const whole = p.span({ start: '2026-01-01', due: '2026-12-31' }, 2026), jul = p.span({ start: '2026-07-01', due: '2026-07-31' }, 2026);
  check('간트 자리: 한 해를 꽉 채우면 0%~100%(잘림 없음), 7월 한 달은 181일째부터 31일(365일 기준)',
    near(whole.left, 0) && near(whole.width, 100) && !whole.cutL && !whole.cutR && near(jul.left, (181 / 365) * 100) && near(jul.width, (31 / 365) * 100));
  const cross = { start: '2026-08-08', due: '2027-02-04' }, c26 = p.span(cross, 2026), c27 = p.span(cross, 2027);
  check('해를 넘기는 프로젝트: 2026 에서는 오른쪽이 12/31 에서 잘리고, 2027 에서는 1/1 부터 35일만 보임',
    c26.cutR && !c26.cutL && near(c26.left + c26.width, 100) && c27.cutL && !c27.cutR && near(c27.left, 0) && near(c27.width, (35 / 365) * 100));
  check('그 해와 안 겹치거나 기간이 틀린 항목은 null, 하루짜리는 1일 폭으로 보임',
    p.span(cross, 2025) === null && p.span(cross, 2028) === null && p.span({ start: '2026-10-05', due: '2026-10-01' }, 2026) === null && p.span({ name: 'x' }, 2026) === null
    && near(p.span({ start: '2026-10-07', due: '2026-10-07' }, 2026).width, 100 / 365));
  check('윤년: 2028 은 366일(2월 29일)이고 달 폭의 합이 한 해 날수와 같음',
    p.monthDays(2028)[1] === 29 && p.monthDays(2026)[1] === 28 && p.monthDays(2028).reduce((a, b) => a + b) === 366
    && near(p.span({ start: '2028-01-01', due: '2028-12-31' }, 2028).width, 100) && near(p.span({ start: '2028-03-01', due: '2028-03-01' }, 2028).left, (60 / 366) * 100));
  check('오늘 세로선: 그 해면 그 날의 시작 자리(2026-10-07 = 279일째), 다른 해면 없음',
    near(p.todayPos(2026, '2026-10-07'), (279 / 365) * 100) && near(p.todayPos(2026, '2026-01-01'), 0) && p.todayPos(2027, '2026-10-07') === null);

  // 새 프로젝트 창
  const ok = { name: '열교환기', client: '', owner: '', status: '계획', start: '2026-10-01', due: '2026-12-31', progress: '0' };
  check('새 프로젝트 창 검사: 정상은 통과(진도율을 비워도 통과)', p.validate(ok) === '' && p.validate({ ...ok, progress: '' }) === '');
  check('새 프로젝트 창 검사: 이름이 비면 안내', p.validate({ ...ok, name: '   ' }).includes('이름'));
  check('새 프로젝트 창 검사: 시작일·종료일이 없으면 안내', p.validate({ ...ok, start: '' }).includes('시작일') && p.validate({ ...ok, due: '' }).includes('종료일'));
  check('새 프로젝트 창 검사: 종료일이 시작일보다 빠르면 안내(같은 날은 통과)', p.validate({ ...ok, due: '2026-09-30' }).includes('종료일') && p.validate({ ...ok, due: '2026-10-01' }) === '');
  check('새 프로젝트 창 검사: 진도율은 0~100 정수만', ['-1', '101', '5.5', 'abc'].every((x) => p.validate({ ...ok, progress: x }).includes('진도율')) && p.validate({ ...ok, progress: '100' }) === '');
  check('새 프로젝트 창 검사: 상태는 계획·진행중·완료만', p.validate({ ...ok, status: '보류' }).includes('상태') && p.STATUS.join() === '계획,진행중,완료');
  const made = p.toProject({ ...ok, name: ' 열교환기 ', client: ' 라마바화학 ', progress: '40' }, 'new-1');
  check('새 프로젝트: 새 id·앞뒤 공백 제거·진도율은 숫자로', made.id === 'new-1' && made.name === '열교환기' && made.client === '라마바화학' && made.progress === 40 && made.start === '2026-10-01');

  // 카드
  check('진도율 막대: 0~100 으로 맞추고 이상한 값은 0', p.pct({ progress: 55 }) === 55 && p.pct({ progress: 150 }) === 100 && p.pct({ progress: -5 }) === 0 && p.pct({ progress: 'x' }) === 0 && p.pct({}) === 0 && p.pct({ progress: 33.4 }) === 33);
  check('기간 글자: 2026.10.01 ~ 2026.12.31, 없으면 "기간 미정"', p.periodText({ start: '2026-10-01', due: '2026-12-31' }) === '2026.10.01 ~ 2026.12.31' && p.periodText({}) === '기간 미정');
  const list = [{ id: 'b', name: '나', start: '2026-09-01', due: '2026-10-01' }, { id: 'a', name: '가', start: '2026-09-01', due: '2026-10-01' }, { id: 'z', name: '기간없음' },
    { id: 'c', name: '다', start: '2026-01-01', due: '2026-02-01' }, null, 3, { name: 'id없음' }, { id: '한글', name: 'x' }];
  check('카드 순서: 시작일 순(같으면 이름 순), 기간 없는 건 맨 뒤, id 없는 항목·깨진 항목은 빠짐', p.sorted(list).map((x) => x.id).join() === 'c,a,b,z');

  // 비서가 형식을 어겨 쓴 항목: 멈추지 않고, 무엇이 문제인지 찾아 알려 준다
  const weird = [null, 'x', { id: 'a', name: '기간이 이상', start: '2026/10/01', due: '2026-12-31' }, { id: 'b', name: '끝이 빠름', start: '2026-10-05', due: '2026-10-01' },
    { id: 'c', name: '진도 이상', start: '2026-10-01', due: '2026-10-02', progress: '50' }, { id: 'd', name: '상태 이상', start: '2026-10-01', due: '2026-10-02', status: '보류' },
    { id: 'e', start: '2026-10-01', due: '2026-10-02' }, { id: '한글', name: '이상한 id', start: '2026-10-01', due: '2026-10-02' },
    { id: 'ok', name: '정상', start: '2026-10-01', due: '2026-10-02', status: '진행중', progress: 10 }];
  let probs;
  try { probs = p.problems(weird); } catch (e) { probs = '예외: ' + e.message; }
  check('형식이 틀린 프로젝트가 섞여도 계산이 멈추지 않음', Array.isArray(probs));
  check('형식 검사: 틀린 8개를 모두 찾고, 정상 항목은 안 잡음', Array.isArray(probs) && probs.length === 8 && !probs.some((x) => x.includes('정상'))
    && ['"기간이 이상": 기간', '"끝이 빠름": 기간', '"진도 이상": 진도율', '"상태 이상": 상태', '"이상한 id": id'].every((w) => probs.some((x) => x.includes(w))));
}

// WBS 공정표: 계산(public/m/wbs-calc.js)을 숫자로 검사 + 저장 API(data/wbs/<프로젝트id>.json) + 화면 파일(public/m/wbs.html)
async function runWbs(ck) {
  const H = { 'Content-Type': 'application/json', Cookie: ck };
  const get = (u) => fetch(BASE + u, { headers: { Cookie: ck } });
  const api = (method, url, body) => fetch(BASE + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  check('로그인 전에는 /m/wbs.html 이 401 (계산 코드 wbs-calc.js 만 공유 화면이 쓰도록 예외로 열려 있음)', (await fetch(BASE + '/m/wbs.html')).status === 401);
  const main = await (await get('/')).text();
  check('메인 화면: WBS 메뉴에 /m/wbs.html 을 띄우고 "#WBS/<프로젝트id>" 의 id 를 넘김', main.includes('/m/wbs.html') && main.includes('showWbs(arg)') && main.includes("'?p=' + encodeURIComponent(pid)"));
  const html = await (await get('/m/wbs.html')).text();
  check('WBS 화면: db.js·wbs-calc.js 를 쓰고, 파일이 바뀌면(db.watch wbs-<id>) 다시 불러오고, 칸 두 번 누르기·Enter·막대 끌기가 있음',
    ['src="/m/db.js"', 'src="/m/wbs-calc.js"', "db.watch('wbs-' + pid", 'ondblclick', "e.key === 'Enter'", 'onpointerdown', 'data-bar', 'data-tg'].every((x) => html.includes(x)));
  check('WBS 화면: EVMS 카드 6장(BAC·PV·EV·SV·SPI·CPI)과 지연 작업, 위·아래·삭제·하위 추가 단추',
    ['BAC · 계약금액', 'PV · 계획 가치', 'EV · 실행 가치', 'SV · 일정 차이', 'SPI · 일정 성과', 'CPI · 비용 성과', '지연 작업', 'data-act="below"', 'data-act="child"', 'data-act="up"', 'data-act="down"', 'data-act="del"'].every((x) => html.includes(x)));

  const box = { window: {} }; vm.createContext(box);
  vm.runInContext(await (await get('/m/wbs-calc.js')).text(), box);
  const w = box.window.wbs, near = (a, b) => Math.abs(a - b) < 1e-9;
  const T = '2026-10-07';
  const leaf = (code, a, b, p, wt) => ({ code, name: code, start: a, end: b, progress: p, ...(wt === undefined ? {} : { weight: wt }) });
  const one = (p, asOf = T, s = '2026-10-01', e = '2026-10-10') => w.compute({ items: [leaf('1', s, e, p)] }, asOf).rows[0];

  // ---- 가중 평균 ----
  const c1 = w.compute({ items: [{ code: '1', name: '설계' }, leaf('1.1', '2026-10-01', '2026-10-10', 80, 3), leaf('1.2', '2026-10-01', '2026-10-10', 40, 1)] }, T);
  check('가중 평균: 1.1(가중치 3, 80%)·1.2(가중치 1, 40%) → 상위 1 은 (240+40)÷4 = 70%', near(c1.rows[0].actual, 70) && near(c1.overall.actual, 70) && !c1.rows[0].leaf && c1.problems.length === 0);
  check('가중치 합이 0 이면 단순 평균 (80%·40% → 60%)',
    near(w.compute({ items: [{ code: '1', name: 'a' }, leaf('1.1', '2026-10-01', '2026-10-10', 80, 0), leaf('1.2', '2026-10-01', '2026-10-10', 40, 0)] }, T).rows[0].actual, 60));
  const c3 = w.compute({ items: [{ code: '1', name: 'a' }, { code: '1.1', name: 'b' }, leaf('1.1.1', '2026-10-01', '2026-10-02', 100), leaf('1.1.2', '2026-10-01', '2026-10-02', 0), leaf('1.2', '2026-10-01', '2026-10-02', 100)] }, T);
  const by = Object.fromEntries(c3.rows.map((r) => [r.code, r]));
  check('3단계 롤업: 1.1 = (100+0)÷2 = 50%, 1 = (50+100)÷2 = 75%', near(by['1.1'].actual, 50) && near(by['1'].actual, 75) && near(c3.overall.actual, 75));
  check('전체에서 차지하는 비중(eff): 1.1.1 = 1/2 × 1/2 = 25%, 1.1.2 = 25%, 1.2 = 50%, 합 100%', near(by['1.1.1'].eff, 0.25) && near(by['1.1.2'].eff, 0.25) && near(by['1.2'].eff, 0.5));

  // ---- 계획 진도(PV 의 바탕) ----
  check('계획 진도: 10/1~10/10 에서 10/7 은 70%, 시작 전 0%, 시작 당일 10%, 완료일·그 뒤 100%, 하루짜리는 그날 100%',
    near(w.planPct('2026-10-01', '2026-10-10', T), 70) && w.planPct('2026-10-01', '2026-10-10', '2026-09-30') === 0 && near(w.planPct('2026-10-01', '2026-10-10', '2026-10-01'), 10)
    && w.planPct('2026-10-01', '2026-10-10', '2026-10-10') === 100 && w.planPct('2026-10-01', '2026-10-10', '2026-10-11') === 100 && w.planPct('2026-10-07', '2026-10-07', T) === 100);
  check('상위 항목의 계획 진도도 하위 계획 진도의 가중 평균 (둘 다 70% → 70%)', near(c1.rows[0].plan, 70) && near(c1.overall.plan, 70));

  // ---- 상태 ----
  const st = (...a) => one(...a).status;
  check('상태: 100% 는 완료', st(100) === '완료');
  check('상태: 계획 70% 인데 실제 55% (15%p 뒤처짐) → 지연', st(55) === '지연');
  check('상태: 격차가 딱 10%p (70% 대 60%) 면 지연이 아니고, 10.1%p (59.9%) 부터 지연', st(60) === '진행' && st(59.9) === '지연');
  check('상태: 시작 전 0% 는 대기, 시작 전인데 진도가 있으면 진행', st(0, '2026-09-20') === '대기' && st(5, '2026-09-20') === '진행');
  check('상태: 오늘이 기간 안이고 격차가 10%p 이하면 0% 라도 진행', st(0, '2026-10-01') === '진행');
  check('상태: 기간이 끝난 뒤 95%·90% 는 진행, 85%·0% 는 지연', st(95, '2026-10-20') === '진행' && st(90, '2026-10-20') === '진행' && st(85, '2026-10-20') === '지연' && st(0, '2026-10-20') === '지연');

  // ---- EVMS ----
  const ev1 = w.compute({ bac: 1e8, ac: 5e7, items: [leaf('1', '2026-10-01', '2026-10-10', 40)] }, '2026-10-05').evms;
  check('EVMS: BAC 1억, 계획 50%·실제 40% → PV 5천만 · EV 4천만 · SV −1천만 · SPI 0.8', ev1.pv === 5e7 && ev1.ev === 4e7 && ev1.sv === -1e7 && near(ev1.spi, 0.8));
  check('CPI = EV ÷ AC (4천만 ÷ 5천만 = 0.8)', near(ev1.cpi, 0.8));
  const ev2 = w.compute({ bac: 1e8, ac: 2e7, items: [leaf('1', '2026-10-01', '2026-10-10', 50)] }, '2026-10-05').evms;
  check('EVMS: 계획 50%·실제 50%·AC 2천만 → SV 0 · SPI 1 · CPI 2.5', ev2.sv === 0 && near(ev2.spi, 1) && near(ev2.cpi, 2.5));
  const ev0 = w.compute({ bac: 1e8, ac: 0, items: [leaf('1', '2026-10-01', '2026-10-10', 0)] }, '2026-09-20').evms;
  check('시작 전(PV 가 0)이면 SPI 는 "—"(null), AC 가 0 이면 CPI 도 null (0 으로 나누지 않음)', ev0.pv === 0 && ev0.spi === null && ev0.cpi === null);
  const evN = w.compute({ items: [leaf('1', '2026-10-01', '2026-10-10', 40)] }, '2026-10-05').evms;
  check('BAC 를 안 넣으면 금액(PV·EV·SV)·CPI 는 null 이고 SPI 는 진도 비율로 계산 (0.8)', evN.bac === null && evN.pv === null && evN.ev === null && evN.sv === null && evN.cpi === null && near(evN.spi, 0.8));
  const lc = w.compute({ items: [{ code: '1', name: 'a' }, leaf('1.1', '2026-10-01', '2026-10-10', 10), leaf('1.2', '2026-10-01', '2026-10-10', 10), leaf('1.3', '2026-10-01', '2026-10-10', 100)] }, T);
  check('지연 작업 수는 맨 아래 작업만 센다 (작업 2개 지연, 상위 항목도 지연이지만 안 셈)', lc.evms.late === 2 && lc.rows.filter((r) => r.status === '지연').length === 3);

  // ---- 정렬·상위 기간·접기·형식 오류 ----
  const c5 = w.compute({ items: [leaf('1.10', '2026-11-01', '2026-11-05', 0), leaf('1.9', '2026-10-03', '2026-10-04', 0), { code: '1', name: 'a' }, leaf('2', '2026-12-01', '2026-12-02', 0), leaf('1.2', '2026-10-10', '2026-10-12', 0)] }, T);
  check('코드 정렬: 1, 1.2, 1.9, 1.10, 2 (1.10 이 1.9 뒤)', c5.rows.map((r) => r.code).join() === '1,1.2,1.9,1.10,2');
  check('대단락의 시작·완료는 하위 중 가장 이른 시작·가장 늦은 완료(자동)', c5.rows[0].start === '2026-10-03' && c5.rows[0].end === '2026-11-05' && c5.range.start === '2026-10-03' && c5.range.end === '2026-12-02');
  check('접은 대단락 밑의 줄은 화면에서 빠짐', w.visible(c5.rows, new Set(['1'])).map((r) => r.code).join() === '1,2');
  let bad;
  try { bad = w.compute({ items: [null, 'x', { code: 'a', name: '코드 이상' }, { code: '1', name: '정상' }, leaf('1.1', '2026-10-01', '2026-10-10', 50), { code: '1.1', name: '겹침' }, leaf('3.1.1', '2026-10-01', '2026-10-02', 0),
    { code: '1.2', name: '날짜 이상', start: '2026/10/01', end: '2026-10-02', progress: 0 }, { code: '1.3', name: '진도 이상', start: '2026-10-01', end: '2026-10-02', progress: 120 }] }, T); } catch (e) { bad = e.message; }
  check('형식이 틀린 항목(모양·코드·겹침·윗 항목 없음·날짜·진도)이 섞여도 멈추지 않고, 이유 7개를 모아 알려 줌', typeof bad === 'object' && bad.problems.length === 7 && bad.rows.map((r) => r.code).join() === '1,1.1,1.2,1.3');

  // ---- 행 추가·삭제·이동 (코드는 항상 1 부터 빈틈없이 다시 매김) ----
  const base = [{ code: '1', name: '설계' }, leaf('1.1', '2026-10-01', '2026-10-05', 100), leaf('1.2', '2026-10-06', '2026-10-10', 0), { code: '2', name: '제작' }, leaf('2.1', '2026-10-11', '2026-10-15', 0)];
  const nm = (r) => r.items.map((i) => `${i.code}:${i.name}`).join(' ');
  const ab = w.addBelow(base, '1.1', T);
  check('아래에 추가: 1.1 바로 아래에 새 행(1.2), 뒤의 것은 번호가 밀림(옛 1.2 → 1.3)', nm(ab) === '1:설계 1.1:1.1 1.2:새 작업 1.3:1.2 2:제작 2.1:2.1' && ab.focus === '1.2' && ab.map['1.2'] === '1.3');
  const ach = w.addChild(base, '1.1', T), kid = ach.items.find((i) => i.code === '1.1.1');
  check('하위로 추가: 작업(1.1)에 하위를 달면 그 작업의 기간·진도(10/1~10/5, 100%)는 새 하위(1.1.1)가 이어받음', kid.start === '2026-10-01' && kid.end === '2026-10-05' && kid.progress === 100 && ach.focus === '1.1.1' && w.validate({ items: ach.items }) === '');
  check('하위로 추가: 대단락(1)에는 맨 끝(1.3)에 새 행', nm(w.addChild(base, '1', T)).includes('1.3:새 작업') && w.addChild(base, '1', T).focus === '1.3');
  check('대단락 추가: 맨 끝(3)', w.addRoot(base, T).focus === '3');
  const rm = w.remove(base, '1');
  check('삭제: 1 을 지우면 하위(1.1·1.2)도 함께 지워지고 2·2.1 이 1·1.1 로 올라옴', nm(rm) === '1:제작 1.1:2.1' && rm.map['2'] === '1' && rm.map['2.1'] === '1.1' && w.countSubtree(base, '1') === 3);
  const up = w.move(base, '1.2', -1);
  check('위로 이동: 1.2 를 위로 올리면 1.1 과 자리가 바뀜(코드는 다시 매김)', nm(up) === '1:설계 1.1:1.2 1.2:1.1 2:제작 2.1:2.1' && up.map['1.2'] === '1.1' && up.focus === '1.1');
  check('맨 위(1.1)를 위로·맨 아래(2)를 아래로 옮기면 아무 일도 안 함', w.move(base, '1.1', -1).noop === true && w.move(base, '2', 1).noop === true);
  check('아래로 이동: 대단락 1 을 아래로 내리면 하위까지 통째로 2 가 됨', nm(w.move(base, '1', 1)) === '1:제작 1.1:2.1 2:설계 2.1:1.1 2.2:1.2');
  check('원래 목록은 안 바뀜(새 목록을 돌려줌)', base.length === 5 && base[2].code === '1.2' && base[2].name === '1.2');
  check('형식 오류가 있는 목록은 행 추가·이동을 거절(몰래 고치지 않음)', (w.addBelow([{ code: '1.1', name: 'x' }], '1.1', T).error || '').startsWith('먼저 형식 오류를 고쳐 주세요'));

  // ---- 칸 고치기·막대 끌기·금액 입력 ----
  const e = (code, f, v) => w.setField(base, code, f, v);
  check('칸 고치기: 가중치 음수·글자, 진도율 101, 이름 빈칸, 없는 날짜, 완료일이 시작일보다 빠름은 거절',
    ['weight|-1', 'weight|abc', 'progress|101', 'name|', 'start|2026-02-31', 'end|2026-09-30'].every((s) => { const [f, v] = s.split('|'); return e('1.1', f, v).error; }));
  check('칸 고치기: 대단락의 진도율·시작·완료는 못 고침(자동 계산)', e('1', 'progress', '50').error.includes('자동') && e('1', 'start', '2026-10-01').error.includes('자동'));
  const ok = e('1.2', 'progress', ' 55 ');
  check('칸 고치기: 진도율 55 저장, 다른 항목은 그대로, 원래 목록은 안 바뀜', ok.items[2].progress === 55 && ok.items[0] === base[0] && base[2].progress === 0);
  check('칸 고치기: 가중치·담당·작업명·날짜', e('1.2', 'weight', '2.5').items[2].weight === 2.5 && e('1.2', 'owner', ' 김가나 ').items[2].owner === '김가나'
    && e('1.2', 'name', ' 용접 ').items[2].name === '용접' && e('1.2', 'end', '2026-10-20').items[2].end === '2026-10-20');
  const mv = w.shiftTask(base, '1.2', 3, 3), rs = w.shiftTask(base, '1.2', 0, -2);
  check('막대 끌기: 이동은 시작·완료를 같이 +3일, 오른쪽 끝 끌기는 완료일만 −2일', mv.items[2].start === '2026-10-09' && mv.items[2].end === '2026-10-13' && rs.items[2].start === '2026-10-06' && rs.items[2].end === '2026-10-08');
  check('막대 끌기: 완료일이 시작일보다 앞으로 가면 거절, 대단락은 못 끎', w.shiftTask(base, '1.2', 0, -6).error && w.shiftTask(base, '1', 1, 1).error);
  const money = ['1200000000', '1,200,000,000원', '12억', '1.5억', '3000만', '12억 3000만', '12억3000만'].map((s) => w.parseMoney(s).value);
  check('금액 입력: 1200000000 · 1,200,000,000원 · 12억 · 1.5억 · 3000만 · 12억 3000만', money.join() === [1.2e9, 1.2e9, 1.2e9, 1.5e8, 3e7, 1.23e9, 1.23e9].join() && w.parseMoney('').value === null
    && ['abc', '-5', '1.5'].every((s) => w.parseMoney(s).error));

  // ---- 검증·정리·간트 가로축 ----
  check('검증: 정상은 통과', w.validate({ bac: null, ac: 0, items: base }) === '' && w.validate({ items: [] }) === '');
  const cases = [[{ items: [{ code: 'a', name: 'x' }] }, '코드'], [{ items: [{ code: '1', name: 'x', start: T, end: T }, { code: '1', name: 'y', start: T, end: T }] }, '겹쳐'],
    [{ items: [{ code: '1.1', name: 'x', start: T, end: T }] }, '위 항목'], [{ items: [{ code: '1', name: 'x' }] }, '시작일'], [{ items: [leaf('1', '2026-10-10', '2026-10-01', 0)] }, '완료일이 시작일보다'],
    [{ items: [leaf('1', T, T, 101)] }, '진도율'], [{ items: [leaf('1', T, T, 0, -1)] }, '가중치'], [{ items: [{ ...leaf('1', T, T, 0), name: '  ' }] }, '작업명'],
    [{ bac: -1, items: [] }, 'BAC'], [{ items: 'x' }, 'items'], [{ items: [], actualLog: { '2026-02-31': 5 } }, 'actualLog'],
    [{ items: Array.from({ length: 1001 }, (_, i) => leaf(String(i + 1), T, T, 0)) }, '1000개']];
  check('검증: 코드 모양·겹침·윗 항목 없음·날짜 없음·완료<시작·진도 101·가중치 음수·작업명 빈칸·BAC 음수·items 아님·actualLog 이상·1001개를 모두 거절', cases.every(([d, word]) => w.validate(d).includes(word)));
  const nz = w.normalize({ items: [leaf('2.1', '2026-10-11', '2026-10-15', 50), { code: '1', name: ' 설계 ', start: '2026-10-01', end: '2026-10-02', progress: 99 }, leaf('1.1', '2026-10-01', '2026-10-05', 100), { code: '2', name: '제작' }] }, T);
  check('정리(저장 모양): 코드 순서·자식 있으면 대단락(상위의 시작·완료·진도율은 지움)·없으면 작업·이름 공백 제거·오늘 실제 진도(75%) 기록',
    nz.items.map((i) => i.code).join() === '1,1.1,2,2.1' && nz.items[0].type === '대단락' && !('start' in nz.items[0]) && !('progress' in nz.items[0]) && nz.items[0].name === '설계'
    && nz.items[1].type === '작업' && nz.items[1].weight === 1 && nz.bac === null && nz.actualLog[T] === 75);
  const sp = w.span({ start: '2026-08-08', end: '2026-11-21' }, T), mo = w.months(sp.from, sp.to);
  check('간트 가로축: 8/8~11/21 → 8/1 ~ 12/31, 달 칸 2026.08·9월·10월·11월·12월 (31·30·31·30·31일)', sp.from === '2026-08-01' && sp.to === '2026-12-31' && mo.map((m) => m.label).join() === '2026.08,9월,10월,11월,12월' && mo.map((m) => m.days).join() === '31,30,31,30,31');
  const sp2 = w.span({ start: '2026-12-20', end: '2027-01-10' }, T);
  check('간트 가로축: 해를 넘기면 2026.12 · 2027.01 로 연도 표시, 오늘이 범위 밖이어도 덮음', w.months('2026-12-01', '2027-01-31').map((m) => m.label).join() === '2026.12,2027.01' && sp2.from === '2026-10-01' && sp2.to === '2027-01-31');
  check('막대 자리(px): 10/1~10/10 은 8/1 에서 61일 뒤, 하루 6px → 왼쪽 366px · 폭 60px', w.px('2026-10-01', '2026-10-10', '2026-08-01', 6).left === 366 && w.px('2026-10-01', '2026-10-10', '2026-08-01', 6).width === 60);

  // ---- S-곡선(계획 누적·실제 누적) ----
  const rowsOf = (items) => w.compute({ items }, T).rows;
  const at = (a, d) => a.find((p) => p.d === d).v;
  const sc1 = w.scurve(rowsOf([leaf('1', '2026-10-01', '2026-10-10', 0)]), '2026-09-29', '2026-10-12');
  check('S-곡선(계획): 작업 하나(10/1~10/10)의 누적은 시작 전 0%, 10/5 에 50%, 10/10 부터 100%, 점은 날마다(14개)',
    near(at(sc1, '2026-09-30'), 0) && near(at(sc1, '2026-10-05'), 50) && near(at(sc1, '2026-10-10'), 100) && near(at(sc1, '2026-10-12'), 100) && sc1.length === 14 && sc1[0].d === '2026-09-29');
  const sc2 = w.scurve(rowsOf([leaf('1', '2026-10-01', '2026-10-10', 0, 1), leaf('2', '2026-10-06', '2026-10-15', 0, 3)]), '2026-10-01', '2026-10-15');
  check('S-곡선(계획): 가중치 1 대 3 인 두 작업의 10/10 누적 = 0.25×100% + 0.75×50% = 62.5%, 마지막 날 100%', near(at(sc2, '2026-10-10'), 62.5) && near(at(sc2, '2026-10-15'), 100));
  const scL = w.scurve(rowsOf([leaf('1', '2025-03-01', '2027-06-30', 0)]), '2025-01-01', '2027-12-31');
  check('S-곡선: 3년짜리도 점이 160~170개로 줄고, 마지막 날(12/31)을 꼭 포함하고, 줄어들지 않음', scL.length <= 170 && scL.at(-1).d === '2027-12-31' && scL.every((p, i) => i === 0 || p.v >= scL[i - 1].v - 1e-9));
  const ap = w.actualPoints({ '2026-10-01': 10, '2026-10-03': 20, '2026-10-05': 25, '2026-10-09': 99, 'x': 5 }, '2026-10-05', 33.3);
  check('S-곡선(실제): 기록 중 오늘까지만(미래·날짜 아닌 키 제외), 오늘 값은 지금 계산한 값(33.3)으로, 날짜순',
    ap.map((p) => p.d + ':' + p.v).join() === '2026-10-01:10,2026-10-03:20,2026-10-05:33.3' && w.actualPoints(undefined, T, 40).length === 1);

  const sl = w.sampleLog({ items: [leaf('1', '2026-09-01', '2026-09-30', 100), leaf('2', '2026-09-15', '2026-12-31', 40)] }, T);
  const slv = Object.values(sl);
  check('예시용 과거 기록(sampleLog): 첫 작업 시작일부터 7일마다 한 점, 줄어들지 않고, 마지막 점은 지금 값(70%)에 가까움',
    Object.keys(sl)[0] === '2026-09-01' && Object.keys(sl)[1] === '2026-09-08' && slv.every((v, i) => i === 0 || v >= slv[i - 1]) && Math.abs(slv.at(-1) - 70) < 15 && !('2026-10-07' in sl) && w.sampleLog({ items: [] }, T) && Object.keys(w.sampleLog({ items: [] }, T)).length === 0);

  // ---- 엑셀(CSV) ----
  const cs =w.csv(w.compute({ items: [{ code: '1', name: '설계, 기본' }, { ...leaf('1.10', '2026-10-01', '2026-10-10', 55.54), name: '=SUM(A1)', owner: '-홍', memo: '줄1\n줄2' }, { ...leaf('2', '2026-10-01', '2026-10-10', 0), name: '5" 배관' }] }, T).rows);
  check('엑셀(CSV): UTF-8 BOM 으로 시작하고, 줄바꿈은 CRLF, 첫 줄은 머리글', cs.startsWith('﻿코드,단계,작업명,담당,시작일,완료일,가중치,진도율(%),계획 진도(%),상태,메모\r\n') && cs.endsWith('\r\n') && !cs.replace('"줄1\n줄2"', '').replace(/\r\n/g, '').includes('\n'));
  check('엑셀(CSV): 쉼표·따옴표·줄바꿈이 든 칸은 따옴표로 감쌈', cs.includes('"설계, 기본"') && cs.includes('"5"" 배관"') && cs.includes('"줄1\n줄2"'));
  check('엑셀(CSV): = - 로 시작하는 글자 칸은 수식으로 읽히지 않게 앞에 \' 를 붙이고, 코드 1.10 은 ="1.10" 으로 써서 1.1 로 안 바뀜',
    cs.includes("'=SUM(A1)") && cs.includes("'-홍") && cs.includes('="1.10"') && cs.includes(',55.5,'));

  // ---- 저장 API: data/wbs/<프로젝트id>.json ----
  const wbsDir = path.join(dir, 'wbs'), today = new Date().toLocaleDateString('sv-SE');
  const ac = new AbortController();
  const stream = await fetch(BASE + '/api/events', { headers: { Cookie: ck }, signal: ac.signal });
  let heard = ''; const dec = new TextDecoder(); const rd = stream.body.getReader();
  (async () => { for (;;) { const r = await rd.read().catch(() => ({ done: true })); if (r.done) return; heard += dec.decode(r.value); } })();
  const changed = async (name) => { const re = new RegExp(`^event: db\\ndata: \\{"name":"${name}"\\}$`, 'm'); for (let i = 0; i < 100 && !re.test(heard); i++) await sleep(30); const okk = re.test(heard); heard = ''; return okk; };
  const g0 = await (await api('GET', '/api/wbs/p1')).json();
  check('처음에는 빈 공정표(etag "none"), 파일은 아직 없음', g0.etag === 'none' && g0.doc.items.length === 0 && !fs.existsSync(path.join(wbsDir, 'p1.json')));
  const docA = { bac: 1e9, ac: null, items: [{ code: '1', name: '설계' }, leaf('1.1', '2026-10-01', '2026-10-05', 100), leaf('1.2', '2026-10-06', '2026-10-10', 0), { code: '2', name: '제작' }, leaf('2.1', '2026-10-11', '2026-10-15', 0)] };
  const r1 = await api('PUT', '/api/wbs/p1', { etag: 'none', doc: docA }), j1 = await r1.json();
  check('저장(PUT): 200, 단계가 자동으로 붙고, 오늘의 실제 진도가 actualLog 에 기록되고, data/wbs/p1.json 이 생김',
    r1.status === 200 && j1.doc.items[0].type === '대단락' && j1.doc.items[1].type === '작업' && typeof j1.doc.actualLog[today] === 'number' && fs.existsSync(path.join(wbsDir, 'p1.json')));
  check('저장하면 알림: wbs-p1 이 바뀜', await changed('wbs-p1'));
  const g1 = await (await api('GET', '/api/wbs/p1')).json();
  check('GET 은 저장한 내용과 같은 etag 를 돌려줌', g1.etag === j1.etag && g1.doc.bac === 1e9 && g1.doc.items.length === 5);
  const stale = await api('PUT', '/api/wbs/p1', { etag: 'none', doc: docA });
  check('옛 etag 로 저장하면 409 이고 파일은 그대로', stale.status === 409 && (await (await api('GET', '/api/wbs/p1')).json()).etag === j1.etag);
  const badPut = await api('PUT', '/api/wbs/p1', { etag: j1.etag, doc: { items: [{ code: 'x', name: 'a' }] } });
  check('형식이 틀린 내용은 400 + 이유, 파일은 그대로', badPut.status === 400 && (await badPut.json()).error.includes('코드') && (await (await api('GET', '/api/wbs/p1')).json()).etag === j1.etag);
  check('etag 가 없거나 내용이 객체가 아니면 400', (await api('PUT', '/api/wbs/p1', { doc: docA })).status === 400 && (await api('PUT', '/api/wbs/p1', [1])).status === 400
    && (await fetch(BASE + '/api/wbs/p1', { method: 'PUT', headers: H, body: '{깨짐' })).status === 400);
  const cur = await (await api('GET', '/api/wbs/p1')).json();
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) => api('PUT', '/api/wbs/p1', { etag: cur.etag, doc: { ...cur.doc, bac: 1000 + i } })));
  const sts = race.map((r) => r.status);
  check('같은 etag 로 동시에 10번 저장해도 하나만 성공하고 나머지는 409 (조용히 덮어쓰지 않음)', sts.filter((s) => s === 200).length === 1 && sts.filter((s) => s === 409).length === 9);
  check('저장 뒤 임시 파일(.tmp)이 안 남음', !fs.readdirSync(wbsDir).some((f) => f.endsWith('.tmp')));

  // 비서(AI)가 파일을 직접 고친 경우: 화면이 알림을 받고, 옛 화면이 저장하려 하면 막혀서 비서의 수정을 덮어쓰지 않는다
  const cur2 = await (await api('GET', '/api/wbs/p1')).json();
  await sleep(200); heard = '';
  const direct = { ...cur2.doc, items: cur2.doc.items.map((i) => (i.code === '1.2' ? { ...i, progress: 77 } : i)) };
  fs.writeFileSync(path.join(wbsDir, 'p1.json'), JSON.stringify(direct, null, 2));
  check('비서가 파일을 직접 고쳐도 알림: wbs-p1 이 바뀜', await changed('wbs-p1'));
  const stale2 = await api('PUT', '/api/wbs/p1', { etag: cur2.etag, doc: cur2.doc });
  check('옛 화면이 저장하려 하면 409 — 비서가 고친 진도율(77)이 그대로 남음', stale2.status === 409 && (await (await api('GET', '/api/wbs/p1')).json()).doc.items.find((i) => i.code === '1.2').progress === 77);
  ac.abort();

  fs.writeFileSync(path.join(wbsDir, 'broken.json'), '{ 깨진 파일');
  check('깨진 파일은 GET 500 으로 알리고, 저장해도 덮어쓰지 않음', (await api('GET', '/api/wbs/broken')).status === 500
    && (await api('PUT', '/api/wbs/broken', { etag: 'none', doc: docA })).status === 409 && fs.readFileSync(path.join(wbsDir, 'broken.json'), 'utf8') === '{ 깨진 파일');
  fs.writeFileSync(path.join(wbsDir, 'bom.json'), '﻿' + JSON.stringify(docA));
  check('메모장이 붙이는 BOM 이 있어도 읽힘', (await (await api('GET', '/api/wbs/bom')).json()).doc.items.length === 5);
  for (const u of ['/api/wbs/nul', '/api/wbs/NUL', '/api/wbs/a.b', '/api/wbs/..%2Fusers', '/api/wbs/a%2Fb'])
    check(`이상한 프로젝트 id 는 거절: PUT ${u}`, (await api('PUT', u, { etag: 'none', doc: docA })).status === 404);
  check('다른 사이트에서 온 저장 요청은 403', (await fetch(BASE + '/api/wbs/p1', { method: 'PUT', headers: { ...H, Origin: 'https://evil.example' }, body: JSON.stringify({ etag: 'x', doc: docA }) })).status === 403);

  // ---- 화면 파일: 새 단추·S-곡선·인쇄 ----
  check('WBS 화면: 💾 Rev 저장 · 📜 이력 · 📊 엑셀 · 📄 PDF · 🔗 공유 링크 단추와 S-곡선(SVG)·인쇄 화면(@page)', ['💾 Rev 저장', '📜 이력', '📊 엑셀', '📄 PDF', '🔗 공유 링크', 'id="sc"', '<svg', '<polyline', '@page', 'beforeprint', 'data-b="restore"'].every((x) => html.includes(x)));
  check('WBS 화면: 공유 화면(/s/)에서는 /m/db.js 를 부르지 않음(로그인이 없어 못 받음)', html.includes("location.pathname.startsWith('/s/')") && html.includes('document.write'));

  // ---- Rev (저장 이력): data/wbs/_history/<프로젝트id>/<번호>_<날짜>_<시각>.json ----
  const put = async (pid, doc) => { const g = await (await api('GET', `/api/wbs/${pid}`)).json(); return (await api('PUT', `/api/wbs/${pid}`, { etag: g.etag, doc })).json(); };
  const withMemo = { ...docA, items: docA.items.map((i) => (i.code === '1.1' ? { ...i, memo: '비밀 메모 xyz' } : i)) };
  await put('r1', withMemo);
  const histDir = path.join(wbsDir, '_history', 'r1');
  check('Rev 가 없으면 빈 목록', (await (await api('GET', '/api/wbs/r1/revs')).json()).revs.length === 0);
  const v1 = await (await api('POST', '/api/wbs/r1/revs', { note: ' 첫 저장 ' })).json();
  const v2 = await (await api('POST', '/api/wbs/r1/revs', {})).json();
  const files = fs.readdirSync(histDir).sort();
  check('Rev 저장: 번호 1·2, 파일은 data/wbs/_history/r1/0001_<날짜>_<시각>.json 모양', v1.rev === 1 && v2.rev === 2 && files.length === 2 && /^0001_\d{4}-\d\d-\d\d_\d{6}\.json$/.test(files[0]) && /^0002_/.test(files[1]));
  const f1 = JSON.parse(fs.readFileSync(path.join(histDir, files[0]), 'utf8'));
  check('Rev 파일: 저장 시각·설명(앞뒤 공백 제거)·자동 여부·그때의 공정표 전체(snapshot)가 들어 있음', f1.rev === 1 && f1.note === '첫 저장' && f1.auto === false && !isNaN(Date.parse(f1.savedAt)) && f1.snapshot.items.length === 5 && f1.snapshot.bac === 1e9);
  const lst = (await (await api('GET', '/api/wbs/r1/revs')).json()).revs;
  check('Rev 목록: 번호 순, 설명·자동 여부 포함(공정표 내용은 안 실림)', lst.map((v) => v.rev).join() === '1,2' && lst[0].note === '첫 저장' && lst[1].auto === false && !('doc' in lst[0]));
  const gv = await (await api('GET', '/api/wbs/r1/revs/1')).json();
  check('Rev 보기: 그때의 공정표(doc)와 저장 시각을 돌려줌', gv.rev === 1 && gv.doc.items.find((i) => i.code === '1.2').progress === 0 && !isNaN(Date.parse(gv.savedAt)));
  await put('r1', { ...withMemo, items: withMemo.items.map((i) => (i.code === '1.2' ? { ...i, progress: 55 } : i)) });
  const rr = await api('POST', '/api/wbs/r1/revs/1/restore'), rj = await rr.json();
  const back = JSON.parse(fs.readFileSync(path.join(histDir, fs.readdirSync(histDir).sort()[2]), 'utf8'));
  check('이 Rev 로 되돌리기: 진도율이 0 으로 돌아오고, 되돌리기 전 상태(55)가 자동 Rev(3)로 먼저 저장됨', rr.status === 200 && rj.doc.items.find((i) => i.code === '1.2').progress === 0 && rj.backupRev === 3
    && back.auto === true && back.note.includes('자동 저장') && back.snapshot.items.find((i) => i.code === '1.2').progress === 55);
  check('되돌린 뒤 파일·etag 가 일치하고 이전 Rev 들은 그대로(1·2·3)', (await (await api('GET', '/api/wbs/r1')).json()).etag === rj.etag && fs.readdirSync(histDir).length === 3);
  check('없는 Rev 는 404, 설명이 100자를 넘으면 400, 공정표 파일이 없으면 Rev 저장 400',
    (await api('GET', '/api/wbs/r1/revs/99')).status === 404 && (await api('POST', '/api/wbs/r1/revs/99/restore')).status === 404
    && (await api('POST', '/api/wbs/r1/revs', { note: 'x'.repeat(101) })).status === 400 && (await api('POST', '/api/wbs/nofile/revs', {})).status === 400);
  const before = fs.readFileSync(path.join(wbsDir, 'r1.json'), 'utf8');
  fs.writeFileSync(path.join(histDir, '0010_2026-01-01_000000.json'), JSON.stringify({ rev: 10, savedAt: '2026-01-01T00:00:00Z', note: '깨진 내용', auto: false, snapshot: { items: [{ code: 'x', name: 'a' }] } }));
  fs.writeFileSync(path.join(histDir, 'memo.json'), '{}'); fs.writeFileSync(path.join(histDir, '0011_2026-01-01_000000.json'), '{ 깨짐');
  const bad10 = await api('POST', '/api/wbs/r1/revs/10/restore');
  check('형식이 틀린 Rev 는 되돌리기 400 이고 지금 파일은 그대로, 이름이 다른 파일·깨진 Rev 는 목록에서 건너뜀',
    bad10.status === 400 && fs.readFileSync(path.join(wbsDir, 'r1.json'), 'utf8') === before && (await (await api('GET', '/api/wbs/r1/revs')).json()).revs.map((v) => v.rev).join() === '1,2,3,10');
  await put('cap', docA);
  fs.mkdirSync(path.join(wbsDir, '_history', 'cap'), { recursive: true });
  for (let i = 1; i <= 200; i++) fs.writeFileSync(path.join(wbsDir, '_history', 'cap', `${String(i).padStart(4, '0')}_2026-01-01_000000.json`), '{}');
  const capRes = await api('POST', '/api/wbs/cap/revs', {});
  check('Rev 가 200개면 더 쌓지 않고 이유를 알림(묻지 않고 지우지 않음)', capRes.status === 409 && (await capRes.json()).error.includes('200') && fs.readdirSync(path.join(wbsDir, '_history', 'cap')).length === 200);
  check('Rev 폴더를 만들어도 공정표 파일 알림·목록에 영향 없음(_history 는 폴더)', fs.statSync(path.join(wbsDir, '_history')).isDirectory() && !fs.existsSync(path.join(wbsDir, '_history.json')));

  // ---- 읽기 전용 공유 링크 ----
  const anon = (u, o) => fetch(BASE + u, o); // 쿠키 없이
  const mk = async (pid) => (await (await api('POST', `/api/wbs/${pid}/share`)).json());
  const s1 = await mk('r1'), tok = (s1.path || '').slice(3);
  const shareFile = path.join(dir, 'share.json');
  check('공유 링크 만들기: /s/<긴 토큰> 주소와 만료일(30일 뒤)', /^\/s\/[A-Za-z0-9_-]{32}$/.test(s1.path) && Math.abs(Date.parse(s1.expiresAt) - Date.now() - 30 * 864e5) < 60000);
  check('토큰은 파일에 없고(해시만 저장), 서버 로그에도 없음', fs.existsSync(shareFile) && !fs.readFileSync(shareFile, 'utf8').includes(tok) && !srv.log.includes(tok));
  const st1 = await (await api('GET', '/api/wbs/r1/share')).json();
  check('공유 상태: 켜져 있음 + 만료일(주소는 다시 안 알려 줌)', st1.active === true && !!st1.expiresAt && !JSON.stringify(st1).includes(tok));
  const pubRes = await anon(`/api/share/${tok}`), pubTxt = await pubRes.text(), pub = JSON.parse(pubTxt);
  check('로그인 없이 /api/share/<토큰> 이 열리고 공정표를 돌려줌', pubRes.status === 200 && pub.doc.items.length === 5 && pub.name === 'r1' && pub.doc.items.some((i) => i.code === '1.1'));
  check('금액(BAC·AC)과 메모는 서버가 아예 안 보냄(응답 글 전체에 없음)', pub.doc.bac === null && pub.doc.ac === null && !pubTxt.includes('비밀 메모') && !pubTxt.includes('1000000000') && !pub.doc.items.some((i) => 'memo' in i));
  const pg = await anon(`/s/${tok}`), pgTxt = await pg.text();
  check('로그인 없이 /s/<토큰> 화면이 열림(캐시·referrer 차단 헤더 포함)', pg.status === 200 && (pg.headers.get('content-type') || '').startsWith('text/html') && pgTxt.includes('WBS 공정표') && pgTxt.includes('/m/wbs-calc.js')
    && pg.headers.get('cache-control') === 'no-store' && pg.headers.get('referrer-policy') === 'no-referrer');
  const wc = await anon('/m/wbs-calc.js');
  check('로그인 없이 받을 수 있는 건 계산 코드(/m/wbs-calc.js)뿐 — 화면(/m/wbs.html)·/m/db.js·/m/cal.js 는 여전히 401', wc.status === 200 && (wc.headers.get('content-type') || '').startsWith('text/javascript')
    && (await anon('/m/wbs.html')).status === 401 && (await anon('/m/db.js')).status === 401 && (await anon('/m/cal.js')).status === 401 && (await anon('/m/projects.html')).status === 401);
  check('토큰으로는 읽기만: 로그인 필요한 API(저장·Rev·공유·목록)는 쿠키 없이 모두 401', (await Promise.all([['GET', '/api/wbs/r1'], ['PUT', '/api/wbs/r1'], ['GET', '/api/wbs/r1/revs'], ['POST', '/api/wbs/r1/share'], ['GET', '/api/db/projects'], ['PUT', `/api/share/${tok}`]]
    .map(([m, u]) => anon(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'PUT' ? '{}' : undefined })))).every((r) => r.status === 401)
    && (await anon(`/s/${tok}`, { method: 'POST' })).status === 405);
  const bogus = 'x'.repeat(32);
  check('틀린 토큰·짧은 토큰은 열리지 않음(404)', (await anon(`/api/share/${bogus}`)).status === 404 && (await anon(`/s/${bogus}`)).status === 404 && (await anon('/s/abc')).status === 404 && (await anon(`/s/${tok}/x`)).status === 404);
  const r2doc = await (await anon(`/api/share/${(await mk('cap')).path.slice(3)}`)).json();
  check('토큰은 그 프로젝트의 공정표만 보여 줌(다른 프로젝트 것은 안 열림)', r2doc.name === 'cap' && (await (await anon(`/api/share/${tok}`)).json()).name === 'r1');
  const s2 = await mk('r1');
  check('새 링크를 만들면 이전 링크는 끊기고 새 링크는 열림', s2.path !== s1.path && (await anon(`/api/share/${tok}`)).status === 404 && (await anon(`/api/share${s2.path.slice(2)}`)).status === 200);
  const tok2 = s2.path.slice(3);
  const del = await (await api('DELETE', '/api/wbs/r1/share')).json();
  check('링크 끊기: 끊은 뒤에는 화면·자료 모두 404, 상태는 꺼짐', del.removed === 1 && (await anon(`/api/share/${tok2}`)).status === 404 && (await anon(`/s/${tok2}`)).status === 404 && (await (await api('GET', '/api/wbs/r1/share')).json()).active === false);
  const s3 = await mk('r1'), tok3 = s3.path.slice(3);
  const sj = JSON.parse(fs.readFileSync(shareFile, 'utf8'));
  for (const h of Object.keys(sj)) if (sj[h].pid === 'r1') sj[h].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(shareFile, JSON.stringify(sj));
  check('만료된 링크는 열리지 않음(404)', (await anon(`/api/share/${tok3}`)).status === 404 && (await anon(`/s/${tok3}`)).status === 404 && (await (await api('GET', '/api/wbs/r1/share')).json()).active === false);
}

// 비서의 스킬(templates/skills → data/.claude/skills)과 행동 지침(.system.md)에 WBS 규칙이 들어갔는지
function runSkills() {
  const wbsCalc = require('./public/m/wbs-calc.js');
  const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
  const names = fs.readdirSync(path.join(__dirname, 'templates', 'skills'));
  check('templates/skills 의 스킬 폴더(platform·wbs)가 모두 data/.claude/skills/<이름>/SKILL.md 로 똑같이 복사됨(옛 내용은 새 내용으로 바뀜)',
    names.includes('platform') && names.includes('wbs') && names.every((n) => read(dir, '.claude', 'skills', n, 'SKILL.md') === read(__dirname, 'templates', 'skills', n, 'SKILL.md')));
  const sk = read(dir, '.claude', 'skills', 'wbs', 'SKILL.md'), plat = read(dir, '.claude', 'skills', 'platform', 'SKILL.md');
  check('wbs 스킬: 이름 wbs, 설명에 "WBS 짜 줘"(만들기)·진도율(고치기)이 있어 요청이 오면 이 문서를 고르게 함', /^---\r?\nname: wbs\r?\ndescription: .*WBS 짜 줘.*진도율/.test(sk));
  check('wbs 스킬: 코드 붙이는 법(1, 1.1, 빈틈없이)·가중치(형제끼리 합 100)·기간(프로젝트 기간 안)·새로 만들 때 진도율 0 규칙이 있음',
    ['`1`, `1.1`, `1.1.1`', '1 부터 빈틈없이', '같은 부모 아래 형제끼리 합이 100', '프로젝트 기간 안', '새로 만들 때는 **0**'].every((x) => sk.includes(x)));
  check('wbs 스킬: "WBS 짜 줘" 절차(프로젝트 목록 맨 끝에 추가·이미 있는 공정표는 덮어쓰지 않고 먼저 물음·다시 읽어 확인)가 있음',
    ['프로젝트 목록 **맨 끝에**', '이미 있으면 덮어쓰지 않는다', '파일을 다시 읽어 확인한다', 'data/db/projects.json'].every((x) => sk.includes(x)));
  check('wbs 스킬: "진도율 60%로" 절차(같은 이름 프로젝트는 공정표가 있는 쪽·"용접의 첫 작업"=N.1·대단락은 직접 못 바꿈·숫자 하나만)가 있음',
    ['그중 `data/wbs/<id>.json` 이 있는 것을 쓴다', '`○○의 첫 작업` = 대단락 `○○` 의 첫 하위(`N.1`)', '대단락은 진도율을 직접 못 바꾼다', '숫자 하나만'].every((x) => sk.includes(x)));
  check('platform 스킬에는 WBS 형식 대신 wbs 스킬로 가라는 안내만 있음(같은 내용이 두 군데 있어 어긋나지 않게)', plat.includes('wbs 스킬') && !plat.includes('`actualLog`') && !plat.includes('_history'));

  // 스킬 안의 "작성 예"가 스킬 자신의 규칙을 지키는지 (예가 틀리면 비서가 틀린 걸 배운다)
  const ex = JSON.parse(/```json\r?\n([\s\S]*?)```/.exec(sk)[1]);
  const [, from, to] = /예시 프로젝트 기간: (\d{4}-\d\d-\d\d) ~ (\d{4}-\d\d-\d\d)/.exec(sk);
  const calc = wbsCalc.compute(ex, '2026-05-01'), leaves = calc.rows.filter((r) => r.leaf);
  check('작성 예: 파일 검증을 통과하고(코드·날짜·진도), 형식 경고가 없고, 상태 계산이 됨', wbsCalc.validate(ex) === '' && calc.problems.length === 0 && ex.bac === null && ex.ac === null && Object.keys(ex.actualLog).length === 0);
  const sums = {};
  for (const it of ex.items) { const p = wbsCalc.parentOf(it.code); sums[p] = (sums[p] || 0) + it.weight; }
  check('작성 예: 같은 부모 아래 가중치 합이 모두 100 (대단락끼리·각 대단락 안 작업끼리)', Object.values(sums).length === 4 && Object.values(sums).every((v) => v === 100));
  check('작성 예: 새로 만든 작업의 진도율은 모두 0, 대단락에는 시작·완료·진도율이 없음', leaves.length === 8 && ex.items.filter((i) => i.type === '작업').every((i) => i.progress === 0)
    && ex.items.filter((i) => i.type === '대단락').every((i) => !('start' in i) && !('end' in i) && !('progress' in i)));
  check('작성 예: 모든 작업이 프로젝트 기간(2026-04-01 ~ 2026-06-29) 안이고, 첫 작업은 시작일에서 시작해 끊김·겹침 없이 이어져 종료일에 끝남',
    leaves.every((r) => r.start >= from && r.end <= to && r.start <= r.end) && leaves[0].start === from && leaves.at(-1).end === to
    && leaves.every((r, i) => i === 0 || r.start === wbsCalc.addDays(leaves[i - 1].end, 1)));
  const rec = JSON.parse(/`(\{ "id": "[a-z0-9]{8}".*?\})`/.exec(sk)[1]);
  check('프로젝트 목록에 넣는 예: platform 스킬의 프로젝트 필드 그대로(id 8자·계획·진도 0)이고 공정표 예와 같은 기간',
    Object.keys(rec).join() === 'id,name,client,status,progress,start,due,owner' && rec.status === '계획' && rec.progress === 0 && rec.start === from && rec.due === to);

  // .system.md: 주인이 손본 줄은 그대로 두고, 새 WBS 안내만 맨 끝에 한 번 더해짐
  const sys = read(dir, '.system.md');
  check('.system.md: 주인이 손으로 덧붙인 줄과 원래 규칙(기억·업무 데이터)은 그대로 남음', sys.includes('나는 존댓말을 쓰는 비서다. (주인이 손으로 덧붙인 줄)') && sys.includes('## 기억 (data/memory.md)') && sys.includes('## 업무 데이터 (data/db/*.json)'));
  check('.system.md: WBS 안내(wbs 스킬을 먼저 읽고 따름)가 맨 끝에 정확히 한 번 더해짐', sys.split('<!-- 지침:wbs -->').length === 2 && sys.includes('.claude/skills/wbs/SKILL.md') && sys.indexOf('<!-- 지침:wbs -->') > sys.indexOf('주인이 손으로 덧붙인 줄'));
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

// 옛 스킬 문서가 남아 있는 PC 를 흉내 낸다: 서버를 켜면 templates/ 의 새 내용으로 바뀌어야 한다 (새 규칙이 기존 설치에도 반영되게)
fs.mkdirSync(path.join(dir, '.claude', 'skills', 'platform'), { recursive: true });
fs.writeFileSync(path.join(dir, '.claude', 'skills', 'platform', 'SKILL.md'), '옛 스킬 문서');
// 주인이 손본 .system.md 를 흉내 낸다 (옛 템플릿 + 손으로 덧붙인 줄): 서버를 켜도 그 줄은 지워지지 않고, 새 WBS 안내만 맨 끝에 한 번 더해져야 한다
fs.copyFileSync(path.join(__dirname, 'templates', 'system.md'), path.join(dir, '.system.md'));
fs.appendFileSync(path.join(dir, '.system.md'), '\n나는 존댓말을 쓰는 비서다. (주인이 손으로 덧붙인 줄)\n');
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
