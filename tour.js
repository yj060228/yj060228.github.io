/* 대회 탭 — 주간 대회 · 승리 순위 · 매일 코인
 *
 *   · 대회: 참가비 5만 코인, AI 와 4인전 3판, 점수 합으로 순위. 기록을 지우고 다시 참가할 수 있어요(참가비는 다시).
 *   · 승리 순위: 서버가 AI 를 맡은 판(AI 캐시 게임 · 대회)에서 이긴 횟수.
 *   · 한 주는 한국 시간 월요일 0시부터. 상금은 일요일 밤 자정에 관리자 지갑에서 지급돼요.
 *   · 매일 코인: 하루 한 번 10만 코인.
 * 판은 서버가 두고, 화면은 AI 연습 탭의 게임판을 같이 씁니다 (solocash.js). */

const TOUR = { info: null, busy: false, err: '', daily: null, timer: null };

const tourLogged = () => !!(ACC && ACC.sb && ACC.user);
const pts = (n) => (n > 0 ? '+' : '') + n;
/* 'YYYY-MM-DD' 를 그대로 읽는다 (보는 사람의 시간대와 상관없이) */
const dateKo = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}월 ${d}일`; };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* 남은 시간 "2일 5시간" */
function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return '곧';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  return d ? `${d}일 ${h % 24}시간` : h ? `${h}시간 ${Math.floor(ms / 60000) % 60}분` : `${Math.max(1, Math.floor(ms / 60000))}분`;
}

async function tourLoad(quiet) {
  if (!quiet) { TOUR.busy = true; tourRender(); }
  try {
    TOUR.info = await mpCall('tour_info', {});
    TOUR.err = '';
  } catch (e) { TOUR.err = e.message; }
  if (tourLogged()) {
    try {
      const { data, error } = await ACC.sb.rpc('daily_status');
      TOUR.daily = error ? null : ((data && data[0]) || null);
    } catch (_) { TOUR.daily = null; }
  } else TOUR.daily = null;
  TOUR.busy = false;
  tourRender();
}

/* ───────── 매일 코인 ───────── */
async function dailyClaim() {
  if (!tourLogged()) { alert('로그인하면 매일 10만 코인을 받을 수 있어요.'); return; }
  try {
    const { data, error } = await ACC.sb.rpc('daily_claim');
    if (error) throw new Error(typeof cleanErr === 'function' ? cleanErr(error.message) : error.message);
    alert(`10만 코인을 받았어요. 지금 ${Number(data).toLocaleString()}코인이에요.`);
    TOUR.daily = { claimed: true, amount: 100000 };
  } catch (e) { alert(e.message); }
  if (typeof coinRefresh === 'function') coinRefresh();
  tourRender();
}
function dailyHtml() {
  if (!tourLogged()) return '<p class="note">로그인하면 매일 10만 코인을 받을 수 있어요.</p>';
  const done = TOUR.daily && TOUR.daily.claimed;
  return `<div class="cashrow">
      <button class="btn ${done ? '' : 'primary'}" data-daily ${done ? 'disabled' : ''}>${done ? '오늘은 받았어요' : '오늘의 10만 코인 받기'}</button>
      <span class="note">하루에 한 번 받을 수 있어요. 한국 시간 자정에 다시 열려요.</span>
    </div>`;
}

/* ───────── 대회 진행 ───────── */
async function tourEnter(again) {
  if (!tourLogged()) { alert('대회는 로그인해야 참가할 수 있어요.'); return; }
  if (UI.cash && !UI.cash.done) { alert('지금 두고 있는 판을 먼저 끝내 주세요.'); return; }
  const fee = (TOUR.info && TOUR.info.fee) || 50000;
  const msg = again
    ? `지금 기록을 지우고 다시 참가할까요?\n참가비 ${fee.toLocaleString()}코인을 다시 내고, 지운 기록은 되살릴 수 없어요.`
    : `참가비 ${fee.toLocaleString()}코인을 내고 대회에 참가할까요?\nAI 와 4인전 세 판을 두고, 점수 합으로 순위가 정해져요.`;
  if (!confirm(msg)) return;
  TOUR.busy = true; tourRender();
  try {
    if (again) await mpCall('tour_withdraw', {});
    const r = await mpCall('tour_enter', {});
    if (typeof coinRefresh === 'function') coinRefresh();
    if (typeof showTab === 'function') showTab('solo');
    await serverGameBegin(r, { kind: 'tour', id: r.id, done: false, gameNo: 1, total: 0, runDone: false },
      `대회 1/${TOUR_GAMES_UI}판 시작`);
  } catch (e) { alert(e.message); }
  TOUR.busy = false;
  tourLoad(true);
}

async function tourNext() {
  if (UI.busy) return;
  UI.busy = true; render();
  try {
    const r = await mpCall('tour_next', {});
    const no = r.me.gamesDone + 1;
    await serverGameBegin(r, { kind: 'tour', id: r.id, done: false, gameNo: no, total: r.me.total, runDone: false },
      `대회 ${no}/${TOUR_GAMES_UI}판 시작 · 누적 ${pts(r.me.total)}점`);
  } catch (e) { alert(e.message); }
  UI.busy = false; render();
}

/* 대회 탭에서 '이어서 두기' / 새로 열었을 때 이어 하기 */
async function tourResume(go) {
  const info = TOUR.info;
  const me = info && info.me;
  if (!me || me.status !== 'playing') return;
  if (UI.cash && UI.cash.kind === 'tour' && UI.cash.id === me.id && !go) return;
  if (UI.cash && UI.cash.kind !== 'tour' && !UI.cash.done) return;   /* 다른 판을 두는 중 */
  if (me.inGame && info.pub) {
    UI.cash = { kind: 'tour', id: me.id, done: false, gameNo: me.gamesDone + 1, total: me.total, runDone: false };
    UI.ended = false; UI.running = false; UI.rec = null; UI.cleared = null; UI.selected.clear();
    UI.state = cashState(info.pub);
    UI.logLines = [];
    say(`— 진행 중이던 대회 ${me.gamesDone + 1}/${TOUR_GAMES_UI}판을 이어서 해요 · 누적 ${pts(me.total)}점 —`);
    banner('진행 중이던 대회 판을 이어서 해요.');
    $('evalChip').classList.add('hidden');
    cashUi(); render();
    if (go && typeof showTab === 'function') showTab('solo');
  } else if (go) {
    UI.cash = { kind: 'tour', id: me.id, done: true, gameNo: me.gamesDone, total: me.total, runDone: false };
    if (typeof showTab === 'function') showTab('solo');
    await tourNext();
  }
}

async function tourWithdraw() {
  if (!confirm('이번 주 대회 기록을 지울까요?\n참가비는 돌려받지 못하고, 지운 기록은 되살릴 수 없어요.')) return;
  try {
    await mpCall('tour_withdraw', {});
    if (UI.cash && UI.cash.kind === 'tour') {
      UI.cash = null; UI.ended = true;
      banner('대회 기록을 지웠어요.');
      cashUi(); render();
    }
  } catch (e) { alert(e.message); }
  tourLoad(true);
}

/* ───────── 그리기 ───────── */
function tourBoardHtml(rows, kind) {
  if (!rows || !rows.length) return `<p class="note">${kind === 'score' ? '아직 세 판을 다 둔 사람이 없어요.' : '아직 이긴 사람이 없어요.'}</p>`;
  const info = TOUR.info;
  const prize = (rank) => kind === 'score'
    ? (info.prizes[rank - 1] ? `<span class="tag pos">${(info.prizes[rank - 1] / 10000).toLocaleString()}만</span>` : '')
    : (rank === 1 ? `<span class="tag pos">${(info.winPrize / 10000).toLocaleString()}만</span>` : '');
  const head = kind === 'score'
    ? '<tr><th>순위</th><th style="text-align:left">아이디</th><th>세 판</th><th>합계</th><th>상금</th></tr>'
    : '<tr><th>순위</th><th style="text-align:left">아이디</th><th>이긴 판</th><th>둔 판</th><th>상금</th></tr>';
  return `<table class="score">${head}${rows.map((r) => `
    <tr class="${r.me ? 'me' : ''}">
      <td>${r.rank}</td><td style="text-align:left">${esc(r.username)}</td>
      ${kind === 'score'
        ? `<td class="faint">${(r.results || []).map(pts).join(' / ')}</td><td class="${r.total > 0 ? 'pos' : r.total < 0 ? 'neg' : ''}"><b>${pts(r.total)}</b></td>`
        : `<td><b>${r.wins}</b></td><td class="faint">${r.games}</td>`}
      <td>${prize(r.rank)}</td></tr>`).join('')}</table>`;
}

function tourMeHtml() {
  const info = TOUR.info;
  if (!tourLogged()) return '<p class="note">로그인하면 대회에 참가할 수 있어요.</p>';
  const me = info.me;
  const fee = info.fee.toLocaleString();
  if (!me) {
    return `<div class="cashrow"><button class="btn primary" data-tour="enter">참가하기 · ${fee}코인</button>
      <span class="note">AI 와 4인전 세 판을 두고, 점수 합으로 순위가 정해져요.</span></div>`;
  }
  const res = (me.results || []).map((v, i) => `${i + 1}판 ${pts(v)}`).join(' · ');
  if (me.status === 'done') {
    return `<div class="tourme"><b>이번 주 기록 ${pts(me.total)}점</b><span class="note">${res}</span></div>
      <div class="cashrow"><button class="btn" data-tour="again">기록 지우고 다시 참가 · ${fee}코인</button>
      <span class="note">더 좋은 기록에 도전할 수 있어요. 지금 기록은 사라져요.</span></div>`;
  }
  const next = me.inGame ? `${me.gamesDone + 1}판째 두는 중` : `${me.gamesDone}판 끝 · 다음은 ${me.gamesDone + 1}판`;
  return `<div class="tourme"><b>진행 중 · ${next}</b><span class="note">누적 ${pts(me.total)}점${res ? ' · ' + res : ''}</span></div>
    <div class="cashrow">
      <button class="btn primary" data-tour="resume">${me.inGame ? '이어서 두기' : `${me.gamesDone + 1}판 시작`}</button>
      <button class="btn" data-tour="withdraw">기록 지우기</button>
    </div>`;
}

function tourRender() {
  const box = $('tourBody');
  if (!box) return;
  const info = TOUR.info;
  if (!info) {
    box.innerHTML = TOUR.err ? `<div class="panel"><p class="note" style="color:var(--bad)">${esc(TOUR.err)}</p></div>`
      : '<div class="panel"><p class="note">불러오는 중…</p></div>';
    weekPanelRender();
    return;
  }
  const winners = info.winners || [];
  const lastHtml = winners.length ? `
    <div class="panel">
      <h2>지난 주 (${dateKo(info.last)} 주) 수상자</h2>
      <table class="score">${winners.map((w) => `<tr>
        <td style="text-align:left"><span class="tag">${w.kind === 'score' ? `대회 ${w.rank}등` : '승리 1등'}</span></td>
        <td style="text-align:left">${esc(w.username)}</td>
        <td><b>${w.kind === 'score' ? pts(w.value) + '점' : w.value + '승'}</b></td>
        <td class="pos">+${(Number(w.amount) / 10000).toLocaleString()}만</td></tr>`).join('')}</table>
    </div>` : '';

  box.innerHTML = `
    <div class="panel">
      <h2>이번 주 대회</h2>
      <p class="note"><b>${dateKo(info.week)}(월) ~ ${dateKo(addDays(info.week, 6))}(일)</b> · 상금까지 ${untilText(info.nextPayout)}</p>
      <p class="note">참가비 ${info.fee.toLocaleString()}코인을 내고 AI 와 4인전 ${info.games}판을 둬요. 세 판 점수 합이 높은 순서로
        1등 ${(info.prizes[0] / 10000)}만 · 2등 ${(info.prizes[1] / 10000)}만 · 3등 ${(info.prizes[2] / 10000)}만 · 4등 ${(info.prizes[3] / 10000)}만 코인을 받아요.
        기록은 한 주에 하나이고, 지우고 다시 참가할 수 있어요(참가비는 다시 내요). 동점이면 먼저 끝낸 사람이 위예요.
        상금은 일요일 밤 자정(한국 시간)에 지급돼요.</p>
      ${TOUR.err ? `<p class="note" style="color:var(--bad)">${esc(TOUR.err)}</p>` : ''}
      ${tourMeHtml()}
    </div>
    <div class="panel">
      <h2>매일 코인</h2>
      ${dailyHtml()}
    </div>
    <div class="panel">
      <h2>대회 순위</h2>
      ${tourBoardHtml(info.score, 'score')}
    </div>
    <div class="panel">
      <h2>이번 주 승리 순위</h2>
      <p class="note">AI 캐시 게임과 대회에서 AI 를 이긴 횟수예요. 1등은 ${(info.winPrize / 10000)}만 코인을 받아요.
        같으면 그 횟수에 먼저 다다른 사람이 위예요. (그냥 AI 연습은 브라우저에서 두는 판이라 세지 않아요.)</p>
      ${tourBoardHtml(info.wins, 'wins')}
    </div>
    ${lastHtml}`;

  for (const b of box.querySelectorAll('[data-tour]')) {
    b.disabled = TOUR.busy;
    b.onclick = () => {
      const k = b.dataset.tour;
      if (k === 'enter') tourEnter(false);
      else if (k === 'again') tourEnter(true);
      else if (k === 'resume') tourResume(true);
      else if (k === 'withdraw') tourWithdraw();
    };
  }
  for (const b of box.querySelectorAll('[data-daily]')) b.onclick = dailyClaim;
  weekPanelRender();
}

/* 왼쪽 칸: 이번 주 순위 짧게 (옛 리더보드 자리) */
function weekPanelRender() {
  const box = $('weekBody');
  if (!box) return;
  const info = TOUR.info;
  if (!info) { box.innerHTML = '<p class="note">불러오는 중…</p>'; return; }
  const top = (rows, f) => (rows && rows.length ? rows.slice(0, 5).map((r) => `
    <tr class="${r.me ? 'me' : ''}"><td>${r.rank}</td><td style="text-align:left">${esc(r.username)}</td><td>${f(r)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="note" style="text-align:left">아직 없어요</td></tr>');
  box.innerHTML = `
    <h3 class="subhead">대회 (세 판 합계)</h3>
    <table class="score">${top(info.score, (r) => `<b>${pts(r.total)}</b>`)}</table>
    <h3 class="subhead">승리 횟수</h3>
    <table class="score">${top(info.wins, (r) => `<b>${r.wins}승</b>`)}</table>
    <p class="note">상금까지 ${untilText(info.nextPayout)} · <a href="#" data-goto-tour>대회 탭에서 보기</a></p>`;
  const a = box.querySelector('[data-goto-tour]');
  if (a) a.onclick = (e) => { e.preventDefault(); showTab('tour'); };
}

/* 로그인 상태가 바뀌면 다시 불러오고, 두던 대회 판이 있으면 이어 한다 */
let tourWho;
async function tourOnAuth() {
  const who = (ACC.user && ACC.user.id) || null;
  if (who === tourWho) return;
  tourWho = who;
  await tourLoad(true);
  if (who) tourResume(false);
}

(function wireTour() {
  tourRender();
  tourLoad(true);
  TOUR.timer = setInterval(() => { if (!document.hidden) tourLoad(true); }, 60000);
})();
