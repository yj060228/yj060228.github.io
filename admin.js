/* 관리자 화면
 *
 * 관리자 계정으로 로그인하면 게임 화면(써틴 판 · 친구와 대전 · 새 게임 · 내 기록)을 숨기고,
 * 그 자리에 관리자에게 필요한 것들을 보여 줘요.
 *   가운데: 코인 요약 · 사람별 코인 · 진행 중인 게임(멀티 방, AI 캐시 게임) · AI 캐시 게임 스위치
 *   오른쪽: 최근 코인 거래 · 최근 대국 (누르면 복기)
 * 관리자인지는 서버가 다시 확인하므로, 여기서 화면을 바꿔도 권한이 생기지는 않아요. */

const ADM = { on: false, data: null, busy: false, err: '', query: '', timer: null };

const admReason = (r) => (typeof REASON !== 'undefined' && REASON[r]) || r;
const admWhen = (iso) => (iso ? fmtDate(iso) : '');

/* 관리자인지 확인해서 화면을 바꾼다. coins.js 가 잔액을 불러온 뒤 불러 준다 */
function adminModeCheck() {
  const on = !!(typeof COIN !== 'undefined' && COIN.isAdmin && ACC && ACC.user);
  if (on === ADM.on) return;
  ADM.on = on;
  document.body.classList.toggle('admin-mode', on);
  clearInterval(ADM.timer);
  if (on) {
    adminLoad();
    ADM.timer = setInterval(() => { if (!document.hidden) adminLoad(true); }, 20000);
  } else {
    ADM.data = null;
  }
}

async function adminLoad(quiet) {
  if (!ADM.on || ADM.busy) return;
  ADM.busy = true;
  if (!quiet) adminRender();
  try {
    const [ov] = await Promise.all([
      mpCall('admin_overview', {}),
      typeof loadHolders === 'function' ? loadHolders() : null,
      typeof loadRooms === 'function' ? loadRooms() : null,
    ]);
    ADM.data = ov;
    ADM.err = '';
  } catch (e) { ADM.err = e.message; }
  ADM.busy = false;
  adminRender();
}

function adminRender() {
  if (!ADM.on) return;
  const main = document.getElementById('admMain');
  const side = document.getElementById('admSide');
  if (!main || !side) return;
  const d = ADM.data;
  const s = COIN.summary;

  /* ── 코인 요약 ── */
  const tiles = s ? `
    <div class="stats">
      <div class="stat"><div class="slabel">발행량</div><div class="sbig">${won(s.issued)}</div>
        <div class="srow"><span>실제 합계</span><b>${won(s.held)}</b></div>
        <div class="srow"><span>맞는지</span><b class="${s.ok ? 'pos' : 'neg'}">${s.ok ? '일치' : '불일치'}</b></div></div>
      <div class="stat"><div class="slabel">사람들이 가진 코인</div><div class="sbig">${won(s.circulating)}</div>
        <div class="srow"><span>가진 사람</span><b>${won(s.holders)}명</b></div>
        <div class="srow"><span>게임에 묶임</span><b>${won(s.locked_total)}</b></div></div>
      <div class="stat"><div class="slabel">관리자 보유</div><div class="sbig">${won(s.admin_held)}</div>
        <div class="srow"><span>남은 비율</span><b>${s.issued ? ((Number(s.admin_held) / Number(s.issued)) * 100).toFixed(1) : '0.0'}%</b></div>
        <div class="srow"><span>나눠 준 코인</span><b>${won(Number(s.issued) - Number(s.admin_held))}</b></div></div>
    </div>` : '<p class="note">불러오는 중…</p>';

  /* ── 사람별 코인 ── */
  const q = ADM.query.trim().toLowerCase();
  const holders = (COIN.holders || []).filter((r) => !q || (r.username || '').toLowerCase().includes(q));
  const holderRows = holders.length ? holders.map((r) => `
    <tr><td style="text-align:left">${esc(r.username)}${r.is_admin ? ' <span class="tag">관리자</span>' : ''}</td>
      <td>${won(r.balance)}</td><td class="${Number(r.locked) ? '' : 'faint'}">${won(r.locked)}</td><td><b>${won(r.held)}</b></td></tr>`).join('')
    : `<tr><td class="note" colspan="4" style="text-align:left">${q ? '찾는 아이디가 없어요.' : '아직 코인을 가진 사람이 없어요.'}</td></tr>`;

  /* ── 진행 중인 게임 ── */
  const rooms = (COIN.rooms || []).filter((r) => !r.stopped && (r.live || r.locked || r.status === 'waiting'));
  const roomRows = rooms.length ? rooms.map((r) => `
    <div class="aroom">
      <div class="arow">
        <span class="code">${esc(r.code)}</span>
        <span class="tag ${r.live ? 'pos' : ''}">${r.live ? `${r.round}번째 판 진행 중` : r.status === 'waiting' ? '대기 중' : '판 사이'}</span>
        ${r.stake ? `<span class="chip cash">◈ 1점당 ${won(r.stake)}</span>` : '<span class="tag">일반</span>'}
        ${r.locked ? `<span class="note">묶임 ${won(r.locked)}</span>` : ''}
        <button class="btn danger" data-adm-stop="${esc(r.code)}">닫기</button>
      </div>
      <div class="aplayers">${r.players.map((p) => `<span class="rp${p.present ? '' : ' faint'}">${esc(p.name)}${
        p.stack !== null ? `<b>◈${won(p.stack)}</b>` : ''}</span>`).join('')}</div>
    </div>`).join('') : '<p class="note">진행 중인 멀티 방이 없어요.</p>';

  const ai = (d && d.aiGames) || [];
  const aiRows = ai.length ? ai.map((g) => `
    <div class="aroom">
      <div class="arow">
        <b>${esc(g.name)}</b>
        <span class="tag">${g.n}인 · ${g.moves}수째</span>
        <span class="chip cash">◈ 1점당 ${won(g.stake)}</span>
        <span class="note">묶임 ${won(g.locked)}</span>
        <span class="gdate">${admWhen(g.started)} 시작</span>
      </div>
      <div class="aplayers"><span class="rp">남은 장수 · ${esc(g.name)} ${g.myCards}장</span>${
        g.aiCards.map((c, i) => `<span class="rp faint">AI ${i + 1} ${c}장</span>`).join('')}</div>
    </div>`).join('') : '<p class="note">진행 중인 AI 캐시 게임이 없어요.</p>';

  const aiOn = typeof CASH === 'undefined' || CASH.enabled !== false;

  main.innerHTML = `
    <div class="panel">
      <h2 class="row">관리자 · 코인 현황
        <button class="btn" id="admReload" style="margin-left:auto" ${ADM.busy ? 'disabled' : ''}>${ADM.busy ? '불러오는 중…' : '새로고침'}</button></h2>
      ${ADM.err ? `<p class="note" style="color:var(--bad)">${esc(ADM.err)}</p>` : ''}
      ${tiles}
      ${s && !s.ok ? '<p class="note" style="color:var(--bad)">발행량과 실제 합계가 다릅니다. 장부를 확인해 주세요.</p>' : ''}
    </div>

    <div class="panel">
      <h2 class="row">사람별 코인<span class="note" style="margin-left:auto">${holders.length}명</span></h2>
      <div class="sendrow"><input type="text" id="admQuery" placeholder="아이디로 찾기" value="${esc(ADM.query)}" autocomplete="off"></div>
      <div class="holders"><table class="score">
        <tr><th style="text-align:left">아이디</th><th>쓸 수 있음</th><th>묶임</th><th>합계</th></tr>${holderRows}
      </table></div>
      <p class="note">지급과 회수는 위쪽 코인 버튼에서 할 수 있어요.</p>
    </div>

    <div class="panel">
      <h2 class="row">진행 중인 게임</h2>
      <h3 class="subhead">친구와 대전</h3>
      <div class="arooms">${roomRows}</div>
      <h3 class="subhead">AI 캐시 게임</h3>
      <div class="cashrow">
        <span class="tag ${aiOn ? 'pos' : 'neg'}">${aiOn ? '켜짐' : '꺼짐'}</span>
        <button class="btn ${aiOn ? 'danger' : 'primary'}" id="admAiToggle">${aiOn ? 'AI 캐시 게임 끄기' : 'AI 캐시 게임 켜기'}</button>
        <span class="note">${aiOn ? '끄면 모두의 화면에서 사라지고, 진행 중인 판은 취소되어 코인을 돌려줘요.' : '꺼져 있어서 아무도 볼 수 없어요.'}</span>
      </div>
      <div class="arooms">${aiRows}</div>
    </div>`;

  /* ── 오른쪽: 최근 거래 · 최근 대국 ── */
  const ledger = (d && d.ledger) || [];
  const who = (l) => (l.from || l.to
    ? `${esc(l.from || '·')} → ${esc(l.to || '·')}`
    : esc(l.memo || ''));
  const ledgerRows = ledger.length ? ledger.map((l) => `
    <div class="aled">
      <div class="r1"><span class="tag">${esc(admReason(l.reason))}</span><span class="gdate">${admWhen(l.at)}</span></div>
      <div class="r2"><span class="w">${who(l)}</span><b>${won(l.amount)}</b></div>
    </div>`).join('') : '<p class="note">아직 거래가 없어요.</p>';

  const SRC = { solo: 'AI', mp: '멀티' };
  const games = (d && d.games) || [];
  const gameRows = games.length ? games.map((g) => {
    const people = g.seats.filter((x) => !x.ai);
    const nm = (seat) => (g.seats.find((x) => x.seat === seat) || {}).name || `${seat}번`;
    return `
    <button class="agame" data-adm-game="${g.id}">
      <span class="gdate">${admWhen(g.at)}</span>
      <span class="tag">${SRC[g.source] || g.source} · ${g.n}인</span>
      <span class="aw">${people.map((x) => `${esc(x.name)} <b class="${g.points[x.seat] > 0 ? 'pos' : g.points[x.seat] < 0 ? 'neg' : ''}">${g.points[x.seat] > 0 ? '+' : ''}${g.points[x.seat]}</b>`).join(' · ')}</span>
      <span class="note">${esc(nm(g.winner))} 승</span>
    </button>`;
  }).join('') : '<p class="note">아직 대국 기록이 없어요.</p>';

  side.innerHTML = `
    <div class="panel">
      <h2>최근 코인 거래</h2>
      <div class="admlist">${ledgerRows}</div>
    </div>
    <div class="panel">
      <h2>최근 대국</h2>
      <div class="admlist">${gameRows}</div>
      <p class="note">누르면 복기 창으로 볼 수 있어요. 기권한 AI 캐시 게임은 남지 않아요.</p>
    </div>`;

  /* ── 연결 ── */
  document.getElementById('admReload').onclick = () => adminLoad();
  const qi = document.getElementById('admQuery');
  qi.oninput = () => {
    ADM.query = qi.value;
    const pos = qi.selectionStart;
    adminRender();
    const again = document.getElementById('admQuery');
    again.focus(); again.setSelectionRange(pos, pos);
  };
  document.getElementById('admAiToggle').onclick = async () => {
    if (typeof cashAdminSet === 'function') await cashAdminSet(!aiOn);
    adminLoad(true);
  };
  for (const b of main.querySelectorAll('[data-adm-stop]')) {
    b.onclick = async () => { await adminStopRoom(b.dataset.admStop); adminLoad(true); };
  }
  for (const b of side.querySelectorAll('[data-adm-game]')) {
    b.onclick = async () => {
      try {
        const r = await mpCall('admin_game', { id: Number(b.dataset.admGame) });
        const first = (r.game.seats || []).find((x) => !x.ai);
        rvOpen(r.game, first ? first.seat : 0);
      } catch (e) { alert(e.message); }
    };
  }
}
