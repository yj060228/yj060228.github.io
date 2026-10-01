/* 친구와 대전 — 서버(Edge Function)가 심판을 보는 온라인 대국 */
const MP = {
  code: null, token: null, playerId: null, seat: null,
  state: null, hand: [], selected: new Set(),
  sub: null, poll: null, tick: null, busy: false, err: '',
  name: '', codeInput: '',          /* 입력칸 내용. 화면을 다시 그려도 유지되게 */
  cash: false, stake: 100, buyinPts: 100,   /* 캐시 게임 설정 (바이인은 몇 점분인지로) */
  chatDraft: '', chatSeen: '',              /* 채팅 입력칸과 마지막으로 그린 목록의 표시 (방 코드·개수·마지막 시각) */
  owner: null, saved: null,         /* 이 자리가 어느 계정 것인지 */
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

/* 방 참가 정보는 이 브라우저에 저장해 두고 새로고침해도 이어서 둘 수 있게 합니다.
 * 이때 "어느 계정으로 들어간 자리인지"(owner)도 같이 적어 둡니다.
 * 이게 없으면 A가 로그아웃하고 B가 로그인했을 때 B에게 A의 자리가 그대로 남아,
 * B가 A 대신 카드를 낼 수 있게 됩니다. 캐시 게임이면 A의 코인이 나가고요. */
function mpSave() {
  try {
    if (MP.token) {
      localStorage.setItem('thirteen-mp', JSON.stringify({
        code: MP.code, token: MP.token, playerId: MP.playerId, owner: MP.owner || null,
      }));
    } else localStorage.removeItem('thirteen-mp');
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
  $('mpChatPanel').classList.toggle('hidden', !inRoom);      /* 대기실에서도 대화할 수 있게 */
  $('mpLogPanel').classList.toggle('hidden', !inRoom || MP.state.status === 'waiting');

  if (!inRoom) { mpRenderLobby(); return; }
  mpRenderRoom();
  if (MP.state.status !== 'waiting') mpRenderTable();
  mpRenderScore();
  mpRenderChat();
  $('mpLog').innerHTML = (MP.state.log || []).map((l) => `<div>${esc(l)}</div>`).join('');
  $('mpLog').scrollTop = $('mpLog').scrollHeight;
}

/* ───────── 대화 ─────────
 * 입력칸은 index.html 에 고정으로 두고 목록만 다시 그립니다.
 * 4초마다 새로 받아올 때 입력하던 글이 날아가지 않게 하려고요. */
function mpRenderChat() {
  const box = $('mpChat');
  if (!box) return;
  const msgs = (MP.state && MP.state.chat) || [];
  /* 바뀐 게 없으면 그대로 둔다. 개수만 보면 다른 방에 들어갔을 때나
     최근 50개로 잘려 개수가 그대로일 때 새로 그리지 않아서, 방 코드와 마지막 시각도 같이 본다 */
  const last = msgs.length ? msgs[msgs.length - 1].t : 0;
  const seen = `${MP.code || ''}:${msgs.length}:${last}`;
  if (seen === MP.chatSeen) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  MP.chatSeen = seen;

  box.innerHTML = msgs.length
    ? msgs.map((c) => {
        const mine = c.id === MP.playerId;
        const d = new Date(c.t);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<div class="cmsg${mine ? ' me' : ''}"><span class="nm">${esc(c.name || '')}</span>`
             + `${esc(c.text)}<span class="tm">${hm}</span></div>`;
      }).join('')
    : '<p class="note">아직 대화가 없어요. 첫 마디를 건네 보세요.</p>';

  if (atBottom || msgs.length <= 1) box.scrollTop = box.scrollHeight;
}

async function mpChatSend() {
  const el = $('mpChatInput');
  const text = (el.value || '').trim();
  if (!text || !MP.token) return;
  el.value = ''; MP.chatDraft = '';
  const note = $('mpChatNote');
  try {
    const r = await mpCall('chat', { token: MP.token, text });
    MP.state = r.state;
    mpRenderChat();
  } catch (e) {
    if (note) note.textContent = e.message;
    el.value = text; MP.chatDraft = text;        /* 못 보냈으면 적은 글을 돌려준다 */
    setTimeout(() => { if (note) note.textContent = '최근 50개까지 남아요. 방이 정리되면 같이 사라집니다.'; }, 2500);
  }
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
        <label class="note" for="mpBuyinSel">바이인</label>
        <select id="mpBuyinSel">${buyinChoices(MP.stake).map((b) =>
          `<option value="${b}"${b === mpBuyin() ? ' selected' : ''}>${b.toLocaleString()}코인 (${b / MP.stake}점분)</option>`).join('')}</select>
      </div>
      <p class="note">${canCash()
        ? '벌점 1점당 고른 금액만큼 참가자끼리 주고받아요. 방에 들어오면 바이인이 묶이고, 판마다 그 안에서 주고받다가 방을 나갈 때 남은 만큼 돌려받아요. 바이인보다 적게 남아도 계속 할 수 있고, 다 잃으면 관전만 할 수 있어요.'
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
    MP.buyinPts = MP.buyinPts || 100;         /* 점수 배수는 유지하고 금액만 다시 계산 */
    mpRenderLobby();
  };
  $('mpBuyinSel').onchange = (e) => {
    MP.buyinPts = Math.round(+e.target.value / MP.stake);
  };

  $('mpCreate').onclick = () => {
    const name = ($('mpName').value || '').trim();
    const n = +$('mpN').value;
    MP.name = name;
    mpDo(async () => {
      if (!name) throw new Error('닉네임을 입력해 주세요.');
      const cash = MP.cash && canCash();
      mpEnter(await mpCall('create', {
        name, nPlayers: n, noLog: mpNoLog(),
        stake: cash ? MP.stake : 0,
        buyin: cash ? mpBuyin() : 0,
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
/* 판돈 후보: 1점당 100 ~ 10000 코인 */
const STAKES = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];
/* 바이인 후보는 '몇 점분인지'로 고릅니다. 서버 제한은 10 ~ 500점분 */
const BUYIN_PTS = [10, 20, 30, 50, 100, 200, 300, 500];
const buyinChoices = (stake) => BUYIN_PTS.map((p) => p * stake).filter((b) => b <= 5000000);
/* 지금 고른 바이인 금액 */
const mpBuyin = () => {
  const list = buyinChoices(MP.stake);
  const want = (MP.buyinPts || 100) * MP.stake;
  return list.includes(want) ? want : (list[list.length - 1] || MP.stake * 100);
};
const canCash = () => !!(ACC.sb && ACC.user);
/* 정산 금액. 서버가 실제로 오간 금액(delta)을 보내 주고, 옛 기록이면 점수로 계산한다 */
const mpDelta = (r, stake) => (typeof r.delta === 'number' ? r.delta : r.points * stake);
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
    ${st.stake ? `<p class="note">캐시 게임이에요. 들어올 때 바이인 <b>${st.buyin.toLocaleString()}코인</b>이 묶이고,
       판이 끝날 때마다 벌점 1점당 <b>${st.stake.toLocaleString()}코인</b>씩 그 안에서 주고받아요.
       바이인보다 적게 남아도 계속 할 수 있고, 한 판에 잃는 금액은 남은 바이인까지예요.
       다 잃으면 관전으로 바뀌고, 방을 나가면 남은 만큼 돌려받아요.</p>` : ''}
    ${st.cash && st.cash.rows ? `<div class="settle"><div class="slabel">정산</div>${st.cash.rows.map((r) => {
      const d = mpDelta(r, st.cash.stake);
      return `
      <div class="drow"><span class="dname">${esc(r.name)}</span>
        <span class="note">${r.points > 0 ? '+' : ''}${r.points}점</span>
        <span class="dpt ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d.toLocaleString()}코인</span>
      </div>`;
    }).join('')}</div>` : ''}
    <div class="plist">${st.players.map((p) => `
      <div class="prow${!waiting && st.turn === p.seat && st.winner < 0 ? ' turn' : ''}">
        <span>${esc(p.name)}</span>
        ${p.id === st.hostPlayer ? '<span class="tag">방장</span>' : ''}
        ${p.guest ? '<span class="tag">게스트</span>' : ''}
        ${!p.present ? '<span class="tag">나감</span>' : ''}
        ${p.spectator ? `<span class="tag">${p.stack === 0 ? '올인 · 관전' : '관전'}</span>` : ''}
        ${st.stake && p.stack !== null && p.stack !== undefined
          ? `<span class="tag stack${p.stack === 0 ? ' neg' : ''}" title="남은 바이인">◈ ${p.stack.toLocaleString()}</span>` : ''}
        ${waiting || p.spectator ? '' : `<span class="cnt">${p.cards}장</span>`}
      </div>`).join('')}</div>
    ${waiting && isHost ? '<div class="acct"><button class="btn primary" id="mpStart">게임 시작</button></div>' : ''}
    ${waiting && !isHost ? '<p class="note">방장이 시작하기를 기다리는 중이에요.</p>' : ''}
    ${MP.err ? `<p class="note" style="color:var(--bad)">${esc(MP.err)}</p>` : ''}`;

  $('mpCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); $('mpCopyNote').textContent = '링크를 복사했어요.'; }
    catch (_) { $('mpCopyNote').textContent = link; }
  };
  $('mpLeave').onclick = () => {
    const me = st.players.find((p) => p.id === MP.playerId);
    const live = st.status === 'playing' && st.winner < 0 && me && !me.spectator;
    if (st.stake && me && me.stack !== null && me.stack !== undefined
        && !confirm(live
          ? '지금 판은 자동으로 패스하며 끝까지 진행되고, 판이 끝나면 남은 바이인을 돌려받아요. 나갈까요?'
          : `남은 바이인 ${me.stack.toLocaleString()}코인을 돌려받고 방을 나갈까요?`)) return;
    mpDo(async () => {
      await mpCall('leave', { token: MP.token });
      mpExit();
      if (typeof coinRefresh === 'function') coinRefresh();
    });
  };
  if ($('mpStart')) $('mpStart').onclick = () => mpDo(async () => { await mpCall('start', { token: MP.token }); await mpRefresh(); });
}

function mpRenderTable() {
  const st = MP.state;
  const myTurn = st.turn === MP.seat && st.winner < 0 && st.status === 'playing';

  $('mpSeats').innerHTML = '';
  /* 아무도 못 이겨서 돈 판이면 그 패를 흐리게 남겨 둔다 */
  const cl = st.lead && st.winner < 0 && st.cleared ? st.cleared : null;
  $('mpPile').classList.toggle('cleared', !!cl);
  $('mpPileLabel').textContent = st.lead ? '선' : '바닥';
  $('mpPileCards').innerHTML = cl
    ? cl.cards.map((c) => cardHtml(c, 'sm done')).join('')
    : st.lastCards.map((c) => cardHtml(c, 'sm')).join('');
  const lastName = (st.players.find((p) => p.seat === st.lastPlayer) || {}).name || '';
  $('mpPileMeta').textContent = st.winner >= 0
    ? '판이 끝났어요'
    : cl
      ? `${cl.name}의 ${TYPE_NAME[cl.type]} — 아무도 못 이김`
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
  else if (MP.seat === null || MP.seat === undefined) {
    const me = st.players.find((p) => p.id === MP.playerId);
    v.className = 'verdict';
    v.textContent = me && me.stack === 0 ? '바이인을 다 잃어서 관전 중이에요' : '관전 중';
  }
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
  const cash = !!st.stake;
  $('mpScore').innerHTML = '<tr><th style="text-align:left">이름</th><th>누적</th>'
    + (cash ? '<th>남은 바이인</th>' : '') + '<th>남은 장수</th></tr>'
    + rows.map((p) => {
      const t = st.totals[p.id] || 0;
      const s = p.stack;
      return `<tr class="${p.id === MP.playerId ? 'me' : ''}"><td style="text-align:left">${esc(p.name)}</td>
        <td class="${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}">${t > 0 ? '+' : ''}${t}</td>
        ${cash ? `<td class="${s === 0 ? 'neg' : ''}">${s === null || s === undefined ? '-' : s.toLocaleString()}</td>` : ''}
        <td>${st.status === 'waiting' || p.spectator ? '-' : p.cards}</td></tr>`;
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
  MP.owner = (ACC.user && ACC.user.id) || null;
  MP.state = r.state; MP.hand = r.hand || []; MP.seat = r.seat ?? null;
  MP.selected.clear();
  mpSave();
  mpSubscribe();
  mpRefresh();
  if (MP.state && MP.state.stake && typeof coinRefresh === 'function') coinRefresh();
}
function mpExit() {
  if (MP.sub) { try { MP.sub.unsubscribe(); } catch (_) {} MP.sub = null; }
  MP.code = MP.token = MP.playerId = MP.owner = null;
  MP.state = null; MP.hand = []; MP.seat = null; MP.selected.clear();
  MP.chatSeen = ''; MP.chatDraft = '';
  if ($('mpChat')) $('mpChat').innerHTML = '';     /* 이전 방 대화를 화면에서도 지운다 */
  if ($('mpChatInput')) $('mpChatInput').value = '';
  mpSave();
}

/* 로그인한 계정이 바뀌면 남의 자리를 들고 있지 않도록 정리합니다.
 * auth.js 가 화면을 다시 그릴 때마다 불러 줍니다. */
function mpOnAuth() {
  const uid = (ACC.user && ACC.user.id) || null;

  if (MP.token) {
    if (MP.owner && MP.owner !== uid) {
      /* A 로 들어간 자리인데 지금은 A 가 아니다 → 방에서 빠져나온다 */
      mpExit();
      MP.err = '계정이 바뀌어서 방에서 나왔어요. 방 코드를 다시 넣으면 들어갈 수 있어요.';
      mpRender();
    } else if (!MP.owner && uid) {
      /* 게스트로 들어갔다가 같은 브라우저에서 로그인한 경우 — 자리는 그대로 두고 주인만 적는다 */
      MP.owner = uid; mpSave();
    }
    return;
  }

  /* 새로고침 직후: 저장해 둔 자리를 지금 계정이 쓸 수 있는지 확인하고 복구 */
  const s = MP.saved;
  if (!s) return;
  MP.saved = null;
  if (s.owner && s.owner !== uid) return;        /* 남의 자리라 버린다 */
  if (!('owner' in s) && uid) return;            /* 옛 형식이라 주인을 모른다 → 안전하게 버린다 */
  MP.code = s.code; MP.token = s.token; MP.playerId = s.playerId;
  MP.owner = s.owner || uid || null;
  mpSave();
  mpSubscribe();
  mpRefresh();
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
$('mpChatSend').onclick = mpChatSend;
$('mpChatInput').onkeydown = (e) => { if (e.key === 'Enter') mpChatSend(); };
$('mpChatInput').oninput = (e) => { MP.chatDraft = e.target.value; };
$('mpAgain').onclick = () => mpDo(async () => { await mpCall('again', { token: MP.token }); await mpRefresh(); });

/* ───────── 시작 ───────── */
(function mpInit() {
  const saved = mpLoad();
  const url = new URLSearchParams(location.search).get('room');
  /* 바로 복구하지 않고 미뤄 둡니다. 누가 로그인해 있는지 확인한 뒤(mpOnAuth) 복구해야
     다른 계정의 자리를 이어받는 일이 생기지 않아요. */
  if (saved && saved.token && (!url || url.toUpperCase() === saved.code)) MP.saved = saved;
  if (url) showTab('mp');
  else { try { showTab(localStorage.getItem('thirteen-tab') || 'solo'); } catch (_) {} }
  MP.poll = setInterval(() => { if (MP.token && !document.hidden) mpRefresh(); }, 4000);
  MP.tick = setInterval(mpTimer, 1000);
  /* 로그인 확인이 이미 끝났으면 지금 복구하고, 아직이면 끝난 뒤 auth.js 가 불러 줍니다 */
  if (ACC.ready) mpOnAuth();
  mpRender();
})();