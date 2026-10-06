// 파일 미리보기 계산 — "무엇을 보여 줄지"만 정한다 (화면 그리기·파일 서빙은 server.js 와 화면이 한다). selftest.js 도 이 파일을 직접 불러 검사한다.
// 워드(docx)·엑셀(xlsx)·PPT(pptx)는 zip 파일 안의 XML 이라, Node 내장 zlib 으로 열어 글자와 표만 뽑는다. 외부 패키지 없음.
// 보여 주는 것은 글자·표뿐이다 (서식·그림·수식 결과는 못 보여 준다 — 그럴 땐 "열기"로 진짜 프로그램에서 연다).
const fs = require('fs');
const zlib = require('zlib');

const MAX_ROWS = 200, MAX_COLS = 30, MAX_TEXT = 200_000, MAX_FILE = 30 * 1024 * 1024;

// ---------- zip 읽기: want(이름) 이 참인 파일만 { 이름: Buffer } ----------
function unzip(buf, want, maxEach = 20 * 1024 * 1024) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; } // 끝 표식(EOCD)
  if (e < 0) throw new Error('zip 파일이 아니에요');
  const n = buf.readUInt16LE(e + 10), out = {};
  let p = buf.readUInt32LE(e + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 목록이 깨졌어요');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(start, start + csize);
    if (method === 0) out[name] = raw;
    else if (method === 8) out[name] = zlib.inflateRawSync(raw, { maxOutputLength: maxEach }); // 압축을 풀었을 때 너무 커지면 멈춘다 (zip 폭탄)
    else throw new Error('지원하지 않는 압축 방식이에요');
  }
  return out;
}

// ---------- XML 글자 다루기 ----------
const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => cp(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16))).replace(/&amp;/g, '&');
const tags = (frag, re) => (frag.match(re) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''); // 태그에 둘러싸인 글자만 이어 붙인다
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unesc(m[1]) : ''; };

// ---------- 워드: { kind:'doc', blocks:[{t:'h',level,text}|{t:'p',text}|{t:'table',rows}] } ----------
function docxView(zip) {
  if (!zip['word/document.xml']) throw new Error('워드 문서가 아니에요');
  const xml = zip['word/document.xml'].toString('utf8'), blocks = [];
  const P = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const para = (f) => unesc((f.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || []).map((t) => (t.startsWith('<w:tab') ? '\t' : t.startsWith('<w:br') ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''));
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (blocks.length >= 2000) break;
    const f = m[0];
    if (f.startsWith('<w:tbl>')) {
      const rows = [...f.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].slice(0, MAX_ROWS).map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].slice(0, MAX_COLS).map((c) => [...c[0].matchAll(P)].map((q) => para(q[0])).join('\n')));
      blocks.push({ t: 'table', rows });
    } else {
      const text = para(f); if (!text.trim()) continue;
      const st = (f.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '', h = st === 'Title' ? 1 : /^Heading(\d)$/.exec(st) ? Math.min(Number(/^Heading(\d)$/.exec(st)[1]) + 1, 4) : 0;
      blocks.push(h ? { t: 'h', level: h, text } : { t: 'p', text });
    }
  }
  return { kind: 'doc', blocks };
}

// ---------- 엑셀: { kind:'sheet', sheets:[{name, rows, more}] } ----------
const colNo = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
function xlsxView(zip) {
  if (!zip['xl/workbook.xml']) throw new Error('엑셀 문서가 아니에요');
  const rels = {};
  for (const m of (zip['xl/_rels/workbook.xml.rels'] || Buffer.alloc(0)).toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) rels[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const shared = [...(zip['xl/sharedStrings.xml'] || Buffer.alloc(0)).toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc(tags(m[1], /<t(?:\s[^>]*)?>[^<]*<\/t>/g)));
  const sheets = [];
  for (const m of zip['xl/workbook.xml'].toString('utf8').matchAll(/<sheet\b[^>]*>/g)) {
    if (sheets.length >= 5) break;
    let target = rels[attr(m[0], 'r:id')] || ''; target = target.replace(/^\//, ''); if (!target.startsWith('xl/')) target = `xl/${target}`;
    const sx = zip[target]; if (!sx) continue;
    const rows = []; let more = false;
    for (const c of sx.toString('utf8').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r'); if (!/^[A-Z]+\d+$/.test(ref)) continue;
      const r = Number(/\d+/.exec(ref)[0]) - 1, k = colNo(ref), t = attr(c[1], 't'), body = c[2] || '';
      if (r >= MAX_ROWS) { more = true; continue; } if (k >= MAX_COLS) { more = true; continue; }
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1], f = (/<f[^>]*>([\s\S]*?)<\/f>/.exec(body) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = unesc(tags(body, /<t(?:\s[^>]*)?>[^<]*<\/t>/g));
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = unesc(v);
      else if (f !== undefined) val = `=${unesc(f)}`; // 계산 결과가 저장돼 있지 않은 수식은 수식 글자로
      (rows[r] ||= [])[k] = val;
    }
    const w = Math.max(0, ...rows.map((r) => (r ? r.length : 0)));
    sheets.push({ name: attr(m[0], 'name') || `시트${sheets.length + 1}`, rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: w }, (_, j) => (rows[i] && rows[i][j]) ?? '')), more });
  }
  return { kind: 'sheet', sheets };
}

// ---------- PPT: { kind:'slides', slides:[{n, texts}] } ----------
function pptxView(zip) {
  const names = Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  if (!names.length) throw new Error('PPT 문서가 아니에요');
  return { kind: 'slides', slides: names.slice(0, 100).map((n, i) => ({ n: i + 1, texts: [...zip[n].toString('utf8').matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) => unesc(tags(p[0], /<a:t(?:\s[^>]*)?>[^<]*<\/a:t>/g))).filter((t) => t.trim()) })) };
}

// ---------- CSV (큰따옴표·줄바꿈 안의 쉼표 처리, 맨 앞 BOM 무시, 엑셀용 ="1.1" 은 1.1 로) ----------
function csvParse(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false, more = false;
  const end = () => { row.push(cell.replace(/^="(.*)"$/, '$1')); cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === ',') end();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; end(); rows.push(row.slice(0, MAX_COLS)); row = []; if (rows.length >= MAX_ROWS) { more = true; break; } }
    else cell += ch;
  }
  if (!more && (cell !== '' || row.length)) { end(); rows.push(row.slice(0, MAX_COLS)); }
  return { rows, more };
}
function decode(buf) { // UTF-8 이 아니면(옛 엑셀이 저장한 CSV) 한국어 EUC-KR 로 읽는다
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); } catch { return new TextDecoder('euc-kr').decode(buf); } // stream: 앞부분만 잘라 읽다 한글이 중간에 끊겨도 UTF-8 이 아니라고 오해하지 않게
}

// ---------- 파일 하나를 보여 줄 모양으로: image·pdf 는 화면이 파일 주소로 직접 보여 주니 종류만 ----------
function viewFile(full, ext) {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return { kind: 'image' };
  if (ext === 'pdf') return { kind: 'pdf' };
  const size = fs.statSync(full).size;
  if (size > MAX_FILE) return { kind: 'none', error: '파일이 너무 커서 미리보기를 만들지 않았어요. ⬇ 받기나 열기를 써 주세요.' };
  if (['txt', 'md', 'json', 'log'].includes(ext)) { const t = decode(fs.readFileSync(full).subarray(0, MAX_TEXT * 3 + 8)).replace(/^﻿/, ''); return { kind: 'text', text: t.slice(0, MAX_TEXT), more: t.length > MAX_TEXT }; }
  if (ext === 'csv') { const { rows, more } = csvParse(decode(fs.readFileSync(full))); return { kind: 'sheet', sheets: [{ name: 'CSV', rows, more }] }; }
  if (['docx', 'xlsx', 'pptx'].includes(ext)) {
    const want = { docx: (n) => n === 'word/document.xml', xlsx: (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n), pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) }[ext];
    const zip = unzip(fs.readFileSync(full), want);
    return { docx: docxView, xlsx: xlsxView, pptx: pptxView }[ext](zip);
  }
  return { kind: 'none', error: '이 형식은 미리보기가 없어요. ⬇ 받기나 열기를 써 주세요.' };
}

module.exports = { unzip, docxView, xlsxView, pptxView, csvParse, viewFile };
