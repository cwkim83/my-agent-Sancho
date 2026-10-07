// 목소리 계산 — 화면을 그리지 않는 순수 함수만 모았다 (selftest 가 이 파일을 그대로 불러다 검사한다).
//   vlib.wake('산초야 오늘 일정') → { ok: true, rest: '오늘 일정' }  호출어 "산초야"로 *시작하는* 말만 ok. 음성 인식이 이름을 다르게 적은 비슷한 소리(산초·산쵸·잔초·산조야 …)도 받는다
//   vlib.speechText(마크다운, 최대글자) → 소리 내어 읽기 좋은 글 (코드·표·링크 주소·진행 표시 줄을 빼고, 문장 끝에서 자른다)
//   vlib.chunks(글, 크기) → 브라우저 목소리가 중간에 끊기지 않게 문장 단위로 나눈 조각들
(() => {
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ', JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  // 글자 → 소리 조각들. 자리(첫소리 i·가운뎃소리 v·받침 f)를 같이 적어서 "첫소리 ㅇ(소리 없음)"과 "받침 ㅇ" 이 섞이지 않게 한다
  const jamo = (str) => [...str].flatMap((ch) => { const c = ch.charCodeAt(0) - 0xac00; return c < 0 || c > 11171 ? [['x', ch]] : [['i', CHO[Math.floor(c / 588)]], ['v', JUNG[Math.floor((c % 588) / 28)]], ...(c % 28 ? [['f', JONG[c % 28]]] : [])]; });
  // 소리가 비슷해서 음성 인식이 곧잘 바꿔 적는 짝 (이 안에서 바뀌면 "작은 틀림" 0.4, 그 밖은 "큰 틀림" 1)
  const SOFT = { i: ['ㅅㅆㅈㅊㅉ'], v: ['ㅏㅑ', 'ㅗㅛㅜㅠ', 'ㅓㅕ', 'ㅐㅔ'], f: ['ㄴㅇㅁ'] };
  const subCost = (a, b) => (a[0] !== b[0] ? 1 : a[1] === b[1] ? 0 : (SOFT[a[0]] || []).some((g) => g.includes(a[1]) && g.includes(b[1])) ? 0.4 : 1);
  function dist(a, b) { // 가중 편집 거리 (넣기·빼기는 1)
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
    return d[a.length][b.length];
  }
  const W3 = jamo('산초야'), W2 = jamo('산초');
  const LIMIT = 0.85; // 작은 틀림 둘까지는 받고(0.8), 큰 틀림 하나(난초야·산책)는 안 받는다
  const PUNCT = /[\s.,!?~…·'"“”‘’()\-]/;

  function wake(text) {
    const s = String(text ?? '');
    const lat = /^[\s.,!?~…]*sancho\b[\s.,!?~…]*/i.exec(s);
    if (lat) return { ok: true, rest: s.slice(lat[0].length).trim() };
    const letters = []; // 맨 앞 글자 4개 (공백·문장부호는 건너뛴다): [글자, 원래 글에서의 자리]
    for (let i = 0; i < s.length && letters.length < 4; i++) if (!PUNCT.test(s[i])) letters.push([s[i], i]);
    const edge = (k) => letters[k] === undefined ? true : s[letters[k][1] + 1] === undefined || PUNCT.test(s[letters[k][1] + 1]); // 그 글자 바로 뒤가 끝이거나 띄어쓰기·부호인가 (낱말이 이어지지 않는가)
    const head = (n) => jamo(letters.slice(0, n).map((l) => l[0]).join(''));
    let used = 0;
    if (letters.length >= 3 && edge(2) && dist(head(3), W3) <= LIMIT) used = 3; // "산초야" 꼴 (야 뒤에 낱말이 이어 붙은 "산초 아침" 같은 것은 아님)
    else if (letters.length >= 2 && dist(head(2), W2) <= LIMIT) { // "산초" 꼴
      used = 2;
      if (letters[2] && '야아가여'.includes(letters[2][0]) && edge(2)) used = 3; // 인식기가 붙인 군더더기 "산초가 …"
    }
    if (!used) return { ok: false, rest: '' };
    return { ok: true, rest: s.slice(letters[used - 1][1] + 1).replace(/^[\s.,!?~…·]+/, '').trim() };
  }

  // 답(마크다운) → 읽기 좋은 글
  function speechText(md, max = 1500) {
    let t = String(md ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^[ \t]*(⏺|●|⚠|🔧|✅|↩)[^\n]*$/gm, ' ') // 도구 진행·검사 알림 줄
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
      .replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ') // 표
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '').replace(/^[ \t]*[-*+•][ \t]+/gm, '').replace(/^[ \t]*\d+\.[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/[*_`~#|]+/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max), k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다.'), cut.lastIndexOf('요.'), cut.lastIndexOf('\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return (k > max * 0.5 ? cut.slice(0, k + 1) : cut).trim();
  }

  function chunks(text, size = 170) { // 문장 단위로 모으되 size 를 넘지 않게. 아주 긴 문장은 쉼표·띄어쓰기에서 자른다
    const out = []; let cur = '';
    for (const part of String(text ?? '').match(/[^.!?。…\n]+[.!?。…]*\s*/g) || []) {
      if (cur && (cur + part).length > size) { out.push(cur.trim()); cur = ''; }
      cur += part;
      while (cur.length > size) { let k = Math.max(cur.lastIndexOf(',', size), cur.lastIndexOf(' ', size)); if (k < 40) k = size - 1; out.push(cur.slice(0, k + 1).trim()); cur = cur.slice(k + 1); }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }

  window.vlib = { jamo, dist, wake, speechText, chunks };
})();
