// 공수(일에 쓴 시간) 계산·검증 — 화면을 그리지 않는 순수 함수만 모았다.
// 브라우저(window.manday)·서버(require)·selftest 가 같은 파일을 쓴다. 날짜는 "2026-10-06" 모양의 글자.
//
// 기록 하나 = data/db/mandays.json 의 항목 하나:
//   { id, owner(아이디), ownerName, date, projectId('' 이면 프로젝트 없는 기타 업무), projectName(저장할 때의 이름), task, hours(시간, 야근 포함), overtime(야근이면 true), src, createdAt }
// 1 M/D(맨데이, 사람·일) = 8시간. 야근 시간도 시간으로 더하고, 야근만 따로도 센다.
(function (root) {
  'use strict';
  const HOURS_PER_MD = 8;
  const MAX_ROWS = 50, TASK_MAX = 60, PAST_DAYS = 400;

  const str = (v) => String(v ?? '');
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const r2 = (x) => Math.round(x * 100) / 100; // 0.1+0.2 같은 찌꺼기를 없애고 소수 둘째 자리까지
  const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const dayStr = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && dayStr(dayNum(s)) === s; // 없는 날(2/31)은 틀림
  const addDays = (s, k) => dayStr(dayNum(s) + k);
  const today = () => new Date().toLocaleDateString('sv-SE'); // 이 PC 의 오늘
  const clip = (v, n) => str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

  const md = (hours) => r2(hours / HOURS_PER_MD); // 시간 → M/D
  const fmtH = (h) => (isNum(h) ? String(r2(h)) : '');
  const fmtMd = (h) => (isNum(h) ? String(md(h)) : '');
  const monthOf = (date) => str(date).slice(0, 7);

  // ---------- 한 줄(기록) 검사 ----------
  // 이유(쉬운 한국어), 괜찮으면 ''. 프로젝트는 여기서 보지 않는다(서버·화면이 프로젝트 목록과 따로 맞춘다)
  function rowProblem(r, asOf) {
    if (!isObj(r)) return '줄 모양이 아님';
    if (!isDate(r.date)) return '날짜가 올바르지 않아요';
    if (r.date > addDays(asOf, 1)) return '아직 오지 않은 날짜예요';
    if (r.date < addDays(asOf, -PAST_DAYS)) return '너무 오래된 날짜예요';
    if (!clip(r.task, TASK_MAX)) return '작업 내용이 비어 있어요';
    if (clip(r.task, 1000).length > TASK_MAX) return `작업 내용은 ${TASK_MAX}자까지예요`;
    if (!isNum(r.hours) || r.hours <= 0) return '시간은 0 보다 큰 숫자여야 해요';
    if (r.hours > 24) return '하루는 24시간까지예요';
    if (Math.abs(r.hours * 4 - Math.round(r.hours * 4)) > 1e-9) return '시간은 0.25 시간(15분) 단위로 적어 주세요';
    return '';
  }

  // 저장할 줄들을 검사하고 다듬는다 → { rows: [{date, projectId, task, hours, overtime, src}] } 또는 { error: "3번째 줄: …" }
  // projects: 프로젝트 목록. projectId 는 목록에 있는 것이거나 ''(기타 업무)여야 한다
  function cleanRows(rows, ctx) {
    if (!Array.isArray(rows) || !rows.length) return { error: '저장할 줄이 없어요.' };
    if (rows.length > MAX_ROWS) return { error: `한 번에 ${MAX_ROWS}줄까지 저장할 수 있어요.` };
    const ids = new Set((ctx.projects || []).filter((p) => isObj(p) && typeof p.id === 'string').map((p) => p.id)), out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], why = rowProblem(r, ctx.today);
      if (why) return { error: `${i + 1}번째 줄: ${why}` };
      if (typeof r.projectId !== 'string' || (r.projectId !== '' && !ids.has(r.projectId))) return { error: `${i + 1}번째 줄: 프로젝트를 골라 주세요 (프로젝트가 없는 일이면 "기타 업무")` };
      if (r.overtime !== undefined && typeof r.overtime !== 'boolean') return { error: `${i + 1}번째 줄: 야근 표시가 올바르지 않아요` };
      out.push({ date: r.date, projectId: r.projectId, task: clip(r.task, TASK_MAX), hours: r2(r.hours), overtime: r.overtime === true, src: r.src === '직접' ? '직접' : '붙여넣기' });
    }
    return { rows: out };
  }

  // ---------- 프로젝트 이름 맞추기 (비서의 답과 상관없이 서버가 한 번 더 본다) ----------
  const norm = (s) => str(s).toLowerCase().replace(/[\s·.,()\-_/]+/g, '');
  // 글에 적힌 프로젝트 말 → 맞는 프로젝트 id 들. 하나면 확실, 둘 이상이면 어느 것인지 물어야 하고, 없으면 모름
  // 이름이 같은 프로젝트가 둘이면(고객사만 다름) 글에 고객사가 적혀 있을 때만 하나로 좁힌다
  function matchProject(text, projects) {
    const t = norm(text);
    if (t.length < 2) return [];
    const list = (Array.isArray(projects) ? projects : []).filter((p) => isObj(p) && typeof p.id === 'string' && norm(p.name));
    const exact = list.filter((p) => norm(p.name) === t);
    let c = exact.length ? exact : list.filter((p) => { const n = norm(p.name); return n.includes(t) || (n.length >= 3 && t.includes(n)); });
    if (c.length > 1) { const byClient = c.filter((p) => norm(p.client) && t.includes(norm(p.client))); if (byClient.length) c = byClient; }
    return c.map((p) => p.id);
  }

  // 비서에게 보여 줄 날짜 계산용 달력: 오늘 기준 지난 14일 ~ 앞 3일
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  const calendarText = (asOf) => Array.from({ length: 18 }, (_, i) => { const d = addDays(asOf, i - 14); return `${d}(${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]})`; }).join(' ');

  // 연도 없는 "10/6" 을 비서가 올해로 적었는데 아직 안 온 날이면, 작년 같은 날로 본다 (연말에 지난 12월 일을 1월에 적는 경우)
  function fixYear(date, asOf) {
    if (!isDate(date) || date <= addDays(asOf, 1)) return date;
    const prev = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
    return isDate(prev) && prev <= addDays(asOf, 1) ? prev : date;
  }

  // 비서의 답 글 → { rows: [초안 줄] } 또는 { error }. 초안 줄: { date, projectId(확실하면 id, 모르면 null), projectText, candidates[id], task, hours, overtime, problem }
  // 비서의 답은 믿지 않고 모양·범위를 서버가 다시 본다: 모르는 칸은 버리고, 프로젝트는 서버가 이름으로 다시 맞춘다
  function fromAnswer(answer, ctx) {
    const text = str(answer), a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a < 0 || z < a) return { error: '비서의 답을 공수 표로 바꾸지 못했어요. 다시 시도해 주세요.' };
    let j; try { j = JSON.parse(text.slice(a, z + 1)); } catch { return { error: '비서의 답을 공수 표로 바꾸지 못했어요. 다시 시도해 주세요.' }; }
    const list = isObj(j) ? (j.기록 ?? j.rows) : null;
    if (!Array.isArray(list)) return { error: '비서의 답을 공수 표로 바꾸지 못했어요. 다시 시도해 주세요.' };
    const known = new Set((ctx.projects || []).filter((p) => isObj(p) && typeof p.id === 'string').map((p) => p.id)), rows = [];
    for (const r of list.slice(0, MAX_ROWS)) {
      if (!isObj(r)) continue;
      const pick = (...ks) => { for (const k of ks) if (r[k] !== undefined) return r[k]; return undefined; };
      const hRaw = pick('시간', 'hours'), hours = isNum(hRaw) ? hRaw : /^\d+(\.\d+)?$/.test(str(hRaw).trim()) ? Number(str(hRaw).trim()) : null;
      const projectText = clip(pick('프로젝트말', 'projectText'), 40), modelId = pick('프로젝트id', 'projectId');
      const det = matchProject(projectText, ctx.projects);
      let projectId = null, candidates = [];
      if (det.length === 1) projectId = det[0];
      else if (det.length > 1) candidates = det; // 이름이 여럿과 맞으면 비서가 하나를 골랐더라도 믿지 않고 묻는다
      else if (typeof modelId === 'string' && known.has(modelId)) projectId = modelId;
      else { const c = pick('후보', 'candidates'); candidates = (Array.isArray(c) ? c : []).filter((x) => known.has(x)).slice(0, 5); }
      const row = { date: fixYear(str(pick('날짜', 'date')), ctx.today), projectId, projectText, candidates, task: clip(pick('작업', 'task'), TASK_MAX), hours: hours === null ? null : r2(hours), overtime: pick('야근', 'overtime') === true };
      rows.push({ ...row, problem: rowProblem(row, ctx.today) });
    }
    if (!rows.length) return { error: '시간 기록으로 읽을 내용을 찾지 못했어요. 예: "10/6 열교환기 용접 8h, 야근 2h / 도면검토 3h"' };
    return { rows };
  }

  // ---------- 합계 ----------
  const valid = (r) => isObj(r) && isDate(r.date) && isNum(r.hours) && r.hours > 0;
  const nameOf = (r, names) => (names && r.projectId && names[r.projectId]) || str(r.projectName).trim() || (r.projectId ? '(이름 없는 프로젝트)' : '기타 업무');
  const tally = (list) => ({ hours: r2(list.reduce((a, r) => a + r.hours, 0)), overtime: r2(list.filter((r) => r.overtime === true).reduce((a, r) => a + r.hours, 0)) });

  const total = (records) => tally((Array.isArray(records) ? records : []).filter(valid));
  // 달별 합계 [{ month, hours, overtime }] 오래된 달부터
  function monthRows(records) {
    const by = new Map();
    for (const r of (Array.isArray(records) ? records : []).filter(valid)) by.set(monthOf(r.date), [...(by.get(monthOf(r.date)) || []), r]);
    return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([month, l]) => ({ month, ...tally(l) }));
  }
  // 프로젝트별 합계 [{ projectId, name, hours, overtime }] 시간 많은 순. month 가 ''(또는 없음)이면 전체 기간. names: { 프로젝트id: 지금 이름 }
  function projectRows(records, month, names) {
    const by = new Map();
    for (const r of (Array.isArray(records) ? records : []).filter((x) => valid(x) && (!month || monthOf(x.date) === month))) by.set(r.projectId || '', [...(by.get(r.projectId || '') || []), r]);
    return [...by].map(([projectId, l]) => ({ projectId, name: nameOf(l[l.length - 1], names), ...tally(l) })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'ko'));
  }
  // 한 프로젝트에 모든 사람이 쓴 공수 (WBS 화면의 "투입 공수"): { hours, overtime, mandays, records, people, from, to }
  function projectTotal(records, pid) {
    const l = (Array.isArray(records) ? records : []).filter((r) => valid(r) && r.projectId === pid && pid !== '');
    const dates = l.map((r) => r.date).sort();
    return { ...tally(l), mandays: md(tally(l).hours), records: l.length, people: new Set(l.map((r) => r.owner)).size, from: dates[0] || '', to: dates[dates.length - 1] || '' };
  }
  const months = (records) => monthRows(records).map((m) => m.month);

  const api = { HOURS_PER_MD, MAX_ROWS, TASK_MAX, isDate, today, addDays, md, fmtH, fmtMd, monthOf, rowProblem, cleanRows, norm, matchProject, calendarText, fixYear, fromAnswer, total, monthRows, projectRows, projectTotal, months, nameOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.manday = api;
})(typeof window !== 'undefined' ? window : globalThis);
