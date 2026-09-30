/* 화면과 게임 진행 */
const CFGA = window.THIRTEEN_CONFIG || {};

let worker = null, workerOk = false, reqId = 0;
const pending = new Map();
try {
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (p) { pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); }
  };
  worker.onerror = () => { workerOk = false; };
  workerOk = true;
} catch (_) { workerOk = false; }

let mainRunner = null;   // 워커를 못 쓸 때 메인 스레드용

function ask(msg) {
  if (workerOk) {
    const id = ++reqId;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ ...msg, id }); });
  }
  return new Promise((res, rej) => setTimeout(() => {
    try {
      if (msg.cmd === 'model') {
        if (msg.buf) { mainRunner = new NetRunner(parseWeights(msg.buf)); res({ H: mainRunner.net.H }); }
        else { mainRunner = null; res({ H: 0 }); }
      } else if (msg.cmd === 'think') {
        const r = mainRunner ? ismctsNN(msg.state, msg.iters, mainRunner, msg.blend)
                             : ismctsPlain(msg.state, msg.iters);
        const total = r.stats.reduce((a, s) => a + s.visits, 0) || 1;
        res({ move: r.move, stats: r.stats.slice(0, 4).map(s => ({ move: s.move, share: s.visits / total })) });
      } else if (msg.cmd === 'value') {
        if (!mainRunner) return res({ value: null });
        const vals = new Float32Array(msg.state.n);
        mainRunner.values(msg.state, vals);
        res({ value: vals[msg.seat] * POINT_SCALE });
      }
    } catch (e) { rej(e); }
  }, 20));
}

/* ───────── 저장 (IndexedDB) ───────── */
const DB = 'thirteen-trainer';
function idb(mode, fn) {
  return new Promise((res, rej) => {
    let rq;
    try { rq = indexedDB.open(DB, 1); } catch (e) { return rej(e); }
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction('kv', mode);
      const out = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : null); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    };
  });
}
const saveModel = (buf, name) => idb('readwrite', (st) => { st.put(buf, 'weights'); st.put(name, 'name'); });
const dropModel = () => idb('readwrite', (st) => { st.delete('weights'); st.delete('name'); });
async function loadSavedModel() {
  try {
    const buf = await idb('readonly', (st) => st.get('weights'));
    const name = await idb('readonly', (st) => st.get('name'));
    return buf ? { buf, name: name || 'weights.bin' } : null;
  } catch (_) { return null; }
}

/* ───────── 상태 ───────── */
const UI = {
  state: null, nPlayers: 4, iters: 600, blend: 0.5,
  selected: new Set(), busy: false, running: false, ended: false, modelName: null, modelH: 0,
  rec: null,                          /* 이번 판의 시작 패와 수순 */
  cleared: null,                      /* 아무도 못 이겨서 돈 직전의 패 */
  totals: [0, 0, 0, 0], games: 0, logLines: [],
};
const $ = (id) => document.getElementById(id);
const SEAT_NAME = (p) => (p === 0 ? '나' : 'AI ' + p);

/* '나이(가)' 처럼 어색하지 않게 조사를 붙인다.
   숫자로 끝나면 읽는 소리 기준 — AI 1이 / AI 2가 */
const DIGIT_JONG = [true, true, false, true, false, false, true, true, true, false]; /* 영 일 이 삼 사 오 육 칠 팔 구 */
function withSubj(name) {
  if (name === '나') return '내가';
  const last = name[name.length - 1];
  const code = name.charCodeAt(name.length - 1);
  let jong;
  if (last >= '0' && last <= '9') jong = DIGIT_JONG[+last];
  else if (code >= 0xac00 && code <= 0xd7a3) jong = (code - 0xac00) % 28 !== 0;
  else return name + '이(가)';
  return name + (jong ? '이' : '가');
}

function say(html) {
  UI.logLines.push(html);
  if (UI.logLines.length > 120) UI.logLines.shift();
  const el = $('log');
  el.innerHTML = UI.logLines.map((l) => `<div>${l}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function cardHtml(c, extra) {
  const r = c >> 2, s = c & 3;
  const cls = (s === 1 || s === 2) ? 'red' : 'blk';
  return `<span class="card ${cls} ${extra || ''}"><span class="rk">${RANK_STR[r]}</span><span class="st">${SUIT_SYM[s]}</span></span>`;
}
const cardsText = (mask) => maskCards(mask).map((c) => RANK_STR[c >> 2] + SUIT_SYM[c & 3]).join(' ');

/* ───────── 렌더 ───────── */
function render() {
  const s = UI.state;
  if (!s) return;

  /* 상대 자리 */
  const seats = $('seats');
  seats.innerHTML = '';
  for (let p = 1; p < s.n; p++) {
    const n = popc(s.hand[p]);
    const d = document.createElement('div');
    d.className = 'seat' + (s.turn === p && s.winner < 0 ? ' active' : '');
    let note = '';
    if (s.winner === p) note = '<span class="state warn">승리</span>';
    else if (n === 1) note = '<span class="state warn">땁</span>';
    else if (n === 2) note = '<span class="state warn">투카드</span>';
    else if (s.passed[p]) note = '<span class="state">패스</span>';
    else note = '<span class="state">&nbsp;</span>';
    d.innerHTML = `<div class="who"><span>${SEAT_NAME(p)}</span><span class="cnt">${n}장</span></div>
      <div class="backs">${'<span class="back"></span>'.repeat(Math.min(n, 13))}</div>${note}`;
    seats.appendChild(d);
  }

  /* 바닥 */
  const lead = s.last.type === PASS;
  /* 아무도 못 이겨서 돈 판이면, 그 패를 흐리게 남겨 둔다 */
  const cl = lead && UI.cleared ? UI.cleared : null;
  $('pile').classList.toggle('cleared', !!cl);
  $('pileLabel').textContent = lead ? '선' : '바닥';
  $('pileCards').innerHTML = cl
    ? cl.cards.map((c) => cardHtml(c, 'sm done')).join('')
    : (lead ? '' : maskCards(s.last).map((c) => cardHtml(c, 'sm')).join(''));
  if (lead) {
    $('pileMeta').textContent = cl
      ? `${SEAT_NAME(cl.seat)}의 ${TYPE_NAME[cl.type]} — 아무도 못 이김`
      : (maskEmpty(s.mustInclude)
          ? `${withSubj(SEAT_NAME(s.lastPlayer))} 원하는 족보를 냅니다`
          : `첫 수 — ${cardsText(s.mustInclude)} 를 포함해서 내야 해요`);
  } else {
    $('pileMeta').textContent = `${SEAT_NAME(s.lastPlayer)}의 ${TYPE_NAME[s.last.type]}`;
  }

  /* 내 패 */
  const myTurn = s.turn === 0 && s.winner < 0;
  const legal = myTurn ? legalMoves(s) : [];
  const playable = new Set();
  for (const m of legal) for (const c of maskCards(m)) playable.add(c);

  const hand = $('hand');
  hand.innerHTML = '';
  for (const c of maskCards(s.hand[0])) {
    const b = document.createElement('button');
    const r = c >> 2, st = c & 3;
    const cls = (st === 1 || st === 2) ? 'red' : 'blk';
    b.className = `card ${cls}` + (UI.selected.has(c) ? ' sel' : '') + (myTurn && !playable.has(c) ? ' dim' : '');
    b.innerHTML = `<span class="rk">${RANK_STR[r]}</span><span class="st">${SUIT_SYM[st]}</span>`;
    b.setAttribute('aria-label', RANK_STR[r] + ' ' + SUIT_SYM[st]);
    b.setAttribute('aria-pressed', UI.selected.has(c) ? 'true' : 'false');
    b.disabled = !myTurn || UI.busy;
    b.onclick = () => { UI.selected.has(c) ? UI.selected.delete(c) : UI.selected.add(c); render(); };
    hand.appendChild(b);
  }
  $('myCount').textContent = popc(s.hand[0]) + '장';

  /* 판정 */
  const v = $('verdict');
  let chosen = null;
  if (s.winner >= 0) {
    v.className = 'verdict';
    v.textContent = '게임 종료';
  } else if (!myTurn) {
    v.className = 'verdict';
    v.textContent = UI.busy ? `${SEAT_NAME(s.turn)} 생각 중…` : `${SEAT_NAME(s.turn)} 차례`;
  } else if (UI.selected.size === 0) {
    v.className = 'verdict';
    const ttap = ttapActive(s);
    v.textContent = ttap ? '다음 사람이 땁! 최선을 내야 해요' : '카드를 골라 주세요';
  } else {
    const want = maskFromCards([...UI.selected]);
    chosen = legal.find((m) => m.type !== PASS && maskEq(m, want)) || null;
    if (chosen) { v.className = 'verdict ok'; v.textContent = TYPE_NAME[chosen.type] + ' — 낼 수 있어요'; }
    else { v.className = 'verdict no'; v.textContent = '낼 수 없는 조합이에요'; }
  }
  UI.chosen = chosen;

  $('btnPlay').disabled = !chosen || UI.busy;
  $('btnPass').disabled = !myTurn || UI.busy || !legal.some((m) => m.type === PASS);
  $('btnHint').disabled = !myTurn || UI.busy;
  $('btnClearSel').disabled = UI.selected.size === 0;

  /* 점수표 */
  const rows = ['<tr><th>자리</th><th>누적</th><th>남은 장수</th></tr>'];
  for (let p = 0; p < s.n; p++) {
    const t = UI.totals[p];
    rows.push(`<tr><td>${SEAT_NAME(p)}</td><td class="${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}">${t > 0 ? '+' : ''}${t}</td><td>${popc(s.hand[p])}</td></tr>`);
  }
  $('scoreTable').innerHTML = rows.join('');
}

function banner(text) {
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text;
  b.classList.remove('hidden');
}

/* ───────── 진행 ───────── */
function announce(p, before, after) {
  if (after === 2 && before > 2) say(`<b>${SEAT_NAME(p)}</b> 투카드!`);
  if (after === 1 && before > 1) say(`<b>${SEAT_NAME(p)}</b> 땁!`);
}

function applyMove(p, m) {
  const s = UI.state;
  const before = popc(s.hand[p]);
  if (UI.rec) UI.rec.moves.push({ s: p, c: m.type === PASS ? [] : maskCards(m) });
  if (m.type === PASS) say(`${SEAT_NAME(p)} 패스`);
  else say(`<b>${SEAT_NAME(p)}</b> ${TYPE_NAME[m.type]} · ${cardsText(m)}`);
  const wasLead = s.last.type === PASS;
  if (m.type !== PASS) UI.cleared = null;
  doMove(s, m);
  if (m.type !== PASS) announce(p, before, popc(s.hand[p]));
  if (m.type === PASS && s.last.type === PASS && !wasLead) say(`— 모두 패스, ${withSubj(SEAT_NAME(s.turn))} 선 —`);
}

/* ───────── 아무도 못 이기는 수 ─────────
 * 남은 사람들이 어차피 패스밖에 못 하는 수를 냈으면, 눌러 주지 않아도 넘어갑니다.
 * 무슨 패로 돌았는지 볼 수 있게 잠깐 세웠다가 패스를 차례로 보여 줘요. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autoPassIfUnbeatable() {
  const s = UI.state;
  if (s.winner >= 0 || s.last.type === PASS) return false;
  if (!nobodyCanBeat(s, s.last)) return false;

  UI.cleared = { cards: maskCards(s.last), type: s.last.type, seat: s.lastPlayer };
  render();
  banner(`${SEAT_NAME(s.lastPlayer)}의 ${TYPE_NAME[s.last.type]} — 아무도 못 이기는 수`);
  await sleep(750);                       /* 무슨 패를 냈는지 보는 시간 */
  say('— 아무도 못 이기는 수 —');
  while (s.winner < 0 && s.last.type !== PASS) {
    applyMove(s.turn, PASS_MOVE);
    render();
    await sleep(170);
  }
  banner('');
  return true;
}

async function aiTurn() {
  if (UI.running) return;
  UI.running = true;
  const s = UI.state;
  UI.busy = true; render();
  await autoPassIfUnbeatable();           /* 사람이 낸 수가 못 이기는 수였던 경우 */
  while (s.winner < 0 && s.turn !== 0) {
    const p = s.turn;
    let r;
    try {
      r = await ask({ cmd: 'think', state: s, iters: UI.iters, blend: UI.blend });
    } catch (e) {
      say(`AI 오류: ${e.message}`);
      const ms = legalMoves(s);
      r = { move: ms[0] };
    }
    applyMove(p, r.move);
    render();
    await sleep(300);
    await autoPassIfUnbeatable();         /* AI 가 낸 수가 못 이기는 수였던 경우 */
  }
  UI.busy = false;
  UI.running = false;
  if (s.winner >= 0) endGame();
  else { await refreshEval(); render(); }
}

async function refreshEval() {
  const chip = $('evalChip');
  const s = UI.state;
  if (!UI.modelName || s.winner >= 0) { chip.classList.add('hidden'); return; }
  try {
    const r = await ask({ cmd: 'value', state: s, seat: 0 });
    if (r.value === null || r.value === undefined) { chip.classList.add('hidden'); return; }
    const v = r.value;
    chip.textContent = `판세 예측 ${v >= 0 ? '+' : ''}${v.toFixed(1)}점`;
    chip.classList.remove('hidden');
  } catch (_) { chip.classList.add('hidden'); }
}

function endGame() {
  const s = UI.state;
  if (UI.ended) return;
  UI.ended = true;
  const pts = finalPoints(s);
  for (let p = 0; p < s.n; p++) UI.totals[p] += pts[p];
  UI.games++;
  const me = pts[0];
  say(`<b>${SEAT_NAME(s.winner)} 승리</b> — ` +
      Array.from({ length: s.n }, (_, p) => `${SEAT_NAME(p)} ${pts[p] > 0 ? '+' : ''}${pts[p]}`).join(' / '));
  banner(s.winner === 0 ? `이겼어요! +${me}점` : `${SEAT_NAME(s.winner)} 승리 — 이번 판 ${me > 0 ? '+' : ''}${me}점`);
  $('evalChip').classList.add('hidden');
  render();
  recordGame(me, s.winner === 0);
  logSoloGame();
}

/* ───────── 대국 기록 보내기 ─────────
 * 설정에서 끄면 보내지 않습니다. 서버가 수순을 다시 둬 보며 규칙에 맞는지 확인해요. */
const loggingOn = () => {
  try { return localStorage.getItem('thirteen-nolog') !== '1'; } catch (_) { return true; }
};
async function logSoloGame() {
  const fn = CFGA.SUPABASE_URL && CFGA.SUPABASE_ANON_KEY
    ? CFGA.SUPABASE_URL + '/functions/v1/thirteen' : '';
  if (!fn || !loggingOn() || !UI.rec || !UI.rec.moves.length) return;
  const payload = {
    action: 'log_solo', deal: UI.rec.deal, moves: UI.rec.moves, seat: 0,
    name: (ACC.rec && ACC.rec.username) || '나',
  };
  UI.rec = null;
  try {
    /* 누구의 기록인지는 서버가 로그인 토큰으로 직접 확인합니다 */
    let auth = 'Bearer ' + CFGA.SUPABASE_ANON_KEY;
    if (ACC.sb) {
      const { data } = await ACC.sb.auth.getSession();
      if (data && data.session && data.session.access_token) auth = 'Bearer ' + data.session.access_token;
    }
    await fetch(fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFGA.SUPABASE_ANON_KEY,
        Authorization: auth,
      },
      body: JSON.stringify(payload),
    });
    if (typeof myOnGameEnd === 'function') myOnGameEnd();
  } catch (_) { /* 기록 실패는 조용히 넘어감 */ }
}

async function humanPlay(move) {
  UI.selected.clear();
  applyMove(0, move);
  banner('');
  $('hintPanel').classList.add('hidden');
  render();
  if (UI.state.winner >= 0) { endGame(); return; }
  await aiTurn();
}

async function newGame() {
  seedRng(randomSeed());              /* 판마다 새로 섞기 */
  UI.state = initState(UI.nPlayers);
  UI.rec = { deal: UI.state.hand.slice(0, UI.nPlayers).map(maskCards), moves: [] };
  UI.cleared = null;
  UI.ended = false;
  UI.running = false;
  UI.busy = false;
  UI.selected.clear();
  UI.logLines = [];
  banner('');
  $('hintPanel').classList.add('hidden');
  const s = UI.state;
  say(`— ${s.n}인 게임 시작 · ${withSubj(SEAT_NAME(s.turn))} 선 —`);
  render();
  if (s.turn !== 0) await aiTurn(); else await refreshEval();
  render();
}

/* ───────── 이벤트 ───────── */
$('btnNew').onclick = () => { if (!UI.busy) newGame(); };
$('btnSettings').onclick = () => $('settings').classList.toggle('hidden');
$('btnClearSel').onclick = () => { UI.selected.clear(); render(); };
$('btnPlay').onclick = () => { if (UI.chosen) humanPlay(UI.chosen); };
$('btnPass').onclick = () => {
  const m = legalMoves(UI.state).find((x) => x.type === PASS);
  if (m) humanPlay(m);
};
$('btnHint').onclick = async () => {
  UI.busy = true; render();
  try {
    const r = await ask({ cmd: 'think', state: UI.state, iters: Math.max(300, UI.iters), blend: UI.blend });
    $('hintList').innerHTML = r.stats.map((h) => {
      const label = h.move.type === PASS ? '패스' : `${TYPE_NAME[h.move.type]} · ${cardsText(h.move)}`;
      return `<div class="hintrow"><span class="mv">${label}</span>
        <span class="bar-wrap"><span class="bar-fill" style="width:${Math.round(h.share * 100)}%"></span></span>
        <span class="pct">${(h.share * 100).toFixed(0)}%</span></div>`;
    }).join('');
    $('hintPanel').classList.remove('hidden');
  } catch (e) { say(`힌트 오류: ${e.message}`); }
  UI.busy = false; render();
};
$('selPlayers').onchange = (e) => { UI.nPlayers = +e.target.value; UI.totals = [0, 0, 0, 0]; };
$('rngIters').oninput = (e) => { UI.iters = +e.target.value; $('valIters').textContent = e.target.value; };
$('rngBlend').oninput = (e) => {
  UI.blend = +e.target.value / 100;
  $('valBlend').textContent = UI.blend === 0 ? '롤아웃' : UI.blend === 1 ? '가치망' : UI.blend === 0.5 ? '반반' : UI.blend.toFixed(1);
};
$('btnLoad').onclick = () => $('fileModel').click();
$('fileModel').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    parseWeights(buf);                       // 형식 검사
    await useModel(buf, f.name);
    try { await saveModel(buf, f.name); } catch (_) {}
    say(`모델 적용: ${f.name}`);
  } catch (err) {
    $('modelNote').textContent = '불러오지 못했어요 — ' + err.message;
  }
};
$('btnClear').onclick = async () => {
  await useModel(null, null);
  try { await dropModel(); } catch (_) {}
  say('기본 탐색 AI로 돌아갔어요');
};

async function useModel(buf, name) {
  const r = await ask({ cmd: 'model', buf: buf ? buf.slice(0) : null });
  UI.modelName = name;
  UI.modelH = r.H || 0;
  const chip = $('modelChip'), lbl = $('modelLabel');
  if (name) {
    lbl.textContent = `${name} · 은닉 ${UI.modelH}`;
    chip.classList.add('on');
    $('btnClear').classList.remove('hidden');
    $('engineChip').textContent = '신경망 ISMCTS';
    $('modelNote').textContent = '이 브라우저에 저장돼 있어요. 다른 파일을 올리면 교체돼요.';
  } else {
    lbl.textContent = '기본 탐색 AI';
    chip.classList.remove('on');
    $('btnClear').classList.add('hidden');
    $('engineChip').textContent = 'ISMCTS';
    $('modelNote').textContent = '학습한 weights.bin 을 올리면 그 신경망이 AI를 이끌어요. 파일은 이 브라우저에만 저장되고 어디로도 전송되지 않아요.';
  }
  await refreshEval();
  render();
}

/* ───────── 시작 ───────── */
(async () => {
  $('valBlend').textContent = '반반';
  initAccount().catch(() => { ACC.ready = true; ACC.rec = localRec(); renderAccount(); renderBoard(); });

  /* 사이트에 올려둔 모델을 먼저 쓰고, 없으면 이 브라우저에 저장해 둔 모델을 씁니다. */
  let loaded = false;
  if (CFGA.MODEL_URL) {
    try {
      const res = await fetch(CFGA.MODEL_URL, { cache: 'no-cache' });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        parseWeights(buf);
        await useModel(buf, '기본 모델');
        loaded = true;
      }
    } catch (_) {}
  }
  if (!loaded) {
    const saved = await loadSavedModel();
    if (saved) { try { await useModel(saved.buf, saved.name); loaded = true; } catch (_) {} }
  }
  await newGame();
})();
