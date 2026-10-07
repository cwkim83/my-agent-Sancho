// 목표(OKR) 계산·검증 — 화면을 그리지 않는 순수 함수만 모았다.
// 브라우저(window.okr)와 selftest(require)가 같은 파일을 쓴다. 날짜는 "2026-10-07" 모양의 글자.
//
// 목표 하나 = data/db/okrs.json 의 항목 하나:
//   { id, level('전사'|'부서'|'개인'), parentId(상위 목표 id, 없으면 ""), title, owner, dept, quarter('2026-Q4' 또는 연간 '2026'), note,
//     krs: [ { metric(지표), unit(단위), start(시작값, 없으면 0), target(목표값), current(현재값), weight(가중치, 없으면 1), due(기한 YYYY-MM-DD, 없으면 분기 끝) } ] }
//
// 계산 규칙
//   KR 달성률   = (현재값 − 시작값) ÷ (목표값 − 시작값), 0~100% 로 자른다. 시작값이 목표값보다 크면(불량률처럼 낮출수록 좋은 지표) 저절로 "내려갈수록 달성".
//   목표 진척   = KR 달성률의 가중 평균(가중치 ÷ 가중치 합). 하위 목표가 있으면 하위 목표들의 평균 — 자기 KR 이 있으면 그것도 하위 목표 하나처럼 한 몫으로 함께 평균한다.
//   색          = 진척을 "시간이 지난 만큼 가야 하는 진척"(분기 시작~끝 중 오늘까지 지난 비율, KR 은 기한까지)과 견준다. 뒤처짐이 10%p 이내면 순조, 25%p 이내면 주의, 넘으면 위험. KR 은 기한이 지났는데 100% 가 아니면 위험.
(function (root) {
  'use strict';
  const LEVELS = ['전사', '부서', '개인'];
  const RANK = { 전사: 0, 부서: 1, 개인: 2 };
  const SLACK = { ok: 0.10, warn: 0.25 }; // 뒤처짐이 이 비율(10%p·25%p)까지면 순조·주의
  const WEIGHT_DEFAULT = 1;

  const str = (v) => String(v ?? '');
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const okId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(str(id));
  const r6 = (x) => Math.round(x * 1e6) / 1e6; // 0.30000000000000004 같은 찌꺼기를 없애고 견준다
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const dayStr = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && dayStr(dayNum(s)) === s; // 없는 날(2/31)은 틀림
  const today = () => new Date().toLocaleDateString('sv-SE'); // 이 PC 의 오늘
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // ---------- 분기 ----------
  // '2026-Q4' → 2026-10-01 ~ 2026-12-31, '2026'(연간) → 2026-01-01 ~ 2026-12-31. 모양이 틀리면 null
  function periodOf(q) {
    const m = /^(\d{4})(?:-Q([1-4]))?$/.exec(str(q));
    if (!m) return null;
    const y = Number(m[1]);
    if (!m[2]) return { start: `${y}-01-01`, end: `${y}-12-31` };
    const a = (Number(m[2]) - 1) * 3 + 1, endMonth = a + 2, last = dayStr(Date.UTC(y, endMonth, 0) / 864e5);
    return { start: `${y}-${String(a).padStart(2, '0')}-01`, end: last };
  }
  const quarterOf = (date) => { const [y, m] = date.split('-').map(Number); return `${y}-Q${Math.ceil(m / 3)}`; }; // "2026-10-07" → "2026-Q4"
  const quarterLabel = (q) => { const m = /^(\d{4})(?:-Q([1-4]))?$/.exec(str(q)); return m ? (m[2] ? `${m[1]}년 ${m[2]}분기` : `${m[1]}년 연간`) : str(q); };

  // 시간이 지난 비율 0~1: start 부터 end 까지 중 asOf(오늘)까지 (양 끝 날을 모두 센다)
  function elapsed(start, end, asOf) {
    const s = dayNum(start), e = dayNum(end), t = dayNum(asOf);
    if (e < s) return 1;
    return clamp01((t - s + 1) / (e - s + 1));
  }

  // ---------- KR ----------
  // KR 하나의 문제(쉬운 한국어 이유), 괜찮으면 ''. 시작값·단위·가중치·기한은 없어도 된다(없으면 0·빈 글자·1·분기 끝)
  function krProblem(kr) {
    if (!isObj(kr)) return '항목 모양이 아님';
    if (!str(kr.metric).trim()) return '지표 이름이 비어 있음';
    if (!isNum(kr.target)) return '목표값이 숫자가 아님';
    if (!isNum(kr.current)) return '현재값이 숫자가 아님';
    if (kr.start !== undefined && kr.start !== null && !isNum(kr.start)) return '시작값이 숫자가 아님';
    if (kr.weight !== undefined && kr.weight !== null && !(isNum(kr.weight) && kr.weight >= 0)) return '가중치가 0 이상의 숫자가 아님';
    if (kr.due !== undefined && kr.due !== null && kr.due !== '' && !isDate(kr.due)) return '기한이 YYYY-MM-DD 가 아님';
    if (kr.unit !== undefined && kr.unit !== null && typeof kr.unit !== 'string') return '단위가 글자가 아님';
    if (startOf(kr) === kr.target) return '시작값과 목표값이 같음';
    return '';
  }
  const startOf = (kr) => (isNum(kr.start) ? kr.start : 0);
  const weightOf = (kr) => (isNum(kr.weight) ? kr.weight : WEIGHT_DEFAULT);

  // 달성률 0~1, 계산할 수 없으면 null
  function krRate(kr) {
    if (krProblem(kr)) return null;
    return r6(clamp01((kr.current - startOf(kr)) / (kr.target - startOf(kr))));
  }

  // 색: 진척 p(0~1), 지나야 할 비율 e(0~1). 100% 면 늘 순조. overdue(기한이 지났는데 미달)면 위험
  function statusOf(p, e, overdue) {
    if (p === null || p === undefined) return null;
    if (p >= 1) return '순조';
    if (overdue) return '위험';
    const lag = r6(e - p);
    return lag <= SLACK.ok ? '순조' : lag <= SLACK.warn ? '주의' : '위험';
  }

  // ---------- 목표 나무 ----------
  // 이 목표를 계산에 쓸 수 있나 (아니면 problems 가 이유를 알린다)
  const objProblem = (o) => {
    if (!isObj(o)) return '항목 모양이 아님';
    if (!okId(o.id)) return 'id 가 없거나 쓸 수 없는 글자';
    if (!str(o.title).trim() || typeof o.title !== 'string') return '제목이 비어 있음';
    if (!LEVELS.includes(o.level)) return '수준이 전사·부서·개인 중 하나가 아님';
    if (!periodOf(o.quarter)) return '분기가 2026-Q4 (또는 연간 2026) 모양이 아님';
    if (o.krs !== undefined && !Array.isArray(o.krs)) return 'KR 목록이 목록(배열)이 아님';
    return '';
  };

  // 한 분기(quarter, 없으면 전부)의 목표들을 나무로 만들고 진척·색을 계산한다.
  // → [ { obj, level, children, krs:[{kr, rate, status, expected, problem}], kr(자기 KR 진척 또는 null), progress, status, expected, period } ] (맨 위 목표들)
  // 상위 목표가 없거나(찾을 수 없음) 수준이 거꾸로(상위가 더 낮은 수준)면 맨 위로 둔다. 수준이 위→아래로만 이어져서 고리(순환)는 생기지 않는다
  function build(items, asOf, quarter) {
    const seen = new Set(), objs = [];
    for (const o of Array.isArray(items) ? items : []) {
      if (objProblem(o) || seen.has(o.id)) continue; // 같은 id 는 앞의 것만
      seen.add(o.id);
      if (!quarter || o.quarter === quarter) objs.push(o);
    }
    const byId = new Map(objs.map((o) => [o.id, o])), kids = new Map(), tops = [];
    for (const o of objs) {
      const p = o.parentId ? byId.get(o.parentId) : null;
      if (p && RANK[p.level] < RANK[o.level]) kids.set(p.id, [...(kids.get(p.id) || []), o]); else tops.push(o);
    }
    const node = (o) => {
      const period = periodOf(o.quarter), exp = elapsed(period.start, period.end, asOf);
      const krs = (Array.isArray(o.krs) ? o.krs : []).map((kr) => {
        const problem = krProblem(kr), rate = problem ? null : krRate(kr);
        const due = isObj(kr) && isDate(kr.due) && kr.due >= period.start ? kr.due : period.end; // 기한이 없거나 분기 앞이면 분기 끝까지
        const e = elapsed(period.start, due, asOf);
        return { kr, rate, problem, expected: e, status: statusOf(rate, e, rate !== null && rate < 1 && isObj(kr) && isDate(kr.due) && kr.due < asOf) };
      });
      const ok = krs.filter((k) => k.rate !== null), wsum = ok.reduce((a, k) => a + weightOf(k.kr), 0);
      const own = ok.length && wsum > 0 ? r6(ok.reduce((a, k) => a + k.rate * weightOf(k.kr), 0) / wsum) : null;
      const children = (kids.get(o.id) || []).map(node);
      const parts = [...(own === null ? [] : [own]), ...children.map((c) => c.progress).filter((x) => x !== null)];
      const progress = parts.length ? r6(mean(parts)) : null;
      return { obj: o, level: o.level, children, krs, kr: own, progress, expected: exp, status: statusOf(progress, exp, false), period };
    };
    return tops.map(node);
  }

  // 새 목표의 상위 목표로 고를 수 있는 것들: 같은 분기에서 더 높은 수준
  const parentChoices = (items, level, quarter) => (Array.isArray(items) ? items : []).filter((o) => !objProblem(o) && o.quarter === quarter && RANK[o.level] < RANK[level]);

  // 화면이 제대로 못 보여 주는 항목(주로 비서가 형식을 어겨 쓴 것). 멈추지 않고 건너뛰되 무엇이 문제인지 알려 준다
  function problems(items) {
    const out = [], list = Array.isArray(items) ? items : [], ids = new Set(), byId = new Map();
    for (const o of list) if (isObj(o) && okId(o.id) && !byId.has(o.id)) byId.set(o.id, o);
    list.forEach((o, i) => {
      const name = isObj(o) && str(o.title).trim() ? `목표 "${str(o.title).slice(0, 30)}"` : `${i + 1}번째 항목`;
      const bad = objProblem(o);
      if (bad) return out.push(`${name}: ${bad}`);
      if (ids.has(o.id)) return out.push(`${name}: id "${o.id}" 가 겹침 (앞의 것만 씀)`);
      ids.add(o.id);
      if (o.parentId) {
        const p = byId.get(o.parentId);
        if (!p) out.push(`${name}: 상위 목표를 찾을 수 없음 (맨 위에 둠)`);
        else if (!(RANK[p.level] < RANK[o.level])) out.push(`${name}: 상위 목표("${str(p.title).slice(0, 20)}")의 수준이 더 높아야 함 (맨 위에 둠)`);
      }
      (o.krs || []).forEach((kr, k) => { const why = krProblem(kr); if (why) out.push(`${name} KR ${k + 1}${isObj(kr) && str(kr.metric).trim() ? ` "${str(kr.metric).slice(0, 20)}"` : ''}: ${why} (계산에서 뺌)`); });
    });
    return out;
  }

  // 데이터에 있는 분기들 + 오늘의 분기, 오래된 것부터
  function quarters(items, asOf) {
    const set = new Set([quarterOf(asOf)]);
    for (const o of Array.isArray(items) ? items : []) if (isObj(o) && periodOf(o.quarter)) set.add(o.quarter);
    return [...set].sort();
  }

  // 숫자를 보기 좋게 (1.8 → "1.8", 4200000 → "4,200,000", 0.1+0.2 → "0.3")
  const fmt = (n) => (isNum(n) ? Number(r6(n)).toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '');
  // 진척 글자는 내림 — 7편 점검: 반올림하면 99.6% 가 "100%" 로 보여, 기한 지난 KR 은 "100%" 인데 "위험"으로 보였다. 100% 는 정말 다 됐을 때만.
  // 0.29×100 = 28.999… 같은 찌꺼기 때문에 아주 작은 수를 더한 뒤 내린다 (-0 은 0)
  const pct = (p) => (p === null || p === undefined ? '-' : `${Math.max(0, Math.floor(p * 100 + 1e-9))}%`);

  const api = { LEVELS, RANK, SLACK, isDate, today, periodOf, quarterOf, quarterLabel, elapsed, krProblem, krRate, startOf, weightOf, statusOf, objProblem, build, parentChoices, problems, quarters, fmt, pct };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.okr = api;
})(typeof window !== 'undefined' ? window : globalThis);
