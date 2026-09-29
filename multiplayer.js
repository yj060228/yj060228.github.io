/* 친구와 대전 — 서버(Edge Function)가 심판을 보는 온라인 대국 */
const MP = {
  code: null, token: null, playerId: null, seat: null,
  state: null, hand: [], selected: new Set(),
  sub: null, poll: null, tick: null, busy: false, err: '',
  name: '', codeInput: '',          /* 입력칸 내용. 화면을 다시 그려도 유지되게 */
  cash: false, stake: 100,          /* 캐시 게임 설정 */
};
const MPCFG = window.THIRTEEN_CONFIG || {};
const FN_URL = MPCFG.SUPABASE_URL ? MPCFG.SUPABASE_URL + '/functions/v1/thirteen' : '';
const mpReady = () => !!(FN_URL && MPCFG.SUPABASE_ANON_KEY);

/* ───────── 서버 호출 ─────────
 * 로그인했으면 내 로그인 토큰을 같이 보냅니다.
 * 서버는 이 토큰으로 "누가 보냈는지"를 직접 확인해요. 그래서 남의 계정을 적어 보내도 소용이 없습니다. */
async function mpAuthHeader() {
  try {
    if (ACC.sb) {
      const { data } = await ACC.sb.auth.getSession();
      if (data && data.session && data.session.access_token) {
        return 'Bearer ' + data.session.access_token;
      }
    }
  } catch (_) {}
  return 'Bearer ' + MPCFG.SUPABASE_ANON_KEY;
}

async function mpCall(action, extra) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: MPCFG.SUPABASE_ANON_KEY,
      Authorization: await mpAuthHeader(),
    },
    body: JSON.stringify({ action, ...extra }),
  });
  const data = await res.json().catch(() => ({ error: '서버 응답을 읽지 못했어요.' }));
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

function mpSave() {
  try {
    if (MP.token) localStorage.setItem('thirteen-mp', JSON.stringify({ code: MP.code, token: MP.token, playerId: MP.playerId }));
    else localStorage.removeItem('thirteen-mp');
  } catch (_) {}
}
function mpLoad() {
  try { return JSON.parse(localStorage.getItem('thirteen-mp') || 'null'); } catch (_) { return null; }
}

/* ───────── 내 관점의 상태 복원 (합법 수 계산용) ───────── */
function mpBuildState() {
  const st = MP.state;
  const seated = st.players.filter((p) => p.seat !== null && p.seat !== undefined);
  const n = seated.length || st.nPlayers;
  const mine = maskFromCards(MP.hand);
  const played = maskFromCards(st.played);
  const last = st.lead
    ? { lo: 0, hi: 0, type: PASS, key: 0, count: 0, id: -1 }
    : (() => {
        const m = maskFromCards(st.lastCards);
        const hit = genAll(m).find((x) => x.type === st.lastType && maskEq(x, m));
        return { lo: m.lo, hi: m.hi, type: st.lastType, key: hit ? hit.key : 0, count: st.lastCards.length, id: 0 };
      })();

  const s = {
    n, turn: st.turn, winner: st.winner, hand: new Array(n).fill(null),
    played, last, lastPlayer: st.lastPlayer, npass: 0,
    passed: new Array(n).fill(0), mustInclude: maskFromCards(st.mustInclude),
  };
  /* 남의 패는 장수만 맞춘 가짜 패. 규칙 판정에는 장수만 쓰입니다. */
  const unseen = [];
  for (let c = 0; c < 52; c++) {
    const r = c >> 2, b = 1 << (c & 3);
    if ((rankBits(mine, r) & b) || (rankBits(played, r) & b)) continue;
    unseen.push(c);
  }
  let i = 0;
  for (const p of seated) {
    if (p.seat === MP.seat) s.hand[p.seat] = mine;
    else { s.hand[p.seat] = maskFromCards(unseen.slice(i, i + p.cards)); i += p.cards; }
    s.passed[p.seat] = p.passed ? 1 : 0;
  }
  for (let k = 0; k < n; k++) if (!s.hand[k]) s.hand[k] = emptyMask();
  return s;
}

/* ───────── 화면 ───────── */
function mpRender() {
  if (!mpReady()) {
    $('mpBody').innerHTML = '<p class="note">서버가 설정되지 않아 친구와 대전을 쓸 수 없어요. config.js 에 Supabase 주소와 키를 넣어 주세요.</p>';
    return;
  }
  const inRoom = !!MP.token && !!MP.state;
  $('mpTablePanel').classList.toggle('hidden', !inRoom || MP.state.status === 'waiting');
  $('mpScorePanel').classList.toggle('hidden', !inRoom);
  $('mpLogPanel').classList.toggle('hidden', !inRoom || MP.state.status === 'waiting');

  if (!inRoom) { mpRenderLobby(); return; }
  mpRenderRoom();
  if (MP.state.status !== 'waiting') mpRenderTable();
  mpRenderScore();
  $('mpLog').innerHTML = (MP.state.log || []).map((l) => `<div>${esc(l)}</div>`).join('');
  $('mpLog').scrollTop = $('mpLog').scrollHeight;
}

function mpRenderLobby() {
  const pre = new URLSearchParams(location.search).get('room') || '';
  if (!MP.name) MP.name = (ACC.rec && ACC.rec.username) || '';
  if (!MP.codeInput) MP.codeInput = pre;
  $('mpBody').innerHTML = `
    <p class="note">방을 만들어 링크를 보내거나, 받은 코드로 들어가세요. 로그인하면 전적이 쌓이고, 로그인 없이도 참여할 수 있어요.</p>
    <div class="acct">
      <input type="text" id="mpName" maxlength="16" placeholder="닉네임" value="${esc(MP.name)}">
    </div>
    <div class="acct">
      <label class="note" for="mpN">인원</label>
      <select id="mpN"><option value="2">2인</option><option value="3">3인</option><option value="4" selected>4인</option></select>
      <button class="btn primary" id="mpCreate">방 만들기</button>
    </div>
    <div class="cashbox">
      <label class="switch">
        <input type="checkbox" id="mpCash" ${MP.cash ? 'checked' : ''} ${canCash() ? '' : 'disabled'}>
        <span>캐시 게임</span>
      </label>
      <div class="acct${MP.cash ? '' : ' hidden'}" id="mpStakeRow">
        <label class="note" for="mpStake">1점당</label>
        <select id="mpStake">${STAKES.map((s) =>
          `<option value="${s}"${s === MP.stake ? ' selected' : ''}>${s.toLocaleString()}코인</option>`).join('')}</select>
        <span class="note" id="mpBuyin">바이인 ${(MP.stake * 100).toLocaleString()}코인</span>
      </div>
      <p class="note">${canCash()
        ? '벌점 1점당 고른 금액만큼 참가자끼리 주고받아요. 판을 시작할 때 100점분(바이인)이 잠시 묶이고, 한 판에 잃는 금액은 그 안에서 끝나요.'
        : '캐시 게임은 로그인해야 쓸 수 있어요.'}</p>
    </div>
    <div class="acct">
      <input type="text" id="mpCode" maxlength="4" placeholder="방 코드" value="${esc(MP.codeInput)}" style="text-transform:uppercase;flex:0 1 120px">
      <button class="btn" id="mpJoin">입장</button>
    </div>
    ${MP.err ? `<p class="note" style="color:var(--bad)">${esc(MP.err)}</p>` : ''}`;

  /* 입력한 값을 먼저 읽어 둡니다. 화면을 다시 그리면 입력칸이 새로 만들어지기 때문이에요. */
  $('mpName').oninput = (e) => { MP.name = e.target.value; };
  $('mpCode').oninput = (e) => { MP.codeInput = e.target.value.toUpperCase(); };
  $('mpCash').onchange = (e) => {
    MP.cash = e.target.checked;
    $('mpStakeRow').classList.toggle('hidden', !MP.cash);
  };
  $('mpStake').onchange = (e) => {
    MP.stake = +e.target.value;
    $('mpBuyin').textContent = `바이인 ${(MP.stake * 100).toLocaleString()}코인`;
  };

  $('mpCreate').onclick = () => {
    const name = ($('mpName').value || '').trim();
    const n = +$('mpN').value;
    MP.name = name;
    mpDo(async () => {
      if (!name) throw new Error('닉네임을 입력해 주세요.');
      mpEnter(await mpCall('create', {
        name, nPlayers: n, noLog: mpNoLog(),
        stake: MP.cash && canCash() ? MP.stake : 0,
      }));
    });
  };
  $('mpJoin').onclick = () => {
    const name = ($('mpName').value || '').trim();
    const code = ($('mpCode').value || '').trim().toUpperCase();
    MP.name = name; MP.codeInput = code;
    mpDo(async () => {
      if (!name) throw new Error('닉네임을 입력해 주세요.');
      if (!code) throw new Error('방 코드를 입력해 주세요.');
      mpEnter(await mpCall('join', { code, name, noLog: mpNoLog() }));
    });
  };
  $('mpCode').onkeydown = (e) => { if (e.key === 'Enter') $('mpJoin').click(); };
  $('mpName').onkeydown = (e) => { if (e.key === 'Enter') ($('mpCode').value.trim() ? $('mpJoin') : $('mpCreate')).click(); };
}
/* 판돈 후보: 100 ~ 10000 코인, 100 단위 */
const STAKES = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];
const canCash = () => !!(ACC.sb && ACC.user);
/* 내 기록 화면에서 저장을 끄면 이 방의 내 기록도 남기지 않는다 */
const mpNoLog = () => (typeof myLoggingOn === 'function' ? !myLoggingOn() : false);

function mpRenderRoom() {
  const st = MP.state;
  const link = location.origin + location.pathname + '?room=' + st.code;
  const isHost = st.hostPlayer === MP.playerId;
  const waiting = st.status === 'waiting';

  $('mpBody').innerHTML = `
    <div class="roomline">
      <span class="code">${esc(st.code)}</span>
      ${st.stake ? `<span class="chip cash">◈ 1점당 ${st.stake.toLocaleString()}</span>` : ''}
      <button class="btn" id="mpCopy">링크 복사</button>
      <button class="btn" id="mpLeave" style="margin-left:auto">방 나가기</button>
    </div>
    <p class="note" id="mpCopyNote">${waiting ? '이 코드나 링크를 친구에게 보내세요.' : `${st.round}번째 판 진행 중`}</p>
    ${st.stake ? `<p class="note">캐시 게임이에요. 판을 시작하면 ${st.buyin.toLocaleString()}코인이 묶이고,
       끝나면 벌점 1점당 ${st.stake.toLocaleString()}코인씩 주고받아요.</p>` : ''}
    ${st.cash ? `<div class="settle"><div class="slabel">정산</div>${st.cash.rows.map((r) => `
      <div class="drow"><span class="dname">${esc(r.name)}</span>
        <span class="note">${r.points > 0 ? '+' : ''}${r.points}점</span>
        <span class="dpt ${r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}">${r.points > 0 ? '+' : ''}${(r.points * st.cash.stake).toLocaleString()}코인</span>
      </div>`).join('')}</div>` : ''}
    <div class="plist">${st.players.map((p) => `
      <div class="prow${!waiting && st.turn === p.seat && st.winner < 0 ? ' turn' : ''}">
        <span>${esc(p.name)}</span>
        ${p.id === st.hostPlayer ? '<span class="tag">방장</span>' : ''}
        ${p.guest ? '<span class="tag">게스트</span>' : ''}
        ${!p.present ? '<span class="tag">나감</span>' : ''}
        ${waiting ? '' : `<span class="cnt">${p.cards}장</span>`}
      </div>`).join('')}</div>
    ${waiting && isHost ? '<div class="acct"><button class="btn primary" id="mpStart">게임 시작</button></div>' : ''}
    ${waiting && !isHost ? '<p class="note">방장이 시작하기를 기다리는 중이에요.</p>' : ''}
    ${MP.err ? `<p class="note" style="color:var(--bad)">${esc(MP.err)}</p>` : ''}`;

  $('mpCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); $('mpCopyNote').textContent = '링크를 복사했어요.'; }
    catch (_) { $('mpCopyNote').textContent = link; }
  };
  $('mpLeave').onclick = () => mpDo(async () => { await mpCall('leave', { token: MP.token }); mpExit(); });
  if ($('mpStart')) $('mpStart').onclick = () => mpDo(async () => { await mpCall('start', { token: MP.token }); await mpRefresh(); });
}

function mpRenderTable() {
  const st = MP.state;
  const myTurn = st.turn === MP.seat && st.winner < 0 && st.status === 'playing';

  $('mpSeats').innerHTML = '';
  $('mpPileLabel').textContent = st.lead ? '선' : '바닥';
  $('mpPileCards').innerHTML = st.lastCards.map((c) => cardHtml(c, 'sm')).join('');
  const lastName = (st.players.find((p) => p.seat === st.lastPlayer) || {}).name || '';
  $('mpPileMeta').textContent = st.winner >= 0
    ? '판이 끝났어요'
    : st.lead
      ? (st.mustInclude.length
          ? `첫 수 — ${st.mustInclude.map((c) => RANK_STR[c >> 2] + SUIT_SYM[c & 3]).join(' ')} 포함`
          : `${(st.players.find((p) => p.seat === st.turn) || {}).name || ''} 선`)
      : `${lastName}의 ${TYPE_NAME[st.lastType]}`;

  const s = mpBuildState();
  const legal = myTurn ? legalMoves(s) : [];
  const playable = new Set();
  for (const m of legal) for (const c of maskCards(m)) playable.add(c);

  const hand = $('mpHand');
  hand.innerHTML = '';
  for (const c of MP.hand.slice().sort((a, b) => a - b)) {
    const b = document.createElement('button');
    const r = c >> 2, su = c & 3;
    b.className = `card ${su === 1 || su === 2 ? 'red' : 'blk'}`
      + (MP.selected.has(c) ? ' sel' : '') + (myTurn && !playable.has(c) ? ' dim' : '');
    b.innerHTML = `<span class="rk">${RANK_STR[r]}</span><span class="st">${SUIT_SYM[su]}</span>`;
    b.disabled = !myTurn || MP.busy;
    b.onclick = () => { MP.selected.has(c) ? MP.selected.delete(c) : MP.selected.add(c); mpRender(); };
    hand.appendChild(b);
  }
  $('mpMyCount').textContent = MP.hand.length + '장';

  const v = $('mpVerdict');
  let chosen = null;
  if (st.winner >= 0) { v.className = 'verdict'; v.textContent = '판 종료'; }
  else if (MP.seat === null || MP.seat === undefined) { v.className = 'verdict'; v.textContent = '관전 중'; }
  else if (!myTurn) {
    v.className = 'verdict';
    v.textContent = `${(st.players.find((p) => p.seat === st.turn) || {}).name || ''} 차례`;
  } else if (MP.selected.size === 0) {
    v.className = 'verdict';
    v.textContent = legal.some((m) => m.type !== PASS) ? '카드를 골라 주세요' : '낼 수 있는 패가 없어요';
  } else {
    const want = maskFromCards([...MP.selected]);
    chosen = legal.find((m) => m.type !== PASS && maskEq(m, want)) || null;
    if (chosen) { v.className = 'verdict ok'; v.textContent = TYPE_NAME[chosen.type] + ' — 낼 수 있어요'; }
    else { v.className = 'verdict no'; v.textContent = '낼 수 없는 조합이에요'; }
  }
  MP.chosen = chosen;
  $('mpPlay').disabled = !chosen || MP.busy;
  $('mpPass').disabled = !myTurn || MP.busy || !legal.some((m) => m.type === PASS);
  $('mpClear').disabled = MP.selected.size === 0;
  $('mpAgain').classList.toggle('hidden', !(st.winner >= 0 && st.hostPlayer === MP.playerId));
}

function mpRenderScore() {
  const st = MP.state;
  const rows = st.players.slice().sort((a, b) => (st.totals[b.id] || 0) - (st.totals[a.id] || 0));
  $('mpScore').innerHTML = '<tr><th style="text-align:left">이름</th><th>누적</th><th>남은 장수</th></tr>'
    + rows.map((p) => {
      const t = st.totals[p.id] || 0;
      return `<tr class="${p.id === MP.playerId ? 'me' : ''}"><td style="text-align:left">${esc(p.name)}</td>
        <td class="${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}">${t > 0 ? '+' : ''}${t}</td>
        <td>${st.status === 'waiting' ? '-' : p.cards}</td></tr>`;
    }).join('');
}

function mpTimer() {
  const el = $('mpTimer');
  if (!el) return;
  const st = MP.state;
  if (!st || st.status !== 'playing' || st.winner >= 0 || !st.deadline) { el.textContent = ''; return; }
  const left = Math.max(0, Math.round((st.deadline - Date.now()) / 1000));
  el.textContent = `${left}초`;
  el.classList.toggle('low', left <= 15);
  if (left === 0) mpRefresh();
}

/* ───────── 동작 ───────── */
async function mpDo(fn) {
  MP.busy = true; MP.err = ''; mpRender();
  try { await fn(); } catch (e) { MP.err = e.message; }
  MP.busy = false; mpRender();
}

function mpEnter(r) {
  MP.code = r.code; MP.token = r.token; MP.playerId = r.playerId;
  MP.state = r.state; MP.hand = r.hand || []; MP.seat = r.seat ?? null;
  MP.selected.clear();
  mpSave();
  mpSubscribe();
  mpRefresh();
}
function mpExit() {
  if (MP.sub) { try { MP.sub.unsubscribe(); } catch (_) {} MP.sub = null; }
  MP.code = MP.token = MP.playerId = null;
  MP.state = null; MP.hand = []; MP.seat = null; MP.selected.clear();
  mpSave();
}

async function mpRefresh() {
  if (!MP.token) return;
  try {
    const r = await mpCall('view', { token: MP.token });
    const before = MP.state && MP.state.winner;
    MP.state = r.state;
    /* 한 판이 막 끝났으면 내 기록과 코인 잔액을 새로 불러온다 */
    if (r.state && r.state.winner >= 0 && before !== undefined && before < 0) {
      if (typeof myOnGameEnd === 'function') myOnGameEnd();
      if (typeof coinRefresh === 'function') coinRefresh();
    }
    MP.seat = r.seat ?? null;
    const same = r.hand.length === MP.hand.length && r.hand.every((c, i) => c === MP.hand[i]);
    if (!same) { MP.hand = r.hand; MP.selected.clear(); }
    MP.err = '';
  } catch (e) {
    MP.err = e.message;
    if (/참가 정보/.test(e.message)) mpExit();
  }
  mpRender();
}

/* 방 상태가 바뀌면 바로 받아오고, 실시간이 막히는 환경을 대비해 주기적으로도 확인 */
function mpSubscribe() {
  if (!ACC.sb || !MP.code) return;
  if (MP.sub) { try { MP.sub.unsubscribe(); } catch (_) {} }
  try {
    MP.sub = ACC.sb.channel('room-' + MP.code)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'code=eq.' + MP.code },
        () => mpRefresh())
      .subscribe();
  } catch (_) { MP.sub = null; }
}

/* ───────── 탭 ───────── */
const TABS = {
  solo: { btn: 'tabSolo', views: ['viewSolo', 'viewSolo2'] },
  mp:   { btn: 'tabMp',   views: ['viewMp'] },
};
function showTab(which) {
  if (!TABS[which]) which = 'solo';
  for (const [key, t] of Object.entries(TABS)) {
    const on = key === which;
    const b = $(t.btn);
    if (b) b.setAttribute('aria-selected', String(on));
    for (const v of t.views) { const el = $(v); if (el) el.hidden = !on; }
  }
  try { localStorage.setItem('thirteen-tab', which); } catch (_) {}
  if (which === 'mp') mpRender();
}
for (const [key, t] of Object.entries(TABS)) {
  const b = $(t.btn);
  if (b) b.onclick = () => showTab(key);
}

/* 규칙은 설정처럼 열고 닫는 패널 */
function toggleRules(open) {
  const el = $('viewRules');
  if (!el) return;
  el.hidden = open === undefined ? !el.hidden : !open;
  if (!el.hidden) {
    if (typeof toggleMyPage === 'function') toggleMyPage(false);
    if (typeof toggleCoins === 'function') toggleCoins(false);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}
if ($('btnRules')) $('btnRules').onclick = () => toggleRules();

$('mpPlay').onclick = () => mpDo(async () => {
  if (!MP.chosen) return;
  const cards = maskCards(MP.chosen);
  await mpCall('play', { token: MP.token, cards });
  MP.selected.clear();
  await mpRefresh();
});
$('mpPass').onclick = () => mpDo(async () => { await mpCall('pass', { token: MP.token }); await mpRefresh(); });
$('mpClear').onclick = () => { MP.selected.clear(); mpRender(); };
$('mpAgain').onclick = () => mpDo(async () => { await mpCall('again', { token: MP.token }); await mpRefresh(); });

/* ───────── 시작 ───────── */
(function mpInit() {
  const saved = mpLoad();
  const url = new URLSearchParams(location.search).get('room');
  if (saved && saved.token && (!url || url.toUpperCase() === saved.code)) {
    MP.code = saved.code; MP.token = saved.token; MP.playerId = saved.playerId;
    mpSubscribe();
    mpRefresh();
  }
  if (url) showTab('mp');
  else { try { showTab(localStorage.getItem('thirteen-tab') || 'solo'); } catch (_) {} }
  MP.poll = setInterval(() => { if (MP.token && !document.hidden) mpRefresh(); }, 4000);
  MP.tick = setInterval(mpTimer, 1000);
  mpRender();
})();
