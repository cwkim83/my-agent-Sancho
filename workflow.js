// 워크플로 실행 엔진 — 노드를 시작 노드부터 선을 따라 하나씩 실행하고, 단계마다 결과를 기록(record)에 남긴다.
// 파일·네트워크·비서(claude)·메신저는 직접 만지지 않는다: 바깥 일은 server.js 가 넘겨 주는 io 함수들로만 한다 (그래서 selftest 가 가짜 io 로 모든 길을 시험할 수 있다).
//
//   run(flow, startId, io, { trigger: 'manual'|'schedule', onUpdate(record), now() }) → 끝난 record
//   record = { id, workflowId, name, trigger, startedAt, endedAt, status: 'running'|'ok'|'error', steps: [{ id, name, type, status: 'pending'|'running'|'ok'|'error'|'skipped', ms, out, error }] }
//
//   io = { owner(만든 관리자 아이디), read(source) → 항목 목록, write(collection, mode, id, fields) → { id }, ask(prompt) → { ok, text }, http({method,url,body}) → { status, text },
//          telegram(text) → { ok, error }, bell(username, title, text), messenger(username, text), resolveUser(담당자 이름) → 아이디|null, userExists(아이디) → bool, sleep(ms) }
//
// 규칙: 선이 앞으로만 가므로(빙 돎 없음) 한 번에 한 노드씩 위에서 아래로 실행한다. 조건 나누기는 참/거짓 선 한쪽만 "켜고", 켜진 선이 하나도 안 들어온 노드는 건너뛴다.
// 한 노드가 실패하면 거기서 멈추고 나머지는 "건너뜀"으로 남긴다 (이미 한 일은 되돌리지 않는다).
// ponytail: 병렬 실행·되풀이(for each)·중간에 멈추기는 없다. 필요해지면 각 노드를 항목마다 되풀이하는 모드를 더한다
'use strict';
const crypto = require('crypto');
const net = require('net');
const wf = require('./public/m/workflow-calc.js');
const { TYPES, str, pick, render, compare, itemLine, isObj } = wf;

const OUT_MAX = 1500, FIELD_MAX = 500, NOTIFY_MAX = 20, RUN_MAX_MS = 15 * 60 * 1000;
const clipOut = (s, n = OUT_MAX) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…(${s.length - n}자 생략)` : s; };
const label = (list, v) => (list.find((o) => o[0] === v) || [v, v])[1];
const errText = (e) => clipOut(e && e.message ? e.message : String(e), 400);

function topo(flow, reach) { // 시작에서 닿는 노드를 "앞 단계가 먼저" 오게 줄 세운다 (같은 순서면 화면에 만든 순서)
  const nodes = flow.nodes.filter((n) => reach.has(n.id)), indeg = new Map(nodes.map((n) => [n.id, 0])), out = [];
  for (const e of flow.edges) if (reach.has(e.from) && reach.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
  const left = new Set(nodes.map((n) => n.id));
  while (left.size) {
    const n = nodes.find((x) => left.has(x.id) && indeg.get(x.id) === 0);
    if (!n) break; // (빙 도는 선은 저장할 때 막혀 있지만, 깨진 파일이어도 멈추지 않게)
    left.delete(n.id); out.push(n);
    for (const e of flow.edges) if (e.from === n.id && reach.has(e.to)) indeg.set(e.to, indeg.get(e.to) - 1);
  }
  return out;
}

function defaultLine(it) { // 항목 한 줄 (읽기 좋은 글)
  if (!isObj(it)) return String(it);
  if (typeof it.line === 'string' && it.line) return it.line;
  const bits = [str(it.title ?? it.name ?? ''), it.date && !it.title ? it.date : '', it.due ? `마감 ${it.due}` : '', it.date && it.title ? `${it.date}${it.start ? ` ${it.start}` : ''}` : '', it.owner ? `담당 ${it.owner}` : '', it.status ? str(it.status) : ''].filter(Boolean);
  return bits.join(' · ') || clipOut(JSON.stringify(it), 120);
}

function fieldsOf(tpl, R, what) { // 틀(JSON 글) → 칸 이름·값이 단순한 객체
  let raw; try { raw = JSON.parse(tpl); } catch { raw = undefined; }
  if (isObj(raw)) { const v = {}; for (const k of Object.keys(raw)) v[k] = typeof raw[k] === 'string' ? R(raw[k]) : raw[k]; return jsonFields(v, what); }
  return jsonFields(R(tpl), what);
}
function jsonFields(text, what) { // JSON 글(또는 이미 읽은 객체) → 칸 이름·값이 단순한 객체
  let v = text; if (typeof text === 'string') { try { v = JSON.parse(text); } catch (e) { throw new Error(`${what}(JSON)이 올바르지 않아요: ${clipOut(e.message, 80)}`); } }
  if (!isObj(v)) throw new Error(`${what}은 { "칸": "값" } 모양이어야 해요.`);
  const keys = Object.keys(v);
  if (keys.length > 20) throw new Error(`${what}은 20칸까지예요.`);
  const out = {};
  for (const k of keys) {
    if (!/^[A-Za-z0-9_가-힣]{1,30}$/.test(k)) throw new Error(`${what}의 칸 이름 "${clipOut(k, 20)}" 은(는) 쓸 수 없어요. (글자·숫자·_ 30자까지)`);
    const x = v[k];
    if (typeof x === 'string') { if (x.length > FIELD_MAX) throw new Error(`"${k}" 칸 값이 ${FIELD_MAX}자를 넘어요.`); out[k] = x; }
    else if (typeof x === 'number' || typeof x === 'boolean' || x === null) out[k] = x;
    else throw new Error(`"${k}" 칸 값은 글·숫자·참거짓만 돼요.`);
  }
  return out;
}

async function run(flow, startId, io, opt = {}) {
  const clock = opt.now || (() => new Date()), t0 = clock();
  const pad = wf.pad, today = wf.ymd(t0), nowText = `${today} ${pad(t0.getHours())}:${pad(t0.getMinutes())}`;
  const rec = { id: opt.runId || `r${crypto.randomBytes(4).toString('hex')}`, workflowId: flow.id, name: flow.name, trigger: opt.trigger || 'manual', startedAt: t0.toISOString(), endedAt: '', status: 'running', steps: [] };
  const push = async () => { if (opt.onUpdate) { try { await opt.onUpdate(rec); } catch { /* 기록을 못 남겨도 실행은 계속 */ } } };
  const by = new Map(flow.nodes.map((n) => [n.id, n]));
  const start = by.get(startId) && TYPES[by.get(startId).type].trigger ? startId : (flow.nodes.find((n) => TYPES[n.type].trigger) || {}).id;
  if (!start) { rec.status = 'error'; rec.endedAt = clock().toISOString(); rec.steps.push({ id: '', name: '(시작)', type: 'manual', status: 'error', ms: 0, out: '', error: '시작 노드가 없어요.' }); await push(); return rec; }
  const order = topo(flow, wf.reachable(flow.nodes, flow.edges, start)), reach = new Set(order.map((n) => n.id));
  rec.steps = order.map((n) => ({ id: n.id, name: n.name, type: n.type, status: 'pending', ms: 0, out: '', error: '' }));
  await push();

  const scope = { steps: {}, names: flow.nodes.map((n) => n.name), today, now: nowText, weekday: wf.WEEK[t0.getDay()], workflow: flow.name, vars: {} };
  const state = new Map(), output = new Map();
  const R = (tpl, extra) => render(tpl, extra ? { ...scope, vars: extra } : scope);

  async function exec(node) { // → 결과 값 (str() 로 글이 되는 것)
    const p = node.params;
    switch (node.type) {
      case 'manual': return { trigger: rec.trigger, text: rec.trigger === 'manual' ? '손으로 시작했어요' : '시계가 시작했어요' };
      case 'daily': case 'every': return { trigger: rec.trigger, text: `${wf.describe(node)} · ${rec.trigger === 'manual' ? '손으로 시작' : '시계가 시작'}` };
      case 'ask': {
        const prompt = R(p.prompt).trim(); if (!prompt) throw new Error('시킬 말이 비어 있어요.');
        const r = await io.ask(prompt); if (!r.ok) throw new Error(r.text || '비서가 답하지 못했어요.');
        return { text: r.text };
      }
      case 'read': {
        let items = await io.read(p.source); if (!Array.isArray(items)) items = [];
        if (p.field && p.op) { const v = R(p.value), path = p.field.split('.'); items = items.filter((it) => compare(p.op, str(pick(it, path)), v)); }
        const total = items.length; items = items.slice(0, p.limit).map((it) => (isObj(it) ? { ...it, line: defaultLine(it) } : it));
        return { source: p.source, items, count: total, text: items.length ? `${items.map((it) => `- ${itemLine(it)}`).join('\n')}${total > items.length ? `\n(… ${total - items.length}개 더)` : ''}` : '(없음)' };
      }
      case 'write': {
        const fields = fieldsOf(p.fields, R, '넣을 칸'); delete fields.id;
        if (!Object.keys(fields).length) throw new Error('넣을 칸이 비어 있어요.');
        const id = p.mode === 'update' ? R(p.id).trim() : null;
        if (p.mode === 'update' && !id) throw new Error('고칠 항목의 id 가 비어 있어요.');
        const r = await io.write(p.collection, p.mode, id, fields);
        return { collection: p.collection, mode: p.mode, id: r.id, text: `${label(wf.WRITABLE, p.collection)} ${p.mode === 'add' ? '추가' : '고침'}: ${r.id}` };
      }
      case 'if': {
        const l = R(p.left), r = ['empty', 'notempty'].includes(p.op) ? '' : R(p.right), result = compare(p.op, l, r);
        return { result, left: l, right: r, op: p.op, text: `${result ? '참' : '거짓'} (${clipOut(l, 60)} ${label(wf.OPS, p.op)}${r ? ` ${clipOut(r, 60)}` : ''})` };
      }
      case 'http': {
        const url = R(p.url).trim(); if (!url) throw new Error('주소가 비어 있어요.');
        const r = await io.http({ method: p.method, url, body: p.method === 'POST' ? R(p.body) : undefined });
        if (r.status >= 400) throw new Error(`웹 호출이 ${r.status} 로 끝났어요.${r.text ? ` ${clipOut(r.text, 120)}` : ''}`);
        let json; try { json = JSON.parse(r.text); } catch { /* 글이면 글로 */ }
        return { status: r.status, ok: true, text: r.text, ...(json !== undefined ? { json } : {}) };
      }
      case 'notice': return notify(node);
      case 'telegram': {
        const text = R(p.text).trim(); if (!text) throw new Error('보낼 글이 비어 있어요.');
        const r = await io.telegram(text); if (!r.ok) throw new Error(r.error || '텔레그램으로 보내지 못했어요.');
        return { text: '텔레그램으로 보냈어요' };
      }
      case 'wait': await io.sleep(p.seconds * 1000); return { seconds: p.seconds, text: `${p.seconds}초 기다렸어요` };
      case 'set': return fieldsOf(p.fields, R, '값들');
      default: throw new Error(`모르는 노드(${node.type}) 예요.`);
    }
  }

  async function notify(node) {
    const p = node.params, title = R(p.title).trim() || flow.name, sent = [], notes = [];
    const deliver = async (username, text, why) => { // 한 사람에게: 메신저는 "나와의 1:1"이 없어서 나에게는 🔔 로
      const body = clipOut(text, 3500);
      if (p.via === 'messenger' && username !== io.owner) { await io.messenger(username, `🔀 ${flow.name}\n\n${body}`); sent.push({ to: username, via: 'messenger' }); }
      else { await io.bell(username, title, body); sent.push({ to: username, via: 'bell' }); if (p.via === 'messenger') notes.push('나에게는 메신저 대신 🔔 로 보냈어요'); }
      if (why) notes.push(why);
    };
    if (p.to === 'owners') {
      if (!p.list || !scope.names.includes(p.list)) throw new Error('담당자를 읽을 앞 단계를 골라 주세요.');
      const srcNode = flow.nodes.find((n) => n.name === p.list), src = srcNode && output.get(srcNode.id), items = isObj(src) ? src.items : null;
      if (!Array.isArray(items)) throw new Error(`"${p.list}" 단계에는 목록(items)이 없어요. 데이터 읽기 단계를 골라 주세요.`);
      const groups = new Map(); for (const it of items) { const o = isObj(it) && typeof it.owner === 'string' && it.owner.trim() ? it.owner.trim() : '(담당 없음)'; (groups.get(o) || groups.set(o, []).get(o)).push(it); }
      if (groups.size > NOTIFY_MAX) throw new Error(`담당자가 ${groups.size}명이에요. 한 번에 ${NOTIFY_MAX}명까지만 알려요.`);
      if (!groups.size) return { sent, unmatched: [], text: '알릴 담당자가 없어요 (목록이 비었어요)' };
      const unmatched = [], lost = [];
      for (const [owner, list] of groups) {
        const text = R(p.text, { owner, count: list.length, lines: list.map((it) => `- ${itemLine(it)}`).join('\n') }), user = owner === '(담당 없음)' ? null : io.resolveUser(owner);
        if (user && user !== io.owner) await deliver(user, text);
        else { unmatched.push(owner); lost.push(`[${owner}]\n${text}`); }
      }
      if (lost.length) { await io.bell(io.owner, title, clipOut(`사용자 목록에 없는 담당자(${unmatched.join(', ')}) 몫을 대신 알려요.\n\n${lost.join('\n\n')}`, 3500)); sent.push({ to: io.owner, via: 'bell' }); }
      const people = sent.filter((s) => s.to !== io.owner || s.via === 'messenger').length;
      return { sent, unmatched, text: `담당자 ${groups.size}명 → ${p.via === 'messenger' ? '메신저' : '🔔'} ${people}명${unmatched.length ? ` · 사용자 목록에 없는 ${unmatched.length}명(${unmatched.join(', ')}) 몫은 나에게 🔔 1건으로 대신 보냈어요` : ''}` };
    }
    let to = io.owner;
    if (p.to === 'user') { to = p.user.trim(); if (!to || !io.userExists(to)) throw new Error(`"${to}" 아이디의 사용자를 찾지 못했어요.`); }
    await deliver(to, R(p.text));
    return { sent, text: `${to} 에게 ${sent[0].via === 'messenger' ? '메신저로' : '🔔 로'} 알렸어요${notes.length ? ` (${notes[0]})` : ''}` };
  }

  for (const node of order) {
    const step = rec.steps.find((s) => s.id === node.id);
    if (rec.status === 'error') { step.status = 'skipped'; step.out = '앞 단계에서 멈춰서 실행하지 않았어요'; continue; }
    if (clock() - t0 > (opt.maxMs || RUN_MAX_MS)) { step.status = 'error'; step.error = '실행 시간이 너무 길어요(15분). 멈췄어요.'; rec.status = 'error'; continue; }
    let on = node.id === start, why = '';
    if (!on) {
      const inc = flow.edges.filter((e) => e.to === node.id && reach.has(e.from));
      on = inc.some((e) => state.get(e.from) === 'ok' && (!e.branch || String(output.get(e.from).result) === e.branch));
      why = inc.some((e) => state.get(e.from) === 'ok' && e.branch) ? '조건이 달라서 건너뛰었어요' : '이어진 앞 단계가 실행되지 않아서 건너뛰었어요';
    }
    if (!on) { step.status = 'skipped'; step.out = why; state.set(node.id, 'skipped'); await push(); continue; }
    step.status = 'running'; await push();
    const t = Date.now();
    try {
      const v = await exec(node);
      output.set(node.id, v); scope.steps[node.name] = v; state.set(node.id, 'ok');
      step.status = 'ok'; step.out = clipOut(str(v));
    } catch (e) { state.set(node.id, 'error'); step.status = 'error'; step.error = errText(e); rec.status = 'error'; }
    step.ms = Date.now() - t; await push();
  }
  if (rec.status !== 'error') rec.status = 'ok';
  rec.endedAt = clock().toISOString(); await push();
  return rec;
}

// 웹 호출이 갈 수 없는 주소: 이 PC 자신·사내망(사설)·링크 로컬·클라우드 메타데이터(169.254.169.254)·멀티캐스트·잘 모르는 모양. 서버(server.js)가 호출 전에 이름을 풀어 나온 모든 주소를 이 검사에 건다
function isPrivateAddress(ip) {
  const s = String(ip).toLowerCase().replace(/^[|]$/g, '');
  const v4 = (a) => { const [x, y] = a.split('.').map(Number); return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && (y === 168 || y === 0)) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19)) || x >= 224; };
  if (net.isIPv4(s)) return v4(s);
  if (net.isIPv6(s)) {
    if (s === '::' || s === '::1') return true;
    let m = /^::ffff:(d+.d+.d+.d+)$/.exec(s); if (m) return v4(m[1]); // IPv4 를 IPv6 로 감싼 모양
    m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s); if (m) { const a = parseInt(m[1], 16), b = parseInt(m[2], 16); return v4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('64:ff9b') || s.startsWith('2002:') || s.startsWith('::'); // 고유 로컬·링크 로컬·멀티캐스트·NAT64·6to4(안에 사설 주소를 담을 수 있음)
  }
  return true; // 주소가 아니면 막는다
}

module.exports = { isPrivateAddress, run, topo, defaultLine, jsonFields, fieldsOf, NOTIFY_MAX, OUT_MAX };
