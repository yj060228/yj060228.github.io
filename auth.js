/* 아이디/비밀번호 회원가입·로그인과 리더보드 (Supabase)
 *
 * Supabase Auth 는 이메일 기반이라, 아이디를 내부적으로
 * <아이디>@example.com 형태의 주소로 바꿔서 씁니다.
 * example.com 은 문서용으로 예약된 도메인이라 실제 메일이 가지 않습니다.
 * 한글처럼 이메일 주소에 못 쓰는 글자는 16진수로 바꿔서 담습니다.
 * (Supabase 대시보드에서 이메일 확인을 꺼 두어야 해요. README 참고)
 */
const CFG = window.THIRTEEN_CONFIG || {};
const ID_DOMAIN = 'example.com';

const ACC = {
  sb: null, user: null, rec: null, rows: [],
  ready: false, busy: false, error: '', mode: 'login',
  boardMode: 'solo', hasMp: true, myRank: null,
};

const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
/* 아이디를 이메일 주소로 바꿉니다. 같은 아이디는 늘 같은 주소가 됩니다. */
function localPart(id) {
  const low = (id || '').toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(low)) return low;
  let hex = '';
  for (const b of new TextEncoder().encode(low)) hex += b.toString(16).padStart(2, '0');
  return 'u' + hex;
}
const idToEmail = (id) => `${localPart(id)}@${ID_DOMAIN}`;
const online = () => !!ACC.sb;

function localRec() {
  try { return JSON.parse(localStorage.getItem('thirteen-local') || 'null'); } catch (_) { return null; }
}
function saveLocalRec(r) { try { localStorage.setItem('thirteen-local', JSON.stringify(r)); } catch (_) {} }

/* 아이디 규칙: 영문/숫자/한글/_/- 2~16자.
   한글은 주소로 바꿀 때 길어지므로 10자까지만 허용합니다. */
function validId(id) {
  if (!/^[\w가-힣-]{2,16}$/.test(id)) return '아이디는 2~16자의 한글·영문·숫자·_·- 만 쓸 수 있어요.';
  if (localPart(id).length > 60) return '아이디가 너무 길어요. 한글은 10자까지 써 주세요.';
  return '';
}

async function initAccount() {
  if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) {
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      ACC.sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await ACC.sb.auth.getSession();
      if (data && data.session) await afterLogin(data.session.user);
      ACC.sb.auth.onAuthStateChange((_e, session) => {
        if (!session) { ACC.user = null; ACC.rec = null; renderAccount(); }
      });
      await loadBoard();
    } catch (e) {
      ACC.sb = null;
      ACC.error = '서버에 연결하지 못했어요. 기록은 이 브라우저에만 남아요.';
    }
  }
  if (!online()) ACC.rec = localRec();
  ACC.ready = true;
  renderAccount();
  renderBoard();
}

async function afterLogin(u) {
  ACC.user = u;
  const { data, error } = await ACC.sb.from('profiles').select('*').eq('id', u.id).maybeSingle();
  if (error) { ACC.error = error.message; return; }
  ACC.rec = data || { id: u.id, username: (u.user_metadata && u.user_metadata.username) || '플레이어',
                      total: 0, games: 0, wins: 0 };
  if (!data) await ACC.sb.from('profiles').upsert(stripRec(ACC.rec));
}
const stripRec = (r) => ({ id: r.id, username: r.username, total: r.total, games: r.games, wins: r.wins });

async function signUp(id, pw) {
  const bad = validId(id);
  if (bad) throw new Error(bad);
  if ((pw || '').length < 6) throw new Error('비밀번호는 6자 이상이어야 해요.');
  const { data, error } = await ACC.sb.auth.signUp({
    email: idToEmail(id), password: pw, options: { data: { username: id } },
  });
  if (error) {
    const m = error.message || '';
    if (m.includes('already') || m.includes('registered')) throw new Error('이미 있는 아이디예요.');
    if (m.includes('Password')) throw new Error('비밀번호가 조건에 맞지 않아요. 6자 이상으로 해 주세요.');
    if (m.includes('Signups not allowed') || m.includes('disabled')) {
      throw new Error('가입이 꺼져 있어요. Supabase의 Authentication 설정에서 Allow new users to sign up 을 켜 주세요.');
    }
    throw new Error(m);
  }
  if (!data.session) {
    const r = await ACC.sb.auth.signInWithPassword({ email: idToEmail(id), password: pw });
    if (r.error) throw new Error('가입은 됐지만 로그인에 실패했어요. 다시 로그인해 주세요.');
    return afterLogin(r.data.user);
  }
  return afterLogin(data.user);
}

async function signIn(id, pw) {
  const { data, error } = await ACC.sb.auth.signInWithPassword({ email: idToEmail(id), password: pw });
  if (error) throw new Error('아이디나 비밀번호가 맞지 않아요.');
  return afterLogin(data.user);
}

async function signOut() {
  if (ACC.sb) await ACC.sb.auth.signOut();
  ACC.user = null; ACC.rec = null; ACC.myRank = null;
  renderAccount(); renderBoard();
}

/* 리더보드에 보여 줄 인원 */
const BOARD_TOP = 25;

/* 서버에서 상위 명단을 받아온다.
 * 정렬과 "1판 이상" 거르기를 서버에서 해야 합니다.
 * 그냥 아무나 받아와서 브라우저에서 줄 세우면,
 * 가입자가 늘었을 때 1등이 명단에 아예 안 들어올 수 있어요. */
async function loadBoard() {
  if (!online()) { renderBoard(); return; }
  const mp = ACC.boardMode === 'mp' && ACC.hasMp;
  const totalCol = mp ? 'mp_total' : 'total';
  const gamesCol = mp ? 'mp_games' : 'games';

  if (ACC.hasMp) {
    const r = await ACC.sb.from('profiles')
      .select('id,username,total,games,wins,mp_total,mp_games,mp_wins')
      .gt(gamesCol, 0)
      .order(totalCol, { ascending: false })
      .limit(BOARD_TOP);
    if (!r.error) { ACC.rows = r.data || []; await loadMyRank(); return; }
    ACC.hasMp = false;          /* 멀티플레이 SQL 을 아직 실행하지 않은 경우 */
  }
  const { data, error } = await ACC.sb.from('profiles')
    .select('id,username,total,games,wins')
    .gt('games', 0)
    .order('total', { ascending: false })
    .limit(BOARD_TOP);
  if (!error) ACC.rows = data || [];
  await loadMyRank();
}

/* 내가 상위 명단 밖이면 내 등수를 따로 구해서 맨 아래에 붙여 준다 */
async function loadMyRank() {
  ACC.myRank = null;
  const rec = ACC.rec;
  if (!ACC.user || !rec) { renderBoard(); return; }

  const mp = ACC.boardMode === 'mp' && ACC.hasMp;
  const totalCol = mp ? 'mp_total' : 'total';
  const gamesCol = mp ? 'mp_games' : 'games';
  const myTotal = Number(rec[totalCol] || (mp ? 0 : rec.total) || 0);
  const myGames = Number(rec[gamesCol] || (mp ? 0 : rec.games) || 0);

  if (myGames > 0 && !ACC.rows.some((r) => r.id === ACC.user.id)) {
    try {
      /* 나보다 점수가 높은 사람이 몇 명인지 세면 그게 내 등수 − 1 */
      const { count, error } = await ACC.sb.from('profiles')
        .select('id', { count: 'exact', head: true })
        .gt(gamesCol, 0)
        .gt(totalCol, myTotal);
      if (!error && count !== null) ACC.myRank = count + 1;
    } catch (_) { /* 등수를 못 구해도 표는 그대로 보여 준다 */ }
  }
  renderBoard();
}

async function recordGame(points, won) {
  if (!ACC.rec) return;
  ACC.rec.total += points;
  ACC.rec.games += 1;
  if (won) ACC.rec.wins += 1;
  if (online() && ACC.user) {
    const { error } = await ACC.sb.from('profiles').upsert(stripRec(ACC.rec));
    if (error) ACC.error = '기록을 저장하지 못했어요: ' + error.message;
    await loadBoard();
  } else {
    saveLocalRec(ACC.rec);
  }
  renderAccount();
  renderBoard();
}

/* ───────── 화면 ───────── */
function renderAccount() {
  const box = $('accountBody');
  if (!ACC.ready) return;

  if (ACC.rec) {
    const r = ACC.rec;
    const rate = r.games ? Math.round((r.wins / r.games) * 100) : 0;
    box.innerHTML = `
      <div class="acct">
        <div style="min-width:0">
          <div class="nm">${esc(r.username)}</div>
          <div class="sm">${r.games}판 · 승점 ${r.total > 0 ? '+' : ''}${r.total} · 승률 ${rate}%</div>
        </div>
        ${online() && ACC.user ? '<button class="btn" id="btnOut" style="margin-left:auto">로그아웃</button>' : ''}
      </div>
      ${online() ? '' : '<p class="note">이 브라우저에만 저장되는 기록이에요.</p>'}
      ${ACC.error ? `<p class="note">${esc(ACC.error)}</p>` : ''}`;
    if ($('btnOut')) $('btnOut').onclick = signOut;
    return;
  }

  if (!online()) {
    box.innerHTML = `
      <p class="note">${ACC.error || '로그인 서버가 설정되지 않아 기록은 이 브라우저에만 남아요.'}</p>
      <div class="acct">
        <input type="text" id="inpId" maxlength="16" placeholder="닉네임">
        <button class="btn primary" id="btnGuest">시작하기</button>
      </div>`;
    const go = () => {
      const v = ($('inpId').value || '').trim();
      if (!v) { $('inpId').style.borderColor = 'var(--bad)'; return; }
      ACC.rec = { username: v, total: 0, games: 0, wins: 0 };
      saveLocalRec(ACC.rec); renderAccount(); renderBoard();
    };
    $('btnGuest').onclick = go;
    $('inpId').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    return;
  }

  const signup = ACC.mode === 'signup';
  box.innerHTML = `
    <p class="note">${signup ? '아이디와 비밀번호를 정해 주세요. 아이디는 한글도 쓸 수 있어요.'
                             : '기록을 남기려면 로그인하세요.'}</p>
    <div class="acct">
      <input type="text" id="inpId" maxlength="16" placeholder="아이디" autocomplete="username">
      <input type="password" id="inpPw" placeholder="비밀번호" autocomplete="${signup ? 'new-password' : 'current-password'}">
      <button class="btn primary" id="btnGo">${signup ? '가입하고 시작' : '로그인'}</button>
    </div>
    <div class="acct">
      <button class="btn" id="btnMode">${signup ? '이미 계정이 있어요' : '처음이에요 — 회원가입'}</button>
      <button class="btn" id="btnGuest">로그인 없이 연습만</button>
    </div>
    ${ACC.error ? `<p class="note" style="color:var(--bad)">${esc(ACC.error)}</p>` : ''}`;

  const submit = async () => {
    const id = ($('inpId').value || '').trim();
    const pw = $('inpPw').value || '';
    ACC.error = ''; ACC.busy = true;
    $('btnGo').disabled = true; $('btnGo').textContent = '잠시만요…';
    try {
      await (signup ? signUp(id, pw) : signIn(id, pw));
      await loadBoard();
    } catch (e) { ACC.error = e.message; }
    ACC.busy = false;
    renderAccount(); renderBoard();
  };
  $('btnGo').onclick = submit;
  $('inpPw').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('btnMode').onclick = () => { ACC.mode = signup ? 'login' : 'signup'; ACC.error = ''; renderAccount(); };
  $('btnGuest').onclick = () => {
    ACC.rec = localRec() || { username: '연습', total: 0, games: 0, wins: 0 };
    saveLocalRec(ACC.rec); renderAccount(); renderBoard();
  };
}

function renderBoard() {
  const t = $('lbTable'), note = $('lbNote');
  const mp = ACC.boardMode === 'mp' && ACC.hasMp;
  const F = mp ? ['mp_total', 'mp_games', 'mp_wins'] : ['total', 'games', 'wins'];
  const seg = $('lbMode');
  if (seg) {
    seg.classList.toggle('hidden', !online() || !ACC.hasMp);
    for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.mode === ACC.boardMode));
  }
  const pick = (r) => ({
    id: r.id, username: r.username,
    total: r[F[0]] || 0, games: r[F[1]] || 0, wins: r[F[2]] || 0,
  });
  /* 서버가 이미 정렬해서 보내 주지만, 한 판 뒀을 때 바로 반영되도록 한 번 더 줄 세웁니다 */
  let rows = ACC.rows.slice().map(pick)
    .filter((r) => r.games > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, BOARD_TOP);
  if (!online()) rows = ACC.rec ? [{ id: 'local', ...pick(ACC.rec) }] : [];

  const row = (r, rank) => {
    const rate = r.games ? Math.round((r.wins / r.games) * 100) : 0;
    const me = ACC.user ? r.id === ACC.user.id : true;
    const cls = r.total > 0 ? 'pos' : r.total < 0 ? 'neg' : '';
    return `<tr class="${me ? 'me' : ''}"><td class="rankno">${rank}</td>
      <td style="text-align:left">${esc(r.username || '이름 없음')}</td>
      <td class="${cls}">${r.total > 0 ? '+' : ''}${r.total}</td>
      <td>${r.games}</td><td>${rate}%</td></tr>`;
  };

  if (!rows.length) {
    t.innerHTML = `<tr><td class="note" style="text-align:left">아직 ${mp ? '친구와 대전' : 'AI 연습'} 기록이 없어요. 한 판 두면 여기에 올라와요.</td></tr>`;
  } else {
    const head = '<tr><th>#</th><th style="text-align:left">아이디</th><th>승점</th><th>판수</th><th>승률</th></tr>';
    let html = head + rows.map((r, i) => row(r, i + 1)).join('');
    /* 내가 상위 명단 밖이면 맨 아래에 내 줄을 따로 붙인다 */
    if (ACC.myRank && ACC.rec && !rows.some((r) => r.id === (ACC.user && ACC.user.id))) {
      html += `<tr class="gap"><td colspan="5">⋯</td></tr>`
            + row({ ...pick(ACC.rec), id: ACC.user.id }, ACC.myRank);
    }
    t.innerHTML = html;
  }

  const where = mp ? '친구와 대전' : 'AI 연습';
  note.textContent = !online() ? '지금은 이 브라우저에만 기록돼요.'
    : `${where}에서 쌓은 누적 승점이에요. 한 판 이상 둔 사람만, 상위 ${BOARD_TOP}명까지 보여요.`;
}

/* 계정 화면이 다시 그려지면 내 기록 화면에도 알려 준다 (mypage.js) */
(function hookMyPage() {
  const orig = renderAccount;
  renderAccount = function () {
    const r = orig.apply(this, arguments);
    if (typeof myOnAuth === 'function') myOnAuth();
    if (typeof coinOnAuth === 'function') coinOnAuth();
    return r;
  };
})();

/* 리더보드 전환 버튼 */
(function wireBoardMode() {
  const seg = document.getElementById('lbMode');
  if (!seg) return;
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (ACC.boardMode === b.dataset.mode) return;
    ACC.boardMode = b.dataset.mode;
    /* 탭이 바뀌면 정렬 기준이 달라지므로 서버에서 다시 받아옵니다 */
    loadBoard();
  });
})();