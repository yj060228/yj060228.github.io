/* AI 와 하는 캐시 게임 — 화면 쪽
 *
 * 카드를 나누고 AI 가 두는 건 서버(Edge Function)가 합니다. 이 파일은 받은 공개 정보로 판을 그리고,
 * 내가 낸 수를 서버에 보내기만 해요. 브라우저에는 내 패와 남의 장수만 내려옵니다.
 *
 *   · 시작하면 내 코인 전부가 묶여서, 그동안 멀티 게임 · 송금 · 다른 게임을 할 수 없어요.
 *   · 판이 끝나면 내 승점 x 1점당 금액만큼 관리자와 주고받아요.
 *   · 기권: 그때 내 패의 벌점 x 4 x 1점당 금액을 벌금으로 내고 끝내요. 기권한 판은 기록에 남지 않아요.
 *   · 관리자가 끄면 모두의 화면에서 사라져요. 각자 설정에서 메인 화면에 보일지도 고를 수 있어요.
 *   · 코인이 없으면 할 수 없어요. */

const CASH_MIN_POINTS = 10;      /* 시작하려면 1점당 금액의 10배 (서버와 같게) */
const CASH_FORFEIT_X = 4;        /* 기권 벌금 배수 (서버와 같게) */
const SOLO_STAKES = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000];
const CASH = { stake: 100, enabled: null };    /* enabled: 관리자가 켜 뒀는지 (null 이면 아직 모름) */

const cashLogged = () => !!(ACC && ACC.sb && ACC.user);
/* 이 브라우저에서 메인 화면에 보일지 (기본은 보임) */
const cashPrefShow = () => { try { return localStorage.getItem('thirteen-cash-show') !== '0'; } catch (_) { return true; } };
const cashSetPrefShow = (on) => { try { on ? localStorage.removeItem('thirteen-cash-show') : localStorage.setItem('thirteen-cash-show', '0'); } catch (_) {} };
const cashLive = () => !!(UI.cash && !UI.cash.done);
const cashBroke = () => cashLogged() && typeof COIN !== 'undefined' && COIN.balance === 0;
const cashVisible = () => cashLive() || (CASH.enabled === true && cashPrefShow());
const cashWanted = () => cashVisible() && !cashLive() && !!($('soloCash') && $('soloCash').checked) && !cashBroke();

/* 서버가 보낸 공개 정보로 판을 다시 만든다. 남의 패는 장수만 맞춘 가짜 패 (규칙 판정에는 장수만 쓰임) */
function cashState(pub) {
  const n = pub.n;
  const mine = maskFromCards(pub.mine);
  const played = maskFromCards(pub.played);
  let last = PASS_MOVE;
  if (!pub.lead) {
    const m = maskFromCards(pub.lastCards);
    const hit = genAll(m).find((x) => x.type === pub.lastType && maskEq(x, m));
    last = { lo: m.lo, hi: m.hi, type: pub.lastType, key: hit ? hit.key : 0, count: pub.lastCards.length, id: hit ? hit.id : 0 };
  }
  const unseen = [];
  for (let c = 0; c < 52; c++) {
    const r = c >> 2, b = 1 << (c & 3);
    if ((rankBits(mine, r) & b) || (rankBits(played, r) & b)) continue;
    unseen.push(c);
  }
  const hand = [mine];
  let k = 0;
  for (let p = 1; p < n; p++) { hand.push(maskFromCards(unseen.slice(k, k + pub.counts[p]))); k += pub.counts[p]; }
  return {
    n, turn: pub.turn, winner: pub.winner, hand, played, last, lastPlayer: pub.lastPlayer,
    npass: 0, passed: pub.passed.slice(), mustInclude: maskFromCards(pub.mustInclude),
  };
}

/* 서버에서 일어난 수를 차례로 보여 준다 */
async function cashReplay(events) {
  let shownUnbeatable = false;
  for (const ev of events) {
    const before = popc(UI.state.hand[ev.s]);
    if (ev.auto && !shownUnbeatable) {
      const s = UI.state;
      UI.cleared = { cards: maskCards(s.last), type: s.last.type, seat: s.lastPlayer };
      say('— 아무도 못 이기는 수 —');
      shownUnbeatable = true;
    }
    if (!ev.c.length) say(`${SEAT_NAME(ev.s)} 패스`);
    else {
      UI.cleared = null; shownUnbeatable = false;
      say(`<b>${SEAT_NAME(ev.s)}</b> ${TYPE_NAME[ev.type]} · ${ev.c.map((c) => RANK_STR[c >> 2] + SUIT_SYM[c & 3]).join(' ')}`);
    }
    const wasLead = UI.state.last.type === PASS;
    UI.state = cashState(ev.pub);
    if (ev.c.length) announce(ev.s, before, popc(UI.state.hand[ev.s]));
    else if (UI.state.last.type === PASS && !wasLead && !ev.auto) say(`— 모두 패스, ${withSubj(SEAT_NAME(UI.state.turn))} 선 —`);
    render();
    if (ev.s !== 0) await sleep(ev.auto ? 170 : 380);
  }
  if (shownUnbeatable) say(`— ${withSubj(SEAT_NAME(UI.state.turn))} 선 —`);
}

/* 판이 끝났을 때 */
function cashEnd(result) {
  const s = UI.state;
  UI.ended = true;
  const pts = result.points;
  for (let p = 0; p < pts.length; p++) UI.totals[p] += pts[p];
  UI.games++;
  if (UI.cash.kind === 'tour') {                 /* 대회 판: 코인은 오가지 않고 점수만 쌓인다 */
    say(`<b>${SEAT_NAME(s.winner)} 승리</b> — ` + pts.map((v, p) => `${SEAT_NAME(p)} ${v > 0 ? '+' : ''}${v}`).join(' / '));
    say(`— 대회 ${result.gameNo}/${TOUR_GAMES_UI}판 끝 · 누적 ${result.total > 0 ? '+' : ''}${result.total}점 —`);
    banner(result.done
      ? `대회 세 판 끝! 합계 ${result.total > 0 ? '+' : ''}${result.total}점이에요. 대회 탭에서 순위를 볼 수 있어요.`
      : `대회 ${result.gameNo}/${TOUR_GAMES_UI}판 끝 · 이번 판 ${pts[0] > 0 ? '+' : ''}${pts[0]}점 · 누적 ${result.total > 0 ? '+' : ''}${result.total}점. 새 게임을 누르면 다음 판이에요.`);
    UI.cash.done = true;
    UI.cash.total = result.total;
    UI.cash.gameNo = result.gameNo;
    UI.cash.runDone = !!result.done;
    cashUi(); render();
    if (typeof myOnGameEnd === 'function') myOnGameEnd();
    if (typeof tourLoad === 'function') tourLoad(true);
    return;
  }
  const coin = Number(result.delta);
  say(`<b>${SEAT_NAME(s.winner)} 승리</b> — ` + pts.map((v, p) => `${SEAT_NAME(p)} ${v > 0 ? '+' : ''}${v}`).join(' / '));
  say(`— 정산 · ${coin >= 0 ? '+' : ''}${coin.toLocaleString()}코인 —`);
  banner(`${s.winner === 0 ? '이겼어요!' : SEAT_NAME(s.winner) + ' 승리'} 이번 판 ${pts[0] > 0 ? '+' : ''}${pts[0]}점 · ${coin >= 0 ? '+' : ''}${coin.toLocaleString()}코인`);
  UI.cash.done = true;
  cashUi();
  render();
  recordGame(pts[0], s.winner === 0);
  if (typeof coinRefresh === 'function') coinRefresh();
  if (typeof myOnGameEnd === 'function') myOnGameEnd();
}

const TOUR_GAMES_UI = 3;

/* 서버가 두는 판을 화면에 올린다 (AI 캐시 게임 · 대회 공통) */
async function serverGameBegin(r, info, title) {
  UI.cash = info;
  UI.ended = false; UI.running = false; UI.rec = null; UI.cleared = null;
  UI.selected.clear(); UI.logLines = [];
  banner('');
  $('hintPanel').classList.add('hidden');
  $('evalChip').classList.add('hidden');
  UI.state = cashState(r.start || r.pub);
  say(`— ${title} · ${withSubj(SEAT_NAME(UI.state.turn))} 선 —`);
  cashUi(); render();
  await cashReplay(r.events || []);
  if (r.result) cashEnd(r.result);
}

async function cashCall(action, extra) {
  return mpCall(action, extra || {});           /* multiplayer.js: 로그인 토큰을 같이 보낸다 */
}

/* 새 캐시 게임 */
async function cashStart() {
  if (!cashLogged()) { alert('AI 캐시 게임은 로그인해야 할 수 있어요.'); return; }
  if (cashBroke()) { alert('코인이 없어서 AI 캐시 게임을 할 수 없어요.'); return; }
  const stake = CASH.stake;
  if (!confirm(`1점당 ${stake.toLocaleString()}코인으로 AI 와 캐시 게임을 시작할까요?\n`
    + '게임이 끝날 때까지 내 코인 전부가 묶이고, 멀티 게임이나 다른 게임을 할 수 없어요.')) return;
  UI.busy = true; render();
  try {
    const r = await cashCall('ai_start', {
      stake, nPlayers: UI.nPlayers,
      noLog: typeof mpNoLog === 'function' ? mpNoLog() : false,
    });
    UI.cash = { id: r.id, stake: r.stake, locked: r.locked, done: false };
    UI.ended = false; UI.running = false; UI.rec = null; UI.cleared = null;
    UI.selected.clear(); UI.logLines = [];
    banner('');
    $('hintPanel').classList.add('hidden');
    $('evalChip').classList.add('hidden');
    UI.state = cashState(r.start || r.pub);
    say(`— ${r.n}인 캐시 게임 시작 · 1점당 ${r.stake.toLocaleString()}코인 · ${withSubj(SEAT_NAME(UI.state.turn))} 선 —`);
    cashUi(); render();
    if (typeof coinRefresh === 'function') coinRefresh();
    await cashReplay(r.events || []);
    if (r.result) cashEnd(r.result);
  } catch (e) {
    alert(e.message);
  }
  UI.busy = false; render();
}

/* 내가 낸 수 */
async function cashPlay(move) {
  if (UI.busy || !UI.cash || UI.cash.done) return;
  UI.busy = true; UI.selected.clear(); render();
  try {
    const tour = UI.cash.kind === 'tour';
    const r = move.type === PASS
      ? await cashCall(tour ? 'tour_pass' : 'ai_pass', { id: UI.cash.id })
      : await cashCall(tour ? 'tour_play' : 'ai_play', { id: UI.cash.id, cards: maskCards(move) });
    banner('');
    await cashReplay(r.events || []);
    if (r.result) cashEnd(r.result);
  } catch (e) {
    alert(e.message);
    await cashResume(true);                      /* 화면과 서버가 어긋났을 수 있으니 다시 받는다 */
  }
  UI.busy = false; render();
}

/* 기권 */
async function cashForfeit() {
  if (!UI.cash || UI.cash.done || UI.busy) return;
  const fine = Math.min(UI.cash.locked, penalty(UI.state.hand[0]) * CASH_FORFEIT_X * UI.cash.stake);
  if (!confirm(`기권할까요?\n지금 내 패의 벌점 ${penalty(UI.state.hand[0])}점 x ${CASH_FORFEIT_X} x ${UI.cash.stake.toLocaleString()}코인 = `
    + `${fine.toLocaleString()}코인을 벌금으로 내고 게임을 끝내요.\n기권한 게임은 기록에 남지 않아요.`)) return;
  UI.busy = true; render();
  try {
    const r = await cashCall('ai_forfeit', { id: UI.cash.id });
    if (r.result) { cashEnd(r.result); }       /* 그새 판이 끝나 있었으면 정상 정산 */
    else {
      UI.ended = true;
      UI.cash.done = true;
      say(`— 기권 · 벌금 ${Number(r.fine).toLocaleString()}코인 —`);
      banner(`기권했어요. 벌금 ${Number(r.fine).toLocaleString()}코인을 냈어요.`);
      cashUi();
      if (typeof coinRefresh === 'function') coinRefresh();
    }
  } catch (e) { alert(e.message); await cashResume(true); }
  UI.busy = false; render();
}

/* 진행 중이던 캐시 게임이 있으면 이어서 한다 (새로고침하거나 다른 기기에서 열었을 때) */
async function cashResume(quiet) {
  if (!cashLogged()) return;
  try {
    const r = await cashCall('ai_active', {});
    if (r.result) {                              /* 끝났는데 정산 전이던 판 */
      UI.cash = { id: r.id, stake: r.stake, locked: r.locked, done: false };
      UI.state = cashState(r.pub);
      cashEnd(r.result);
      return;
    }
    if (r.enabled !== undefined) CASH.enabled = r.enabled;
    if (UI.cash && UI.cash.kind === 'tour') { cashUi(); return; }   /* 대회 판은 tour.js 가 맡는다 */
    if (!r.active) {
      /* 화면에서는 두고 있었는데 서버에 판이 없으면, 관리자가 꺼서 취소된 것 */
      if (cashLive()) {
        UI.cash = null; UI.ended = true;
        say('— 이 판은 취소됐어요 · 묶였던 코인은 돌려받았어요 —');
        banner(CASH.enabled === false
          ? '관리자가 AI 캐시 게임을 꺼서 이 판은 취소됐어요. 묶였던 코인은 돌려받았어요.'
          : '이 판은 더 이상 진행할 수 없어요. 새 게임을 눌러 주세요.');
        if (typeof coinRefresh === 'function') coinRefresh();
        render();
      }
      cashUi();
      return;
    }
    UI.cash = { id: r.id, stake: r.stake, locked: r.locked, done: false };
    UI.ended = false; UI.running = false; UI.rec = null; UI.cleared = null; UI.selected.clear();
    UI.state = cashState(r.pub);
    $('soloCash').checked = true;
    CASH.stake = r.stake;
    if (!quiet) {
      UI.logLines = [];
      say(`— 진행 중이던 캐시 게임을 이어서 해요 · 1점당 ${r.stake.toLocaleString()}코인 —`);
      banner('진행 중이던 캐시 게임을 이어서 해요.');
      if (typeof showTab === 'function') showTab('solo');
    }
    $('evalChip').classList.add('hidden');
    cashUi(); render();
  } catch (_) { /* 서버가 아직 준비되지 않았으면 조용히 넘어감 */ }
}

/* 관리자가 켜 뒀는지 서버에 묻는다 (누구나) */
async function cashLoadConfig() {
  try {
    const r = await cashCall('ai_config', {});
    CASH.enabled = r.enabled !== false;
  } catch (_) { CASH.enabled = false; }      /* 서버가 아직 준비되지 않았으면 숨긴다 */
  cashUi();
}

/* 관리자: 켜고 끄기 */
async function cashAdminSet(on) {
  const el = $('adminCashOn');
  if (!on && !confirm('AI 캐시 게임을 끌까요?\n모든 사람 화면에서 사라지고, 진행 중이던 판은 모두 취소되어 묶였던 코인을 정산 없이 돌려줘요.')) {
    el.checked = true; return;
  }
  el.disabled = true;
  try {
    const r = await cashCall('ai_admin_set', { enabled: on });
    CASH.enabled = r.enabled;
    alert(on ? 'AI 캐시 게임을 켰어요.'
      : `AI 캐시 게임을 껐어요.${r.voided ? ` 진행 중이던 ${r.voided}판을 취소하고 코인을 돌려줬어요.` : ''}`);
    if (typeof coinRefresh === 'function') coinRefresh();
  } catch (e) {
    alert(e.message);
    el.checked = CASH.enabled !== false;
  }
  el.disabled = false;
  cashUi();
}

/* 캐시 게임 줄 (토글 · 금액 · 안내 · 기권 버튼) 과 설정 칸 */
function cashUi() {
  const live = cashLive();
  const visible = cashVisible();
  const broke = cashBroke() && !live;
  const tour = !!(UI.cash && UI.cash.kind === 'tour' && !UI.cash.runDone);
  $('soloCash').parentElement.classList.toggle('hidden', tour);

  /* 설정: 개인 보이기 / 관리자 스위치 */
  $('cashPrefRow').classList.toggle('hidden', CASH.enabled !== true);
  $('prefCashShow').checked = cashPrefShow();
  const admin = typeof COIN !== 'undefined' && COIN.isAdmin && cashLogged();
  $('cashAdminRow').classList.toggle('hidden', !admin);
  if (admin && !$('adminCashOn').disabled) $('adminCashOn').checked = CASH.enabled !== false;

  $('soloCashPanel').classList.toggle('hidden', !visible && !tour);
  if ((!visible || broke) && !live) $('soloCash').checked = false;
  const on = cashWanted();
  const sel = $('soloStake');
  if (!sel.options.length) {
    sel.innerHTML = SOLO_STAKES.map((s) => `<option value="${s}">${s.toLocaleString()}코인</option>`).join('');
  }
  sel.value = String(CASH.stake);
  $('soloCash').disabled = live || !cashLogged() || broke;
  sel.disabled = live;
  $('soloStakeRow').classList.toggle('hidden', tour || (!on && !live));
  $('soloCashPanel').classList.toggle('live', live || tour);
  const chip = $('soloCashChip');
  chip.classList.toggle('hidden', !live && !tour);
  if (tour) {
    const no = UI.cash.done ? UI.cash.gameNo : (UI.cash.gameNo || 1);
    chip.textContent = `🏆 대회 ${no}/${TOUR_GAMES_UI}판 · 누적 ${UI.cash.total > 0 ? '+' : ''}${UI.cash.total || 0}점`;
  } else if (live) chip.textContent = `◈ 1점당 ${UI.cash.stake.toLocaleString()} · 묶임 ${Number(UI.cash.locked).toLocaleString()}`;
  $('btnForfeit').classList.toggle('hidden', !live || tour);
  if (tour) {
    $('soloCashNote').textContent = UI.cash.done
      ? '이번 판이 끝났어요. 새 게임을 누르면 다음 대회 판을 시작해요.'
      : '대회 판이에요. 카드와 AI 는 서버가 맡고, 힌트와 판세 예측은 쓸 수 없어요. 세 판을 다 두면 점수 합이 순위표에 올라가요.';
    return;
  }

  $('soloCashNote').textContent = !cashLogged()
    ? '로그인하면 AI 와 코인을 걸고 둘 수 있어요. 끄면 지금처럼 재미로 둬요.'
    : broke
      ? '코인이 없어서 AI 캐시 게임을 할 수 없어요. 코인이 생기면 다시 켤 수 있어요.'
    : live
      ? '캐시 게임 중이에요. 끝날 때까지 코인 전부가 묶여 있고, 새 게임 · 멀티 게임은 할 수 없어요. '
        + `기권하면 내 패 벌점 x ${CASH_FORFEIT_X} x 1점당 금액을 벌금으로 내고 끝나요.`
      : on
        ? `새 게임을 누르면 시작해요. 판이 끝나면 내 승점 x 1점당 금액만큼 주고받아요. `
          + `시작하려면 1점당 금액의 ${CASH_MIN_POINTS}배 이상 코인이 있어야 하고, 게임 중에는 코인 전부가 묶여요. `
          + '카드와 AI 는 서버가 맡고, 힌트와 판세 예측은 쓸 수 없어요.'
        : '켜면 AI 와 코인을 걸고 둬요. 끄면 지금처럼 재미로 둬요.';
}

/* 로그인 상태가 바뀔 때 auth.js 가 불러 준다 */
let cashWho;
function cashOnAuth() {
  const who = (ACC.user && ACC.user.id) || null;
  cashUi();
  if (CASH.enabled === null) cashLoadConfig();
  if (who === cashWho) return;
  cashWho = who;
  if (!who && UI.cash) {                         /* 로그아웃하면 화면에서만 내려놓는다 (서버에는 남아 있음) */
    UI.cash = null; $('soloCash').checked = false; cashUi();
    newGame();
    return;
  }
  if (who) cashResume(false);
}

(function wireCash() {
  $('soloCash').onchange = () => cashUi();
  $('soloStake').onchange = (e) => { CASH.stake = Number(e.target.value); };
  $('btnForfeit').onclick = cashForfeit;
  $('prefCashShow').onchange = (e) => { cashSetPrefShow(e.target.checked); cashUi(); };
  $('adminCashOn').onchange = (e) => cashAdminSet(e.target.checked);
  cashUi();
  cashLoadConfig();
  if (ACC.ready) cashOnAuth();
})();
