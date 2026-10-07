// PWA 아이콘 만들기: node make-icons.js  → public/icons/icon-192.png, icon-512.png (Node 내장 zlib 만 사용)
// 화면 왼쪽 위 로고와 같은 모양: 파랑→보라 바탕에 흰 "S", S 의 두 끝에 점(노드), 오른쪽 위에 금빛 반짝이.
// 그림은 모두 바탕 한가운데 원(반지름 40%) 안에 있어서, 폰이 모서리를 둥글게/동그랗게 잘라도(maskable) 안 잘린다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG1 = [37, 99, 235], BG2 = [124, 58, 237], FG = [255, 255, 255], GOLD = [253, 230, 138]; // #2563eb → #7c3aed (왼쪽 위 → 오른쪽 아래), 흰색, #fde68a
const SS = 4; // 한 픽셀을 4x4 로 쪼개 그려서 가장자리를 부드럽게

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length), t = Buffer.from(type);
  out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}
function png(n, rgb) { // n x n, 8비트 RGB
  const raw = Buffer.alloc((n * 3 + 1) * n); // 줄마다 맨 앞 1바이트는 필터 종류(0 = 없음)
  for (let y = 0; y < n; y++) rgb.copy(raw, y * (n * 3 + 1) + 1, y * n * 3, (y + 1) * n * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// "S" = 위아래로 쌓은 두 개의 고리에서 각각 한쪽을 터 놓은 모양 (끝은 둥글게)
function sDist(x, y, n) { // (x, y) 에서 S 의 가장자리까지 거리 (안쪽이면 음수)
  const r = 0.105 * n, half = 0.048 * n, cx = n / 2, cy = n / 2; // 고리 반지름 · 획 두께의 절반 (전체 높이는 바탕의 약 52%)
  const ring = (ox, oy, from, to) => { // from → to 각도(도, 화면 기준 0°=오른쪽·90°=아래)로 각도가 커지는 쪽 호. 호 밖이면 끝점(둥근 머리)까지의 거리
    const dx = x - ox, dy = y - oy, len = Math.hypot(dx, dy);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI, a = ((ang - from) % 360 + 360) % 360, span = ((to - from) % 360 + 360) % 360;
    if (a <= span) return Math.abs(len - r) - half;
    const e = (d) => Math.hypot(x - (ox + r * Math.cos((d * Math.PI) / 180)), y - (oy + r * Math.sin((d * Math.PI) / 180))) - half;
    return Math.min(e(from), e(to));
  };
  // 위 고리: 맨 아래(90°)에서 왼쪽·위를 돌아 오른쪽 위(330°)까지 / 아래 고리: 맨 위(270°)에서 오른쪽·아래를 돌아 왼쪽 아래(150°)까지
  const dot = (d, oy) => Math.hypot(x - (cx + r * Math.cos((d * Math.PI) / 180)), y - (oy + r * Math.sin((d * Math.PI) / 180))) - 0.062 * n; // S 의 두 끝(330°·150°)의 점
  return Math.min(ring(cx, cy - r, 90, 330), ring(cx, cy + r, 270, 150), dot(330, cy - r), dot(150, cy + r));
}
// 네 갈래 반짝이: |u|^q + |v|^q <= s^q (q < 1 이면 가운데가 오목한 별 모양)
const sparkle = (x, y, n) => { const u = Math.abs(x - 0.73 * n), v = Math.abs(y - 0.27 * n), s = 0.07 * n, q = 0.55; return u ** q + v ** q <= s ** q; };

function icon(n) {
  const rgb = Buffer.alloc(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let hit = 0, gold = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      if (sDist(px, py, n) <= 0) hit++; else if (sparkle(px, py, n)) gold++;
    }
    const k = hit / (SS * SS), g = gold / (SS * SS), t = (x + y) / (2 * n); // t: 바탕 그러데이션 위치
    for (let c = 0; c < 3; c++) { const bg = BG1[c] + (BG2[c] - BG1[c]) * t; rgb[(y * n + x) * 3 + c] = Math.round(bg + (FG[c] - bg) * k + (GOLD[c] - bg) * g); }
  }
  return png(n, rgb);
}

const dir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const n of [192, 512]) { fs.writeFileSync(path.join(dir, `icon-${n}.png`), icon(n)); console.log(`public/icons/icon-${n}.png`); }
