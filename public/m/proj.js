// 프로젝트 화면 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다).
// 날짜는 모두 "2026-10-06" 모양의 글자. cal.js 를 먼저 불러와야 한다.
(() => {
  const { isDate, isObj, okId } = window.cal;
  const str = (v) => String(v ?? '');
  const STATUS = ['계획', '진행중', '완료'];
  const num = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; }; // 날짜 → 날 수 (여름시간 등에 흔들리지 않게 UTC)

  const hasSpan = (p) => isDate(p.start) && isDate(p.due) && p.start <= p.due; // 간트에 그릴 수 있는 기간
  const pct = (p) => { const n = Number(p.progress); return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : 0; };
  const periodText = (p) => (hasSpan(p) ? `${p.start.replace(/-/g, '.')} ~ ${p.due.replace(/-/g, '.')}` : '기간 미정');

  // 카드로 보여 줄 프로젝트(id 가 있는 것)만, 시작일 순. 기간이 없는 것은 맨 뒤
  const sorted = (projects) => projects.filter((p) => isObj(p) && okId(p.id))
    .sort((a, b) => (hasSpan(a) ? a.start : '9999').localeCompare(hasSpan(b) ? b.start : '9999') || str(a.name).localeCompare(str(b.name)));

  // 비서가 형식을 어겨 쓴 항목: 멈추지 않고 건너뛰되(카드는 되는 만큼 보여 주고, 간트에서는 뺀다), 무엇이 문제인지 모아 알려 준다
  function problems(projects = []) {
    const why = (p) => {
      if (!isObj(p)) return '항목 모양이 아님';
      if (!okId(p.id)) return 'id 가 없거나 쓸 수 없는 글자';
      if (!str(p.name).trim()) return '이름이 없음';
      if (!hasSpan(p)) return '기간(start·due)이 YYYY-MM-DD 가 아니거나 끝이 시작보다 빠름';
      if (p.progress !== undefined && !(typeof p.progress === 'number' && p.progress >= 0 && p.progress <= 100)) return '진도율이 0~100 숫자가 아님';
      if (p.status !== undefined && !STATUS.includes(p.status)) return `상태가 ${STATUS.join('·')} 중 하나가 아님`;
      return '';
    };
    const label = (p) => (isObj(p) && p.name ? str(p.name) : JSON.stringify(p) ?? str(p)).slice(0, 30);
    return projects.map((p) => [p, why(p)]).filter(([, w]) => w).map(([p, w]) => `프로젝트 "${label(p)}": ${w}`);
  }

  // 새 프로젝트 창에서 저장을 누를 때: 문제가 있으면 쉬운 말로 된 이유를, 괜찮으면 '' 를 돌려준다
  function validate(f) {
    if (!str(f.name).trim()) return '프로젝트 이름을 적어 주세요.';
    if (!isDate(f.start)) return '시작일을 골라 주세요.';
    if (!isDate(f.due)) return '종료일을 골라 주세요.';
    if (f.due < f.start) return '종료일이 시작일보다 빨라요.';
    if (!STATUS.includes(f.status)) return '상태를 골라 주세요.';
    const n = str(f.progress).trim() === '' ? 0 : Number(f.progress);
    if (!Number.isInteger(n) || n < 0 || n > 100) return '진도율은 0~100 사이 정수로 적어 주세요.';
    return '';
  }
  const toProject = (f, id) => ({
    id, name: str(f.name).trim(), client: str(f.client).trim(), owner: str(f.owner).trim(),
    status: f.status, start: f.start, due: f.due, progress: str(f.progress).trim() === '' ? 0 : Number(f.progress),
  });

  // ---------- 연간 간트: 그 해(1/1~12/31)를 가로 100% 로 보고, 막대가 차지하는 자리를 % 로 ----------
  const yearDays = (year) => num(`${year + 1}-01-01`) - num(`${year}-01-01`); // 365 또는 366
  const monthDays = (year) => Array.from({ length: 12 }, (_, m) => new Date(year, m + 1, 0).getDate());
  // 그 해와 안 겹치면 null. 해 밖으로 나간 쪽은 잘라서(cutL·cutR) 알려 준다
  function span(p, year) {
    if (!hasSpan(p)) return null;
    const y0 = num(`${year}-01-01`), n = yearDays(year), s = num(p.start), e = num(p.due);
    const a = Math.max(s, y0), b = Math.min(e, y0 + n - 1);
    if (a > b) return null;
    return { left: ((a - y0) / n) * 100, width: ((b - a + 1) / n) * 100, cutL: s < y0, cutR: e > y0 + n - 1 };
  }
  // 오늘 세로선의 자리(%) — 그 날의 시작 지점. 오늘이 그 해가 아니면 null
  const todayPos = (year, today) => (today.slice(0, 4) === String(year) ? ((num(today) - num(`${year}-01-01`)) / yearDays(year)) * 100 : null);

  window.proj = { STATUS, hasSpan, pct, periodText, sorted, problems, validate, toProject, monthDays, span, todayPos };
})();
