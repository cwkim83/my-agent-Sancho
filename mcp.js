// MCP 창구의 두뇌 (9편 셋째 단계): MCP(Model Context Protocol) Streamable HTTP 의 JSON-RPC 2.0 메시지를 처리한다.
// 도구는 "읽기 전용" 5개뿐이다. 이 파일은 아무것도 불러오지 않는다(require 없음): 파일·네트워크·프로그램 실행을 아예 할 수 없고,
// 서버(server.js)가 넘겨 주는 읽기 함수(ctx)로 본 것만 돌려준다. selftest 가 도구 목록과 이 사실을 못박는다 — 쓰기·실행 도구는 여기에 넣지 않는다.
//
//   handleMessage(메시지, ctx) → JSON-RPC 응답 객체, 답이 필요 없는 메시지(알림·응답)면 null
//   ctx = { now(Date), cal(public/m/cal.js), wbsCalc(public/m/wbs-calc.js), events(), projects(), tasks(), wbsDoc(프로젝트id), me({name,username}|null), log(도구이름, 성공여부) }
'use strict';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // 지원하는 프로토콜 버전 (맨 앞이 최신). 클라이언트가 부른 버전이 여기 있으면 그대로, 없으면 최신으로 답한다
const SERVER_INFO = { name: 'sancho', title: 'Sancho 비서 (읽기 전용)', version: '1.0.0' };
const INSTRUCTIONS = 'Sancho 비서의 일정·프로젝트·WBS 지연 작업·내 할 일을 읽기만 합니다. 쓰기·실행 도구는 없습니다.';
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (v) => (v === undefined || v === null ? '' : String(v));
const r1 = (n) => Math.round(Number(n) * 10) / 10; // 소수 첫째 자리까지
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const PID = /^[A-Za-z0-9_-]{1,64}$/;

// 인자 검사: 모르는 이름이 있거나 모양이 틀리면 이유(글), 괜찮으면 ''
const noArgs = (a) => (Object.keys(a).length ? `이 도구는 인자가 없어요 (받은 것: ${Object.keys(a).join(', ').slice(0, 60)})` : '');
function checkArgs(a, spec) { // spec: { 이름: 'string' | 'boolean' }
  const extra = Object.keys(a).filter((k) => !(k in spec));
  if (extra.length) return `모르는 인자: ${extra.join(', ').slice(0, 60)}`;
  for (const [k, t] of Object.entries(spec)) if (k in a && typeof a[k] !== t) return `${k} 는 ${t === 'string' ? '글자' : '참/거짓'}여야 해요`;
  return '';
}

const eventOut = (e) => ({ title: str(e.title), kind: str(e.kind), date: str(e.date), end_date: str(e.endDate) || str(e.date), start: str(e.start), end: str(e.end), place: str(e.place) }); // 메모(memo)는 보내지 않는다
const weekday = (ctx, day) => DOW[ctx.cal.parse(day).getDay()];

// 프로젝트별 WBS 계산: [{ id, name, calc }] — WBS 파일이 있는 프로젝트만
function wbsOf(ctx, only) {
  const day = ctx.cal.ymd(ctx.now), out = [];
  for (const p of ctx.projects()) {
    if (!isObj(p) || !PID.test(str(p.id)) || (only && p.id !== only)) continue;
    const doc = ctx.wbsDoc(p.id);
    if (doc) out.push({ id: p.id, name: str(p.name), calc: ctx.wbsCalc.compute(doc, day) });
  }
  return out;
}

const TOOLS = [
  {
    name: 'get_today_events', title: '오늘 일정',
    description: '오늘 일정(회의·출장·검사 입회 등)을 시작 시각 순으로 돌려줍니다. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    check: noArgs,
    run(a, ctx) {
      const day = ctx.cal.ymd(ctx.now), events = ctx.cal.eventsOn(ctx.events(), day).map(eventOut);
      return { date: day, weekday: weekday(ctx, day), count: events.length, events };
    },
  },
  {
    name: 'get_week_events', title: '이번 주 일정',
    description: '이번 주(월요일~일요일) 일정을 날짜별로 돌려줍니다. 여러 날에 걸친 일정은 걸친 날마다 나옵니다. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    check: noArgs,
    run(a, ctx) {
      const days = ctx.cal.weekDays(ctx.cal.ymd(ctx.now)), all = ctx.events(), seen = new Set();
      const out = days.map((d) => ({ date: d, weekday: weekday(ctx, d), events: ctx.cal.eventsOn(all, d).map((e) => { seen.add(e); return eventOut(e); }) }));
      return { week_start: days[0], week_end: days[6], total_events: seen.size, days: out };
    },
  },
  {
    name: 'list_projects', title: '프로젝트 목록·진도율',
    description: '프로젝트 목록과 진도율을 돌려줍니다 (이름·발주처·상태·진도율·기간·담당). WBS 공정표가 있으면 WBS 기준 실제·계획 진도와 지연 작업 수도 함께 줍니다. 금액·메모는 보내지 않습니다. 읽기 전용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    check: noArgs,
    run(a, ctx) {
      const calc = new Map(wbsOf(ctx).map((w) => [w.id, w.calc]));
      const projects = ctx.projects().filter(isObj).map((p) => {
        const o = { id: str(p.id), name: str(p.name), client: str(p.client), status: str(p.status), progress_percent: num(p.progress), start: str(p.start), due: str(p.due), owner: str(p.owner) };
        const c = calc.get(p.id);
        if (c) o.wbs = { actual_percent: r1(c.overall.actual), planned_percent: r1(c.overall.plan), delayed_tasks: c.evms.late };
        return o;
      });
      return { count: projects.length, projects };
    },
  },
  {
    name: 'get_delayed_wbs_tasks', title: 'WBS 지연 작업',
    description: 'WBS 공정표에서 지연된 작업을 돌려줍니다. 지연 = 계획 진도보다 실제 진도가 10%p 넘게 낮은 작업(WBS 화면의 "지연"과 같은 기준). project_id 를 주면 그 프로젝트만. 금액·메모는 보내지 않습니다. 읽기 전용.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: '프로젝트 id (list_projects 의 id). 생략하면 모든 프로젝트' } }, additionalProperties: false },
    check: (a) => checkArgs(a, { project_id: 'string' }) || (a.project_id !== undefined && !PID.test(a.project_id) ? 'project_id 모양이 올바르지 않아요' : ''),
    run(a, ctx) {
      const list = wbsOf(ctx, a.project_id);
      if (a.project_id && !list.length) throw new Error('그 프로젝트의 WBS 공정표를 찾지 못했어요. list_projects 로 id 를 확인해 주세요.');
      const projects = list.map((w) => ({ project_id: w.id, project_name: w.name, delayed_tasks: w.calc.rows.filter((r) => r.leaf && r.status === '지연')
        .map((r) => ({ code: r.code, name: r.name, owner: r.owner, start: r.start, end: r.end, planned_percent: r1(r.plan), actual_percent: r1(r.actual), behind_points: r1(r.plan - r.actual) })) }));
      return { as_of: ctx.cal.ymd(ctx.now), rule: '계획 진도보다 실제 진도가 10%p 넘게 낮은 작업', total_delayed: projects.reduce((n, p) => n + p.delayed_tasks.length, 0), projects };
    },
  },
  {
    name: 'get_my_tasks', title: '내 할 일',
    description: '이 커넥터를 만든 사용자의 할 일을 마감일 순으로 돌려줍니다. 기본은 끝나지 않은 것만, include_done 을 true 로 주면 완료한 것도. 읽기 전용.',
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean', description: '완료한 할 일도 포함 (기본 false)' } }, additionalProperties: false },
    check: (a) => checkArgs(a, { include_done: 'boolean' }),
    run(a, ctx) {
      if (!ctx.me) throw new Error('이 커넥터를 만든 사용자를 찾지 못했어요. 설정에서 커넥터 주소를 다시 만들어 주세요.');
      const mine = new Set([ctx.me.name, ctx.me.username].map((s) => str(s).toLowerCase()).filter(Boolean)), day = ctx.cal.ymd(ctx.now);
      const names = new Map(ctx.projects().filter(isObj).map((p) => [p.id, str(p.name)]));
      const tasks = ctx.tasks().filter((t) => isObj(t) && mine.has(str(t.owner).toLowerCase()) && (a.include_done === true || t.status !== '완료'))
        .sort((x, y) => (str(x.due) || '9999').localeCompare(str(y.due) || '9999'))
        .map((t) => ({ id: str(t.id), title: str(t.title), due: str(t.due), status: str(t.status), overdue: !!t.due && t.due < day && t.status !== '완료', project: names.get(t.projectId) || null }));
      return { owner: ctx.me.name, as_of: day, count: tasks.length, tasks };
    },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);
const listed = () => TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { title, ...READ_ONLY } }));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const textResult = (text, isError) => ({ content: [{ type: 'text', text }], isError });

function callTool(id, params, ctx) {
  if (!isObj(params) || typeof params.name !== 'string') return rpcError(id, -32602, 'params.name(도구 이름)이 필요해요.');
  const tool = TOOLS.find((t) => t.name === params.name);
  const log = (name, ok) => { try { if (ctx.log) ctx.log(name, ok); } catch { /* 기록을 못 남겨도 답은 한다 */ } }; // 이용 기록: 도구 이름(우리 목록의 것만)과 성공 여부뿐 — 인자·결과는 넘기지 않는다
  if (!tool) { log('(알 수 없는 도구)', false); return rpcError(id, -32602, `없는 도구예요: ${params.name.slice(0, 60)}`); }
  const args = params.arguments === undefined ? {} : params.arguments;
  const why = isObj(args) ? tool.check(args) : 'arguments 는 객체여야 해요';
  if (why) { log(tool.name, false); return rpcError(id, -32602, `인자가 올바르지 않아요: ${why}`); }
  try {
    const out = tool.run(args, ctx);
    log(tool.name, true);
    return rpcResult(id, textResult(JSON.stringify(out, null, 2), false));
  } catch (e) {
    log(tool.name, false);
    return rpcResult(id, textResult(`도구를 실행하지 못했어요: ${str(e && e.message).slice(0, 200)}`, true)); // 도구 안의 실패는 프로토콜 오류가 아니라 isError 결과로
  }
}

function handleMessage(msg, ctx) {
  if (!isObj(msg) || msg.jsonrpc !== '2.0') return rpcError(isObj(msg) ? msg.id : null, -32600, 'JSON-RPC 2.0 요청이 아니에요.');
  if (typeof msg.method !== 'string') return 'result' in msg || 'error' in msg ? null : rpcError(msg.id, -32600, 'method 가 없어요.'); // 클라이언트가 보낸 응답은 받기만 한다
  if (msg.id === undefined) return null; // 알림(notifications/initialized 등)에는 답하지 않는다
  if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return rpcError(null, -32600, 'id 는 글자나 숫자여야 해요.');
  const p = msg.params;
  switch (msg.method) {
    case 'initialize': {
      const v = isObj(p) && VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0];
      return rpcResult(msg.id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping': return rpcResult(msg.id, {});
    case 'tools/list': return rpcResult(msg.id, { tools: listed() });
    case 'tools/call': return callTool(msg.id, p, ctx);
    default: return rpcError(msg.id, -32601, `지원하지 않는 메서드예요: ${msg.method.slice(0, 60)}`); // resources·prompts 등은 없다
  }
}

module.exports = { handleMessage, TOOL_NAMES, VERSIONS };
