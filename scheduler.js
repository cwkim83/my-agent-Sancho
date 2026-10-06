// 예약의 시각 계산 — 순수 계산만 한다 (파일·진짜 시계·claude 는 건드리지 않는다). server.js 가 쓰고, selftest.js 는 시각을 바꿔 가며 직접 부른다.
// 예약 항목: { id, 이름, 언제, 지시문, 켬, 마지막실행 }  (형식 설명은 templates/system-add/schedule.md)
//   언제: { 종류: 'daily', 시각: 'HH:MM' } | { 종류: 'weekly', 요일: '월', 시각: 'HH:MM' } | { 종류: 'once', 날짜: 'YYYY-MM-DD', 시각: 'HH:MM' } | { 종류: 'every', 분: N }
// 시각은 모두 이 PC 의 지역 시각이다.
const DAYS = '일월화수목금토'; // Date.getDay() 순서
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ymd = (d) => d.toLocaleDateString('sv-SE');

// 형식이 틀리면 쉬운 한국어 이유를, 맞으면 null
function check(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return '항목이 { … } 모양이 아니에요.';
  if (typeof e.id !== 'string' || !e.id) return 'id 가 없어요.';
  if (typeof e.지시문 !== 'string' || !e.지시문.trim()) return '지시문이 비어 있어요.';
  if (e.마지막실행 && Number.isNaN(Date.parse(e.마지막실행))) return '마지막실행이 시각이 아니에요.';
  const w = e.언제;
  if (!w || typeof w !== 'object') return '언제가 없어요.';
  if (w.종류 === 'every') return Number.isInteger(w.분) && w.분 >= 1 ? null : 'every 의 분은 1 이상의 정수여야 해요.';
  if (!['daily', 'weekly', 'once'].includes(w.종류)) return '언제.종류는 daily · weekly · once · every 중 하나여야 해요.';
  if (!HHMM.test(w.시각)) return '시각은 24시간 HH:MM (예: 08:30) 이어야 해요.';
  if (w.종류 === 'weekly' && !(typeof w.요일 === 'string' && w.요일.length === 1 && DAYS.includes(w.요일))) return '요일은 월·화·수·목·금·토·일 중 한 글자여야 해요.';
  // 2026-02-30 같은 없는 날은 자바스크립트가 3월 2일로 넘겨 버리므로, 되돌려 봐서 같은 날인지 본다
  if (w.종류 === 'once' && !(/^\d{4}-\d\d-\d\d$/.test(w.날짜) && ymd(new Date(`${w.날짜}T00:00`)) === w.날짜)) return '날짜는 있는 날(YYYY-MM-DD)이어야 해요.';
  return null;
}

// now 이전(같은 순간 포함)에서 가장 최근의 정해진 시각. 없으면 null. (every 는 정해진 시각이 없어서 여기서 다루지 않는다)
function lastDue(w, now) {
  if (w.종류 === 'once') { const t = new Date(`${w.날짜}T${w.시각}`); return t <= now ? t : null; }
  const [h, m] = w.시각.split(':').map(Number), d = new Date(now);
  d.setHours(h, m, 0, 0); // 오늘의 그 시각
  if (w.종류 === 'daily') { if (d > now) d.setDate(d.getDate() - 1); return d; }
  d.setDate(d.getDate() - ((d.getDay() - DAYS.indexOf(w.요일) + 7) % 7)); // 가장 가까운 지난(또는 오늘) 그 요일
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

// 지금 실행할 때인가. 마지막실행이 없으면 "한 번도 안 돌았다"로 본다.
// 놓친 회차를 몰아서 돌리지 않는 이유: 가장 최근 정해진 시각 "하나"만 보기 때문이다 — 며칠을 놓쳐도 한 번 돌면 마지막실행이 그 시각을 넘어서 끝.
function isDue(e, now) {
  if (check(e) || e.켬 === false) return false; // 형식 검사가 먼저 (null 같은 이상한 항목에서 터지지 않게)
  const w = e.언제, last = e.마지막실행 ? new Date(e.마지막실행) : null;
  if (w.종류 === 'every') return !last || now - last >= w.분 * 60_000;
  const due = lastDue(w, now);
  return !!due && (!last || last < due);
}

module.exports = { check, lastDue, isDue };
