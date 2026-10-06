// 화면용 저장소 도우미 — 모든 업무 화면이 이 파일 하나로 data/db/<이름>.json 을 읽고 쓴다.
//   db.list('events')                       → 목록(배열)
//   db.save('events', 'e1', { title: '…' }) → 저장·수정 (같은 id 면 통째로 바꿈)
//   db.remove('events', 'e1')               → 삭제
//   db.watch('events', () => 다시그리기())  → 파일이 바뀌면(AI 가 직접 고쳐도) 부름. 끄는 함수를 돌려줌
(() => {
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `요청 실패 (${r.status})`);
    return j;
  }
  const url = (name, id) => `/api/db/${encodeURIComponent(name)}${id === undefined ? '' : '/' + encodeURIComponent(id)}`;

  const watchers = new Map(); // 이름 -> 부를 함수들
  let es = null, opened = false;
  function connect() { // 연결은 화면당 하나만 열어 모두가 나눠 쓴다
    es = new EventSource('/api/events');
    es.addEventListener('db', (e) => (watchers.get(JSON.parse(e.data).name) || []).forEach((f) => f()));
    // 끊겼다 다시 이어지면 그 사이 바뀐 걸 놓쳤을 수 있으니 모두에게 알린다 (맨 처음 연결은 제외)
    es.onopen = () => { if (opened) watchers.forEach((set) => set.forEach((f) => f())); opened = true; };
  }

  window.db = {
    list: (name) => call('GET', url(name)),
    save: (name, id, data) => call('PUT', url(name, id), data),
    remove: (name, id) => call('DELETE', url(name, id)),
    watch(name, fn) {
      if (!es) connect();
      if (!watchers.has(name)) watchers.set(name, new Set());
      watchers.get(name).add(fn);
      return () => watchers.get(name).delete(fn);
    },
  };
})();
