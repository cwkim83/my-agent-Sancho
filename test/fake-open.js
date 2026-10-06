// 점검용 가짜 "열기": 진짜 워드·엑셀을 띄우지 않고, 열라고 한 파일 경로를 기록만 한다 (SANCHO_OPEN_SCRIPT 로 server.js 에 연결)
require('fs').appendFileSync(process.env.SANCHO_OPEN_LOG, process.argv[2] + '\n');
