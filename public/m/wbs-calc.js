// WBS 공정표 계산·검증 — 화면을 그리지 않는 순수 함수만 모았다.
// 브라우저(window.wbs)와 서버(require)가 같은 파일을 쓰고, selftest 가 이 파일을 불러다 숫자로 검사한다.
// 날짜는 "2026-10-06" 모양의 글자이고, 계산할 때는 날 수(1970-01-01 부터 센 날)로 바꿔 쓴다. 기간은 달력일(주말 포함).
(function (root) {
  'use strict';
  const MAX_ITEMS = 1000;
  const LATE_GAP = 10; // 계획 진도보다 실제 진도가 이만큼(%p)을 "넘게" 낮으면 지연
  const CODE = /^[1-9]\d*(\.[1-9]\d*)*$/; // 1, 1.1, 1.1.1

  const str = (v) => String(v ?? '');
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const ymd = (n) => new Date(n * 864e5).toISOString().slice(0, 10); // 날 수 → "2026-10-06"
  const num = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && ymd(num(s)) === s; // 없는 날(2/31)은 틀림
  const addDays = (s, k) => ymd(num(s) + k);
  const today = () => new Date().toLocaleDateString('sv-SE'); // 이 PC 의 오늘
  const r6 = (x) => Math.round(x * 1e6) / 1e6; // 10.000000000000002 같은 부동소수점 찌꺼기를 없애고 비교한다

  // 코드: "1.10" 이 "1.9" 뒤에 오도록 숫자로 비교한다
  const parentOf = (c) => (c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '');
  const cmp = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };

  // ---------- 계산 ----------
  // 작업의 계획 진도(%): 시작 전 0, 완료일 이후 100, 그 사이는 (오늘 − 시작 + 1) ÷ 기간 일수 × 100
  function planPct(start, end, asOf) {
    const s = num(start), e = num(end), t = num(asOf);
    if (t < s) return 0;
    if (t >= e) return 100;
    return ((t - s + 1) / (e - s + 1)) * 100;
  }
  // 상태는 위에서부터 먼저 맞는 것: 완료(100%) → 지연(계획−실제 > 10%p) → 진행(시작했거나 오늘이 기간 안) → 대기
  const statusOf = (actual, plan, start, end, t) => {
    if (r6(actual) >= 100) return '완료';
    if (r6(plan - actual) > LATE_GAP) return '지연';
    if (actual > 0 || (start && num(start) <= t && t <= num(end))) return '진행';
    return '대기';
  };

  // 항목들을 트리로 엮어 상위 항목의 진도·기간을 하위에서 자동으로 구한다 (상위 값은 파일에 저장하지 않는다).
  // 돌려주는 rows 는 화면에 그리는 순서(코드 순서)이고, 형식이 틀린 항목은 건너뛰고 problems 에 이유를 모은다.
  function compute(doc, asOf) {
    doc = isObj(doc) ? doc : {};
    const t = num(asOf), problems = [], byCode = new Map();
    const label = (it) => (isObj(it) ? `${str(it.code)} ${str(it.name)}`.trim() : JSON.stringify(it) ?? str(it)).slice(0, 40);
    for (const it of Array.isArray(doc.items) ? doc.items : []) {
      if (!isObj(it)) problems.push(`항목 모양이 아님: ${label(it)}`);
      else if (typeof it.code !== 'string' || !CODE.test(it.code)) problems.push(`"${label(it)}": 코드가 1, 1.1, 1.1.1 모양이 아님`);
      else if (byCode.has(it.code)) problems.push(`"${label(it)}": 코드가 겹침`);
      else byCode.set(it.code, { it, code: it.code, kids: [], ok: false });
    }
    const roots = [];
    for (const n of [...byCode.values()].sort((a, b) => cmp(a.code, b.code))) { // 위 항목이 먼저 처리된다
      const pc = parentOf(n.code), p = byCode.get(pc);
      if (!pc) { n.ok = true; roots.push(n); }
      else if (p && p.ok) { n.ok = true; p.kids.push(n); }
      else problems.push(`"${label(n.it)}": 위 항목(${pc})이 없어 건너뜀`);
    }

    const share = (list) => { // 같은 부모 아래 형제끼리의 비중 (가중치 합이 0 이면 똑같이 나눔)
      const sum = list.reduce((a, k) => a + k.w, 0);
      list.forEach((k) => { k.share = sum > 0 ? k.w / sum : 1 / list.length; });
    };
    const avg = (list, key) => list.reduce((a, k) => a + k[key] * k.share, 0);
    const fill = (n) => {
      const it = n.it;
      n.w = isNum(it.weight) && it.weight >= 0 ? it.weight : 1;
      if (it.weight !== undefined && n.w !== it.weight) problems.push(`"${label(it)}": 가중치가 0 이상의 숫자가 아님(1 로 계산)`);
      if (!n.kids.length) { // 작업: 입력한 값 그대로
        const ok = isDate(it.start) && isDate(it.end) && it.start <= it.end;
        if (!ok) problems.push(`"${label(it)}": 시작·완료가 YYYY-MM-DD 가 아니거나 완료가 시작보다 빠름`);
        if (it.progress !== undefined && !(isNum(it.progress) && it.progress >= 0 && it.progress <= 100)) problems.push(`"${label(it)}": 진도율이 0~100 숫자가 아님`);
        n.leaf = true; n.start = ok ? it.start : null; n.end = ok ? it.end : null;
        n.actual = isNum(it.progress) ? Math.min(100, Math.max(0, it.progress)) : 0;
        n.plan = ok ? planPct(it.start, it.end, asOf) : 0;
        return;
      }
      n.kids.forEach(fill); share(n.kids); // 대단락: 하위의 가중 평균, 기간은 가장 이른 시작~가장 늦은 완료
      n.actual = avg(n.kids, 'actual'); n.plan = avg(n.kids, 'plan');
      const ss = n.kids.map((k) => k.start).filter(Boolean).sort(), es = n.kids.map((k) => k.end).filter(Boolean).sort();
      n.start = ss[0] || null; n.end = es[es.length - 1] || null;
    };
    roots.forEach(fill); share(roots);
    const overall = { actual: avg(roots, 'actual'), plan: avg(roots, 'plan') };

    const rows = [];
    const emit = (n, depth, eff) => {
      eff *= n.share; // 프로젝트 전체에서 이 항목이 차지하는 비중
      rows.push({ code: n.code, depth, leaf: !!n.leaf, name: str(n.it.name), owner: str(n.it.owner), start: n.start, end: n.end, weight: n.w, share: n.share, eff,
        actual: n.actual, plan: n.plan, status: statusOf(n.actual, n.plan, n.start, n.end, t), it: n.it });
      n.kids.forEach((k) => emit(k, depth + 1, eff));
    };
    roots.forEach((r) => emit(r, 0, 1));

    // EVMS: PV = BAC × 계획 진도, EV = BAC × 실제 진도, SV = EV − PV, SPI = EV ÷ PV, CPI = EV ÷ AC
    const bac = isNum(doc.bac) && doc.bac >= 0 ? doc.bac : null, ac = isNum(doc.ac) && doc.ac >= 0 ? doc.ac : null;
    const pv = bac === null ? null : (bac * overall.plan) / 100, ev = bac === null ? null : (bac * overall.actual) / 100;
    const evms = { bac, ac, pv, ev, sv: bac === null ? null : ev - pv, spi: overall.plan > 0 ? overall.actual / overall.plan : null,
      cpi: ev !== null && ac > 0 ? ev / ac : null, late: rows.filter((r) => r.leaf && r.status === '지연').length };
    const dated = rows.filter((r) => r.leaf && r.start);
    const range = dated.length ? { start: dated.map((r) => r.start).sort()[0], end: dated.map((r) => r.end).sort().pop() } : null;
    return { rows, overall, evms, problems, range };
  }

  // 접힌 대단락 밑의 줄은 뺀다
  const visible = (rows, collapsed) => rows.filter((r) => { for (let p = parentOf(r.code); p; p = parentOf(p)) if (collapsed.has(p)) return false; return true; });

  // ---------- 간트 가로축: 달 단위 ----------
  // 모든 날짜와 오늘을 덮는 범위(첫 달 1일 ~ 끝 달 말일). 앞뒤에 여유를 둔다
  function span(range, asOf) {
    const t = num(asOf), a = range ? Math.min(num(range.start) - 7, t) : t - 30, b = range ? Math.max(num(range.end) + 14, t) : t + 150;
    const d0 = new Date(a * 864e5), d1 = new Date(b * 864e5);
    return { from: ymd(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1) / 864e5), to: ymd(Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, 0) / 864e5) };
  }
  function months(from, to) { // [{label, days}] — 첫 달과 1월에는 연도를 붙인다
    const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7) - 1;
    while (Date.UTC(y, m, 1) / 864e5 <= num(to)) {
      out.push({ label: m === 0 || !out.length ? `${y}.${String(m + 1).padStart(2, '0')}` : `${m + 1}월`, days: new Date(Date.UTC(y, m + 1, 0)).getUTCDate() });
      if (++m > 11) { m = 0; y++; }
    }
    return out;
  }
  const x = (day, from, dayW) => (num(day) - num(from)) * dayW; // 그 날의 왼쪽 끝(px)
  const px = (start, end, from, dayW) => ({ left: x(start, from, dayW), width: (num(end) - num(start) + 1) * dayW });

  // ---------- S-곡선 ----------
  // 계획 누적 진도: 날짜마다 (모든 작업의 전체 비중 × 그 날의 작업 계획 진도) 의 합. 긴 기간은 점이 160개 안팎이 되게 건너뛰며 잡는다
  function scurve(rows, from, to) {
    const leaves = rows.filter((r) => r.leaf && r.start), n0 = num(from), n1 = num(to);
    if (n1 < n0) return [];
    const step = Math.max(1, Math.ceil((n1 - n0 + 1) / 160)), out = [];
    for (let n = n0; ; n += step) {
      const nn = Math.min(n, n1), d = ymd(nn);
      out.push({ d, v: leaves.reduce((a, r) => a + r.eff * planPct(r.start, r.end, d), 0) });
      if (nn === n1) return out;
    }
  }
  // 실제 누적 진도: 저장할 때마다 쌓인 기록(actualLog)에서 오늘까지만. 오늘 값은 지금 계산한 값으로 덮는다. 기록이 없는 날은 만들어 내지 않는다
  function actualPoints(log, asOf, nowActual) {
    const m = new Map(Object.entries(isObj(log) ? log : {}).filter(([d, v]) => isDate(d) && d <= asOf && isNum(v)));
    m.set(asOf, nowActual);
    return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => ({ d, v }));
  }

  // 예시 데이터용(진짜 기록이 아님): 지금의 진도율이 각 작업 기간 동안 일정한 속도로 쌓여 왔다고 보고, 일주일마다의 "실제 누적 진도"를 거꾸로 만든다.
  // 진짜 기록은 저장할 때마다 actualLog 에 하루 한 점씩 쌓이는 것뿐이라 과거는 되살릴 수 없다 — 예시 공정표의 S-곡선이 점 하나로 보이지 않게 하려는 용도
  function sampleLog(doc, asOf, step = 7) {
    const items = Array.isArray(doc.items) ? doc.items : [], starts = items.map((it) => it && it.start).filter(isDate).sort(), log = {};
    if (!starts.length) return log;
    for (let d = starts[0]; d < asOf; d = addDays(d, step)) {
      const scaled = items.map((it) => {
        if (!isObj(it) || !isDate(it.start) || !isDate(it.end) || !isNum(it.progress)) return it;
        const e = Math.min(num(it.end), num(asOf)), f = d < it.start ? 0 : Math.min(1, (num(d) - num(it.start) + 1) / Math.max(1, e - num(it.start) + 1));
        return { ...it, progress: it.progress * f };
      });
      log[d] = Math.round(compute({ items: scaled }, d).overall.actual * 100) / 100;
    }
    return log;
  }

  // ---------- 엑셀(CSV): UTF-8 BOM(한글이 안 깨짐) + 줄바꿈 CRLF ----------
  // 글자 칸이 = + - @ 로 시작하면 엑셀이 수식으로 읽을 수 있어서 앞에 ' 를 붙인다. 코드(1.10 이 1.1 로 바뀌는 것 방지)는 우리가 만든 모양이라 ="1.10" 으로 쓴다
  const csvCell = (v, isText) => {
    let s = str(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function csv(rows) {
    const r1 = (x) => Math.round(x * 10) / 10;
    const head = ['코드', '단계', '작업명', '담당', '시작일', '완료일', '가중치', '진도율(%)', '계획 진도(%)', '상태', '메모'].map((h) => csvCell(h));
    const body = rows.map((r) => [r.code.includes('.') ? `="${r.code}"` : r.code, r.leaf ? '작업' : '대단락', csvCell(r.name, true), csvCell(r.owner, true), csvCell(r.start), csvCell(r.end),
      csvCell(r.weight), csvCell(r1(r.actual)), csvCell(r1(r.plan)), r.status, csvCell(r.it.memo, true)].join(','));
    return '﻿' + [head.join(','), ...body].join('\r\n') + '\r\n';
  }

  // ---------- 검증·정리 (서버가 저장 전에 한다) ----------
  function validate(doc) {
    if (!isObj(doc) || !Array.isArray(doc.items)) return '저장할 내용이 올바르지 않습니다. (items 목록이 필요해요)';
    if (doc.items.length > MAX_ITEMS) return `항목은 ${MAX_ITEMS}개까지 넣을 수 있어요.`;
    if (doc.bac != null && !(isNum(doc.bac) && doc.bac >= 0)) return '계약금액(BAC)은 0 이상의 숫자여야 해요.';
    if (doc.ac != null && !(isNum(doc.ac) && doc.ac >= 0)) return '실제 비용(AC)은 0 이상의 숫자여야 해요.';
    if (doc.actualLog != null) {
      const e = isObj(doc.actualLog) ? Object.entries(doc.actualLog) : null;
      if (!e || e.length > 4000 || e.some(([d, v]) => !isDate(d) || !isNum(v) || v < 0 || v > 100)) return 'actualLog 는 {날짜: 0~100 숫자} 모양이어야 해요.';
    }
    const codes = new Set();
    for (const it of doc.items) {
      if (!isObj(it)) return '항목 모양이 올바르지 않습니다.';
      if (typeof it.code !== 'string' || !CODE.test(it.code)) return `코드 "${str(it.code)}" 는 1, 1.1, 1.1.1 모양이어야 해요.`;
      if (codes.has(it.code)) return `코드 ${it.code} 가 겹쳐요.`;
      codes.add(it.code);
    }
    const parents = new Set(doc.items.map((it) => parentOf(it.code)));
    for (const it of doc.items) {
      const c = it.code, pc = parentOf(c);
      if (pc && !codes.has(pc)) return `${c} 의 위 항목(${pc})이 없어요.`;
      if (typeof it.name !== 'string' || !it.name.trim() || it.name.length > 200) return `${c}: 작업명은 1~200자여야 해요.`;
      if (it.owner !== undefined && (typeof it.owner !== 'string' || it.owner.length > 200)) return `${c}: 담당은 200자 이하 글자여야 해요.`;
      if (it.memo !== undefined && (typeof it.memo !== 'string' || it.memo.length > 2000)) return `${c}: 메모는 2000자 이하 글자여야 해요.`;
      if (it.weight !== undefined && !(isNum(it.weight) && it.weight >= 0 && it.weight <= 1e6)) return `${c}: 가중치는 0 이상의 숫자여야 해요.`;
      if (!parents.has(c)) { // 맨 아래 항목(작업)만 날짜·진도를 직접 가진다
        if (!isDate(it.start) || !isDate(it.end)) return `${c}: 시작일·완료일을 YYYY-MM-DD 로 적어 주세요.`;
        if (it.end < it.start) return `${c}: 완료일이 시작일보다 빨라요.`;
        if (it.progress !== undefined && !(isNum(it.progress) && it.progress >= 0 && it.progress <= 100)) return `${c}: 진도율은 0~100 숫자여야 해요.`;
      }
    }
    return '';
  }
  // 저장할 모양으로 정리: 코드 순서·단계(자식 있으면 대단락)·상위 항목의 날짜/진도 제거·오늘의 실제 진도 기록(S-곡선 재료)
  function normalize(doc, asOf) {
    const parents = new Set(doc.items.map((it) => parentOf(it.code)));
    const items = [...doc.items].sort((a, b) => cmp(a.code, b.code)).map((it) => {
      const { code, type, name, owner, start, end, weight, progress, memo, ...rest } = it;
      const par = parents.has(code);
      return { code, type: par ? '대단락' : '작업', name: name.trim(), owner: owner ?? '', ...(par ? {} : { start, end }), weight: weight ?? 1, ...(par ? {} : { progress: progress ?? 0 }), memo: memo ?? '', ...rest };
    });
    const out = { ...doc, bac: doc.bac ?? null, ac: doc.ac ?? null, items, actualLog: { ...(doc.actualLog || {}) } };
    out.actualLog[asOf] = Math.round(compute(out, asOf).overall.actual * 100) / 100;
    return out;
  }
  const emptyDoc = () => ({ bac: null, ac: null, items: [], actualLog: {} });

  // ---------- 고치기 (화면이 부른다. 모두 새 목록을 돌려주고 원래 것은 안 바꾼다) ----------
  // 코드는 항상 1 부터 빈틈없이 다시 매긴다(순서가 곧 코드). map 은 옛 코드 → 새 코드
  const nest = (items) => {
    const by = new Map(), roots = [];
    [...items].sort((a, b) => cmp(a.code, b.code)).forEach((it) => { const n = { it: { ...it }, kids: [] }; by.set(it.code, n); (by.get(parentOf(it.code)) || { kids: roots }).kids.push(n); });
    return { roots, by };
  };
  const siblings = (tree, n) => (tree.by.get(parentOf(n.it.code)) || { kids: tree.roots }).kids;
  function flat(roots) {
    const out = [], map = {};
    const go = (list, prefix) => list.forEach((n, i) => { const code = prefix + (i + 1); if (n.it.code) map[n.it.code] = code; n.newCode = code; out.push({ ...n.it, code }); go(n.kids, code + '.'); });
    go(roots, '');
    return { items: out, map };
  }
  const fresh = (asOf) => ({ it: { code: '', type: '작업', name: '새 작업', owner: '', start: asOf, end: addDays(asOf, 6), weight: 1, progress: 0, memo: '' }, kids: [] });
  function edit(items, fn) { // fn(tree) 이 트리를 고치고 눈여겨볼 노드를 돌려준다. false 면 할 일이 없음
    const bad = validate({ items });
    if (bad) return { error: `먼저 형식 오류를 고쳐 주세요: ${bad}` };
    const tree = nest(items), node = fn(tree);
    if (node === false) return { items, map: {}, noop: true };
    const f = flat(tree.roots);
    return { ...f, focus: node ? node.newCode : undefined };
  }
  const addRoot = (items, asOf) => edit(items, (t) => { const f = fresh(asOf); t.roots.push(f); return f; });
  const addBelow = (items, code, asOf) => edit(items, (t) => { const n = t.by.get(code); if (!n) return false; const f = fresh(asOf), l = siblings(t, n); l.splice(l.indexOf(n) + 1, 0, f); return f; });
  const addChild = (items, code, asOf) => edit(items, (t) => { // 작업에 하위를 달면 그 작업의 기간·진도는 새 하위가 이어받아 값이 사라지지 않는다
    const n = t.by.get(code); if (!n) return false;
    const f = fresh(asOf);
    if (!n.kids.length && isDate(n.it.start) && isDate(n.it.end)) Object.assign(f.it, { start: n.it.start, end: n.it.end, progress: n.it.progress ?? 0 });
    n.kids.push(f); return f;
  });
  const remove = (items, code) => edit(items, (t) => { const n = t.by.get(code); if (!n) return false; const l = siblings(t, n); l.splice(l.indexOf(n), 1); return null; });
  const move = (items, code, dir) => edit(items, (t) => { // dir: -1 위로, +1 아래로 (같은 부모 안에서만)
    const n = t.by.get(code); if (!n) return false;
    const l = siblings(t, n), i = l.indexOf(n), j = i + dir;
    if (j < 0 || j >= l.length) return false;
    [l[i], l[j]] = [l[j], l[i]]; return n;
  });
  const countSubtree = (items, code) => items.filter((it) => it && typeof it.code === 'string' && (it.code === code || it.code.startsWith(code + '.'))).length;

  const isLeaf = (items, code) => !items.some((x) => x && typeof x.code === 'string' && parentOf(x.code) === code);
  // 표의 칸을 고칠 때: 틀리면 { error: 쉬운 말 }, 되면 { items }
  function setField(items, code, field, raw) {
    const i = items.findIndex((it) => it && it.code === code);
    if (i < 0) return { error: '그 항목을 찾을 수 없어요.' };
    const it = { ...items[i] }, v = str(raw).trim();
    const leafOnly = () => (isLeaf(items, code) ? '' : '대단락의 시작·완료·진도율은 하위 항목에서 자동으로 계산돼요.');
    if (field === 'name') { if (!v || v.length > 200) return { error: '작업명은 1~200자로 적어 주세요.' }; it.name = v; }
    else if (field === 'owner') { if (v.length > 200) return { error: '담당은 200자까지예요.' }; it.owner = v; }
    else if (field === 'weight') { const n = Number(v); if (v === '' || !Number.isFinite(n) || n < 0 || n > 1e6) return { error: '가중치는 0 이상의 숫자예요.' }; it.weight = n; }
    else if (field === 'progress') {
      if (leafOnly()) return { error: leafOnly() };
      const n = Number(v); if (v === '' || !Number.isFinite(n) || n < 0 || n > 100) return { error: '진도율은 0~100 사이 숫자예요.' };
      it.progress = n;
    } else if (field === 'start' || field === 'end') {
      if (leafOnly()) return { error: leafOnly() };
      if (!isDate(v)) return { error: '날짜를 YYYY-MM-DD 모양으로 적어 주세요.' };
      it[field] = v;
      if (isDate(it.start) && isDate(it.end) && it.end < it.start) return { error: '완료일이 시작일보다 빨라요.' };
    } else return { error: '고칠 수 없는 칸이에요.' };
    return { items: items.map((x, k) => (k === i ? it : x)) };
  }
  // 간트 막대를 끌 때: 시작일에 ds 일, 완료일에 de 일을 더한다 (이동은 ds = de, 늘리기는 ds = 0)
  function shiftTask(items, code, ds, de) {
    const i = items.findIndex((it) => it && it.code === code), it = items[i];
    if (!it || !isLeaf(items, code) || !isDate(it.start) || !isDate(it.end)) return { error: '이 항목은 끌어서 바꿀 수 없어요.' };
    const start = addDays(it.start, ds), end = addDays(it.end, de);
    if (end < start) return { error: '완료일이 시작일보다 빨라질 수 없어요.' };
    return { items: items.map((x, k) => (k === i ? { ...it, start, end } : x)) };
  }
  // 금액 입력: "1200000000", "1,200,000,000원", "12억", "3000만", "12억 3000만" → 원. 빈 칸은 null
  function parseMoney(raw) {
    const s = str(raw).replace(/[,\s원]/g, '');
    if (s === '') return { value: null };
    const m = /^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)만)?(\d+)?$/.exec(s);
    if (!m || !(m[1] || m[2] || m[3])) return { error: '금액은 숫자로 적어 주세요. (예: 1200000000, 12억, 3000만)' };
    return { value: Math.round(Number(m[1] || 0) * 1e8 + Number(m[2] || 0) * 1e4 + Number(m[3] || 0)) };
  }

  const api = { MAX_ITEMS, CODE, num, ymd, isDate, addDays, today, parentOf, cmp, planPct, compute, visible, span, months, x, px, scurve, actualPoints, sampleLog, csv,
    validate, normalize, emptyDoc, addRoot, addBelow, addChild, remove, move, countSubtree, setField, shiftTask, parseMoney };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.wbs = api;
})(typeof window !== 'undefined' ? window : globalThis);
