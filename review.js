/* 복기 — 지난 대국을 한 수씩 다시 보며 AI 와 비교한다
 *
 * 분석 방법
 *   · 내가 둔 수마다, 그 순간 내가 알 수 있던 정보(내 패, 바닥에 나온 패, 남은 장수)만으로
 *     AI 가 다시 탐색한다. 상대 패는 모르는 채로 여러 번 섞어 보며 계산한다.
 *   · 수마다 '기대 점수'(이 판이 끝났을 때 내 점수의 예상값)를 구하고,
 *     AI 가 좋게 본 수들 중 가장 높은 값과 내가 둔 수의 값 차이로 실수를 가린다.
 *   · 모든 수에 대해, 모든 패를 아는 상태로도 한 번 더 탐색해서 '패를 알 때' 기대 점수를 같이 보여 준다.
 *   · 훌륭한 수: AI 가 고르지 않은 수인데, 모든 패를 아는 상태로 보면 그 수가 가장 좋고
 *     실제로 그 판을 이긴 경우. 상대 패를 몰라서 AI 도 찾지 못한 결정적인 수다.
 *
 * 탐색은 무작위가 섞여서 같은 국면도 매번 1~3점쯤 흔들린다. 그래서 기준을 넉넉하게 잡았다. */

const RV_RED = 8;       /* 이만큼(점) 이상 손해면 치명적 실수 */
const RV_YELLOW = 3;    /* 이만큼 이상이면 아쉬운 수 */
const RV_SKY_GAP = 2;   /* 훌륭한 수: 모든 패를 알 때 AI 의 수보다 이만큼 이상 좋아야 */
const RV_CONSIDER = 0.1;/* AI 가 이 비율 이상 검토한 수만 '좋게 본 수'로 친다 */
const RV_PLAUSIBLE = 0.25; /* AI 도 이만큼 진지하게 검토한 수는 실수로 치지 않는다 */
const RV_SKY_MIN_HAND = 4; /* 훌륭한 수: 두기 전 내 패가 이만큼은 남아 있어야 (거의 끝난 판 제외) */
const RV_SKY_MIN_LEFT = 4; /* 훌륭한 수: 그 뒤로 판이 이만큼(수)은 더 이어져야 */

const RV_LABEL = {
  red: '치명적 실수', yellow: '아쉬운 수', green: '좋은 수', sky: '훌륭한 수',
  forced: '외길', unknown: '판단 보류', other: '', wait: '분석 중', todo: '분석 전',
};

const RV = {
  open: false, game: null, seat: 0, steps: [], idx: -1,
  res: {}, token: 0, running: false, err: '', done: 0, total: 0,
};

const rvName = (seat) => {
  const g = RV.game;
  const s = g && (g.seats || []).find((x) => x.seat === seat);
  return s ? s.name : `${seat}번`;
};
const rvCards = (m, cls) => (m.type === PASS
  ? '<span class="note">패스</span>'
  : `<span class="row-cards">${maskCards(m).map((c) => cardHtml(c, cls || 'sm')).join('')}</span>`);
const rvPts = (v) => (v === null || v === undefined ? '–' : (v > 0 ? '+' : '') + v.toFixed(1));

/* 기록을 처음부터 다시 둬 보며 수마다 그 직전 국면을 만든다 */
function rvBuild(d) {
  const n = d.n_players || (d.deal || []).length;
  const g = initState(n, d.deal.map((h) => maskFromCards(h)));
  const moves = d.moves || [];
  /* '전 판 승자가 선' 방에서는 가장 낮은 카드가 아닌 사람이 먼저 낸다 */
  if (moves.length && moves[0].s !== g.turn) {
    g.turn = g.lastPlayer = moves[0].s;
    g.mustInclude = emptyMask();
  }
  const steps = [];
  for (const mv of moves) {
    const ms = legalMoves(g);
    const m = (!mv.c || !mv.c.length)
      ? ms.find((x) => x.type === PASS)
      : ms.find((x) => x.type !== PASS && maskEq(x, maskFromCards(mv.c)));
    if (!m || g.turn !== mv.s) break;          /* 기록이 규칙과 안 맞으면 거기까지만 */
    steps.push({ state: cloneState(g), move: m, seat: mv.s, forced: ms.length === 1 });
    doMove(g, m);
  }
  return { steps, final: g };
}

/* 여러 번 분석한 결과를 수마다 평균한다 (탐색이 흔들리는 걸 줄이려고) */
function rvMerge(list) {
  const by = new Map();
  for (const r of list) {
    for (const x of r.stats) {
      const e = by.get(x.move.id) || { move: x.move, visits: 0, share: 0, sum: 0, n: 0 };
      e.visits += x.visits;
      e.share += x.share / list.length;
      if (x.value !== null) { e.sum += x.value; e.n++; }
      by.set(x.move.id, e);
    }
  }
  const stats = [...by.values()].map((e) => ({
    move: e.move, visits: e.visits, share: e.share, value: e.n ? e.sum / e.n : null,
  })).sort((a, b) => b.share - a.share);
  return { best: stats[0].move.id, stats };
}

/* 실수 가리기
 *   · AI 가 좋게 본 수들 중 가장 높은 기대 점수와, 내가 둔 수의 기대 점수 차이(손해)로 정한다
 *   · AI 도 진지하게 검토한 수는 그 국면에서 그럴 만한 선택이라 실수로 치지 않는다
 *   · 값을 제대로 못 구했으면 판단을 보류한다 */
function rvClassify(step, r) {
  const act = r.stats.find((x) => x.move.id === step.move.id);
  const good = r.stats.filter((x) => x.share >= RV_CONSIDER && x.value !== null);
  const best = (good.length ? good : r.stats.filter((x) => x.value !== null))
    .reduce((a, x) => (a === null || x.value > a ? x.value : a), null);
  const mine = act && act.value !== null ? act.value : null;
  const loss = best === null || mine === null ? null : Math.max(0, best - mine);
  let kind = 'green';
  if (loss === null) kind = 'unknown';
  else if (act.share >= RV_PLAUSIBLE) kind = 'green';
  else if (loss >= RV_RED) kind = 'red';
  else if (loss >= RV_YELLOW) kind = 'yellow';
  return { kind, loss, best, mine, aiPick: r.best, plausible: !!act && act.share >= RV_PLAUSIBLE };
}

/* 표에 보여 줄 수: AI 가 실제로 값을 구한 수 중 많이 검토한 6개 + 내가 둔 수.
   값이 없는('–') 줄은 보여 주지 않는다 */
const RV_SHOW = 6;
function rvShown(stats, actualId) {
  const rows = stats.filter((x) => x.value !== null).sort((a, b) => b.share - a.share);
  const shown = rows.slice(0, RV_SHOW);
  if (!shown.some((x) => x.move.id === actualId)) {
    const act = stats.find((x) => x.move.id === actualId);
    if (act) shown.push(act);
  }
  return shown;
}

/* 거의 끝난 판인지: 내 패가 얼마 안 남았거나, 그 뒤로 몇 수 안 남았으면 */
function rvLateGame(i) {
  const step = RV.steps[i];
  const hand = popc(step.state.hand[step.seat]);
  const left = RV.steps.length - 1 - i;
  return hand < RV_SKY_MIN_HAND || left < RV_SKY_MIN_LEFT;
}

/* 훌륭한 수: AI 가 고르지 않았지만, 모든 패를 알면 그 수가 가장 좋았고 실제로 이긴 경우 */
function rvBrilliant(step, open) {
  const act = open.stats.find((x) => x.move.id === step.move.id);
  if (!act || act.value === null) return false;
  const others = open.stats.filter((x) => x.move.id !== step.move.id && x.value !== null && x.visits >= 20);
  const bestOther = others.reduce((a, x) => (a === null || x.value > a ? x.value : a), null);
  return bestOther === null || act.value - bestOther >= RV_SKY_GAP;
}

function rvIters() {
  const nn = typeof UI !== 'undefined' && UI.modelName;
  return nn ? 800 : 2000;
}

/* 내 수를 하나씩 분석한다. 누른 수가 있으면 그것부터 */
async function rvRun() {
  if (RV.running) return;
  RV.running = true;
  const token = RV.token;
  try {
    for (;;) {
      if (token !== RV.token || !RV.open) break;
      const todo = RV.steps.map((s, i) => i).filter((i) => rvMine(i) && !RV.res[i]);
      if (!todo.length) break;
      const i = todo.includes(RV.idx) ? RV.idx : todo[0];
      const step = RV.steps[i];
      RV.res[i] = { kind: 'wait' };
      rvRender();

      const want = { cmd: 'analyze', state: step.state, iters: rvIters(), blend: UI.blend, focus: step.move.id };
      let r = await ask(want);
      if (token !== RV.token) break;
      let c = rvClassify(step, r);
      /* 실수로 보이면 한 번 더 분석해서 평균으로 다시 판단한다 (우연히 흔들린 값으로 몰지 않게) */
      if (c.kind === 'red' || c.kind === 'yellow') {
        const r2 = await ask(want);
        if (token !== RV.token) break;
        r = rvMerge([r, r2]);
        c = rvClassify(step, r);
      }
      const out = { ...c, stats: r.stats, open: null };

      /* 모든 패를 아는 상태로 다시 본다. 표에 보일 수들은 모두 꼭 둬 봐서 값이 빠지지 않게 */
      const shownIds = rvShown(r.stats, step.move.id).map((x) => x.move.id);
      const o = await ask({ cmd: 'analyze', state: step.state, iters: rvIters(), blend: UI.blend, focus: shownIds, open: true });
      if (token !== RV.token) break;
      out.open = o.stats;

      /* 훌륭한 수: AI 가 다른 수를 골랐는데 이 판을 이겼고, 패를 알고 보면 내 수가 가장 좋았을 때.
         거의 끝난 판에서는 어떤 수든 이기기 쉬워서 훌륭한 수로 치지 않는다 */
      const won = RV.game.winner_seat === RV.seat;
      if (won && r.best !== step.move.id && !rvLateGame(i) && rvBrilliant(step, o)) out.kind = 'sky';
      RV.res[i] = out;
      RV.done++;
      rvRender();
    }
  } catch (e) {
    RV.err = '분석하지 못했어요 — ' + ((e && e.message) || e);
  }
  RV.running = false;
  rvRender();
}

/* 앞선 분석이 멈추기를 기다렸다가 새로 시작 */
function rvKick() {
  const go = () => (RV.running ? setTimeout(go, 50) : rvRun());
  go();
}

const rvMine = (i) => RV.steps[i] && RV.steps[i].seat === RV.seat && !RV.steps[i].forced;

function rvOpen(game, seat) {
  const built = rvBuild(game);
  RV.token++;
  RV.open = true; RV.game = game; RV.seat = seat; RV.steps = built.steps; RV.res = {};
  RV.err = ''; RV.done = 0;
  RV.total = RV.steps.filter((s, i) => rvMine(i)).length;
  RV.idx = RV.steps.findIndex((s, i) => rvMine(i));
  if (RV.idx < 0) RV.idx = 0;
  if (built.steps.length < (game.moves || []).length) {
    RV.err = `기록 ${built.steps.length + 1}번째 수부터는 규칙과 맞지 않아 보여 줄 수 없어요.`;
  }
  const el = document.getElementById('reviewModal');
  el.hidden = false;
  document.body.classList.add('modal-open');
  rvRender();
  rvKick();
}

function rvClose() {
  RV.open = false; RV.token++;
  const el = document.getElementById('reviewModal');
  if (el) el.hidden = true;
  document.body.classList.remove('modal-open');
}

function rvSetSeat(seat) {
  RV.token++;
  RV.seat = seat; RV.res = {}; RV.done = 0;
  RV.total = RV.steps.filter((s, i) => rvMine(i)).length;
  const first = RV.steps.findIndex((s, i) => rvMine(i));
  if (first >= 0) RV.idx = first;
  /* 진행 중이던 분석은 토큰이 바뀌어서 스스로 멈춘다 */
  rvRender(); rvKick();
}

function rvGo(i) {
  if (i < 0 || i >= RV.steps.length) return;
  RV.idx = i;
  rvRender();
  const row = document.querySelector(`#rvMoves [data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/* ───────── 그리기 ───────── */
function rvRender() {
  const box = document.getElementById('rvBody');
  if (!box || !RV.open) return;
  const g = RV.game;
  const step = RV.steps[RV.idx];

  const counts = { red: 0, yellow: 0, green: 0, sky: 0 };
  for (const k of Object.keys(RV.res)) if (counts[RV.res[k].kind] !== undefined) counts[RV.res[k].kind]++;

  const seatOpts = (g.seats || []).filter((x) => !x.ai)
    .map((x) => `<option value="${x.seat}"${x.seat === RV.seat ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  const moves = RV.steps.map((s, i) => {
    const r = RV.res[i];
    const kind = s.forced ? 'forced' : r ? r.kind : (s.seat === RV.seat ? 'todo' : 'other');
    return `<button class="rvm k-${kind}${i === RV.idx ? ' on' : ''}" data-i="${i}">
      <span class="dnum">${i + 1}</span><span class="dname">${esc(rvName(s.seat))}</span>
      ${rvCards(s.move)}
      ${RV_LABEL[kind] ? `<span class="rvk">${RV_LABEL[kind]}</span>` : ''}
    </button>`;
  }).join('');

  box.innerHTML = `
    <div class="rvtop">
      <span class="note">${fmtDate(g.created_at)} · ${g.n_players}인 · ${esc(rvName(g.winner_seat))} 승리</span>
      ${seatOpts ? `<label class="note" for="rvSeat">누구의 수를 볼까요</label><select id="rvSeat">${seatOpts}</select>` : ''}
    </div>
    <div class="rvsum">
      <span class="rvbadge k-red">치명적 실수 ${counts.red}</span>
      <span class="rvbadge k-yellow">아쉬운 수 ${counts.yellow}</span>
      <span class="rvbadge k-green">좋은 수 ${counts.green}</span>
      <span class="rvbadge k-sky">훌륭한 수 ${counts.sky}</span>
      <span class="note">${RV.running || RV.done < RV.total ? `분석 중 ${RV.done}/${RV.total}` : `분석 끝 · ${RV.total}수`}</span>
    </div>
    ${RV.err ? `<p class="note" style="color:var(--bad)">${esc(RV.err)}</p>` : ''}
    <div class="rvgrid">
      <div class="rvmain">${step ? rvBoardHtml(step) + rvDetailHtml(RV.idx) : '<p class="note">둔 수가 없어요.</p>'}</div>
      <div class="rvside">
        <div class="rvnav">
          <button class="btn" id="rvPrev">◀ 이전</button>
          <button class="btn" id="rvNextMine">다음 내 수</button>
          <button class="btn" id="rvNext">다음 ▶</button>
        </div>
        <div class="rvmoves" id="rvMoves">${moves}</div>
      </div>
    </div>`;

  for (const b of box.querySelectorAll('.rvm')) b.onclick = () => rvGo(Number(b.dataset.i));
  const sel = document.getElementById('rvSeat');
  if (sel) sel.onchange = (e) => rvSetSeat(Number(e.target.value));
  document.getElementById('rvPrev').onclick = () => rvGo(RV.idx - 1);
  document.getElementById('rvNext').onclick = () => rvGo(RV.idx + 1);
  document.getElementById('rvNextMine').onclick = () => {
    const n = RV.steps.findIndex((s, i) => i > RV.idx && rvMine(i));
    if (n >= 0) rvGo(n);
  };
  /* 누른 수가 아직 분석 전이면 그것부터 하도록 */
  if (rvMine(RV.idx) && !RV.res[RV.idx] && !RV.running) rvRun();
}

/* 그 수를 두기 직전의 판 */
function rvBoardHtml(step) {
  const s = step.state;
  const seats = [];
  for (let p = 0; p < s.n; p++) {
    const me = p === step.seat;
    const hand = maskCards(s.hand[p]);
    const used = new Set(me ? maskCards(step.move) : []);
    seats.push(`
      <div class="rvseat${me ? ' turn' : ''}">
        <div class="rvwho"><b>${esc(rvName(p))}</b>
          <span class="note">${hand.length}장${s.passed[p] ? ' · 패스' : ''}</span></div>
        <div class="row-cards">${hand.map((c) => cardHtml(c, 'sm' + (used.has(c) ? ' sel' : ''))).join('')}</div>
      </div>`);
  }
  const lead = s.last.type === PASS;
  const pile = lead
    ? `<span class="note">${maskEmpty(s.mustInclude) ? '선 — 아무 패나 낼 수 있어요' : `첫 수 — ${maskCards(s.mustInclude).map(cardStr).join(' ')} 포함`}</span>`
    : `${rvCards(s.last)}<span class="note">${esc(rvName(s.lastPlayer))}의 ${TYPE_NAME[s.last.type]}</span>`;
  return `
    <div class="rvboard">
      <div class="rvpile"><span class="lbl">${lead ? '선' : '바닥'}</span>${pile}</div>
      ${seats.join('')}
    </div>`;
}

/* 이 수에 대한 AI 의견 */
function rvDetailHtml(i) {
  const step = RV.steps[i];
  const who = esc(rvName(step.seat));
  const head = `<div class="rvplay"><span class="note">${i + 1}번째 수 · ${who}</span>${rvCards(step.move)}</div>`;
  if (step.forced) return head + '<p class="note">낼 수 있는 수가 이것뿐이라 분석하지 않았어요.</p>';
  if (step.seat !== RV.seat) return head + '<p class="note">위에서 고른 사람의 수만 분석해요. 이 사람의 수를 보려면 위에서 바꿔 주세요.</p>';
  const r = RV.res[i];
  if (!r || r.kind === 'wait') return head + '<p class="note">AI 가 이 국면을 다시 생각하는 중이에요…</p>';

  const verdict = {
    red: `기대 점수를 <b>${r.loss.toFixed(1)}점</b> 잃은 수예요. AI 라면 다른 수를 냈어요.`,
    yellow: `AI 가 본 최선보다 <b>${r.loss.toFixed(1)}점</b> 아쉬운 수예요.`,
    green: r.plausible && r.loss >= RV_YELLOW
      ? `최선과 ${r.loss.toFixed(1)}점 차이가 나지만, AI 도 진지하게 고민한 수라 실수로 치지 않았어요.`
      : r.loss > 0.05 ? `최선과 ${r.loss.toFixed(1)}점 차이로, 충분히 좋은 수예요.` : 'AI 가 본 최선과 같은 수예요.',
    unknown: '이 수의 값을 충분히 계산하지 못해서 판단을 보류했어요.',
    sky: '상대 패를 몰라서 AI 도 고르지 않았지만, 모든 패를 알고 보면 가장 좋은 수였고 그대로 이겼어요.',
  }[r.kind];

  const shown = rvShown(r.stats, step.move.id);
  const openOf = (id) => {
    const o = r.open && r.open.find((x) => x.move.id === id);
    return o ? o.value : null;
  };
  const table = shown.map((x) => {
    const mine = x.move.id === step.move.id, pick = x.move.id === r.aiPick;
    return `
      <div class="rvrow${mine ? ' mine' : ''}">
        <span class="rvtag">${pick ? 'AI 추천' : ''}${mine ? (pick ? ' · 내 수' : '내 수') : ''}</span>
        ${rvCards(x.move)}
        <span class="rvbar"><i style="width:${Math.round(x.share * 100)}%"></i></span>
        <span class="rvval ${x.value > 0 ? 'pos' : x.value < 0 ? 'neg' : ''}">${rvPts(x.value)}</span>
        ${r.open ? `<span class="rvval faint" title="모든 패를 알 때">${rvPts(openOf(x.move.id))}</span>` : ''}
      </div>`;
  }).join('');

  return `${head}
    <div class="rvverdict k-${r.kind}"><b>${RV_LABEL[r.kind]}</b> ${verdict}</div>
    <div class="rvtable">
      <div class="rvrow rvhead"><span class="rvtag"></span><span>수</span><span>AI 검토 비율</span><span class="rvval">기대 점수</span>${r.open ? '<span class="rvval">패를 알 때</span>' : ''}</div>
      ${table}
    </div>
    <p class="note">기대 점수는 이 수를 냈을 때 판이 끝나면 받을 것으로 예상되는 점수예요.
      그 순간 볼 수 있던 정보(내 패, 나온 패, 남은 장수)만으로 계산했어요.</p>`;
}

(function wireReview() {
  const c = document.getElementById('rvClose');
  if (c) c.onclick = rvClose;
  const m = document.getElementById('reviewModal');
  if (m) m.onclick = (e) => { if (e.target === m) rvClose(); };
  document.addEventListener('keydown', (e) => {
    if (!RV.open) return;
    if (e.key === 'Escape') rvClose();
    else if (e.key === 'ArrowLeft') rvGo(RV.idx - 1);
    else if (e.key === 'ArrowRight') rvGo(RV.idx + 1);
  });
})();
