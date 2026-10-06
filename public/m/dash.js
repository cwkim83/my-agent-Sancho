// 대시보드 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다)
//   dash.greeting(now, '이름')       → "좋은 아침입니다, 이름님"
//   dash.stats({events, projects, tasks, notices}, now) → 숫자 카드와 목록에 쓸 값
//   dash.dday('2026-10-09', now)     → "D-3" / "오늘" / "1일 지남"
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

  window.dash = { greeting, stats, dday };
})();
