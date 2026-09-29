/* 게임머니(코인) — 잔액, 보내기, 내역
 *
 * 이 파일은 화면만 그립니다. 잔액을 바꾸는 일은 전부 서버에서 일어나요.
 * 여기서 숫자를 고쳐도 서버는 쳐다보지 않습니다. */

const COIN = {
  open: false, balance: null, locked: 0, isAdmin: false,
  rows: [], busy: false, err: '', msg: '',
  to: '', amount: '', gTo: '', gAmount: '',
};

const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const REASON = {
  genesis: '최초 발행', grant: '지급', transfer: '송금',
  escrow: '판돈 묶음', settle: '정산', refund: '환불',
};

/* 위쪽 막대의 코인 표시 */
function coinChip() {
  const el = document.getElementById('coinChip');
  if (!el) return;
  const on = !!(ACC && ACC.sb && ACC.user);
  el.hidden = !on;
  if (!on) return;
  const b = COIN.balance;
  el.innerHTML = `<span class="cicon">◈</span><b>${b === null ? '…' : won(b)}</b>`
    + (COIN.locked ? `<span class="clock">묶임 ${won(COIN.locked)}</span>` : '');
}

async function coinLoad(quiet) {
  if (!ACC.sb || !ACC.user) { COIN.balance = null; coinChip(); coinRender(); return; }
  if (!quiet) { COIN.busy = true; coinRender(); }
  try {
    const w = await ACC.sb.rpc('my_wallet');
    if (w.error) throw new Error('코인 정보를 불러오지 못했어요. coins.sql 을 실행했는지 확인해 주세요.');
    const row = (w.data && w.data[0]) || { balance: 0, locked: 0, is_admin: false };
    COIN.balance = Number(row.balance);
    COIN.locked = Number(row.locked);
    COIN.isAdmin = !!row.is_admin;
    COIN.err = '';
    if (COIN.open) {
      const h = await ACC.sb.rpc('coin_history', { p_limit: 30 });
      COIN.rows = h.error ? [] : (h.data || []);
    }
  } catch (e) { COIN.err = e.message; }
  COIN.busy = false;
  coinChip(); coinRender();
}

/* 코인 보내기 */
async function coinSend() {
  const to = COIN.to.trim();
  const amt = Math.floor(Number(COIN.amount));
  COIN.err = ''; COIN.msg = '';
  if (!to) { COIN.err = '받는 사람 아이디를 적어 주세요.'; return coinRender(); }
  if (!Number.isFinite(amt) || amt <= 0) { COIN.err = '보낼 금액을 1 이상으로 적어 주세요.'; return coinRender(); }
  if (COIN.balance !== null && amt > COIN.balance) { COIN.err = '가진 코인보다 많이 보낼 수 없어요.'; return coinRender(); }

  COIN.busy = true; coinRender();
  const { data, error } = await ACC.sb.rpc('coin_transfer', { p_to_username: to, p_amount: amt });
  COIN.busy = false;
  if (error) { COIN.err = cleanErr(error.message); return coinRender(); }
  COIN.balance = Number(data);
  COIN.msg = `${esc(to)} 님에게 ${won(amt)}코인을 보냈어요.`;
  COIN.to = ''; COIN.amount = '';
  coinLoad(true);
}

/* 관리자 지급 */
async function coinGrant() {
  const to = COIN.gTo.trim();
  const amt = Math.floor(Number(COIN.gAmount));
  COIN.err = ''; COIN.msg = '';
  if (!to || !Number.isFinite(amt) || amt <= 0) { COIN.err = '아이디와 금액을 적어 주세요.'; return coinRender(); }
  COIN.busy = true; coinRender();
  const { data, error } = await ACC.sb.rpc('admin_grant', { p_username: to, p_amount: amt });
  COIN.busy = false;
  if (error) { COIN.err = cleanErr(error.message); return coinRender(); }
  COIN.balance = Number(data);
  COIN.msg = `${esc(to)} 님에게 ${won(amt)}코인을 지급했어요.`;
  COIN.gTo = ''; COIN.gAmount = '';
  coinLoad(true);
}

/* 서버가 보낸 오류에서 사람이 읽을 부분만 남긴다 */
function cleanErr(m) {
  const s = String(m || '');
  const hit = /([^:]*(?:요|다)\.)\s*$/.exec(s.split('\n')[0]);
  if (hit) return hit[1].trim();
  if (/permission denied|not exist/i.test(s)) return '이 기능이 아직 준비되지 않았어요. coins.sql 을 실행했는지 확인해 주세요.';
  return s.slice(0, 120);
}

function coinRender() {
  const box = document.getElementById('coinBody');
  if (!box) return;

  if (!ACC.sb) {
    box.innerHTML = '<p class="note">서버가 설정되지 않아 코인을 쓸 수 없어요.</p>';
    return;
  }
  if (!ACC.user) {
    box.innerHTML = '<p class="note">로그인하면 코인을 받고 보낼 수 있어요. 코인은 친구와 대전의 캐시 게임에서만 오갑니다.</p>';
    return;
  }

  const note = (COIN.err ? `<p class="note" style="color:var(--bad)">${esc(COIN.err)}</p>` : '')
             + (COIN.msg ? `<p class="note" style="color:var(--good)">${COIN.msg}</p>` : '');

  const list = COIN.rows.length ? COIN.rows.map((r) => `
    <div class="crow">
      <span class="gdate">${fmtDate(r.created_at)}</span>
      <span class="tag">${REASON[r.reason] || r.reason}</span>
      <span class="cwho">${r.other_name ? esc(r.other_name) : ''}</span>
      <span class="camt ${r.incoming ? 'pos' : 'neg'}">${r.incoming ? '+' : '−'}${won(r.amount)}</span>
    </div>`).join('') : '<p class="note">아직 오간 코인이 없어요.</p>';

  box.innerHTML = `
    <div class="cbal">
      <div class="slabel">가진 코인</div>
      <div class="cbig">${COIN.balance === null ? '…' : won(COIN.balance)}<span class="sunit">코인</span></div>
      ${COIN.locked ? `<div class="note">캐시 게임에 ${won(COIN.locked)}코인이 묶여 있어요. 판이 끝나면 정산되어 돌아옵니다.</div>` : ''}
    </div>
    ${note}

    <h3 class="subhead">코인 보내기</h3>
    <div class="sendrow">
      <input type="text" id="cTo" placeholder="받는 사람 아이디" value="${esc(COIN.to)}" autocomplete="off">
      <input type="text" id="cAmt" inputmode="numeric" placeholder="금액" value="${esc(COIN.amount)}">
      <button class="btn primary" id="cSend" ${COIN.busy ? 'disabled' : ''}>보내기</button>
    </div>
    <p class="note">아이디를 정확히 적어 주세요. 한 번 보낸 코인은 되돌릴 수 없어요.</p>

    ${COIN.isAdmin ? `
    <h3 class="subhead">지급 (관리자)</h3>
    <div class="sendrow">
      <input type="text" id="gTo" placeholder="받는 사람 아이디" value="${esc(COIN.gTo)}" autocomplete="off">
      <input type="text" id="gAmt" inputmode="numeric" placeholder="금액" value="${esc(COIN.gAmount)}">
      <button class="btn" id="gSend" ${COIN.busy ? 'disabled' : ''}>지급</button>
    </div>
    <p class="note">내 지갑에서 빠져나갑니다. 전체 발행량은 1억 코인으로 고정이에요.</p>` : ''}

    <h3 class="subhead">주고받은 내역</h3>
    <div class="clist">${list}</div>`;

  const keep = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.oninput = () => { COIN[key] = el.value; };
  };
  keep('cTo', 'to'); keep('cAmt', 'amount'); keep('gTo', 'gTo'); keep('gAmt', 'gAmount');
  const send = document.getElementById('cSend');
  if (send) send.onclick = coinSend;
  const grant = document.getElementById('gSend');
  if (grant) grant.onclick = coinGrant;
  const amt = document.getElementById('cAmt');
  if (amt) amt.onkeydown = (e) => { if (e.key === 'Enter') coinSend(); };
}

/* 열고 닫기 */
function toggleCoins(open) {
  const el = document.getElementById('viewCoins');
  if (!el) return;
  el.hidden = open === undefined ? !el.hidden : !open;
  COIN.open = !el.hidden;
  if (COIN.open) {
    if (typeof toggleRules === 'function') toggleRules(false);
    if (typeof toggleMyPage === 'function') toggleMyPage(false);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    coinLoad();
  }
}

/* 로그인·로그아웃, 그리고 판이 끝날 때 auth.js / multiplayer.js 가 불러 준다 */
let coinWho;
function coinOnAuth() {
  const who = (ACC.user && ACC.user.id) || null;
  if (who === coinWho) return;
  coinWho = who;
  COIN.balance = null; COIN.locked = 0; COIN.rows = []; COIN.isAdmin = false;
  COIN.err = ''; COIN.msg = '';
  if (ACC.sb && ACC.user) coinLoad(true); else { coinChip(); coinRender(); }
}
function coinRefresh() { if (ACC.sb && ACC.user) coinLoad(true); }

(function wireCoins() {
  const b = document.getElementById('btnCoins');
  if (b) b.onclick = () => toggleCoins();
  const c = document.getElementById('coinsClose');
  if (c) c.onclick = () => toggleCoins(false);
  const chip = document.getElementById('coinChip');
  if (chip) chip.onclick = () => toggleCoins(true);
  coinChip(); coinRender();
})();
