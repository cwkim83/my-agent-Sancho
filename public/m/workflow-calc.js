// 워크플로 계산 — 화면을 그리지 않고 파일·네트워크도 건드리지 않는 순수 함수만 모았다.
// 브라우저(window.wf)와 서버(workflow.js·server.js)·selftest 가 같은 파일을 쓴다 (노드 규칙이 두 군데 생기지 않게).
//
// 워크플로 하나 = data/db/workflows.json 의 항목 하나 (화면은 /api/workflows 로만 읽고 쓴다):
//   { id, name, enabled(자동 실행 켬), owner(만든 관리자 아이디), nodes: [...], edges: [...], triggerRuns: { 노드id: 마지막으로 시계가 돌린 시각 }(서버가 관리), createdAt, updatedAt }
//   노드 = { id, type, name(워크플로 안에서 하나뿐인 이름 — {{steps.이름}} 으로 부른다), x, y, params: { … } }     선 = { from: 노드id, to: 노드id, branch?: 'true' | 'false'(조건 나누기에서 나갈 때만) }
// 값 넣기: {{today}} 오늘(2026-10-07) · {{now}} · {{weekday}} · {{workflow}} · {{steps.이름}} 앞 단계 결과 · {{steps.이름.count}} 처럼 점으로 안쪽 값 · (담당자별 알림에서만) {{owner}} {{count}} {{lines}}
(function (root) {
  const LIMITS = { nodes: 40, edges: 80, name: 40, nodeName: 30, text: 4000, wait: 120 };
  const OPS = [['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['eq', '같다'], ['ne', '다르다'], ['contains', '포함'], ['notcontains', '포함 안 함'], ['empty', '비어 있다'], ['notempty', '비어 있지 않다']];
  const FILTER_OPS = [['', '(조건 없음)'], ['eq', '같다'], ['ne', '다르다'], ['contains', '포함'], ['gt', '>'], ['lt', '<'], ['ge', '≥'], ['le', '≤']];
  const SOURCES = [['wbs-delayed', 'WBS 지연 작업'], ['tasks', '할 일'], ['events', '일정'], ['projects', '프로젝트'], ['meetings', '회의'], ['notices', '알림'], ['okrs', '목표(OKR)']]; // 읽을 수 있는 것: 이 밖의 자료(결재·공수·메신저 …)는 못 읽는다
  const WRITABLE = [['tasks', '할 일'], ['events', '일정'], ['projects', '프로젝트']]; // 쓸 수 있는 것 (지우기는 없다)
  const text = (key, label, def = '', o = {}) => ({ key, label, kind: 'text', def, ...o });
  const area = (key, label, def = '', o = {}) => ({ key, label, kind: 'area', def, ...o });
  const select = (key, label, options, def) => ({ key, label, kind: 'select', options, def: def === undefined ? options[0][0] : def });
  const TYPES = {
    manual: { label: '수동 시작', icon: '▶', group: '시작', trigger: true, params: [], help: '▶ 실행을 누르면 여기서 시작해요.' },
    daily: { label: '매일 시각', icon: '⏰', group: '시작', trigger: true, params: [{ key: 'time', label: '시각', kind: 'time', def: '08:00' }], help: '켜 두면(자동 실행 켬) 매일 이 시각에 시계가 돌려요.' },
    every: { label: 'N분마다', icon: '🔁', group: '시작', trigger: true, params: [{ key: 'minutes', label: '몇 분마다', kind: 'number', min: 1, max: 1440, def: 30 }], help: '켜 두면 이 간격마다 시계가 돌려요.' },
    ask: { label: '비서에게 시키기', icon: '🤖', group: '일하기', params: [area('prompt', '시킬 말', '', { rows: 5 })], help: '예약처럼 보는 사람 없이 비서가 일해요. 결과 글은 {{steps.이름}}.' },
    read: { label: '데이터 읽기', icon: '📥', group: '일하기', params: [select('source', '무엇을', SOURCES), text('field', '걸러낼 칸(선택)', '', { ph: '예: status, owner' }), select('op', '조건', FILTER_OPS), text('value', '값', ''), { key: 'limit', label: '최대 개수', kind: 'number', min: 1, max: 200, def: 50 }],
      help: '결과: {{steps.이름}}(읽기 좋은 글) · {{steps.이름.count}}(개수).' },
    write: { label: '데이터 쓰기', icon: '📤', group: '일하기', params: [select('collection', '어디에', WRITABLE), select('mode', '방법', [['add', '새로 추가'], ['update', 'id 로 찾아 고침']]), text('id', '고칠 항목 id (고침일 때)', ''), area('fields', '넣을 칸 (JSON)', '{"title": "", "due": "{{today}}", "status": "할 일"}', { rows: 4 })],
      help: '추가·고치기만 해요 (지우지 않아요).' },
    if: { label: '조건 나누기', icon: '🔀', group: '흐름', branches: ['true', 'false'], params: [text('left', '왼쪽 값', '{{steps.이름.count}}'), select('op', '비교', OPS), text('right', '오른쪽 값', '0')], help: '참이면 위쪽(참) 선, 아니면 아래쪽(거짓) 선으로 가요. 선이 없는 쪽은 그냥 끝나요.' },
    http: { label: '웹 호출', icon: '🌐', group: '일하기', params: [select('method', '방식', [['GET', 'GET (가져오기)'], ['POST', 'POST (보내기)']]), text('url', '주소', 'https://'), area('body', '보낼 내용 (POST 일 때)', '', { rows: 3 })],
      help: '⚠ 이 PC 밖으로 나가는 호출이에요. 이 PC 안·사내망 주소는 막혀 있어요. 결과: {{steps.이름.text}} · {{steps.이름.status}}.' },
    notice: { label: '알림', icon: '🔔', group: '일하기', params: [select('via', '어디로', [['bell', '🔔 알림'], ['messenger', '💬 메신저']]), select('to', '누구에게', [['me', '나(만든 관리자)'], ['owners', '담당자별 (앞 단계 목록의 owner)'], ['user', '특정 사람(아이디)']]), text('user', '아이디 (특정 사람일 때)', ''), { key: 'list', label: '담당자를 읽을 앞 단계', kind: 'step', def: '' }, text('title', '제목', '워크플로 알림'), area('text', '내용', '', { rows: 4 })],
      help: '담당자별이면 사람마다 {{owner}} · {{count}} · {{lines}}(그 사람 몫의 목록)를 쓸 수 있어요. 사용자 목록에 없는 담당자 몫은 나에게 🔔 로 와요.' },
    telegram: { label: '텔레그램', icon: '✈️', group: '일하기', params: [area('text', '보낼 글', '', { rows: 4 })], help: '⚠ 텔레그램 서버를 거쳐 이 PC 밖으로 나가요. 설정에서 봇을 연결해야 해요.' },
    wait: { label: '기다리기', icon: '⏳', group: '흐름', params: [{ key: 'seconds', label: '몇 초', kind: 'number', min: 0, max: LIMITS.wait, def: 5 }], help: `최대 ${LIMITS.wait}초까지 기다려요.` },
    set: { label: '값 만들기', icon: '🧮', group: '흐름', params: [area('fields', '값들 (JSON)', '{"이름": "값 {{today}}"}', { rows: 4 })], help: '여기서 만든 값은 {{steps.이름.키}} 로 불러요.' },
  };
  const TYPE_ORDER = ['manual', 'daily', 'every', 'ask', 'read', 'write', 'if', 'http', 'notice', 'telegram', 'wait', 'set'];
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
  const NODE_ID = /^[A-Za-z0-9_-]{1,16}$/, NODE_NAME = /^[0-9A-Za-z가-힣 _()-]{1,30}$/, HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WEEK = '일월화수목금토';

  // ---- 값 넣기 ({{…}}) ----
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function pick(v, segs) { // 점 경로로 안쪽 값 찾기 (객체의 자기 칸만, 배열은 번호)
    for (const s of segs) {
      if (v === null || v === undefined) return undefined;
      if (Array.isArray(v)) v = /^\d+$/.test(s) ? v[Number(s)] : undefined;
      else if (isObj(v) && hasOwn(v, s)) v = v[s]; else return undefined;
    }
    return v;
  }
  function str(v) { // 글로: 글·숫자는 그대로, { text } 가 있는 결과는 그 글, 나머지는 한 줄 JSON
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (isObj(v) && typeof v.text === 'string') return v.text;
    try { return JSON.stringify(v).slice(0, LIMITS.text); } catch { return ''; }
  }
  // scope: { steps: { 이름: 결과 }, names: [모든 노드 이름], today, now, weekday, workflow, vars: { owner, count, lines } }
  function lookup(expr, scope) {
    if (expr.startsWith('steps.')) {
      const rest = expr.slice(6), names = (scope.names || Object.keys(scope.steps || {})).filter((n) => rest === n || rest.startsWith(`${n}.`)).sort((a, b) => b.length - a.length);
      if (!names.length) throw new Error(`{{${expr}}} 의 이름을 찾지 못했어요. 노드 이름이 맞는지 확인해 주세요.`);
      const name = names[0], v = hasOwn(scope.steps || {}, name) ? scope.steps[name] : undefined;
      return rest === name ? v : pick(v, rest.slice(name.length + 1).split('.'));
    }
    if (['today', 'now', 'weekday', 'workflow'].includes(expr)) return scope[expr];
    if (scope.vars && hasOwn(scope.vars, expr)) return scope.vars[expr];
    throw new Error(`{{${expr}}} 는 알 수 없는 값이에요. (today · now · weekday · workflow · steps.이름 중에서)`);
  }
  const render = (tpl, scope) => String(tpl ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expr) => str(lookup(expr.trim(), scope)));
  const refsOf = (tpl) => [...String(tpl ?? '').matchAll(/\{\{\s*steps\.([^{}]+?)\s*\}\}/g)].map((m) => m[1].trim());

  // ---- 비교 (조건 나누기·걸러내기) ----
  const num = (s) => { const t = String(s ?? '').trim(); return t !== '' && Number.isFinite(Number(t)) ? Number(t) : null; };
  function compare(op, l, r) { // 숫자면 숫자끼리, 아니면 글(날짜 2026-10-07 같은 글은 앞뒤로 비교돼요)
    l = String(l ?? '').trim(); r = String(r ?? '').trim();
    if (op === 'empty') return l === '';
    if (op === 'notempty') return l !== '';
    if (op === 'contains') return l.includes(r);
    if (op === 'notcontains') return !l.includes(r);
    const a = num(l), b = num(r), x = a !== null && b !== null ? a : l, y = a !== null && b !== null ? b : r;
    if (op === 'eq') return x === y; if (op === 'ne') return x !== y;
    if (op === 'gt') return x > y; if (op === 'ge') return x >= y; if (op === 'lt') return x < y; if (op === 'le') return x <= y;
    throw new Error(`알 수 없는 비교(${op}) 예요.`);
  }
  const itemLine = (it) => (!isObj(it) ? String(it) : typeof it.line === 'string' && it.line ? it.line : str(it.title ?? it.name ?? it) || '(내용 없음)');

  // ---- 검사·정리: 화면에서 온 것도, 비서가 쓴 것도, 파일에서 읽은 것도 이 함수를 거친다 ----
  function cleanParams(type, p) {
    const T = TYPES[type], src = isObj(p) ? p : {}, out = {};
    for (const f of T.params) {
      let v = src[f.key];
      if (f.kind === 'select') v = f.options.some((o) => o[0] === v) ? v : f.def;
      else if (f.kind === 'number') { v = Number(v); v = Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, Math.round(v))) : f.def; }
      else if (f.kind === 'time') v = HHMM.test(String(v)) ? String(v) : f.def;
      else v = clip(v === undefined || v === null ? f.def : v, LIMITS.text);
      out[f.key] = v;
    }
    return out;
  }
  function normalize(w) { // → { wf, errors(저장을 막는 문제), warns(알려 주기만) }
    const errors = [], warns = [];
    if (!isObj(w)) return { wf: null, errors: ['워크플로가 { … } 모양이 아니에요.'], warns };
    const nodes = [], by = new Map(), names = new Set();
    const rawNodes = Array.isArray(w.nodes) ? w.nodes : [];
    if (!Array.isArray(w.nodes)) errors.push('nodes 가 목록이 아니에요.');
    if (rawNodes.length > LIMITS.nodes) errors.push(`노드는 ${LIMITS.nodes}개까지예요.`);
    for (const n of rawNodes.slice(0, LIMITS.nodes)) {
      if (!isObj(n)) { errors.push('노드 하나가 { … } 모양이 아니에요.'); continue; }
      const id = String(n.id ?? '');
      if (!NODE_ID.test(id) || by.has(id)) { errors.push(`노드 id "${clip(id, 20)}" 이(가) 비었거나 겹치거나 모양이 틀려요. (영문·숫자·-·_ 16자까지, 노드마다 달라야 해요)`); continue; }
      if (!hasOwn(TYPES, n.type)) { errors.push(`노드 "${id}" 의 type "${clip(n.type, 20)}" 을(를) 몰라요. (${TYPE_ORDER.join(' · ')} 중에서)`); continue; }
      const name = clip(n.name, LIMITS.nodeName).trim() || TYPES[n.type].label;
      if (!NODE_NAME.test(name)) { errors.push(`노드 이름 "${name}" 에는 한글·영문·숫자·공백·_·-·() 만 쓸 수 있어요. ({ } . 같은 기호는 안 돼요)`); continue; }
      if (names.has(name.toLowerCase())) { errors.push(`노드 이름 "${name}" 이(가) 겹쳐요. 이름은 서로 달라야 앞 단계 결과를 부를 수 있어요.`); continue; }
      names.add(name.toLowerCase());
      const node = { id, type: n.type, name, x: Number.isFinite(Number(n.x)) && n.x !== null && n.x !== '' ? Math.round(Math.min(5000, Math.max(-500, Number(n.x)))) : NaN, y: Number.isFinite(Number(n.y)) && n.y !== null && n.y !== '' ? Math.round(Math.min(5000, Math.max(-500, Number(n.y)))) : NaN, params: cleanParams(n.type, n.params) };
      by.set(id, node); nodes.push(node);
    }
    const edges = [], seen = new Set(), rawEdges = Array.isArray(w.edges) ? w.edges : [];
    if (!Array.isArray(w.edges)) errors.push('edges 가 목록이 아니에요.');
    if (rawEdges.length > LIMITS.edges) errors.push(`선은 ${LIMITS.edges}개까지예요.`);
    for (const e of rawEdges.slice(0, LIMITS.edges)) {
      if (!isObj(e)) { errors.push('선 하나가 { … } 모양이 아니에요.'); continue; }
      const a = by.get(String(e.from)), b = by.get(String(e.to));
      if (!a || !b) { errors.push(`선 ${clip(e.from, 16)} → ${clip(e.to, 16)} 의 노드를 찾지 못했어요.`); continue; }
      if (a === b) { errors.push(`"${a.name}" 에서 자기 자신으로 가는 선은 안 돼요.`); continue; }
      if (TYPES[b.type].trigger) { errors.push(`시작 노드 "${b.name}" 으로 들어오는 선은 안 돼요.`); continue; }
      let branch = null;
      if (TYPES[a.type].branches) {
        branch = String(e.branch);
        if (!TYPES[a.type].branches.includes(branch)) { errors.push(`조건 나누기 "${a.name}" 에서 나가는 선은 branch 를 "true"(참) 나 "false"(거짓) 로 정해야 해요.`); continue; }
      }
      const key = `${a.id}>${b.id}>${branch}`; if (seen.has(key)) continue; seen.add(key);
      edges.push(branch ? { from: a.id, to: b.id, branch } : { from: a.id, to: b.id });
    }
    if (!nodes.some((n) => TYPES[n.type].trigger)) errors.push('시작 노드(수동 시작·매일 시각·N분마다)가 하나는 있어야 해요.');
    if (hasCycle(nodes, edges)) errors.push('선이 빙 돌아 제자리로 와요. 앞으로만 가게 이어 주세요. (되풀이는 지원하지 않아요)');
    const nameSet = nodes.map((n) => n.name), reach = reachable(nodes, edges);
    for (const n of nodes) {
      for (const f of TYPES[n.type].params) if (typeof n.params[f.key] === 'string') for (const r of refsOf(n.params[f.key])) {
        if (!nameSet.some((nm) => r === nm || r.startsWith(`${nm}.`))) warns.push(`"${n.name}": {{steps.${r}}} 와 같은 이름의 노드가 없어요.`);
      }
      if (!reach.has(n.id)) warns.push(`"${n.name}" 은(는) 시작 노드에서 이어지지 않아서 실행되지 않아요.`);
    }
    if (nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) autoLayout(nodes, edges);
    const wf = { id: typeof w.id === 'string' ? w.id : '', name: clip(w.name, LIMITS.name).trim() || '이름 없는 워크플로', enabled: w.enabled === true, nodes, edges };
    return { wf, errors, warns };
  }
  function hasCycle(nodes, edges) { // 빙 도는 선이 있는가
    const next = new Map(nodes.map((n) => [n.id, []])); for (const e of edges) next.get(e.from).push(e.to);
    const state = new Map();
    const visit = (id) => { if (state.get(id) === 1) return true; if (state.get(id) === 2) return false; state.set(id, 1); for (const t of next.get(id)) if (visit(t)) return true; state.set(id, 2); return false; };
    return nodes.some((n) => visit(n.id));
  }
  function reachable(nodes, edges, start) { // 시작 노드(들)에서 선을 따라 갈 수 있는 노드 id 들
    const next = new Map(nodes.map((n) => [n.id, []])); for (const e of edges) next.get(e.from) && next.get(e.from).push(e.to);
    const seen = new Set(), stack = start ? [start] : nodes.filter((n) => TYPES[n.type].trigger).map((n) => n.id);
    while (stack.length) { const id = stack.pop(); if (seen.has(id)) continue; seen.add(id); stack.push(...(next.get(id) || [])); }
    return seen;
  }
  function autoLayout(nodes, edges) { // 왼쪽 → 오른쪽: 앞에서 오는 가장 긴 길이를 칸으로
    const depth = new Map(nodes.map((n) => [n.id, 0])), by = new Map(nodes.map((n) => [n.id, n]));
    for (let i = 0; i < nodes.length; i++) for (const e of edges) depth.set(e.to, Math.max(depth.get(e.to), depth.get(e.from) + 1));
    const row = new Map();
    for (const n of nodes) { const d = depth.get(n.id), r = row.get(d) || 0; row.set(d, r + 1); if (!Number.isFinite(n.x)) n.x = 40 + d * 220; if (!Number.isFinite(n.y)) n.y = 40 + r * 120; }
    return by;
  }
  function describe(n) { // 노드 상자에 보이는 한 줄 설명
    const p = n.params || {}, T = TYPES[n.type], lab = (list, v) => (list.find((o) => o[0] === v) || [v, v])[1], c = (s, k) => clip(String(s).replace(/\s+/g, ' '), k);
    switch (n.type) {
      case 'daily': return `매일 ${p.time}`;
      case 'every': return `${p.minutes}분마다`;
      case 'ask': return c(p.prompt, 40) || '(시킬 말 없음)';
      case 'read': return `${lab(SOURCES, p.source)}${p.field && p.op ? ` · ${p.field} ${lab(FILTER_OPS, p.op)} ${c(p.value, 12)}` : ''}`;
      case 'write': return `${lab(WRITABLE, p.collection)} ${p.mode === 'add' ? '추가' : '고침'}`;
      case 'if': return c(`${p.left} ${lab(OPS, p.op)} ${['empty', 'notempty'].includes(p.op) ? '' : p.right}`, 40);
      case 'http': return `${p.method} ${c(p.url, 34)}`;
      case 'notice': return `${p.via === 'messenger' ? '💬' : '🔔'} → ${p.to === 'owners' ? '담당자별' : p.to === 'user' ? p.user || '?' : '나'}`;
      case 'telegram': return c(p.text, 40) || '(보낼 글 없음)';
      case 'wait': return `${p.seconds}초`;
      case 'set': return c(p.fields, 40);
      default: return T.help ? '' : '';
    }
  }
  const schedOf = (n) => (n.type === 'daily' ? { 종류: 'daily', 시각: n.params.time } : n.type === 'every' ? { 종류: 'every', 분: n.params.minutes } : null); // 4편 시계(scheduler.js)가 아는 모양

  const api = { LIMITS, TYPES, TYPE_ORDER, OPS, FILTER_OPS, SOURCES, WRITABLE, WEEK, ymd, pad, str, pick, render, refsOf, compare, itemLine, normalize, hasCycle, reachable, autoLayout, describe, schedOf, isObj, clip, cleanParams };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.wf = api;
})(typeof window !== 'undefined' ? window : globalThis);
