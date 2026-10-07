// 대시보드 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다)
//   dash.greeting(now, '이름')       → "좋은 아침입니다, 이름님"
//   dash.stats({events, projects, tasks, notices}, now) → 숫자 카드와 목록에 쓸 값
//   dash.dday('2026-10-09', now)     → "D-3" / "오늘" / "1일 지남"
//   dash.upcoming(events, now)       → 내일부터 7일 일정 · dash.taskCounts(tasks) → 상태별 개수
//   dash.gantt(projects, now)        → 간트차트 막대·달 눈금·오늘 선 (% 위치)
(() => {
  const { ymd, isDate, eventsOn } = window.cal; // cal.js 를 먼저 불러와야 한다

  function greeting(now, name) {
    const h = now.getHours();
    const hi = h >= 5 && h < 12 ? '좋은 아침입니다' : h >= 12 && h < 18 ? '좋은 오후입니다' : '좋은 저녁입니다';
    return `${hi}, ${name}님`;
  }

  // AI 가 파일을 직접 고친 자료도 올 수 있으니 비어 있거나 모양이 다른 항목이 있어도 멈추지 않는다
  function stats({ events = [], projects = [], tasks = [], notices = [] }, now) {
    const today = ymd(now);
    const limit = new Date(now); limit.setDate(limit.getDate() + 7);
    const soon = ymd(limit);
    const todayEvents = eventsOn(events, today);
    // 마감이 지난 것도 "임박"에 넣는다 (더 급하니까). 몇 개가 지난 건지는 overdue 로 따로 알려 준다
    // 마감일 모양이 틀린 것("10/7" 등)은 글자 비교가 엉뚱하게 맞아떨어지므로 아예 빼고 센다
    const dueSoon = tasks.filter((t) => t && isDate(t.due) && t.status !== '완료' && t.due <= soon)
      .sort((a, b) => a.due.localeCompare(b.due));
    const obj = (x) => x !== null && typeof x === 'object';
    return {
      todayEvents,
      activeProjects: projects.filter((p) => obj(p) && p.status === '진행중').length,
      dueSoon,
      overdue: dueSoon.filter((t) => t.due < today).length,
      unread: notices.filter((n) => obj(n) && !Array.isArray(n) && !n.read).length,
    };
  }

  function dday(due, now) {
    const n = Math.round((Date.parse(due) - Date.parse(ymd(now))) / 864e5); // 날짜만 있는 글자는 둘 다 같은 기준(UTC 자정)으로 읽힌다
    return isNaN(n) ? '' : n < 0 ? `${-n}일 지남` : n === 0 ? '오늘' : `D-${n}`;
  }

  // 앞으로 7일(내일~7일 뒤) 일정, 날짜·시간순. 오늘 것은 "오늘 일정" 카드가 따로 보여 준다
  function upcoming(events, now, days = 7) {
    const out = [];
    for (let i = 1; i <= days; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const day = ymd(d); for (const e of eventsOn(events, day)) out.push({ ...e, day }); }
    return out;
  }

  // 할 일 상태별 개수 (모양이 틀린 항목은 뺀다)
  function taskCounts(tasks) {
    const c = { '할 일': 0, 진행중: 0, 완료: 0 };
    for (const t of tasks) if (t && typeof t === 'object' && t.status in c) c[t.status]++;
    return c;
  }

  // 간트차트: 끝나지 않은 프로젝트(시작·마감일이 맞는 것)를 막대로. 기간은 첫 시작 달 1일 ~ 마지막 마감 다음 달 1일.
  // 위치는 그 기간 안의 % (left·width·today), 달 눈금은 months. 오늘이 기간 밖이면 today 는 null
  function gantt(projects, now) {
    const ok = projects.filter((p) => p && typeof p === 'object' && p.status !== '완료' && isDate(p.start) && isDate(p.due) && p.start <= p.due)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!ok.length) return { rows: [], months: [], today: null };
    const day = (s) => Date.parse(s) / 864e5; // 날짜 글자는 UTC 자정으로 읽힌다 (dday 와 같은 기준)
    const first = ok[0].start.slice(0, 7) + '-01', lastDue = ok.reduce((m, p) => (p.due > m ? p.due : m), '');
    const [y, mo] = lastDue.split('-').map(Number), end = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const a = day(first), span = day(end) - a, pct = (s) => Math.round(((day(s) - a) / span) * 1000) / 10;
    const months = [];
    for (let s = first; s < end;) { const [yy, mm] = s.split('-').map(Number); months.push({ label: mm === 1 || !months.length ? `${yy}.${mm}월` : `${mm}월`, left: pct(s) }); s = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`; }
    const t = ymd(now), today = t >= first && t < end ? pct(t) : null;
    const rows = ok.map((p) => ({ id: p.id, name: p.name, client: p.client, owner: p.owner, status: p.status, start: p.start, due: p.due,
      progress: Math.max(0, Math.min(100, Number(p.progress) || 0)), left: pct(p.start), width: Math.max(1, Math.round((pct(p.due) - pct(p.start) + 100 / span) * 10) / 10), late: p.due < t }));
    return { rows, months, today };
  }

  window.dash = { greeting, stats, dday, upcoming, taskCounts, gantt };
})();
