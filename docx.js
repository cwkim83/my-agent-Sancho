// 워드(docx) 만들기 — 회의록 한 장을 서버가 직접 만든다. docx 는 zip 안의 XML 이라 Node 내장 zlib 만으로 쓴다 (외부 패키지 없음, 비서·파이썬·"명령 실행" 권한도 필요 없다).
// 읽기(미리보기)는 officeview.js. selftest 는 이 파일이 만든 문서를 officeview 로 다시 읽어 보고, 파이썬 docx 가 있으면 그걸로도 열어 본다.
const zlib = require('zlib');

// ---------- zip 쓰기: { 이름: 내용 } → Buffer ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries, now = new Date()) {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nb = Buffer.from(name), raw = Buffer.isBuffer(content) ? content : Buffer.from(content), data = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- 문서 조각 ----------
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t, o = {}) => `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.after !== undefined ? `<w:spacing w:after="${o.after}"/>` : ''}${o.indent ? `<w:ind w:left="${o.indent}"/>` : ''}</w:pPr>${run(t, o)}</w:p>`;
const paras = (text, o = {}) => (String(text ?? '').split('\n').map((l) => para(l, o)).join('') || para('', o)); // 줄바꿈은 문단 나누기로
const cell = (text, w, o = {}) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ''}</w:tcPr>${paras(text, { after: 40, ...o })}</w:tc>`;
const BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="9AA4B2"/>`).join('');
function table(head, rows, widths) { // head: 제목 줄(없으면 null), rows: 글자 배열의 배열, widths: 칸 너비(dxa)
  const tr = (cells, o) => `<w:tr>${o.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c, i) => cell(c, widths[i], o)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${BORDER}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head ? tr(head, { header: true, b: true, fill: 'EEF2F7' }) : ''}${rows.map((r) => tr(r, {})).join('')}</w:tbl>${para('', { after: 120 })}`;
}
const none = (x) => (x && String(x).trim() ? x : '-');

// meeting: { title, date, start, end, place, projectName, attendees[], creatorName, summary:{agenda[],discussion[{topic,points[]}],decisions[],actions[{task,owner,due}]}, transcript, source }
function meetingDocx(m) {
  const S = m.summary || {}, W = 9638, when = `${m.date || ''}${m.start ? ` ${m.start}${m.end ? `~${m.end}` : ''}` : ''}`.trim();
  const sec = (t) => para(t, { style: 'Heading1' });
  const body = [
    para('회의록', { style: 'Title' }),
    table(null, [['회의', m.title], ['일시', when], ['장소', none(m.place)], ['참석자', none((m.attendees || []).join(', '))], ['프로젝트', none(m.projectName)], ['작성', `${none(m.creatorName)} (받아쓴 글을 AI 비서 산초가 정리함${m.source === '붙여넣기' ? ' · 붙여넣은 글' : ' · 음성 녹취'})`]], [1700, W - 1700]),
    sec('1. 안건'), (S.agenda || []).length ? table(['번호', '안건'], S.agenda.map((a, i) => [String(i + 1), a]), [900, W - 900]) : para('(없음)'),
    sec('2. 논의'), (S.discussion || []).length ? table(['주제', '논의 내용'], S.discussion.map((d) => [d.topic, (d.points || []).map((p) => `• ${p}`).join('\n')]), [2600, W - 2600]) : para('(없음)'),
    sec('3. 결정 사항'), (S.decisions || []).length ? table(['번호', '결정'], S.decisions.map((d, i) => [String(i + 1), d]), [900, W - 900]) : para('(없음)'),
    sec('4. 할 일'), (S.actions || []).length ? table(['번호', '할 일', '담당', '기한'], S.actions.map((a, i) => [String(i + 1), a.task, none(a.owner), none(a.due)]), [800, W - 800 - 1700 - 1700, 1700, 1700]) : para('(없음)'),
    sec('5. 녹취 원문'), paras(m.transcript || '(없음)', { sz: 18, after: 20 }),
  ].join('');
  const sect = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="Malgun Gothic" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3A6E"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style></w:styles>`;
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': styles,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`,
  });
}

module.exports = { zip, meetingDocx };
