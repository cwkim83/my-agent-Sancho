// 메일·캘린더 문지기 — claude 의 PreToolUse 훅으로 서버가 건다 (주인이 "보낼까요?"·"등록할까요?"에 "네" 한 그 차례에만).
// 보내기·등록 도구가 실제로 돌기 직전에 claude 가 도구 입력을 표준입력으로 넘겨 준다. 여기서 막으면(종료 코드 2) 도구는 돌지 않고 이유가 비서에게 간다.
//  - 확인 내용 파일(SANCHO_GATE: 서버가 data 밖 임시 폴더에 둠)이 없으면 막는다 → 주인이 확인한 차례가 아니다
//  - 도구 입력에 든 메일 주소가 하나라도 비서가 "보낼까요?" 에서 보여 준 주소가 아니면 막는다
//  - 메일 보내기는 한 통만: 처음 통과할 때 확인 파일 이름을 바꿔(한 번에 하나만 성공하는 동작) 두 번째부터는 막는다
const fs = require('fs');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const deny = (why) => { process.stderr.write(why); process.exit(2); };

let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  let j, g;
  try { j = JSON.parse(raw); } catch { return deny('문지기: 요청을 읽지 못해 막았어요.'); }
  const gate = process.env.SANCHO_GATE;
  try { g = JSON.parse(fs.readFileSync(gate, 'utf8')); } catch {
    if (gate && fs.existsSync(`${gate}.used`)) return deny('주인이 확인한 메일은 한 통뿐이라 더 보내는 것은 막았어요.'); // 이미 한 통 보낸 차례
    return deny('주인이 확인한 차례가 아니라서 막았어요. 먼저 내용을 보여 주고 물어본 뒤, 주인이 "네" 하면 그때 하세요.');
  }
  if (!Array.isArray(g.tools) || !g.tools.includes(j.tool_name)) return deny('주인이 확인한 일과 다른 도구라서 막았어요.');
  const shown = new Set((g.emails || []).map((e) => String(e).toLowerCase()));
  const extra = [...new Set((JSON.stringify(j.tool_input || {}).match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].filter((e) => !shown.has(e));
  if (extra.length) return deny(`주인에게 보여 주지 않은 주소(${extra.join(', ')})가 있어서 막았어요. 받는 사람 주소를 모두 보여 주고 다시 물어보세요.`);
  if (g.once) { try { fs.renameSync(gate, `${gate}.used`); } catch { return deny('주인이 확인한 메일은 한 통뿐이라 더 보내는 것은 막았어요.'); } }
  process.exit(0);
});
