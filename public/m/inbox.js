// 알림(🔔)·예약 칸에 쓰는 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다)
//   inbox.notices(items)       → 화면에 그릴 알림 목록(새것부터). 객체가 아닌 항목은 빼고, 모양이 이상한 칸은 기본값으로 채운다
//   inbox.when(iso, now)       → "14:03"(오늘) / "10/6 14:03"(다른 날) / ""(시각이 이상함)
//   inbox.full(iso)            → "2026-10-07 14:03"
//   inbox.scheduleText(언제)    → "매일 08:30" · "매주 월 09:00" · "2026-10-08 15:00 한 번" · "30분마다"
(() => {
  const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x); // dash.js 의 안 읽은 알림 수와 같은 기준(그래서 🔔 숫자와 대시보드 카드 숫자가 어긋나지 않는다)
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  function notices(items) {
    return (Array.isArray(items) ? items : []).filter(obj).map((n) => ({
      raw: n, // 읽음 표시로 저장할 때 원래 항목(모르는 칸 포함)을 그대로 쓰려고
      id: typeof n.id === 'string' ? n.id : '',
      title: String(n.title ?? '').trim() || '(제목 없음)',
      body: String(n.body ?? ''),
      detail: String(n.detail ?? ''),
      level: n.level === '주의' ? '주의' : '안내',
      at: Number.isNaN(Date.parse(n.at)) ? '' : n.at,
      read: !!n.read,
    })).reverse().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)); // 같은 시각이면 파일 뒤쪽(나중에 쌓인) 것이 위로
  }

  function when(iso, now) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toDateString() === now.toDateString() ? hm(d) : `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
  }

  function full(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('sv-SE')} ${hm(d)}`;
  }

  function scheduleText(w) {
    if (!obj(w)) return '(언제인지 모름)';
    if (w.종류 === 'daily') return `매일 ${w.시각}`;
    if (w.종류 === 'weekly') return `매주 ${w.요일} ${w.시각}`;
    if (w.종류 === 'once') return `${w.날짜} ${w.시각} 한 번`;
    if (w.종류 === 'every') return w.분 >= 60 && w.분 % 60 === 0 ? `${w.분 / 60}시간마다` : `${w.분}분마다`;
    return '(언제인지 모름)';
  }

  window.inbox = { notices, when, full, scheduleText };
})();
