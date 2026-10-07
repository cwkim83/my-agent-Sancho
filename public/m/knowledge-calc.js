// 지식노트 계산 — 화면을 그리지 않는 순수 함수만 모았다. 브라우저(window.kn)와 selftest(require)가 같은 파일을 쓴다.
//
//   점(node)  = { id: '종류:값', type, title, facts: [짧은 글], text(미리보기 본문), body(다른 점의 언급을 찾는 글, 이름 정리됨), key(다른 점이 이 점을 부르는 이름, 정리됨), ref(열기에 쓸 값), hub(뇌 그래프의 칸 점), deg(이어진 선 수), x, y, vx, vy }
//   선(edge)  = { a: 점 id, b: 점 id, kind: 'ref'(자료가 직접 가리킴: 할 일→프로젝트 …) | 'mention'(글에서 이름이 나옴) | 'own'(뇌 그래프에서 칸에 속함) }
//   kn.buildMap({ projects, tasks, meetings, approvals, wiki: [{name, text}], people: [{name, dept}] }) → { nodes, edges, types, omitted }   (지식 지도: 프로젝트·할 일·회의·결재·위키·사람)
//   kn.buildBrain({ memory: [글], wiki: [{name}], skills: [{name, description}], chats: [{id, title, updatedAt}], schedule: [{id, 이름, 지시문, when}] }) → 같은 모양 (뇌 그래프: 기억·위키·스킬·대화·예약)
//   kn.sim(nodes, edges)  → { step(n) → 남은 열기, alpha, reheat(a) }  힘으로 점을 알아서 벌려 놓는다 (같은 점·선이면 늘 같은 모양)
//   kn.bounds(nodes) → { x0, y0, x1, y1 }
//
// ponytail: 언급 찾기는 "이름 글자가 글 안에 들어 있나"(공백·-·_ 무시)뿐이다. 점이 수천 개가 되면 느려지므로 종류마다 CAP 로 개수를 자른다. 더 정확해야 하면 형태소 분석을 붙인다.
(function (root) {
  const CAP = { map: { 프로젝트: 100, '할 일': 300, 회의: 120, 결재: 120, 위키: 60, 사람: 120 }, brain: { 기억: 120, 위키: 120, 스킬: 30, 대화: 100, 예약: 40 } };
  const COLORS = { 프로젝트: '#2f6fed', '할 일': '#12b76a', 회의: '#7a5af8', 결재: '#f79009', 위키: '#06aed4', 사람: '#ee46bc', 기억: '#ee46bc', 스킬: '#7a5af8', 대화: '#2f6fed', 예약: '#12b76a', 뇌: '#1d2939' };
  const MAP_TYPES = ['프로젝트', '할 일', '회의', '결재', '위키', '사람'], BRAIN_TYPES = ['기억', '위키', '스킬', '대화', '예약'];
  const BODY_MAX = 3000, GENERIC = 0.3; // 글 안에서 이름을 찾는 길이 / 이름이 점의 이만큼보다 많은 글에 나오면 너무 흔한 말이라 선을 긋지 않는다

  const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const clipText = (s, n) => { const t = String(s ?? '').replace(/\r\n?/g, '\n').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_·]+/g, ''); // "아침-브리핑" 과 "아침 브리핑" 이 같은 이름으로 보이게
  const kv = (label, v) => (v === undefined || v === null || v === '' ? '' : `${label} ${v}`);
  const list = (a, n) => (Array.isArray(a) ? a.filter((x) => x && typeof x === 'object' || typeof x === 'string').slice(0, n) : []);
  const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

  function graph() { // 점·선을 모으는 작은 틀
    const nodes = [], edges = [], by = new Map(), seen = new Set();
    const add = (type, id, title, o = {}) => {
      const k = `${type}:${id}`; if (by.has(k)) return by.get(k);
      const shown = clip(title, 60) || '(이름 없음)';
      const n = { id: k, type, title: shown, facts: (o.facts || []).filter(Boolean), text: o.text || '', body: norm(String(o.body ?? `${title} ${o.text || ''}`).slice(0, BODY_MAX)), key: o.key === undefined ? norm(title) : norm(o.key), ref: o.ref || '', hub: !!o.hub, deg: 0 };
      by.set(k, n); nodes.push(n); return n;
    };
    const link = (a, b, kind) => { // 두 점 사이 선 하나만 (이미 있으면 그대로 둔다 — 자료가 직접 가리킨 선이 먼저 들어간다)
      if (!a || !b || a === b) return;
      const p = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(p)) return; seen.add(p); edges.push({ a: a.id, b: b.id, kind }); a.deg++; b.deg++;
    };
    return { nodes, edges, by, add, link };
  }

  function mentions(g, minKey = 3) { // 글(body)에 다른 점의 이름(key)이 들어 있으면 선: 부른 쪽(a) → 불린 쪽(b)
    const { nodes } = g;
    for (const k of nodes) {
      if (!k.key || k.key.length < (k.type === '사람' ? 2 : minKey)) continue;
      const hits = nodes.filter((n) => n !== k && !n.hub && n.body.includes(k.key));
      if (nodes.length > 20 && hits.length > nodes.length * GENERIC) continue; // 너무 흔한 말
      for (const n of hits) g.link(n, k, 'mention');
    }
  }

  function buildMap(d = {}) {
    const g = graph(), omitted = {};
    const take = (type, a, cmp) => { let arr = Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []; if (cmp) arr = arr.sort(cmp); // 자르기 전에 정렬한다 (끝난 할 일이 먼저 잘려 나가게)
       if (arr.length > CAP.map[type]) omitted[type] = arr.length - CAP.map[type]; return arr.slice(0, CAP.map[type]); };
    const person = (name, dept) => { const nm = clip(name, 30); if (!nm) return null; const had = g.by.get(`사람:${nm}`), n = g.add('사람', nm, nm, { facts: [dept ? `부서 ${dept}` : '참여자'], text: '', body: nm }); if (had && dept && !had.facts.some((f) => f.startsWith('부서'))) had.facts = [`부서 ${dept}`]; return n; };
    for (const u of take('사람', d.people)) person(u.name, clip(u.dept, 30));
    for (const p of take('프로젝트', d.projects)) {
      const n = g.add('프로젝트', str(p.id) || str(p.name), p.name, { facts: [kv('고객', p.client), kv('상태', p.status), p.progress !== undefined ? `진도 ${p.progress}%` : '', p.start || p.due ? `기간 ${p.start || '?'} ~ ${p.due || '?'}` : '', kv('담당', p.owner)], text: '', body: `${p.name} ${p.client || ''}`, ref: str(p.id) });
      if (p.owner) g.link(n, person(p.owner), 'ref');
    }
    const tasks = take('할 일', d.tasks, (a, b) => Number(/완료/.test(a.status)) - Number(/완료/.test(b.status)));
    for (const t of tasks) {
      const n = g.add('할 일', str(t.id) || str(t.title), t.title, { facts: [kv('마감', t.due), kv('상태', t.status), kv('담당', t.owner)], body: `${t.title} ${t.owner || ''}`, key: String(t.title || '').length >= 6 ? t.title : '' });
      if (t.projectId) g.link(n, g.by.get(`프로젝트:${t.projectId}`), 'ref');
      if (t.owner) g.link(n, person(t.owner), 'ref');
    }
    for (const m of take('회의', d.meetings)) {
      const s = m.summary && typeof m.summary === 'object' ? m.summary : {}, att = list(m.attendees, 30).map((x) => clip(x, 30));
      const n = g.add('회의', str(m.id) || str(m.title), m.title, { facts: [kv('날짜', m.date), kv('장소', m.place), att.length ? `참석 ${att.length}명` : ''],
        text: clipText([...(Array.isArray(s.agenda) ? ['안건: ' + s.agenda.join(' · ')] : []), ...(Array.isArray(s.decisions) ? ['결정: ' + s.decisions.map((x) => (typeof x === 'string' ? x : x && x.text) || '').join(' / ')] : []), att.length ? '참석: ' + att.join(', ') : ''].join('\n') || m.transcript, 600),
        body: `${m.title} ${att.join(' ')} ${m.transcript || ''} ${JSON.stringify(s)}`, key: String(m.title || '').length >= 6 ? m.title : '', ref: str(m.id) });
      if (m.projectId) g.link(n, g.by.get(`프로젝트:${m.projectId}`), 'ref');
      for (const a of att) g.link(n, person(a), 'ref');
    }
    for (const a of take('결재', d.approvals)) {
      const n = g.add('결재', str(a.id) || str(a.title), a.title, { facts: [kv('번호', a.no), kv('상태', a.status), a.amount ? `금액 ${Number(a.amount).toLocaleString('ko-KR')}원` : '', kv('기안', a.drafterName)], text: clipText(a.body, 600), body: `${a.title} ${a.body || ''}`, key: String(a.title || '').length >= 6 ? a.title : '', ref: str(a.id) });
      if (a.drafterName) g.link(n, person(a.drafterName), 'ref');
      for (const l of list(a.line, 10)) if (l && l.name) g.link(n, person(l.name, l.dept), 'ref');
    }
    for (const w of take('위키', d.wiki)) g.add('위키', str(w.name), w.name, { facts: ['위키 문서'], text: clipText(w.text, 1500), body: `${w.name} ${w.text || ''}` });
    mentions(g);
    return { nodes: g.nodes, edges: g.edges, types: MAP_TYPES, omitted };
  }

  function buildBrain(d = {}) {
    const g = graph(), omitted = {};
    const center = g.add('뇌', 'brain', '산초', { facts: ['내 비서의 머릿속'], key: '', hub: true });
    const cats = { 기억: list(d.memory, 1e5).map((t) => ({ title: clip(String(t).replace(/^- /, ''), 60), text: String(t).replace(/^- /, ''), date: (/^\d{4}-\d\d-\d\d/.exec(String(t).replace(/^- /, '')) || [''])[0] }))
      , 위키: list(d.wiki, 1e5).map((w) => ({ title: w.name, name: w.name }))
      , 스킬: list(d.skills, 1e5).map((s) => ({ title: s.name, name: s.name, text: s.description }))
      , 대화: list(d.chats, 1e5).map((c) => ({ title: c.title, id: c.id, at: c.updatedAt }))
      , 예약: list(d.schedule, 1e5).map((e) => ({ title: e.이름, id: e.id, text: e.지시문, when: e.when })) };
    for (const type of BRAIN_TYPES) {
      const all = cats[type].filter((x) => x && x.title), items = all.slice(0, CAP.brain[type]);
      if (all.length > items.length) omitted[type] = all.length - items.length;
      const hub = g.add(type, 'hub', `${type} ${all.length}`, { facts: [`${all.length}개${omitted[type] ? ` (가장 최근 ${items.length}개만 그림)` : ''}`], key: '', hub: true });
      g.link(center, hub, 'own');
      items.forEach((x, i) => {
        const id = x.id || x.name || String(i), n = g.add(type, id, x.title, { facts: [x.date ? `날짜 ${x.date}` : '', x.when ? x.when : '', x.at ? `최근 ${String(x.at).slice(0, 10)}` : ''],
          text: clipText(x.text || '', 600), body: `${x.title} ${x.text || ''}`, key: type === '위키' || type === '스킬' || type === '예약' ? x.title : '', ref: x.name || x.id || '' });
        g.link(n, hub, 'own');
      });
    }
    mentions(g);
    return { nodes: g.nodes, edges: g.edges, types: BRAIN_TYPES, omitted };
  }

  // ---- 힘으로 벌려 놓기 (점끼리는 밀고, 선으로 이어진 점은 당기고, 가운데로 살짝 모은다)
  function sim(nodes, edges, opt = {}) {
    let seed = opt.seed || 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const N = nodes.length, by = new Map(nodes.map((n) => [n.id, n])), R0 = 40 + Math.sqrt(N) * 26;
    for (const n of nodes) { if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { const a = rnd() * 6.2832, r = R0 * Math.sqrt(rnd()); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; } n.vx = 0; n.vy = 0; }
    const links = edges.map((e) => [by.get(e.a), by.get(e.b), e.kind]).filter((l) => l[0] && l[1]);
    let alpha = 1;
    const REP = 1400, REST = 58, SPRING = 0.07, GRAVITY = 0.012, DAMP = 0.78, VMAX = 40, CUT = 240, CELL = 120;
    for (const n of nodes) n.w = 1 + Math.min(n.deg || 0, 12) * 0.12 + (n.hub ? 1.5 : 0); // 많이 이어진 점·칸 점은 더 넓게 자리를 잡는다 (점마다 한 번만 계산)
    function push(a, b, dx, dy, d2) {
      const d = Math.sqrt(d2) || 0.01, f = (REP * a.w * b.w) / (d2 + 40) * alpha, fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
    function tick() {
      if (N <= 350) { for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y; push(a, b, dx, dy, dx * dx + dy * dy); } }
      else { // 점이 많으면 칸(격자)으로 나눠 가까운 칸끼리만 민다
        const grid = new Map(), key = (cx, cy) => `${cx},${cy}`;
        for (const n of nodes) { const k = key(Math.floor(n.x / CELL), Math.floor(n.y / CELL)); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
        for (const a of nodes) {
          const cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL);
          for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) for (const b of grid.get(key(cx + ox, cy + oy)) || []) {
            if (b.id <= a.id) continue; const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy; if (d2 < CUT * CUT) push(a, b, dx, dy, d2);
          }
        }
      }
      for (const [a, b, kind] of links) {
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01, rest = kind === 'mention' ? REST * 1.6 : kind === 'own' ? REST * 1.2 : REST;
        const f = (d - rest) * SPRING * (kind === 'mention' ? 0.45 : 1) * alpha, fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const n of nodes) {
        if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
        n.vx = (n.vx - n.x * GRAVITY * alpha) * DAMP; n.vy = (n.vy - n.y * GRAVITY * alpha) * DAMP;
        const v = Math.hypot(n.vx, n.vy); if (v > VMAX) { n.vx *= VMAX / v; n.vy *= VMAX / v; }
        n.x += n.vx; n.y += n.vy;
      }
    }
    return {
      step(k = 1) { for (let i = 0; i < k && alpha > 0.02; i++) { tick(); alpha *= 0.985; } return alpha; },
      get alpha() { return alpha; },
      reheat(a = 0.35) { alpha = Math.max(alpha, a); },
    };
  }

  function bounds(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y; }
    return nodes.length ? { x0, y0, x1, y1 } : { x0: -1, y0: -1, x1: 1, y1: 1 };
  }

  const api = { CAP, COLORS, MAP_TYPES, BRAIN_TYPES, norm, buildMap, buildBrain, sim, bounds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.kn = api;
})(typeof window !== 'undefined' ? window : globalThis);
