// 메일정리 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다). cal.js 를 먼저 불러와야 한다.
// 메일 항목은 data/db/mails.json 의 한 줄: { id, 보낸사람, 제목, 받은날, 분류, 요약, 할일, 마감일, 일정날짜, 일정시작, 일정장소, 일정종류, 상태, 초안, 초안위치, 일정id, 할일id, … }
(() => {
  const cal = window.cal; // cal.js 를 먼저 불러와야 한다
  const KINDS = ['긴급', '업무', '광고'], EVENT_KINDS = ['회의', '출장', '검사 입회', '개인'], DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const str = (v) => String(v ?? '');
  const pad = (n) => String(n).padStart(2, '0');

  const stripTags = (t) => str(t).replace(/^(\s*\[[^\]]{1,10}\]\s*)+/, '').trim(); // "[긴급] 제목" → "제목"
  const short = (ymd) => { const d = cal.parse(ymd); return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`; }; // "2026-10-13" → "10/13(화)"
  const plusHour = (hm) => { const [h, m] = hm.split(':').map(Number), t = Math.min(h * 60 + m + 60, 23 * 60 + 59); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };

  // 칸(긴급·업무·광고)별 카드. 모르는 분류는 업무로, 처리됨은 showDone 일 때만. 마감이 빠른 순(마감 없는 건 뒤), 같으면 최근 받은 순
  function columns(list, showDone) {
    const out = Object.fromEntries(KINDS.map((k) => [k, []]));
    for (const m of list) {
      if (!cal.isObj(m) || (m.상태 === '처리됨' && !showDone)) continue;
      out[KINDS.includes(m.분류) ? m.분류 : '업무'].push(m);
    }
    for (const k of KINDS) out[k].sort((a, b) => (a.마감일 || '9999').localeCompare(b.마감일 || '9999') || str(b.받은날).localeCompare(str(a.받은날)));
    return out;
  }

  // 카드에 붙는 마감 표시: { text, cls } (cls: late 지남 · soon 오늘·내일 · '' ). 마감일이 없거나 모양이 틀리면 null
  function dueInfo(m, today) {
    if (!cal.isDate(m.마감일)) return null;
    const diff = Math.round((cal.parse(m.마감일) - cal.parse(today)) / 86400000);
    if (diff < 0) return { text: `마감 ${short(m.마감일)} · ${-diff}일 지남`, cls: 'late' };
    if (diff === 0) return { text: '마감 오늘', cls: 'soon' };
    if (diff === 1) return { text: `마감 내일 ${short(m.마감일)}`, cls: 'soon' };
    return { text: `마감 ${short(m.마감일)}`, cls: '' };
  }

  // 일정 종류: 비서가 적은 것이 맞으면 그대로, 아니면 글에서 짐작한다
  function guessKind(m) {
    if (EVENT_KINDS.includes(m.일정종류)) return m.일정종류;
    const t = `${str(m.제목)} ${str(m.할일)} ${str(m.요약)}`;
    return /입회|검사|시험/.test(t) ? '검사 입회' : /출장|방문|실사|현장/.test(t) ? '출장' : /회의|미팅|협의/.test(t) ? '회의' : '개인';
  }

  // "일정으로 등록": 메일이 알리는 일정(일정날짜)이 있으면 그 날 그 시각에, 없으면 마감일에 "마감: …" 종일 일정으로. 날짜가 하나도 없으면 { error }
  function eventFrom(m, id) {
    const hasEvent = cal.isDate(m.일정날짜), date = hasEvent ? m.일정날짜 : cal.isDate(m.마감일) ? m.마감일 : '';
    if (!date) return { error: '일정으로 잡을 날짜가 메일 요약에 없어요. 일정 메뉴에서 직접 추가해 주세요.' };
    const start = hasEvent && cal.isTime(m.일정시작) ? m.일정시작 : '';
    const base = stripTags(m.제목) || str(m.요약) || '메일 일정';
    return { event: {
      id, title: (hasEvent ? base : `마감: ${base}`).slice(0, 100), kind: hasEvent ? guessKind(m) : '개인', date, endDate: date,
      start, end: start ? plusHour(start) : '', place: hasEvent ? str(m.일정장소) : '', memo: `메일: ${str(m.보낸사람)} — ${str(m.요약)}`.slice(0, 300), projectId: null,
    } };
  }

  // "할 일로 등록": 할일 한 줄(없으면 제목)을 마감일과 함께. 담당자는 비워 둔다
  const taskFrom = (m, id) => ({ id, title: (str(m.할일).trim() || stripTags(m.제목) || '메일 할 일').slice(0, 100), projectId: null, due: cal.isDate(m.마감일) ? m.마감일 : '', status: '할 일', owner: '' });

  // 등록해 둔 일정·할 일이 아직 있는지 (주인이 일정 메뉴에서 지웠으면 "등록됨" 표시를 거둔다)
  const isRegistered = (list, id) => !!id && list.some((x) => cal.isObj(x) && str(x.id) === str(id));

  window.mailx = { KINDS, EVENT_KINDS, stripTags, short, columns, dueInfo, guessKind, eventFrom, taskFrom, isRegistered };
})();
