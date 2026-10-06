// 달력 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다).
// 날짜는 모두 "2026-10-06" 모양의 글자이고, 한 주는 월요일부터 시작한다.
(() => {
  const str = (v) => String(v ?? '');
  const ymd = (d) => d.toLocaleDateString('sv-SE'); // Date → "2026-10-06"
  const parse = (s) => { const [y, m, d] = str(s).split('-').map(Number); return new Date(y, m - 1, d); }; // "그 날 0시"(이 PC 시간)
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const addMonths = (s, n) => { const d = parse(s); return ymd(new Date(d.getFullYear(), d.getMonth() + n, 1)); }; // 항상 그 달 1일
  const weekStart = (s) => addDays(s, -((parse(s).getDay() + 6) % 7));
  const weekDays = (s) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(s), i));

  // s 가 속한 달을 덮는 주들 (앞뒤 달의 날짜가 섞여 4~6줄)
  function monthGrid(s) {
    const d = parse(s), last = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const weeks = [];
    for (let w = weekStart(ymd(new Date(d.getFullYear(), d.getMonth(), 1))); w <= last; w = addDays(w, 7)) weeks.push(weekDays(w));
    return weeks;
  }

  // 모양 검사: 날짜는 진짜 있는 날("2026-02-31" 은 안 됨), 시각은 0 을 붙인 24시간, id 는 서버 주소에 쓸 수 있는 글자
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && ymd(parse(s)) === s;
  const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const okId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(str(id));
  const endOf = (e) => (isDate(e.endDate) && e.endDate >= e.date ? e.endDate : e.date); // 끝 날짜가 이상하면 하루짜리로 본다

  // 그 날에 걸친 일정(여러 날짜 일정 포함), 시작 시각 순. 날짜 모양이 틀린 항목은 건너뛴다 (problems 가 따로 알려 준다)
  const eventsOn = (events, day) => events.filter((e) => isObj(e) && isDate(e.date) && e.date <= day && day <= endOf(e))
    .sort((a, b) => str(a.start).localeCompare(str(b.start)));
  const dueOn = (tasks, day) => tasks.filter((t) => isObj(t) && t.due === day);

  // 화면이 제대로 못 보여 주거나 고칠 수 없는 항목(주로 비서가 형식을 어겨 쓴 것). 멈추지 않고 건너뛰되, 무엇이 문제인지 모아 알려 준다
  function problems(events = [], tasks = []) {
    const label = (x) => (isObj(x) && x.title ? str(x.title) : JSON.stringify(x) ?? str(x)).slice(0, 30);
    const why = (x, isEvent) => {
      if (!isObj(x)) return '항목 모양이 아님';
      if (!okId(x.id)) return 'id 가 없거나 쓸 수 없는 글자';
      if (isEvent) {
        if (!isDate(x.date)) return '날짜가 YYYY-MM-DD 가 아님';
        if (x.endDate && (!isDate(x.endDate) || x.endDate < x.date)) return '끝 날짜가 이상함';
        if ((x.start && !isTime(x.start)) || (x.end && !isTime(x.end))) return '시각이 HH:MM 이 아님';
      } else if (x.due && !isDate(x.due)) return '마감일이 YYYY-MM-DD 가 아님';
      return '';
    };
    return [...events.map((e) => [e, why(e, true), '일정']), ...tasks.map((t) => [t, why(t, false), '할 일'])]
      .filter(([, w]) => w).map(([x, w, kind]) => `${kind} "${label(x)}": ${w}`);
  }

  // 일정 창에서 저장을 누를 때: 문제가 있으면 쉬운 말로 된 이유를, 괜찮으면 '' 를 돌려준다
  function validate(f) {
    if (!str(f.title).trim()) return '제목을 적어 주세요.';
    if (!/^\d{4}-\d\d-\d\d$/.test(str(f.date))) return '날짜를 골라 주세요.';
    if (f.endDate && f.endDate < f.date) return '종료 날짜가 시작 날짜보다 빨라요.';
    if ((!f.endDate || f.endDate === f.date) && f.start && f.end && f.end < f.start) return '끝 시각이 시작 시각보다 빨라요.';
    return '';
  }
  // 창에 적은 값 → 저장할 일정. 고치는 경우 창에 없는 필드(projectId 등)는 그대로 둔다 (PUT 은 통째로 바꾸기 때문)
  const toEvent = (old, f, newId) => ({
    ...(old || {}), id: old ? str(old.id) : newId,
    title: str(f.title).trim(), kind: f.kind, date: f.date, endDate: f.endDate || f.date,
    start: str(f.start), end: str(f.end), place: str(f.place).trim(), memo: str(f.memo).trim(),
  });

  window.cal = { ymd, parse, addDays, addMonths, weekStart, weekDays, monthGrid, isDate, isTime, eventsOn, dueOn, problems, validate, toEvent };
})();
