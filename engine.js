/* 써틴 규칙 + ISMCTS + 신경망 추론 (thirteen.c 의 자바스크립트 이식)
 *
 * 카드 인덱스 = rank*4 + suit   (클수록 강함)
 *   rank 0..12 = 3,4,...,K,A,2 / suit 0=C 1=H 2=D 3=S
 * 손패는 52비트 마스크를 두 개의 32비트 정수로 나눠 담음.
 *   lo = rank 0..5  (비트 4r+s)
 *   hi = rank 6..12 (비트 4(r-6)+s)
 */
'use strict';

const RANK_STR = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUIT_CHR = ['C','H','D','S'];
const SUIT_SYM = ['♣','♥','♦','♠'];

const PASS = 0, SINGLE = 1, PAIR = 2, TRIPLE = 3,
      STRAIGHT = 4, FLUSH = 5, FULLHOUSE = 6, FOURCARD = 7, STRAIGHTFLUSH = 8;
const TYPE_NAME = ['패스','싱글','페어','트리플','스트레이트','플러쉬','풀하우스','포카드','스트레이트플러쉬'];

const HAND_SIZE = 13;

/* ───────── 비트 유틸 ───────── */
const POP4 = new Uint8Array([0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4]);

function popc32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}
const popc = (h) => popc32(h.lo) + popc32(h.hi);

/* rank r 의 4비트 무늬 마스크 */
function rankBits(h, r) {
  return r < 6 ? (h.lo >>> (4 * r)) & 15 : (h.hi >>> (4 * (r - 6))) & 15;
}
function emptyMask() { return { lo: 0, hi: 0 }; }
function cloneMask(h) { return { lo: h.lo, hi: h.hi }; }
function maskFromRanks(bits) {           // bits: 길이 13 배열
  let lo = 0, hi = 0;
  for (let r = 0; r < 13; r++) {
    if (r < 6) lo |= bits[r] << (4 * r);
    else hi |= bits[r] << (4 * (r - 6));
  }
  return { lo: lo | 0, hi: hi | 0 };
}
function maskFromCards(cards) {
  const bits = new Array(13).fill(0);
  for (const c of cards) bits[c >> 2] |= 1 << (c & 3);
  return maskFromRanks(bits);
}
function maskCards(h) {                  // 낮은 카드부터 인덱스 배열
  const out = [];
  for (let r = 0; r < 13; r++) {
    const b = rankBits(h, r);
    for (let s = 0; s < 4; s++) if (b & (1 << s)) out.push(r * 4 + s);
  }
  return out;
}
const maskAnd    = (a, b) => ({ lo: a.lo & b.lo, hi: a.hi & b.hi });
const maskOr     = (a, b) => ({ lo: a.lo | b.lo, hi: a.hi | b.hi });
const maskAndNot = (a, b) => ({ lo: a.lo & ~b.lo, hi: a.hi & ~b.hi });
const maskEmpty  = (a) => a.lo === 0 && a.hi === 0;
const maskEq     = (a, b) => a.lo === b.lo && a.hi === b.hi;
const maskSubset = (a, b) => (a.lo & ~b.lo) === 0 && (a.hi & ~b.hi) === 0;
/* 2(=rank 12)의 장수 */
const countTwos = (h) => POP4[rankBits(h, 12)];
/* 유일한 숫자 키 (lo < 2^24, hi < 2^28) */
const moveKey = (lo, hi) => lo * 268435456 + hi;

function cardStr(c) { return RANK_STR[c >> 2] + SUIT_SYM[c & 3]; }

/* ───────── 난수 (xorshift32) ───────── */
let rngState = 2463534242;
function seedRng(s) { rngState = (s | 0) || 1; }
/* 시각과 난수를 섞은 새 시작값. 페이지를 열 때마다, 새 판마다 다른 패가 나오게 함 */
function randomSeed() { return (Date.now() ^ Math.floor(Math.random() * 4294967296)) | 0; }
seedRng(randomSeed());
function rnd32() {
  let x = rngState;
  x ^= x << 13; x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;  x |= 0;
  rngState = x;
  return x >>> 0;
}
const rnd = (n) => rnd32() % n;

/* ───────── 족보 서열 ───────── */
/* 자연 숫자(A=1 또는 14, 2=2, 3..K=3..13) → rank 인덱스 */
function natToRank(v) {
  if (v === 1 || v === 14) return 11;   // A
  if (v === 2) return 12;               // 2
  return v - 3;                         // 3..K
}
/* 시작값 s(1..10) 의 서열. A-2-3-4-5 가 최고 */
function straightStrengthOfStart(s) {
  if (s === 1) return 9;                // A-2-3-4-5
  if (s === 2) return 8;                // 2-3-4-5-6
  return s - 3;                         // 3-4-5-6-7(0) ~ 10-J-Q-K-A(7)
}
const STRAIGHT_SEQ = [];                // [{start, ranks:[5]}]
for (let s = 1; s <= 10; s++) {
  const ranks = [];
  for (let i = 0; i < 5; i++) ranks.push(natToRank(s + i));
  STRAIGHT_SEQ.push({ start: s, ranks, strength: straightStrengthOfStart(s) });
}
/* 5장 마스크가 스트레이트면 서열(0~9), 아니면 -1 */
function straightStrength(h) {
  let rs = 0, n = 0;
  for (let r = 0; r < 13; r++) if (rankBits(h, r)) { rs |= 1 << r; n++; }
  if (n !== 5) return -1;
  for (const seq of STRAIGHT_SEQ) {
    let want = 0;
    for (const r of seq.ranks) want |= 1 << r;
    if (want === rs) return seq.strength;
  }
  return -1;
}
/* 마스크에서 가장 높은 카드 인덱스 */
function hiCard(h) {
  for (let r = 12; r >= 0; r--) {
    const b = rankBits(h, r);
    if (b) { for (let s = 3; s >= 0; s--) if (b & (1 << s)) return r * 4 + s; }
  }
  return -1;
}

function makeMove(mask, type, key, count) {
  return { lo: mask.lo, hi: mask.hi, type, key, count, id: moveKey(mask.lo, mask.hi) };
}
const PASS_MOVE = { lo: 0, hi: 0, type: PASS, key: 0, count: 0, id: -1 };

/* 같은 장수 + 더 높은 key 면 이김 */
const beats = (a, b) => a.count === b.count && a.key > b.key;

/* rank r 안에서 k장 부분집합들의 무늬 마스크 */
function rankSubsets(bits, k) {
  const out = [];
  for (let x = 1; x < 16; x++) if (POP4[x] === k && (x & bits) === x) out.push(x);
  return out;
}

/* ───────── 가능한 모든 조합 ───────── */
function genAll(hand) {
  const out = [];
  const bits = new Array(13), lst = [];
  for (let r = 0; r < 13; r++) {
    bits[r] = rankBits(hand, r);
    const a = [];
    for (let s = 0; s < 4; s++) if (bits[r] & (1 << s)) a.push(r * 4 + s);
    lst.push(a);
  }
  const single = (c) => { const m = maskFromCards([c]); out.push(makeMove(m, SINGLE, c, 1)); };

  for (let r = 0; r < 13; r++) {
    for (const c of lst[r]) single(c);
    for (const sub of rankSubsets(bits[r], 2)) {
      const m = maskFromRanks(rankOnly(r, sub));
      out.push(makeMove(m, PAIR, hiCard(m), 2));
    }
    for (const sub of rankSubsets(bits[r], 3)) {
      const m = maskFromRanks(rankOnly(r, sub));
      out.push(makeMove(m, TRIPLE, hiCard(m), 3));
    }
  }

  /* 스트레이트 / 스트레이트플러쉬 */
  for (const seq of STRAIGHT_SEQ) {
    const [r0, r1, r2, r3, r4] = seq.ranks;
    if (!lst[r0].length || !lst[r1].length || !lst[r2].length || !lst[r3].length || !lst[r4].length) continue;
    for (const a of lst[r0]) for (const b of lst[r1]) for (const c of lst[r2])
    for (const d of lst[r3]) for (const e of lst[r4]) {
      const cs = [a, b, c, d, e];
      const m = maskFromCards(cs);
      let same = true;
      for (const x of cs) if ((x & 3) !== (a & 3)) same = false;
      const t = same ? STRAIGHTFLUSH : STRAIGHT;
      out.push(makeMove(m, t, t * 64 + seq.strength * 4 + (hiCard(m) & 3), 5));
    }
  }

  /* 플러쉬 */
  for (let su = 0; su < 4; su++) {
    const f = [];
    for (let r = 0; r < 13; r++) if (bits[r] & (1 << su)) f.push(r * 4 + su);
    const k = f.length;
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++)
    for (let d = c + 1; d < k; d++) for (let e = d + 1; e < k; e++) {
      const m = maskFromCards([f[a], f[b], f[c], f[d], f[e]]);
      if (straightStrength(m) >= 0) continue;     // 스트레이트플러쉬는 위에서 생성
      out.push(makeMove(m, FLUSH, FLUSH * 64 + f[e], 5));
    }
  }

  /* 풀하우스 */
  for (let rt = 0; rt < 13; rt++) {
    for (const t3 of rankSubsets(bits[rt], 3)) {
      for (let rp = 0; rp < 13; rp++) {
        if (rp === rt) continue;
        for (const p2 of rankSubsets(bits[rp], 2)) {
          const arr = new Array(13).fill(0);
          arr[rt] = t3; arr[rp] = p2;
          out.push(makeMove(maskFromRanks(arr), FULLHOUSE, FULLHOUSE * 64 + rt, 5));
        }
      }
    }
  }

  /* 포카드 + 아무 카드 1장 */
  for (let r = 0; r < 13; r++) {
    if (POP4[bits[r]] !== 4) continue;
    const quad = new Array(13).fill(0); quad[r] = 15;
    const qm = maskFromRanks(quad);
    const rest = maskAndNot(hand, qm);
    for (const c of maskCards(rest)) {
      const m = maskOr(qm, maskFromCards([c]));
      out.push(makeMove(m, FOURCARD, FOURCARD * 64 + r, 5));
    }
  }
  return out;
}
function rankOnly(r, suitBits) {
  const a = new Array(13).fill(0);
  a[r] = suitBits;
  return a;
}

/* ───────── 게임 상태 ───────── */
function newState(n) {
  return {
    n, turn: 0, winner: -1,
    hand: Array.from({ length: n }, emptyMask),
    played: emptyMask(),
    last: PASS_MOVE, lastPlayer: 0,
    npass: 0, passed: new Array(n).fill(0),
    mustInclude: emptyMask(),
  };
}
function cloneState(s) {
  return {
    n: s.n, turn: s.turn, winner: s.winner,
    hand: s.hand.map(cloneMask),
    played: cloneMask(s.played),
    last: s.last, lastPlayer: s.lastPlayer,
    npass: s.npass, passed: s.passed.slice(),
    mustInclude: cloneMask(s.mustInclude),
  };
}
function dealCards(n) {
  const deck = [];
  for (let i = 0; i < 52; i++) deck.push(i);
  for (let i = 51; i > 0; i--) { const j = rnd(i + 1); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  const hands = [];
  for (let p = 0; p < n; p++) hands.push(maskFromCards(deck.slice(p * HAND_SIZE, (p + 1) * HAND_SIZE)));
  return hands;
}
function initState(n, hands) {
  const s = newState(n);
  s.hand = (hands || dealCards(n)).map(cloneMask);
  /* 선: 가장 낮은 카드 보유자. 그 카드를 첫 수에 반드시 포함 */
  for (let c = 0; c < 52; c++) {
    const m = maskFromCards([c]);
    let owner = -1;
    for (let p = 0; p < n; p++) if (!maskEmpty(maskAnd(s.hand[p], m))) owner = p;
    if (owner >= 0) { s.turn = s.lastPlayer = owner; s.mustInclude = m; break; }
  }
  return s;
}

function nextPlayer(s, p) { return (p + 1) % s.n; }

/* 다음 차례 사람이 1장 남았으면(땁) 최선을 내야 함 */
function ttapActive(s) {
  if (s.winner >= 0) return 0;
  const nx = nextPlayer(s, s.turn);
  return nx !== s.turn && popc(s.hand[nx]) === 1 ? 1 : 0;
}

function legalMoves(s) {
  if (s.winner >= 0) return [];
  const all = genAll(s.hand[s.turn]);
  const ttap = ttapActive(s);

  if (s.last.type === PASS) {
    const topCard = hiCard(s.hand[s.turn]);
    const res = [];
    for (const m of all) {
      if (!maskEmpty(s.mustInclude) && maskEmpty(maskAnd(m, s.mustInclude))) continue;
      if (ttap && m.type === SINGLE && m.key !== topCard) continue;
      res.push(m);
    }
    return res;
  }

  let best = -1;
  const res = [];
  for (const m of all) if (beats(m, s.last)) { res.push(m); if (m.key > best) best = m.key; }
  if (ttap && res.length > 0) return res.filter((m) => m.key === best);
  res.push(PASS_MOVE);
  return res;
}

function doMove(s, m) {
  const p = s.turn;
  if (m.type === PASS) {
    s.npass++; s.passed[p] = 1;
    if (s.npass >= s.n - 1) {
      s.last = PASS_MOVE;
      s.turn = s.lastPlayer;
      s.npass = 0; s.passed.fill(0);
    } else s.turn = nextPlayer(s, p);
    return;
  }
  s.hand[p] = maskAndNot(s.hand[p], m);
  s.played = maskOr(s.played, m);
  s.last = m;
  s.lastPlayer = p;
  s.npass = 0; s.passed.fill(0);
  s.mustInclude = emptyMask();
  if (maskEmpty(s.hand[p])) { s.winner = p; return; }
  s.turn = nextPlayer(s, p);
}

/* ───────── 아무도 못 이기는 수 ─────────
 *
 * 중요: 판정은 '공개된 정보'만 씁니다. 누구의 손패도 들여다보지 않아요.
 *
 * 손패를 보고 판정하면 정보가 새어 나갑니다. 예를 들어 2♦·2♥·2♠ 가 아직
 * 안 나온 상태에서 2♣ 에 자동 패스가 걸리면, 그걸 본 사람들은 "아무도 2를
 * 안 들고 있구나" 를 확실히 알게 됩니다. 원래라면 추측만 할 수 있는 정보예요.
 *
 * 그래서 '바닥에 깔린 카드' 만 보고 판정합니다. 아직 안 나온 카드는 전부
 * 누군가 갖고 있을 수 있다고 봐요 (낸 사람 자신의 손패도 포함). 손패를 못 보는
 * 심판이 똑같이 판정할 수 있고, 참가자 누구나 검산할 수 있습니다.
 *
 * 2♠ 는 늘 걸리고, 2♠ 가 이미 나갔으면 2♦ 가, 2♠·2♦ 가 나갔으면 2♥ 가
 * 그 자리를 넘겨받습니다. 내가 2♠ 를 쥔 채 2♦ 를 내는 경우는 걸리지 않아요 —
 * 걸리면 내가 2♠ 를 갖고 있다는 게 드러나니까요.
 *
 * 남은 장수도 공개 정보라 같이 씁니다. 상대가 모두 3장씩 남았는데 5장짜리를
 * 냈다면, 아무도 5장을 낼 수 없으니 못 이깁니다. */
const FULL_MASK = { lo: 0x00ffffff, hi: 0x0fffffff };

function nobodyCanBeat(s, m) {
  if (!m || m.type === PASS || s.winner >= 0) return false;

  /* 아직 그만큼의 장수를 낼 수 있는 사람이 있는가 (남은 장수는 공개 정보) */
  let enough = false;
  for (let p = 0; p < s.n; p++) {
    if (p !== s.lastPlayer && popc(s.hand[p]) >= m.count) { enough = true; break; }
  }
  if (!enough) return true;

  /* 아직 안 나온 카드로 이 수를 이길 수 있는가 */
  const rest = maskAndNot(FULL_MASK, s.played);
  for (const x of genAll(rest)) {
    if (x.count === m.count && x.key > m.key) return false;
  }
  return true;
}

/* 못 이기는 수면 나머지를 전부 패스시키고, 몇 명이 패스했는지 돌려준다 */
function autoPassRound(s) {
  if (s.winner >= 0 || s.last.type === PASS) return 0;
  if (!nobodyCanBeat(s, s.last)) return 0;
  let n = 0;
  while (s.winner < 0 && s.last.type !== PASS && n < s.n) { doMove(s, PASS_MOVE); n++; }
  return n;
}

/* 벌점: 남은 장수 x 2^(2의 개수) x (10장 이상이면 2) */
function penalty(h) {
  const c = popc(h);
  if (c === 0) return 0;
  let m = c << countTwos(h);
  if (c >= 10) m *= 2;
  return m;
}
function finalPoints(s) {
  let S = 0;
  const pen = [];
  for (let p = 0; p < s.n; p++) { pen.push(penalty(s.hand[p])); S += pen[p]; }
  return pen.map((x) => S - s.n * x);
}
const POINT_SCALE = 50;
function result(s, p) {
  let S = 0;
  for (let i = 0; i < s.n; i++) S += penalty(s.hand[i]);
  return (S - s.n * penalty(s.hand[p])) / POINT_SCALE;
}

/* 결정화: observer 가 모르는 카드를 섞어 다시 나눠줌 */
function determinize(s, obs) {
  const seen = maskOr(s.hand[obs], s.played);
  const pool = [];
  for (let c = 0; c < 52; c++) {
    const r = c >> 2, sbit = 1 << (c & 3);
    if (!(rankBits(seen, r) & sbit)) pool.push(c);
  }
  for (let i = pool.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  let idx = 0;
  for (let p = 0; p < s.n; p++) {
    if (p === obs) continue;
    const need = popc(s.hand[p]);
    s.hand[p] = maskFromCards(pool.slice(idx, idx + need));
    idx += need;
  }
}

/* ───────── 특징 벡터 (thirteen.c 와 동일해야 함) ───────── */
const STATE_FEAT = 175, MOVE_FEAT = 69;

function makeRec(s, me) {
  const counts = [];
  for (let i = 0; i < 4; i++) counts.push(i < s.n ? popc(s.hand[(me + i) % s.n]) : -1);
  return {
    hand: s.hand[me],
    played: s.played,
    lead: s.last.type === PASS ? 1 : 0,
    lastCards: s.last.type === PASS ? emptyMask() : s.last,
    lastType: s.last.type,
    nPlayers: s.n,
    ttap: me === s.turn ? ttapActive(s) : 0,
    firstMove: maskEmpty(s.mustInclude) ? 0 : 1,
    counts,
  };
}

function stateFeatures(r, f) {
  f.fill(0);
  for (let c = 0; c < 52; c++) {
    const rk = c >> 2, sb = 1 << (c & 3);
    if (rankBits(r.hand, rk) & sb) f[c] = 1;
    if (rankBits(r.played, rk) & sb) f[52 + c] = 1;
    if (rankBits(r.lastCards, rk) & sb) f[104 + c] = 1;
  }
  for (let i = 0; i < 4; i++) f[156 + i] = r.counts[i] < 0 ? 0 : r.counts[i] / 13;
  f[160 + (r.nPlayers - 2)] = 1;
  f[163] = r.lead;
  f[164] = r.ttap;
  f[165] = r.firstMove;
  f[166 + r.lastType] = 1;
}

function moveFeatures(r, m, f) {
  f.fill(0);
  const after = maskAndNot(r.hand, m);
  for (let c = 0; c < 52; c++) {
    const rk = c >> 2, sb = 1 << (c & 3);
    if (rankBits(m, rk) & sb) f[c] = 1;
  }
  f[52 + m.type] = 1;
  f[61] = popc(m) / 5;
  const sub = m.key % 64;
  switch (m.type) {
    case SINGLE: case PAIR: case TRIPLE: f[62] = m.key / 51; break;
    case STRAIGHT: case STRAIGHTFLUSH:   f[62] = sub / 39; break;
    case FLUSH:                          f[62] = sub / 51; break;
    case FULLHOUSE: case FOURCARD:       f[62] = sub / 12; break;
  }
  f[63] = popc(after) / 13;
  f[64] = countTwos(m) / 4;
  f[65] = countTwos(after) / 4;
  let broken = 0, lonely = 0;
  for (let rk = 0; rk < 13; rk++) {
    const used = POP4[rankBits(m, rk)], left = POP4[rankBits(after, rk)];
    if (used && left) broken++;
    if (left === 1) lonely++;
  }
  f[66] = broken / 5;
  f[67] = lonely / 13;
  f[68] = maskEmpty(after) ? 1 : 0;
}

/* ───────── 신경망 ───────── */
function parseWeights(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic === 'TNN1') throw new Error('예전(승률 목표) 모델이에요. 점수 목표로 학습한 weights.bin 을 올려 주세요.');
  if (magic !== 'TNN2') throw new Error('weights.bin 형식이 아니에요.');
  const S = dv.getInt32(4, true), F = dv.getInt32(8, true), H = dv.getInt32(12, true);
  if (S !== STATE_FEAT || F !== MOVE_FEAT) throw new Error(`특징 크기가 맞지 않아요 (${S}, ${F}).`);
  let off = 16;
  const layers = [];
  for (let i = 0; i < 7; i++) {
    const out = dv.getInt32(off, true), inn = dv.getInt32(off + 4, true);
    off += 8;
    const W = new Float32Array(buf.slice(off, off + 4 * out * inn)); off += 4 * out * inn;
    const b = new Float32Array(buf.slice(off, off + 4 * out));       off += 4 * out;
    layers.push({ out, in: inn, W, b });
  }
  const [s1, s2, m1, p1, p2, v1, v2] = layers;
  return { S, F, H, s1, s2, m1, p1, p2, v1, v2 };
}

/* y = W·x + b (+relu), x 는 W 의 열 off 부터 len 개에 대응 */
function linearPart(L, x, len, off, y, addBias) {
  const W = L.W, b = L.b, inn = L.in, out = L.out;
  for (let o = 0; o < out; o++) {
    const base = o * inn + off;
    let acc = addBias ? b[o] : 0;
    for (let i = 0; i < len; i++) acc += W[base + i] * x[i];
    y[o] = acc;
  }
}
function relu(a, n) { for (let i = 0; i < n; i++) if (a[i] < 0) a[i] = 0; }

class NetRunner {
  constructor(net) {
    this.net = net;
    const H = net.H;
    this.sf = new Float32Array(STATE_FEAT);
    this.mf = new Float32Array(MOVE_FEAT);
    this.t = new Float32Array(Math.max(H, 256));
    this.h = new Float32Array(H);
    this.ph = new Float32Array(H);
    this.mm = new Float32Array(H);
    this.t2 = new Float32Array(H);
    this.vt = new Float32Array(net.v1.out);
  }
  encode(rec) {
    const n = this.net, H = n.H;
    stateFeatures(rec, this.sf);
    linearPart(n.s1, this.sf, n.S, 0, this.t, true); relu(this.t, H);
    linearPart(n.s2, this.t, H, 0, this.h, true);    relu(this.h, H);
    return this.h;
  }
  valueFromH(h) {
    const n = this.net;
    linearPart(n.v1, h, n.H, 0, this.vt, true); relu(this.vt, n.v1.out);
    const o = new Float32Array(1);
    linearPart(n.v2, this.vt, n.v1.out, 0, o, true);
    return o[0];
  }
  policyFromH(h, rec, moves) {
    const n = this.net, H = n.H, out = new Float32Array(moves.length);
    linearPart(n.p1, h, H, 0, this.ph, true);
    const one = new Float32Array(1);
    let mx = -1e30;
    for (let j = 0; j < moves.length; j++) {
      moveFeatures(rec, moves[j], this.mf);
      linearPart(n.m1, this.mf, n.F, 0, this.mm, true); relu(this.mm, H);
      linearPart(n.p1, this.mm, H, H, this.t2, false);
      for (let o = 0; o < H; o++) { this.t2[o] += this.ph[o]; if (this.t2[o] < 0) this.t2[o] = 0; }
      linearPart(n.p2, this.t2, H, 0, one, true);
      out[j] = one[0];
      if (out[j] > mx) mx = out[j];
    }
    let sum = 0;
    for (let j = 0; j < out.length; j++) { out[j] = Math.exp(out[j] - mx); sum += out[j]; }
    for (let j = 0; j < out.length; j++) out[j] /= sum;
    return out;
  }
  /* 각 자리의 예상 점수. 합이 0이 되도록 평균을 뺌 */
  values(s, vals) {
    let sum = 0;
    for (let p = 0; p < s.n; p++) {
      const h = this.encode(makeRec(s, p));
      vals[p] = this.valueFromH(h);
      sum += vals[p];
    }
    for (let p = 0; p < s.n; p++) vals[p] -= sum / s.n;
  }
}

/* ───────── ISMCTS ───────── */
function randomPlayout(s) {
  while (s.winner < 0) {
    const ms = legalMoves(s);
    if (!ms.length) break;
    doMove(s, ms[rnd(ms.length)]);
  }
}

/* 탐색 옵션 (복기에서 씀)
 *   open     : 상대 패를 다시 섞지 않고 실제 패 그대로 탐색 (모든 패를 아는 상태)
 *   focus    : 이 수(move.id)는 뿌리에서 최소 focusMin 번은 둬 보게 해서 값을 꼭 구한다 */

/* 신경망 없음: UCB + avails */
function ismctsPlain(rootState, iters, c = 0.7, opts = {}) {
  const me = rootState.turn;
  const rootMoves = legalMoves(rootState);
  if (rootMoves.length === 1) return { move: rootMoves[0], stats: [{ move: rootMoves[0], visits: iters }] };

  const root = { children: new Map(), visits: 0 };
  for (let it = 0; it < iters; it++) {
    const st = cloneState(rootState);
    if (!opts.open) determinize(st, me);
    let node = root;
    const path = [];

    for (;;) {
      const ms = legalMoves(st);
      if (!ms.length) break;
      const untried = ms.filter((m) => !node.children.has(m.id));
      if (untried.length) {
        const m = untried[rnd(untried.length)];
        const pl = st.turn;
        doMove(st, m);
        const child = { children: new Map(), visits: 0, wins: 0, avails: 1, pjm: pl, move: m };
        node.children.set(m.id, child);
        path.push(child);
        node = child;
        break;
      }
      let best = null, bestv = -1e18;
      for (const m of ms) {
        const ch = node.children.get(m.id);
        ch.avails++;
        const v = ch.wins / ch.visits + c * Math.sqrt(Math.log(ch.avails) / ch.visits);
        if (v > bestv) { bestv = v; best = ch; }
      }
      if (node === root && opts.focus !== undefined) {
        const fc = node.children.get(opts.focus);
        if (fc && fc.visits < (opts.focusMin || 0)) best = fc;
      }
      doMove(st, best.move);
      path.push(best);
      node = best;
    }

    randomPlayout(st);
    root.visits++;
    for (const nd of path) { nd.visits++; nd.wins += result(st, nd.pjm); }
  }
  return finish(root, rootMoves);
}

/* 신경망: PUCT + 가치망/롤아웃 혼합 */
function ismctsNN(rootState, iters, runner, blend = 1.0, cpuct = 1.5, opts = {}) {
  const me = rootState.turn;
  const rootMoves = legalMoves(rootState);
  if (rootMoves.length === 1) return { move: rootMoves[0], stats: [{ move: rootMoves[0], visits: iters }] };

  const root = { children: new Map(), visits: 0, priors: null, fpu: 0 };
  {
    const vals = new Float32Array(rootState.n);
    runner.values(rootState, vals);
    root.fpu = vals[me];
  }
  const vals = new Float32Array(rootState.n);

  for (let it = 0; it < iters; it++) {
    const st = cloneState(rootState);
    if (!opts.open) determinize(st, me);
    let node = root;
    const path = [];
    let done = false;

    for (;;) {
      const ms = legalMoves(st);
      if (!ms.length) {
        for (let p = 0; p < st.n; p++) vals[p] = result(st, p);
        done = true;
        break;
      }
      if (!node.priors) {
        const rec = makeRec(st, st.turn);
        const h = runner.encode(rec);
        const pr = runner.policyFromH(h, rec, ms);
        node.priors = new Map();
        for (let i = 0; i < ms.length; i++) node.priors.set(ms[i].id, pr[i]);
      }
      const sq = Math.sqrt(node.visits + 1);
      let bestIdx = 0, bestv = -1e18;
      for (let i = 0; i < ms.length; i++) {
        const ch = node.children.get(ms[i].id);
        const q = ch && ch.visits ? ch.wins / ch.visits : node.fpu;
        const nvis = ch ? ch.visits : 0;
        const prior = node.priors.get(ms[i].id) ?? 1 / ms.length;
        const v = q + cpuct * prior * sq / (1 + nvis);
        if (v > bestv) { bestv = v; bestIdx = i; }
      }
      if (node === root && opts.focus !== undefined) {
        const fc = node.children.get(opts.focus);
        const fi = ms.findIndex((x) => x.id === opts.focus);
        if (fi >= 0 && (!fc || fc.visits < (opts.focusMin || 0))) bestIdx = fi;
      }
      const m = ms[bestIdx];
      const existing = node.children.get(m.id);
      const pl = st.turn;
      doMove(st, m);
      if (existing) { path.push(existing); node = existing; continue; }

      const child = { children: new Map(), visits: 0, wins: 0, pjm: pl, move: m, priors: null, fpu: 0 };
      node.children.set(m.id, child);
      path.push(child);

      if (st.winner >= 0) {
        for (let p = 0; p < st.n; p++) vals[p] = result(st, p);
      } else {
        if (blend > 0) runner.values(st, vals);
        else vals.fill(0);
        if (blend < 1) {
          const rs = cloneState(st);
          randomPlayout(rs);
          for (let p = 0; p < st.n; p++) vals[p] = blend * vals[p] + (1 - blend) * result(rs, p);
        }
        child.fpu = vals[st.turn];
      }
      done = true;
      break;
    }
    if (!done) for (let p = 0; p < st.n; p++) vals[p] = result(st, p);

    root.visits++;
    for (const nd of path) { nd.visits++; nd.wins += vals[nd.pjm]; }
  }
  return finish(root, rootMoves);
}

function finish(root, rootMoves) {
  const stats = rootMoves.map((m) => {
    const ch = root.children.get(m.id);
    return { move: m, visits: ch ? ch.visits : 0, q: ch && ch.visits ? ch.wins / ch.visits : null };
  });
  stats.sort((a, b) => b.visits - a.visits);
  return { move: stats[0].move, stats };
}

/* ───────── 복기: 한 국면 분석 ─────────
 * 이 국면에서 둘 수 있는 모든 수를 탐색해서, 수마다 기대 점수(점)와 AI 가 검토한 비율을 돌려준다.
 *   open  : true 면 모든 패를 아는 상태로 탐색 (훌륭한 수 판정용)
 *   focus : 실제로 둔 수. 탐색이 외면해도 값은 구할 수 있게 일정 횟수는 꼭 둬 본다 */
function analyzePosition(d, runner) {
  const opts = { open: !!d.open, focus: d.focus, focusMin: Math.max(20, Math.round(d.iters * 0.05)) };
  const r = runner
    ? ismctsNN(d.state, d.iters, runner, d.blend === undefined ? 1 : d.blend, 1.5, opts)
    : ismctsPlain(d.state, d.iters, 0.7, opts);
  const total = r.stats.reduce((a, x) => a + x.visits, 0) || 1;
  return {
    best: r.move.id,
    stats: r.stats.map((x) => ({
      move: x.move, visits: x.visits, share: x.visits / total,
      value: x.q === null || x.q === undefined ? null : x.q * POINT_SCALE,
    })),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    RANK_STR, SUIT_CHR, SUIT_SYM, TYPE_NAME, PASS, SINGLE, PAIR, TRIPLE,
    STRAIGHT, FLUSH, FULLHOUSE, FOURCARD, STRAIGHTFLUSH,
    popc, rankBits, maskFromCards, maskCards, maskAnd, maskOr, maskAndNot,
    maskEmpty, maskEq, maskSubset, emptyMask, cloneMask, countTwos, hiCard, cardStr,
    seedRng, randomSeed, rnd, genAll, legalMoves, doMove, initState, cloneState, dealCards,
    penalty, finalPoints, result, determinize, ttapActive, straightStrength,
    nobodyCanBeat, autoPassRound, PASS_MOVE,
    stateFeatures, moveFeatures, makeRec, parseWeights, NetRunner,
    ismctsPlain, ismctsNN, analyzePosition, STATE_FEAT, MOVE_FEAT, POINT_SCALE,
  };
}
