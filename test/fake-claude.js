// 점검용 가짜 claude: 진짜 Claude Code 와 같은 모양(stream-json)의 줄을 흉내 낸다. 서버 점검(selftest.js)에서만 쓴다.
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => run(input.trim()));
const a = process.argv;
const ri = a.indexOf('--resume');
const sid = ri >= 0 ? a[ri + 1] : 'fake-' + Date.now();
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 메일정리 흉내: 서버가 보내는 "[메일 정리]"·"[답장 초안]" 지시를 받아, 진짜 비서가 하듯 data/db/mails.json 을 직접 고친다 (점검용 표시 파일로 동작을 바꾼다)
//   fake-mail-bad.flag → 형식을 어긴다(원문 칸·긴 글·이상한 분류 + 기존 항목 지움) / fake-mail-slow.flag → 1.5초 걸림 / fake-mail-nodraft.flag → 초안을 안 적음
async function mail(msg) {
  const fs = require('fs'), real = msg.includes('실제 메일함 모드'), has = (f) => fs.existsSync(f);
  const allowed = (() => { const i = a.indexOf('--allowedTools'), o = []; for (let k = i + 1; i >= 0 && k < a.length && !a[k].startsWith('--'); k++) o.push(a[k]); return o; })();
  fs.appendFileSync('fake-prompts.log', msg + `\nALLOW=${allowed.join(',')}` + '\n---\n'); // 메일정리 실행이 받은 허용 목록도 남긴다 (명령 도구가 없어야 한다)
  if (has('fake-mail-slow.flag')) await sleep(1500);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv-SE'); };
  const done = (t) => { delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); };
  let cur; try { cur = has('db/mails.json') ? read('db/mails.json') : []; } catch { return done('mails.json 이 깨져 있어서 건드리지 않았어요'); }
  if (msg.startsWith('[답장 초안]')) {
    const m = cur.find((x) => x.id === (/id 가 "([^"]+)"/.exec(msg) || [])[1]);
    if (m && !has('fake-mail-nodraft.flag')) { m.초안 = '안녕하세요.\n확인 후 회신드리겠습니다.\n감사합니다.'; m.초안위치 = real ? 'Gmail 임시보관함' : '연습용(저장만)'; fs.writeFileSync('db/mails.json', JSON.stringify(cur, null, 2)); }
    return done(m ? '답장 초안을 만들었어요' : '그 메일이 없어요');
  }
  if (has('fake-mail-break.flag')) { fs.writeFileSync('db/mails.json', '{ 깨짐'); return done('끝'); } // 파일을 깨 놓고 끝나는 비서
  const src = real ? [{ id: 'g-1', 보낸사람: '가상 발신자', 소속: '', 제목: '[긴급] 실제 모드 시험 메일', 며칠전: 0, 본문: '실제 모드 본문' }] : read('db/sample-mails.json');
  let n = 0;
  for (const s of src) {
    if (s.며칠전 > 1 || cur.some((c) => c.원본id === s.id)) continue;
    const kind = /^\[긴급\]/.test(s.제목) ? '긴급' : /^\[광고\]/.test(s.제목) ? '광고' : '업무', ad = kind === '광고';
    cur.push({ id: 'k' + String(cur.length + 1).padStart(7, '0'), 출처: real ? 'Gmail' : '연습', 원본id: s.id, 보낸사람: `${s.보낸사람}${s.소속 ? ` (${s.소속})` : ''}`, 제목: s.제목, 받은날: day(s.며칠전), 분류: kind,
      요약: `${s.제목} 요약`, 할일: ad ? '' : '확인하고 회신', 마감일: ad ? '' : day(-1), 일정날짜: '', 일정시작: '', 일정장소: '', 일정종류: '', 상태: '새것', 초안: '', 초안위치: '', 일정id: '', 할일id: '' });
    n++;
  }
  if (has('fake-mail-bad.flag')) { // 형식을 어긴 비서: 원문 칸·긴 글·이상한 분류·줄바꿈 제목을 끼우고, 맨 앞 기존 항목을 지워 버린다
    const first = cur.find((c) => c.원본id === src[0].id);
    if (first) Object.assign(first, { 본문: src[0].본문, 원문: src[0].본문, 요약: '긴'.repeat(500), 분류: '이상한분류', 제목: '줄\n바꿈  제목', 마감일: '2026-02-31', 일정시작: '25:99', 상태: '엉뚱' });
    cur.shift();
  }
  fs.writeFileSync('db/mails.json', JSON.stringify(cur, null, 2));
  done(`새 메일 ${n}통 정리\n(둘째 줄: 비서가 길게 보고해도 화면에는 첫 줄만 나와야 한다)`);
}

async function run(msg) {
  out({ type: 'system', subtype: 'init' });
  if (msg.startsWith('[메일 정리]') || msg.startsWith('[답장 초안]')) return mail(msg);
  if (msg.startsWith('[회의록 정리]')) { // 회의록 정리 흉내: 받아쓴 글에 /실패해 가 있으면 죽고, /느리게 는 2초, /잘못된형식 은 JSON 이 아닌 글, /펜스 는 앞뒤에 말과 코드 블록 표시를 붙인다. 받은 도구·글을 점검용 파일에 남긴다
    require('fs').appendFileSync('fake-meeting-args.log', JSON.stringify({ tools: a.indexOf('--tools') >= 0 ? a[a.indexOf('--tools') + 1] : null, prompt: msg }) + '\n');
    if (msg.includes('/실패해')) { process.stderr.write('boom: 회의록 정리 중 죽음'); process.exit(3); }
    if (msg.includes('/느리게')) await sleep(2000);
    if (msg.includes('/한번만실패') && !require('fs').existsSync('fake-meeting-once.flag')) { require('fs').writeFileSync('fake-meeting-once.flag', ''); process.stderr.write('boom: 첫 번째만 죽음'); process.exit(3); } // 다시 정리하면 성공하는 경우
    const text = msg.includes('/잘못된형식') ? '회의록을 잘 정리했어요! (JSON 이 아님)' : (() => {
      const j = JSON.stringify({ 안건: ['압력용기 도면 2차 검토', '납기 일정 확인', '<b>태그</b> & 기호'], 논의: [{ 주제: '도면 치수', 내용: ['노즐 위치 확인', '용접 순서 조정'] }, { 주제: '', 내용: ['주제 없는 논의는 버려진다'] }],
        결정: ['도면 2차안으로 확정한다', '납기는 11월 20일로 유지한다', '길'.repeat(400)], 할일: [{ 할일: '도면 2차안 수정', 담당: '김민준', 기한: '2026-10-09' }, { 할일: '견적 재요청', 담당: '이서연', 기한: '2026-13-45' }, { 할일: '검사 계획서 작성', 담당: '박지호', 기한: '' }, { 할일: '', 담당: '없음', 기한: '' }], 군더더기: '모르는 칸은 버려진다' });
      return msg.includes('/펜스') ? '네, 정리했어요.\n```json\n' + j + '\n```\n끝' : j;
    })();
    delta(text); out({ type: 'result', subtype: 'success', is_error: false, result: text }); return;
  }
  if (msg.startsWith('[메신저 채널 질문]')) { // 메신저 "@산초" 흉내: 질문에 /실패해 가 있으면 죽고, /느리게 가 있으면 2초 걸린 뒤 평소처럼 (받은 글을 그대로 되울려서 서버가 무엇을 건넸는지 보인다)
    const q = msg.slice(msg.lastIndexOf('\n요청: ')); // 맨 끝의 "요청: …" 만 본다 (앞의 대화 속 글에는 반응하지 않는다)
    if (q.includes('/실패해')) { process.stderr.write('boom: 메신저 답변 중 죽음'); process.exit(3); }
    if (q.includes('/느리게')) await sleep(2000);
  }
  if (msg === '/orphan') { // 멈춘 python 흉내: 답을 다 보내고 끝났는데, 띄운 프로그램이 출력 통로를 붙잡은 채 20초 남는다
    require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, cwd: require('os').tmpdir() }).unref(); // 점검 폴더를 붙잡지 않게 다른 곳에서
    delta('다 했어요'); out({ type: 'result', subtype: 'success', is_error: false, result: '다 했어요' }); process.exit(0);
  }
  if (msg.startsWith('/make-doc')) { // 문서 만들기 흉내: 파일함에 문서를 두고(+ 카드에 안 나와야 하는 임시·숨김 파일), 글로 알린다
    const fs = require('fs'), name = msg.slice(9).trim() || '보고서.docx';
    fs.mkdirSync('파일함', { recursive: true });
    fs.writeFileSync('파일함/' + name, 'DOC:' + name); fs.writeFileSync('파일함/~$' + name, 'tmp'); fs.writeFileSync('파일함/.숨김', 'x'); fs.writeFileSync('파일함/작업중.tmp', 'x');
    const t = '문서를 만들었어요: ' + name; delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); return;
  }
  if (msg === '/login') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
  if (msg === '/limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' }); process.exit(1);
  }
  if (msg === '/crash') { process.stderr.write('boom: 갑자기 죽음'); process.exit(3); } // 결과 없이 죽는 경우
  if (msg === '/long') { const t = '가'.repeat(25000); delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); return; } // 알림에 담는 결과 길이 한도 점검용
  if (msg === '/markdown') { const t = '## 아침 요약\n\n**오늘 가장 신경 쓸 것:** 수압시험 입회\n\n| 시각 | 일정 |\n|---|---|\n| 10:00 | 입회 |'; delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); return; } // 폰으로 보낼 때 마크다운 기호를 걷어 내는지 점검용
  if (msg.startsWith('/wait')) { require('fs').appendFileSync('wait-runs.log', 'start\n'); await sleep(2500); } // 예약 겹침 점검용: 시작할 때마다 한 줄 적고 2.5초 걸린다
  if (msg === '/slow') { for (let i = 0; i < 300; i++) { delta('느림 '); await sleep(100); } }
  if (msg.includes('파일')) out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read', id: 't1' } } });
  const leak = (process.env.CLAUDECODE || process.env.ANTHROPIC_BASE_URL) ? 'LEAK' : 'clean';
  const fs = require('fs');
  const arg = (flag) => (a.indexOf(flag) >= 0 ? a[a.indexOf(flag) + 1] : null);
  const sysFile = arg('--append-system-prompt-file');
  const sysOk = sysFile && fs.existsSync(sysFile) && fs.readFileSync(sysFile, 'utf8').includes('Sancho') ? 'ok' : 'none';
  const deny = ['.system.md', '.claude/**'].every((f) => a.includes(`Edit(./${f})`) && a.includes(`Write(./${f})`)) && a.includes('Bash')
    && ['users.json', 'sessions.json', 'share.json', 'settings.json'].every((f) => ['Read', 'Edit', 'Write'].every((t) => a.includes(`${t}(./${f})`))) ? 'ok' : 'none'; // 비밀번호·로그인 기록·공유 링크·텔레그램 봇 토큰 파일은 읽지도 못하게
  // 허용 도구가 모두 data/ 안(./**)으로 묶여 있는지: 범위 없는 'Read' 같은 것이 하나라도 있으면 none
  const allowed = a.slice(a.indexOf('--allowedTools') + 1);
  const allowList = allowed.slice(0, allowed.findIndex((x) => x.startsWith('--')));
  const scope = allowList.length && allowList.every((t) => ['WebSearch', 'WebFetch'].includes(t) || /^(Read|Glob|Grep|Edit|Write)\(\.\/\*\*\)$/.test(t)) ? 'ok' : 'none';
  // 개발용 지침·플러그인 훅·커넥터를 싣지 않고, 도구를 7개로 고정했는지 (4편 점검: 비서가 상위 폴더를 프로젝트로 착각하던 원인)
  const iso = arg('--setting-sources') === 'local' && a.includes('--strict-mcp-config') && a.includes('--disable-slash-commands')
    && arg('--tools') === 'Read,Glob,Grep,Edit,Write,WebSearch,WebFetch' ? 'ok' : 'none';
  // 권한(설정 → 권한)이 명령줄에 어떻게 실렸는지: 플래그 하나가 받는 값들을 모은다
  const vals = (flag) => { const i = a.indexOf(flag), o = []; if (i < 0) return o; for (let k = i + 1; k < a.length && !a[k].startsWith('--'); k++) o.push(a[k]); return o; };
  // --settings 로 받은 것: 훅 끄기(disableAllHooks) 또는 문지기 훅. 문지기 확인 파일(SANCHO_GATE)이 있으면 그 내용도
  const settings = (() => { try { return JSON.parse(arg('--settings') || '{}'); } catch { return {}; } })();
  const gateHook = settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0];
  const gateInfo = (() => { try { return JSON.parse(fs.readFileSync(process.env.SANCHO_GATE, 'utf8')); } catch { return null; } })();
  if (msg === '/gatepath') { const t = `GATEPATH ${process.env.SANCHO_GATE || '-'}`; delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); return; }
  const al = vals('--allowedTools'), dn = vals('--disallowedTools'), G = 'mcp__claude_ai_Gmail__', has = (l, t) => (l.includes(t) ? 'Y' : 'N');
  const perm = [`apps=${has(al, G + 'search_threads')}`, `send=${has(al, G + 'send_message')}${has(al, G + 'reply')}${has(al, G + 'forward')}`, `sendDeny=${has(dn, G + 'send_message')}${has(dn, G + 'reply')}${has(dn, G + 'forward')}`,
    `shell=${has(al, 'Bash')}${has(al, 'PowerShell')}`, `toolsShell=${has(vals('--tools')[0].split(','), 'Bash')}`, `home=${a.includes('--add-dir') ? a[a.indexOf('--add-dir') + 1] : 'off'}`,
    `src=${arg('--setting-sources')}`, `strict=${a.includes('--strict-mcp-config') ? 'Y' : 'N'}`, `hooksOff=${settings.disableAllHooks === true ? 'Y' : 'N'}`, `ts=${has(vals('--tools')[0].split(','), 'ToolSearch')}`,
    `gate=${gateHook ? gateHook.matcher : '-'}`, `gateCmd=${gateHook ? (gateHook.hooks[0].command.includes('mailgate.js') ? 'Y' : 'N') : '-'}`, `gateFile=${gateInfo ? 'Y' : 'N'}`, `gateEmails=${gateInfo ? gateInfo.emails.join(';') || '-' : '-'}`, `gateOnce=${gateInfo ? (gateInfo.once ? 'Y' : 'N') : '-'}`].join(' ');
  if (msg === '/perm') { const t = `PERM ${perm} | allow=${al.join(',')} | deny=${dn.join(',')}`; delta(t); out({ type: 'result', subtype: 'success', is_error: false, result: t }); return; } // 권한 점검용: 받은 허용·거절 목록을 그대로 돌려준다
  if (msg.startsWith('/tool ')) { out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: msg.slice(6), id: 't9' } } }); delta('끝'); out({ type: 'result', subtype: 'success', is_error: false, result: '끝' }); return; } // 화면에 뜨는 도구 이름표 점검용
  const home = (/users\/([a-z0-9_.-]+)\/memory\.md/.exec(arg('--append-system-prompt') || '') || [])[1]; // 서버가 알려 준 "이 사람의 개인 폴더"
  if (msg.startsWith('기억해:')) fs.appendFileSync(home ? `users/${home}/memory.md` : 'memory.md', `- 2000-01-01 ${msg.slice(4).trim()}\n`); // 진짜 비서가 하는 일을 흉내
  const reply = `에코: ${msg} | resume=${ri >= 0 ? a[ri + 1] : 'none'} | env=${leak} | cwd=${require('path').basename(process.cwd())} | stdin=ok | sys=${sysOk} | deny=${deny} | scope=${scope} | iso=${iso} | tools=[${arg('--tools')}] | perm=${perm} | ctx=${arg('--append-system-prompt')}`;
  for (let i = 0; i < reply.length; i += 20) { delta(reply.slice(i, i + 20)); await sleep(5); } // 여러 조각으로 흘려보낸다(윈도우는 5ms 가 실제 15ms 쯤이라 조각을 너무 잘게 하면 느려진다)
  out({ type: 'result', subtype: 'success', is_error: false, result: reply });
}
