/* 내 기록 — 지난 대국과 통계 */
const MY = { open: false, stats: null, games: [], detail: null, busy: false, err: '' };

const myLoggingOn = () => {
  try { return localStorage.getItem('thirteen-nolog') !== '1'; } catch (_) { return true; }
};
const mySetLogging = (on) => {
  try { on ? localStorage.removeItem('thirteen-nolog') : localStorage.setItem('thirteen-nolog', '1'); } catch (_) {}
};

const SRC_NAME = { solo: 'AI 연습', mp: '친구와 대전' };
const fmtDate = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const signed = (n) => (n > 0 ? '+' : '') + n;

async function myLoad() {
  MY.busy = true; MY.err = ''; myRender();
  try {
    const [st, gs] = await Promise.all([
      ACC.sb.rpc('my_stats'),
      ACC.sb.from('game_players')
        .select('game_id,seat,points,won,source,n_players,created_at')
        .order('created_at', { ascending: false }).limit(30),
    ]);
    if (st.error) throw new Error('통계를 불러오지 못했어요. history.sql 을 실행했는지 확인해 주세요.');
    if (gs.error) throw new Error(gs.error.message);
    MY.stats = st.data || [];
    MY.games = gs.data || [];
  } catch (e) { MY.err = e.message; }
  MY.busy = false; myRender();
}

async function myOpenDetail(gameId) {
  if (MY.detail && MY.detail.id === gameId) { MY.detail = null; myRender(); return; }
  MY.detail = { id: gameId, loading: true };
  myRender();
  try {
    const { data, error } = await ACC.sb.from('game_logs')
      .select('id,seats,deal,moves,points,winner_seat,n_players,source,created_at')
      .eq('id', gameId).single();
    if (error) throw new Error(error.message);
    MY.detail = data;
  } catch (e) { MY.detail = { id: gameId, error: e.message }; }
  myRender();
}

function statBlock(rows) {
  const games = rows.reduce((a, r) => a + r.games, 0);
  const wins = rows.reduce((a, r) => a + r.wins, 0);
  const total = rows.reduce((a, r) => a + r.total, 0);
  return { games, wins, total,
    rate: games ? Math.round((wins / games) * 100) : 0,
    avg: games ? total / games : 0 };
}

function myRender() {
  const box = document.getElementById('myBody');
  if (!box) return;

  const toggle = `
    <label class="switch">
      <input type="checkbox" id="myLogSw" ${myLoggingOn() ? 'checked' : ''}>
      <span>대국 기록 저장</span>
    </label>
    <p class="note">끄면 앞으로 둔 판이 저장되지 않고 이 화면에도 쌓이지 않아요.
       이미 저장된 기록은 그대로 남아요. 저장되는 건 카드와 수순, 점수뿐이에요.</p>`;

  if (!ACC.sb) {
    box.innerHTML = `<p class="note">서버가 설정되지 않아 기록을 볼 수 없어요.</p>${toggle}`;
    wireToggle(); return;
  }
  if (!ACC.user) {
    box.innerHTML = `<p class="note">로그인하면 지난 대국과 통계를 볼 수 있어요.
      게스트로 둔 판은 기록되지 않아요.</p>${toggle}`;
    wireToggle(); return;
  }
  if (MY.busy && !MY.stats) { box.innerHTML = '<p class="note">불러오는 중…</p>'; return; }
  if (MY.err) { box.innerHTML = `<p class="note" style="color:var(--bad)">${esc(MY.err)}</p>${toggle}`; wireToggle(); return; }

  const rows = MY.stats || [];
  const all = statBlock(rows);
  const cards = [['전체', all]]
    .concat(['solo', 'mp'].map((k) => [SRC_NAME[k], statBlock(rows.filter((r) => r.source === k))]))
    .filter(([, s], i) => i === 0 || s.games > 0);

  const tiles = cards.map(([label, s]) => `
    <div class="stat">
      <div class="slabel">${label}</div>
      <div class="sbig">${s.games}<span class="sunit">판</span></div>
      <div class="srow"><span>승률</span><b>${s.rate}%</b></div>
      <div class="srow"><span>판당 평균</span><b class="${s.avg > 0 ? 'pos' : s.avg < 0 ? 'neg' : ''}">${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(1)}점</b></div>
      <div class="srow"><span>누적</span><b class="${s.total > 0 ? 'pos' : s.total < 0 ? 'neg' : ''}">${signed(s.total)}점</b></div>
    </div>`).join('');

  const list = MY.games.length ? MY.games.map((g) => {
    const open = MY.detail && MY.detail.id === g.game_id;
    return `
    <div class="gitem">
      <button class="grow" data-id="${g.game_id}">
        <span class="gdate">${fmtDate(g.created_at)}</span>
        <span class="tag">${SRC_NAME[g.source] || g.source}</span>
        <span class="tag">${g.n_players}인</span>
        <span class="gres ${g.won ? 'win' : ''}">${g.won ? '승' : '패'}</span>
        <span class="gpt ${g.points > 0 ? 'pos' : g.points < 0 ? 'neg' : ''}">${signed(g.points)}점</span>
      </button>
      ${open ? `<div class="gdetail">${detailHtml(MY.detail)}</div>` : ''}
    </div>`;
  }).join('') : '<p class="note">아직 기록이 없어요. 한 판 두고 나면 여기에 쌓여요.</p>';

  box.innerHTML = `
    <div class="stats">${tiles}</div>
    <h3 class="subhead">최근 대국</h3>
    <div class="glist">${list}</div>
    <p class="note">최근 30판까지 보여줘요. 통계는 저장된 모든 판을 기준으로 해요.</p>
    <hr class="sep">
    ${toggle}`;

  for (const b of box.querySelectorAll('.grow')) {
    b.onclick = () => myOpenDetail(Number(b.dataset.id));
  }
  wireToggle();
}

function wireToggle() {
  const sw = document.getElementById('myLogSw');
  if (sw) sw.onchange = (e) => { mySetLogging(e.target.checked); myRender(); };
}

function detailHtml(d) {
  if (d.loading) return '<p class="note">불러오는 중…</p>';
  if (d.error) return `<p class="note" style="color:var(--bad)">${esc(d.error)}</p>`;
  const nameOf = (seat) => {
    const s = (d.seats || []).find((x) => x.seat === seat);
    return s ? s.name : seat + '번';
  };
  const hands = (d.deal || []).map((cs, i) =>
    `<div class="drow"><span class="dname">${esc(nameOf(i))}</span>
      <span class="row-cards">${cs.slice().sort((a, b) => a - b).map((c) => cardHtml(c, 'sm')).join('')}</span>
      <span class="dpt ${d.points[i] > 0 ? 'pos' : d.points[i] < 0 ? 'neg' : ''}">${signed(d.points[i])}점</span></div>`).join('');
  const moves = (d.moves || []).map((m, i) =>
    `<div class="drow"><span class="dnum">${i + 1}</span><span class="dname">${esc(nameOf(m.s))}</span>` +
    (m.c && m.c.length
      ? `<span class="row-cards">${m.c.map((c) => cardHtml(c, 'sm')).join('')}</span>`
      : '<span class="note">패스</span>') + '</div>').join('');
  return `
    <h4 class="dhead">시작 패 · ${esc(nameOf(d.winner_seat))} 승리</h4>
    ${hands}
    <h4 class="dhead">수순 (${(d.moves || []).length}수)</h4>
    <div class="dmoves">${moves}</div>`;
}

/* 열고 닫기 */
function toggleMyPage(open) {
  const el = document.getElementById('viewMy');
  if (!el) return;
  el.hidden = open === undefined ? !el.hidden : !open;
  MY.open = !el.hidden;
  if (MY.open) {
    if (typeof toggleRules === 'function') toggleRules(false);
    if (typeof toggleCoins === 'function') toggleCoins(false);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (ACC.sb && ACC.user) myLoad(); else myRender();
  }
}

/* auth.js 가 화면을 다시 그릴 때마다 불러 준다.
   사람이 바뀌었을 때만 다시 불러온다 */
let myWho = undefined;
function myOnAuth() {
  const who = (ACC.user && ACC.user.id) || null;
  if (who === myWho) return;
  myWho = who;
  MY.stats = null; MY.games = []; MY.detail = null; MY.err = '';
  if (MY.open && ACC.sb && ACC.user) myLoad(); else myRender();
}

/* 한 판 끝난 뒤 열려 있으면 새 기록을 반영한다 */
function myOnGameEnd() {
  MY.stats = null; MY.games = []; MY.detail = null;
  if (MY.open && ACC.sb && ACC.user) myLoad();
}

(function wireMy() {
  const b = document.getElementById('btnMy');
  if (b) b.onclick = () => toggleMyPage();
  const c = document.getElementById('myClose');
  if (c) c.onclick = () => toggleMyPage(false);
  myRender();
})();
