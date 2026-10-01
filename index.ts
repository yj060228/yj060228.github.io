// @ts-nocheck
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

/* 신경망 없음: UCB + avails */
function ismctsPlain(rootState, iters, c = 0.7) {
  const me = rootState.turn;
  const rootMoves = legalMoves(rootState);
  if (rootMoves.length === 1) return { move: rootMoves[0], stats: [{ move: rootMoves[0], visits: iters }] };

  const root = { children: new Map(), visits: 0 };
  for (let it = 0; it < iters; it++) {
    const st = cloneState(rootState);
    determinize(st, me);
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
function ismctsNN(rootState, iters, runner, blend = 1.0, cpuct = 1.5) {
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
    determinize(st, me);
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



/* ═══════════════════════════════════════════════════════════════════
 * 써틴 멀티플레이 심판
 *
 * 모든 카드는 이 함수 안에서만 다뤄집니다.
 * 참가자에게는 공개 정보와 '자기 패'만 내려갑니다.
 * ═══════════════════════════════════════════════════════════════════ */

const DB  = Deno.env.get('SUPABASE_URL') + '/rest/v1';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const HEAD = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const TURN_SECONDS = 90;          /* 이 시간 안에 두지 않으면 자동 패스 */
const ROOM_HOURS = 12;            /* 이 시간이 지난 방은 정리 */
const CHAT_MAX = 200;             /* 한 번에 보낼 수 있는 글자 수 */
const CHAT_KEEP = 50;             /* 방에 남겨 두는 최근 대화 수 */
const CHAT_GAP = 700;             /* 같은 사람이 다시 보낼 때까지 (ms) */

async function q(path, init) {
  const res = await fetch(DB + path, { ...init, headers: { ...HEAD, ...(init && init.headers) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const sel    = (p) => q(p);
const ins    = (t, body) => q('/' + t, { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } });
const upd    = (p, body) => q(p, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } });
const del    = (p) => q(p, { method: 'DELETE' });
const upsert = (t, body) => q('/' + t, { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});
const fail = (msg, status = 400) => json({ error: msg }, status);

/* 헷갈리기 쉬운 글자(0,O,1,I)를 뺀 방 코드 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let s = '';
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}
const nowMs = () => Date.now();
const cardsOf = (mask) => maskCards(mask);
const isSeated = (p) => p.seat !== null && p.seat !== undefined;
const hasStack = (p) => p.stack !== null && p.stack !== undefined;

/* ───────── 누가 보냈는지 서버가 직접 확인 ─────────
 * 브라우저가 보낸 userId 는 믿지 않습니다. 누구든 남의 id 를 적어 보낼 수 있으니까요.
 * 로그인 토큰을 Supabase 에 물어봐서 진짜 사용자 id 를 받아옵니다.
 * 토큰이 없거나 가짜면 null 이고, 그 사람은 게스트로 취급합니다. */
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
async function authUser(req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok || tok === ANON || tok === KEY) return null;   /* 공개 키는 사람이 아니다 */
  try {
    const res = await fetch(Deno.env.get('SUPABASE_URL') + '/auth/v1/user', {
      headers: { apikey: ANON || KEY, Authorization: 'Bearer ' + tok },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && typeof u.id === 'string' ? u.id : null;
  } catch (_) { return null; }
}

/* 판돈: 1점당 100 ~ 10000 코인, 100 단위 */
const STAKE_MIN = 100, STAKE_MAX = 10000, STAKE_STEP = 100;
/* 바이인: 방장이 정합니다. 안 정하면 1점당 금액의 100배 */
const BUYIN_POINTS = 100;          /* 기본값 */
const BUYIN_MIN_POINTS = 10;       /* 최소한 10점은 지을 수 있어야 함 */
const BUYIN_MAX_POINTS = 500;
const BUYIN_CAP = 5000000;
const BUYIN_STEP = 100;

/* 방의 바이인 (옛 방은 buyin 이 0 이라 예전 방식으로) */
const buyinOf = (room) => {
  const stake = room.stake || 0;
  if (!stake) return 0;
  return room.buyin > 0 ? Number(room.buyin) : stake * BUYIN_POINTS;
};

function normStake(v) {
  const n = Math.floor(Number(v) || 0);
  if (!n) return 0;
  if (n < STAKE_MIN || n > STAKE_MAX || n % STAKE_STEP !== 0) return -1;
  return n;
}

/* 바이인 검사. 0 이면 기본값(100배)을 쓰겠다는 뜻 */
function normBuyin(stake, v) {
  const n = Math.floor(Number(v) || 0);
  if (!n) return stake * BUYIN_POINTS;
  if (n % BUYIN_STEP !== 0) return -1;
  if (n > BUYIN_CAP) return -1;
  if (n < stake * BUYIN_MIN_POINTS || n > stake * BUYIN_MAX_POINTS) return -1;
  return n;
}
/* 판마다 다른 열쇠. 방 코드가 나중에 다시 쓰여도 겹치지 않게 임의의 글자를 붙인다 */
const gameRef = (code, round) => `room:${code}:${round}:${crypto.randomUUID().slice(0, 8)}`;

/* 코인 함수는 심판만 부를 수 있습니다 (SQL 에서 권한을 그렇게 걸어 뒀습니다) */
const rpc = (fn, args) => q('/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) });

/* ───────── 공개 상태 만들기 ─────────
 * 캐시 방이면 사람마다 '남은 바이인'(stack)을 같이 실어서 모두가 볼 수 있게 합니다.
 * 판에 앉지 못한 사람(다 잃었거나 나중에 들어온 사람)도 관전자로 목록에 남깁니다. */
function buildPublic(room, players, st) {
  const g = st && st.game;
  const seated = players.filter(isSeated).sort((a, b) => a.seat - b.seat);
  const watchers = room.stake ? players.filter((p) => !isSeated(p) && hasStack(p)) : [];
  const listed = room.status === 'waiting' ? players : seated.concat(watchers);
  return {
    code: room.code,
    status: room.status,
    nPlayers: room.n_players,
    hostPlayer: room.host_player,
    stake: room.stake || 0,
    buyin: buyinOf(room),
    round: (st && st.round) || 0,
    cash: (st && st.cash) || null,
    players: listed.map((p) => ({
      id: p.id, name: p.name, seat: p.seat, present: p.present,
      guest: !p.user_id,
      cards: g && isSeated(p) ? popc(g.hand[p.seat]) : 0,
      passed: g && isSeated(p) ? !!g.passed[p.seat] : false,
      stack: room.stake && hasStack(p) ? p.stack : null,
      spectator: room.status !== 'waiting' && !isSeated(p),
    })),
    totals: (st && st.totals) || {},
    log: (st && st.log) || [],
    turn: g ? g.turn : null,
    winner: g ? g.winner : -1,
    lead: g ? g.last.type === PASS : true,
    lastCards: g && g.last.type !== PASS ? cardsOf(g.last) : [],
    lastType: g ? g.last.type : 0,
    lastPlayer: g ? g.lastPlayer : null,
    mustInclude: g ? cardsOf(g.mustInclude) : [],
    played: g ? cardsOf(g.played) : [],
    cleared: (st && st.cleared) || null,
    chat: (st && st.chat) || [],
    deadline: (st && st.deadline) || 0,
    stopped: !!(st && st.stopped),
    leadMode: normLead(st && st.leadMode),
  };
}

async function saveRoom(room, players, st, statusOverride) {
  const status = statusOverride || room.status;
  const pub = buildPublic({ ...room, status }, players, st);
  await upd(`/rooms?code=eq.${room.code}`, {
    status, public_state: pub, version: room.version + 1, updated_at: new Date().toISOString(),
  });
  if (st) await upsert('room_games?on_conflict=room_code', {
    room_code: room.code, secret_state: st, updated_at: new Date().toISOString(),
  });
  return pub;
}

/* 캐시 방이면 사람마다 묶여 있는 코인(stack)을 붙여 둔다. 묶인 게 없으면 null */
async function loadStacks(room, players) {
  if (!room.stake) return;
  const rows = await sel(`/cash_seats?room_code=eq.${encodeURIComponent(room.code)}&select=user_id,stack`);
  const by = new Map(rows.map((r) => [r.user_id, Number(r.stack)]));
  for (const p of players) p.stack = p.user_id && by.has(p.user_id) ? by.get(p.user_id) : null;
}

async function loadRoom(code) {
  const rooms = await sel(`/rooms?code=eq.${encodeURIComponent(code)}&select=*`);
  if (!rooms.length) return null;
  const players = await sel(`/room_players?room_code=eq.${encodeURIComponent(code)}&select=*&order=created_at`);
  const games = await sel(`/room_games?room_code=eq.${encodeURIComponent(code)}&select=*`);
  await loadStacks(rooms[0], players);
  return { room: rooms[0], players, st: games.length ? games[0].secret_state : null };
}

const seatName = (players, seat) => {
  const p = players.find((x) => x.seat === seat);
  return p ? p.name : `${seat}번 자리`;
};
function addLog(st, line) {
  st.log = (st.log || []).concat([line]).slice(-40);
}

/* ───────── 한 수 적용 ───────── */
function applyMove(st, players, move) {
  const g = st.game;
  const seat = g.turn;
  const who = seatName(players, seat);
  if (move.type === PASS) addLog(st, `${who} 패스`);
  else addLog(st, `${who} · ${TYPE_NAME[move.type]} ${cardsOf(move).map(cardStr).join(' ')}`);

  const wasLead = g.last.type === PASS;
  st.moves = st.moves || [];
  st.moves.push({ s: seat, c: move.type === PASS ? [] : cardsOf(move) });
  doMove(g, move);

  if (move.type !== PASS) {
    const left = popc(g.hand[seat]);
    if (left === 2) addLog(st, `${who} 투카드!`);
    if (left === 1) addLog(st, `${who} 땁!`);
  } else if (g.last.type === PASS && !wasLead) {
    addLog(st, `— 모두 패스, ${seatName(players, g.turn)} 선 —`);
  }
  st.deadline = nowMs() + TURN_SECONDS * 1000;

  /* 남은 사람이 아무도 못 이기는 수면, 패스를 기다리지 않고 바로 넘긴다.
   * 어차피 모두 패스밖에 할 수 없어서 게임 내용은 달라지지 않습니다. */
  if (move.type !== PASS) {
    st.cleared = null;
    if (nobodyCanBeat(g, g.last)) {
      const cards = cardsOf(g.last);
      const info = { cards, type: g.last.type, seat, name: who };
      addLog(st, '— 아무도 못 이기는 수 —');
      while (g.winner < 0 && g.last.type !== PASS) {
        addLog(st, `${seatName(players, g.turn)} 패스`);
        st.moves.push({ s: g.turn, c: [] });
        doMove(g, PASS_MOVE);
      }
      if (g.winner < 0) {
        st.cleared = info;
        addLog(st, `— ${seatName(players, g.turn)} 선 —`);
      }
      st.deadline = nowMs() + TURN_SECONDS * 1000;
    }
  }
}

/* 자리를 비운 사람이나 시간이 지난 사람의 차례를 대신 처리 */
function autoAdvance(st, players) {
  const g = st.game;
  let guard = 0;
  while (g.winner < 0 && guard++ < 200) {
    const p = players.find((x) => x.seat === g.turn);
    const gone = p && !p.present;
    const late = st.deadline && nowMs() > st.deadline;
    if (!gone && !late) break;

    const ms = legalMoves(g);
    if (!ms.length) break;
    const pass = ms.find((m) => m.type === PASS);
    if (pass) applyMove(st, players, pass);
    else {
      /* 선이라 패스할 수 없으면 가장 약한 수를 냄 */
      let best = ms[0];
      for (const m of ms) if (m.count < best.count || (m.count === best.count && m.key < best.key)) best = m;
      applyMove(st, players, best);
    }
  }
}

/* ───────── 대국 기록 저장 ─────────
 * 카드와 수순을 남깁니다. 마이페이지에서 본인이 참여한 판만 볼 수 있어요. */
async function saveLog(info) {
  try {
    const rows = await ins('game_logs', {
      source: info.source, room_code: info.roomCode || null,
      n_players: info.nPlayers, winner_seat: info.winnerSeat,
      seats: info.seats, deal: info.deal, moves: info.moves, points: info.points,
    });
    const gameId = rows && rows[0] && rows[0].id;
    if (!gameId) return null;
    const mine = info.seats
      .filter((x) => x.user_id)
      .map((x) => ({
        game_id: gameId, user_id: x.user_id, seat: x.seat,
        points: info.points[x.seat], won: info.winnerSeat === x.seat,
        source: info.source, n_players: info.nPlayers,
      }));
    if (mine.length) await ins('game_players', mine);
    return gameId;
  } catch (_) { return null; }   /* 기록 실패가 게임을 막지는 않게 */
}

/* ───────── 캐시 게임 (세션 바이인) ─────────
 * 코인은 여기서만 움직입니다. 금액은 서버가 들고 있는 카드와 승점으로만 정해지고,
 * 브라우저가 보낸 숫자는 하나도 쓰지 않습니다.
 *
 *  · 방에 들어오면 바이인을 한 번 묶는다            (seat_buyin)
 *  · 판이 끝날 때마다 묶인 코인 안에서 주고받는다    (seat_settle)
 *    바이인보다 적게 남아도 계속 할 수 있고, 한 판에 잃는 금액은 남은 만큼까지다.
 *  · 다 잃으면 자리에서 빠지고 관전만 한다
 *  · 방을 나가면 남은 만큼 돌려받는다               (seat_cashout)
 *    판 도중에 나가면 그 판이 끝난 뒤에 돌려받는다. */

const coinMsg = (e) => {
  const m = String((e && e.message) || e);
  return m.includes('코인이 모자라') ? null : m.slice(0, 120);
};

/* 바이인 묶기. 이미 이 방에 묶어 둔 게 있으면 그대로 둔다. 남은 금액을 돌려준다 */
async function seatBuyin(room, userId) {
  return Number(await rpc('seat_buyin', { p_room: room.code, p_user: userId, p_buyin: buyinOf(room) }));
}

/* 남은 금액 돌려주기. 돌려준 금액을 돌려준다 */
async function seatCashout(room, userId) {
  return Number(await rpc('seat_cashout', { p_room: room.code, p_user: userId }));
}

/* 방에 있지만 아직 바이인을 묶지 않은 사람은 판을 시작할 때 묶는다.
 * (이 기능을 넣기 전에 만든 방이나, 나갔다가 다시 온 사람) 코인이 모자라면 관전으로 남는다. */
async function ensureBuyins(room, st, players) {
  if (!room.stake) return;
  for (const p of players) {
    if (!p.present || !p.user_id || hasStack(p)) continue;
    try { p.stack = await seatBuyin(room, p.user_id); }
    catch (_) { addLog(st, `— ${p.name} 코인이 모자라 관전합니다 —`); }
  }
}

/* 남은 바이인이 있는 사람만 판에 앉는다 */
const canPlay = (room, p) => p.present && (!room.stake || (p.user_id && p.stack > 0));

/* 판이 끝나면 벌점 1점당 판돈만큼, 묶인 코인 안에서 주고받는다 */
async function settleRound(room, st, pts) {
  const r = st.cashRound;
  if (!r) return null;
  try {
    const rows = await rpc('seat_settle', {
      p_ref: r.ref, p_room: room.code,
      p_users: r.seats.map((x) => x.user_id),
      p_points: r.seats.map((x) => pts[x.seat]),
      p_stake: r.stake,
    });
    const by = new Map((rows || []).map((x) => [x.user_id, x]));
    return {
      stake: r.stake,
      rows: r.seats.map((x) => {
        const z = by.get(x.user_id) || {};
        return {
          seat: x.seat, name: x.name, points: pts[x.seat],
          delta: Number(z.delta || 0), stack: Number(z.stack || 0),
        };
      }),
    };
  } catch (e) {
    return { failed: true, stake: r.stake, msg: String((e && e.message) || e).slice(0, 120) };
  }
}

/* 이 기능을 넣기 전에 시작한 판(판마다 묶던 방식)이 남아 있으면 예전 방식으로 정산한다 */
async function legacySettle(st, players, pts) {
  const c = st.cashLock;
  if (!c) return null;
  const seated = players.filter(isSeated).sort((a, b) => a.seat - b.seat);
  const ids = seated.map((p) => p.user_id);
  const same = ids.length === c.seats.length && ids.every((x, i) => x === c.seats[i]);
  try {
    if (!same) { await rpc('cash_refund', { p_ref: c.ref }); return; }
    await rpc('cash_settle', { p_ref: c.ref, p_users: ids, p_points: seated.map((p) => pts[p.seat]) });
  } catch (_) {
    try { await rpc('cash_refund', { p_ref: c.ref }); } catch (__) {}
  }
}

/* ───────── 판 종료 ───────── */
async function finishGame(room, st, players) {
  const g = st.game;
  const pts = finalPoints(g);
  st.totals = st.totals || {};
  const names = [];
  for (const p of players) {
    if (!isSeated(p)) continue;
    const v = pts[p.seat];
    st.totals[p.id] = (st.totals[p.id] || 0) + v;
    names.push(`${p.name} ${v > 0 ? '+' : ''}${v}`);
  }
  addLog(st, `${seatName(players, g.winner)} 승리 — ${names.join(' / ')}`);
  const winner = players.find((p) => p.seat === g.winner);
  st.lastWinnerId = winner ? winner.id : null;   /* '전 판 승자가 선' 규칙에 쓴다 */

  /* 캐시 게임이면 코인 정산 */
  await legacySettle(st, players, pts);
  st.cashLock = null;
  const cash = await settleRound(room, st, pts);
  st.cashRound = null;
  st.cash = null;
  if (cash) {
    if (cash.failed) {
      addLog(st, '— 정산하지 못해서 이번 판은 코인이 오가지 않았어요 —');
    } else {
      st.cash = cash;
      addLog(st, '— 정산 · ' + cash.rows
        .map((r) => `${r.name} ${r.delta > 0 ? '+' : ''}${r.delta.toLocaleString()}`)
        .join(' / ') + ' 코인 —');
      for (const r of cash.rows) {
        if (r.stack === 0) addLog(st, `— ${r.name} 올인! 이제 관전합니다 —`);
      }
    }
  }

  /* 판 도중에 나간 사람은 이제 남은 코인을 돌려받는다 */
  if (room.stake) {
    for (const p of players) {
      if (p.present || !p.user_id || !hasStack(p)) continue;
      try {
        const back = await seatCashout(room, p.user_id);
        addLog(st, `— ${p.name} 나감 · ${back.toLocaleString()}코인 돌려받음 —`);
      } catch (_) { /* 못 돌려준 건 cleanup_seats 가 나중에 돌려준다 */ }
    }
    await loadStacks(room, players);
  }

  await saveLog({
    source: 'mp', roomCode: room.code,
    nPlayers: g.n, winnerSeat: g.winner,
    seats: players
      .filter(isSeated)
      .map((p) => ({ seat: p.seat, name: p.name, user_id: p.no_log ? null : (p.user_id || null), guest: !p.user_id, ai: false })),
    deal: st.deal || [], moves: st.moves || [], points: pts,
  });

  /* 로그인한 사람은 멀티플레이 전적에 반영 */
  for (const p of players) {
    if (!p.user_id || !isSeated(p)) continue;
    try {
      const rows = await sel(`/profiles?id=eq.${p.user_id}&select=mp_total,mp_games,mp_wins`);
      if (!rows.length) continue;
      const r = rows[0];
      await upd(`/profiles?id=eq.${p.user_id}`, {
        mp_total: (r.mp_total || 0) + pts[p.seat],
        mp_games: (r.mp_games || 0) + 1,
        mp_wins: (r.mp_wins || 0) + (g.winner === p.seat ? 1 : 0),
      });
    } catch (_) { /* 전적 반영 실패가 게임을 막지는 않게 */ }
  }
}

/* ───────── 새 판 시작 ───────── */
/* 선 정하기
 *   lowest : 매 판 가장 낮은 카드(보통 3♣)를 가진 사람이 그 카드를 넣어서 첫 수를 낸다
 *   winner : 첫 판만 그렇게 하고, 다음 판부터는 전 판 승자가 아무 패나 내며 시작한다 */
const normLead = (v) => (v === 'winner' ? 'winner' : 'lowest');

function startRound(st, players, nPlayers) {
  seedRng(randomSeed());
  const g = initState(nPlayers);
  let why = '';
  if (normLead(st.leadMode) === 'winner' && (st.round || 0) > 0) {
    const w = st.lastWinnerId && players.find((p) => p.id === st.lastWinnerId && isSeated(p));
    if (w && w.seat < nPlayers) {
      g.turn = g.lastPlayer = w.seat;
      g.mustInclude = emptyMask();          /* 승자는 아무 패나 낼 수 있다 */
      why = ' (전 판 승자)';
    } else {
      why = ' (전 판 승자가 없어 가장 낮은 카드)';
    }
  }
  st.game = g;
  st.deal = g.hand.slice(0, nPlayers).map(cardsOf);
  st.moves = [];
  st.cleared = null;
  st.round = (st.round || 0) + 1;
  st.deadline = nowMs() + TURN_SECONDS * 1000;
  addLog(st, `— ${st.round}번째 판 시작 · ${seatName(players, g.turn)} 선${why} —`);
}

/* 캐시 게임이면 이번 판에 누가 앉았는지 적어 두고 카드를 돌린다 */
function beginRound(room, st, players, n) {
  st.cashLock = null;
  st.cash = null;
  startRound(st, players, n);
  st.cashRound = null;
  if (room.stake) {
    const seated = players.filter(isSeated).sort((a, b) => a.seat - b.seat);
    st.cashRound = {
      ref: gameRef(room.code, st.round), stake: room.stake,
      seats: seated.map((p) => ({ seat: p.seat, user_id: p.user_id, name: p.name })),
    };
    addLog(st, `— 캐시 게임 · 1점당 ${room.stake.toLocaleString()}코인 · 남은 바이인 `
      + seated.map((p) => `${p.name} ${Number(p.stack).toLocaleString()}`).join(' / ') + ' —');
  }
}

/* 자리를 다시 정한다. order 에 있는 사람이 0번부터 앉고, 나머지는 자리에서 빠진다 */
async function assignSeats(room, players, order) {
  for (const p of players) {
    const i = order.indexOf(p);
    const seat = i >= 0 ? i : null;
    if (p.seat !== seat) await upd(`/room_players?id=eq.${p.id}`, { seat });
    p.seat = seat;
  }
  if (room.n_players !== order.length) {
    await upd(`/rooms?code=eq.${room.code}`, { n_players: order.length });
    room.n_players = order.length;
  }
}

/* 보내온 수순이 규칙에 맞는지 처음부터 다시 둬 보며 확인 */
function replay(deal, moves) {
  if (!Array.isArray(deal) || deal.length < 2 || deal.length > 4) return null;
  const seen = new Set();
  for (const hand of deal) {
    if (!Array.isArray(hand) || hand.length !== HAND_SIZE) return null;
    for (const c of hand) {
      if (!Number.isInteger(c) || c < 0 || c > 51 || seen.has(c)) return null;
      seen.add(c);
    }
  }
  if (!Array.isArray(moves) || moves.length > 400) return null;

  const g = initState(deal.length, deal.map((h) => maskFromCards(h)));
  for (const mv of moves) {
    if (g.winner >= 0) return null;
    if (!mv || g.turn !== mv.s) return null;
    const ms = legalMoves(g);
    let m = null;
    if (!mv.c || !mv.c.length) m = ms.find((x) => x.type === PASS) || null;
    else {
      const want = maskFromCards(mv.c.map(Number));
      m = ms.find((x) => x.type !== PASS && maskEq(x, want)) || null;
    }
    if (!m) return null;
    doMove(g, m);
  }
  return g.winner >= 0 ? g : null;
}

/* 이 사람이 캐시 방에 들어갈 만큼 코인을 갖고 있는지 */
async function hasCoins(userId, buyin) {
  const rows = await sel(`/wallets?user_id=eq.${userId}&select=balance`);
  return rows.length ? Number(rows[0].balance) >= buyin : false;
}

/* ───────── 관리자 ─────────
 * admins 표에 있는 계정만 씁니다. 누가 보냈는지는 로그인 토큰으로 서버가 직접 확인해요. */
async function isAdmin(uid) {
  if (!uid) return false;
  const rows = await sel(`/admins?user_id=eq.${uid}&select=user_id`);
  return rows.length > 0;
}
const inList = (codes) => codes.map((c) => encodeURIComponent(c)).join(',');

/* 최근 방과, 코인이 묶여 있는 방을 모두 보여 준다 */
async function adminRooms() {
  const since = new Date(nowMs() - ROOM_HOURS * 3600 * 1000).toISOString();
  const recent = await sel(`/rooms?updated_at=gte.${encodeURIComponent(since)}`
    + '&select=code,status,stake,buyin,n_players,host_player,public_state,updated_at&order=updated_at.desc&limit=100');
  const seats = await sel('/cash_seats?select=room_code,user_id,stack,buyin');
  const codes = new Set(recent.map((r) => r.code));
  const extra = [...new Set(seats.map((x) => x.room_code))].filter((c) => !codes.has(c));
  const old = extra.length
    ? await sel(`/rooms?code=in.(${inList(extra)})&select=code,status,stake,buyin,n_players,host_player,public_state,updated_at`)
    : [];
  const rooms = recent.concat(old);
  const all = rooms.map((r) => r.code).concat(extra.filter((c) => !old.some((r) => r.code === c)));
  if (!all.length) return [];

  const players = await sel(`/room_players?room_code=in.(${inList(all)})`
    + '&select=room_code,name,seat,present,user_id&order=created_at');
  return all.map((code) => {
    const r = rooms.find((x) => x.code === code) || null;
    const pub = (r && r.public_state) || {};
    const mine = seats.filter((x) => x.room_code === code);
    return {
      code,
      exists: !!r,
      status: r ? r.status : 'gone',
      stopped: !!pub.stopped,
      stake: r ? r.stake || 0 : 0,
      buyin: r ? buyinOf(r) : 0,
      round: pub.round || 0,
      live: !!(r && r.status === 'playing' && pub.winner !== undefined && pub.winner < 0),
      updatedAt: r ? r.updated_at : null,
      locked: mine.reduce((sum, x) => sum + Number(x.stack), 0),
      players: players.filter((p) => p.room_code === code).map((p) => {
        const z = mine.find((x) => x.user_id === p.user_id);
        return {
          name: p.name, seat: p.seat, present: p.present, guest: !p.user_id,
          host: r ? r.host_player === p.id : false,
          stack: z ? Number(z.stack) : null,
        };
      }),
    };
  });
}

/* 방 닫기: 하던 판은 무효로 하고, 묶여 있던 코인을 각자에게 돌려준다 */
async function adminStop(code) {
  const found = await loadRoom(code);
  const returned = [];
  const nameOf = (players, userId) => {
    const p = (players || []).find((x) => x.user_id === userId);
    return p ? p.name : '알 수 없음';
  };

  let st = found && found.st ? found.st : { totals: {}, log: [], round: 0 };
  /* 이 기능을 넣기 전 방식(판마다 묶기)으로 묶인 판이 있으면 그것도 돌려준다 */
  if (st.cashLock) {
    try { await rpc('cash_refund', { p_ref: st.cashLock.ref }); } catch (_) {}
  }
  const seats = await sel(`/cash_seats?room_code=eq.${encodeURIComponent(code)}&select=user_id`);
  for (const x of seats) {
    const back = await seatCashout({ code }, x.user_id);
    returned.push({ name: nameOf(found && found.players, x.user_id), amount: back });
  }
  if (!found) return { code, returned, closed: false };

  const { room, players } = found;
  const wasLive = !!(st.game && st.game.winner < 0);
  st.cashLock = null;
  st.cashRound = null;
  st.cash = null;
  st.game = null;
  st.cleared = null;
  st.deadline = 0;
  st.stopped = true;
  addLog(st, `— 관리자가 방을 닫았어요${wasLive ? ' · 하던 판은 무효예요' : ''} —`);
  if (returned.length) {
    addLog(st, '— 돌려준 코인 · ' + returned.map((x) => `${x.name} ${x.amount.toLocaleString()}`).join(' / ') + ' —');
  }
  await loadStacks(room, players);
  await saveRoom(room, players, st, 'ended');
  return { code, returned, closed: true, wasLive };
}

/* ───────── 요청 처리 ───────── */
async function handle(body, uid) {
  const action = body.action;

  if (action === 'admin_rooms' || action === 'admin_stop') {
    if (!(await isAdmin(uid))) return fail('권한이 없어요.', 403);
    if (action === 'admin_rooms') return json({ rooms: await adminRooms() });
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail('방 코드가 올바르지 않아요.');
    return json(await adminStop(code));
  }

  if (action === 'log_solo') {
    const g = replay(body.deal, body.moves);
    if (!g) return fail('기록이 규칙에 맞지 않아요.');
    const pts = finalPoints(g);
    const mySeat = Number(body.seat) || 0;
    const seats = [];
    for (let i = 0; i < g.n; i++) {
      seats.push(i === mySeat
        ? { seat: i, name: String(body.name || '나').slice(0, 16), user_id: uid, guest: !uid, ai: false }
        : { seat: i, name: 'AI ' + i, user_id: null, guest: false, ai: true });
    }
    const id = await saveLog({
      source: 'solo', nPlayers: g.n, winnerSeat: g.winner,
      seats, deal: body.deal, moves: body.moves, points: pts,
    });
    return json({ ok: true, id });
  }

  if (action === 'create') {
    const name = String(body.name || '').trim().slice(0, 16);
    if (!name) return fail('닉네임을 입력해 주세요.');
    const n = Math.min(4, Math.max(2, parseInt(body.nPlayers, 10) || 4));

    /* 캐시 게임이면 로그인과 코인이 필요하다 */
    const stake = normStake(body.stake);
    if (stake < 0) return fail('판돈은 1점당 100 ~ 10000 코인 사이에서 100 단위로 골라 주세요.');
    let buyin = 0;
    if (stake) {
      buyin = normBuyin(stake, body.buyin);
      if (buyin < 0) {
        return fail(`바이인은 ${(stake * BUYIN_MIN_POINTS).toLocaleString()} ~ `
          + `${Math.min(stake * BUYIN_MAX_POINTS, BUYIN_CAP).toLocaleString()}코인 사이에서 `
          + `100 단위로 골라 주세요. (1점당 ${stake.toLocaleString()}코인 기준)`);
      }
      if (!uid) return fail('캐시 게임은 로그인해야 만들 수 있어요.', 401);
      if (!(await hasCoins(uid, buyin))) {
        return fail(`코인이 모자라요. 이 방은 바이인 ${buyin.toLocaleString()}코인이 있어야 만들 수 있어요.`);
      }
    }

    await q('/rpc/cleanup_old_rooms', { method: 'POST', body: '{}' }).catch(() => {});
    await q('/rpc/cleanup_cash', { method: 'POST', body: '{}' }).catch(() => {});
    await q('/rpc/cleanup_seats', { method: 'POST', body: '{}' }).catch(() => {});

    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const c = makeCode();
      const exist = await sel(`/rooms?code=eq.${c}&select=code`);
      if (!exist.length) code = c;
    }
    if (!code) return fail('방 코드를 만들지 못했어요. 다시 시도해 주세요.');

    const token = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await ins('rooms', {
      code, host_player: playerId, n_players: n, status: 'waiting',
      stake, buyin, public_state: {},
    });
    await ins('room_players', {
      id: playerId, room_code: code, token, user_id: uid, name, present: true,
      no_log: !!body.noLog,
    });

    /* 방장도 들어오는 순간 바이인을 묶는다 */
    if (stake) {
      try {
        await seatBuyin({ code, stake, buyin }, uid);
      } catch (e) {
        await del(`/room_players?id=eq.${playerId}`).catch(() => {});
        await del(`/rooms?code=eq.${code}`).catch(() => {});
        const m = coinMsg(e);
        return fail(m ? '바이인을 묶지 못했어요: ' + m
                      : `코인이 모자라요. 이 방은 바이인 ${buyin.toLocaleString()}코인이 있어야 만들 수 있어요.`);
      }
    }

    const { room, players } = await loadRoom(code);
    const pub = await saveRoom(room, players, { totals: {}, log: [], round: 0, leadMode: normLead(body.leadMode) });
    return json({ code, token, playerId, state: pub });
  }

  if (action === 'join') {
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim().slice(0, 16);
    if (!name) return fail('닉네임을 입력해 주세요.');
    const found = await loadRoom(code);
    if (!found) return fail('그런 방이 없어요. 코드를 다시 확인해 주세요.', 404);
    const { room, players, st } = found;
    if (st && st.stopped) return fail('관리자가 닫은 방이에요. 새 방을 만들어 주세요.');
    const buyin = buyinOf(room);
    const short = `코인이 모자라요. 이 방은 바이인 ${buyin.toLocaleString()}코인이 있어야 들어올 수 있어요.`;

    /* 캐시 방은 로그인과 바이인이 필요하다 */
    if (room.stake) {
      if (!uid) return fail('이 방은 캐시 게임이라 로그인해야 들어올 수 있어요.', 401);
      const mine = players.find((p) => p.user_id === uid);
      if (!(mine && hasStack(mine)) && !(await hasCoins(uid, buyin))) return fail(short);
    }

    /* 같은 계정으로 다시 들어오면 원래 자리로 복귀.
     * 캐시 방에서 이미 나가서 코인을 돌려받았다면 바이인을 새로 묶는다 */
    if (uid) {
      const mine = players.find((p) => p.user_id === uid);
      if (mine) {
        if (room.stake && !hasStack(mine)) {
          try { await seatBuyin(room, uid); }
          catch (e) { const m = coinMsg(e); return fail(m ? '바이인을 묶지 못했어요: ' + m : short); }
        }
        await upd(`/room_players?id=eq.${mine.id}`, { present: true, name });
        const again = await loadRoom(code);
        const pub = await saveRoom(again.room, again.players, again.st);
        return json({ code, token: mine.token, playerId: mine.id, state: pub });
      }
    }
    if (room.status !== 'waiting') return fail('이미 시작한 방이에요.');
    if (players.length >= room.n_players) return fail('자리가 다 찼어요.');

    const token = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await ins('room_players', {
      id: playerId, room_code: code, token, user_id: uid, name, present: true,
      no_log: !!body.noLog,
    });
    if (room.stake) {
      try {
        await seatBuyin(room, uid);
      } catch (e) {
        await del(`/room_players?id=eq.${playerId}`).catch(() => {});
        const m = coinMsg(e);
        return fail(m ? '바이인을 묶지 못했어요: ' + m : short);
      }
    }
    const again = await loadRoom(code);
    const pub = await saveRoom(again.room, again.players, st);
    return json({ code, token, playerId, state: pub });
  }

  /* 여기부터는 토큰이 필요 */
  const token = String(body.token || '');
  if (!token) return fail('참가 정보가 없어요. 방에 다시 들어와 주세요.', 401);
  const me = (await sel(`/room_players?token=eq.${encodeURIComponent(token)}&select=*`))[0];
  if (!me) return fail('참가 정보가 만료됐어요. 방에 다시 들어와 주세요.', 401);

  const found = await loadRoom(me.room_code);
  if (!found) return fail('방이 사라졌어요.', 404);
  let { room, players, st } = found;

  /* 이 자리가 어떤 계정의 자리라면, 그 계정으로 로그인한 사람만 쓸 수 있습니다.
   * 참가 토큰이 브라우저에 남아 있어도 다른 계정이 이어받을 수 없게 막아요.
   * (게스트 자리는 user_id 가 없으니 예전처럼 토큰만으로 씁니다.) */
  if (me.user_id) {
    if (room.stake && uid !== me.user_id) {
      return fail('이 자리는 다른 계정의 자리예요. 그 계정으로 로그인해 주세요.', 403);
    }
    if (uid && uid !== me.user_id) {
      return fail('지금 로그인한 계정의 자리가 아니에요.', 403);
    }
  }

  if (st && st.stopped && action !== 'view' && action !== 'leave' && action !== 'chat') {
    return fail('관리자가 닫은 방이에요. 방을 나가 주세요.');
  }

  if (action === 'start') {
    if (room.host_player !== me.id) return fail('방장만 시작할 수 있어요.');
    if (room.status === 'playing') return fail('이미 진행 중이에요.');
    st = {
      totals: (st && st.totals) || {}, log: [], round: (st && st.round) || 0,
      chat: (st && st.chat) || [],          /* 대기실에서 나눈 대화는 남긴다 */
      leadMode: normLead(st && st.leadMode),
      lastWinnerId: (st && st.lastWinnerId) || null,
    };
    await ensureBuyins(room, st, players);
    const joined = players.filter((p) => canPlay(room, p));
    if (joined.length < 2) {
      return fail(room.stake ? '바이인을 묶은 사람이 두 명 이상 있어야 시작할 수 있어요.'
                             : '두 명 이상 있어야 시작할 수 있어요.');
    }

    /* 자리 배정 */
    const order = joined.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    await assignSeats(room, players, order);
    beginRound(room, st, players, order.length);
    const mine = players.find((p) => p.id === me.id);
    const pub = await saveRoom(room, players, st, 'playing');
    return json({
      state: pub, seat: mine ? mine.seat : null,
      hand: mine && isSeated(mine) ? cardsOf(st.game.hand[mine.seat]) : [],
    });
  }

  if (action === 'again') {
    if (room.host_player !== me.id) return fail('방장만 새 판을 시작할 수 있어요.');
    if (!st || !st.game || st.game.winner < 0) return fail('아직 판이 끝나지 않았어요.');
    st.log = [];
    if (room.stake) {
      /* 남은 바이인이 있는 사람만 다시 앉는다. 다 잃은 사람은 관전.
         앉는 순서는 지난 판 자리 순서를 그대로 따른다 */
      await ensureBuyins(room, st, players);
      const order = players.filter((p) => canPlay(room, p))
        .sort((a, b) => (isSeated(a) ? a.seat : 99) - (isSeated(b) ? b.seat : 99));
      if (order.length < 2) {
        return fail('바이인이 남은 사람이 두 명 이상 있어야 새 판을 시작할 수 있어요.');
      }
      await assignSeats(room, players, order);
    } else {
      const seated = players.filter((p) => isSeated(p) && p.present);
      if (seated.length < 2) return fail('두 명 이상 있어야 해요.');
    }
    beginRound(room, st, players, room.n_players);
    const pub = await saveRoom(room, players, st, 'playing');
    return json({ state: pub });
  }

  /* ───────── 채팅 ─────────
   * 같은 방 사람들끼리만 보이고, 최근 CHAT_KEEP 개만 남습니다.
   * 글자 수와 도배는 서버에서 막습니다. 그려 줄 때는 화면에서 escape 합니다. */
  if (action === 'chat') {
    const text = String(body.text || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')   /* 제어문자 제거 */
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CHAT_MAX);
    if (!text) return fail('보낼 말을 적어 주세요.');

    if (!st) st = { totals: {}, log: [], round: 0 };
    st.chat = Array.isArray(st.chat) ? st.chat : [];

    const now = nowMs();
    const mine = st.chat.filter((c) => c.id === me.id);
    const last = mine.length ? mine[mine.length - 1].t : 0;
    if (now - last < CHAT_GAP) return fail('조금 천천히 보내 주세요.');

    st.chat = st.chat.concat([{
      id: me.id, name: me.name,
      seat: isSeated(me) ? me.seat : null,
      text, t: now,
    }]).slice(-CHAT_KEEP);

    const pub = await saveRoom(room, players, st);
    return json({ state: pub });
  }

  if (action === 'leave') {
    await upd(`/room_players?id=eq.${me.id}`, { present: false });
    const again = await loadRoom(room.code);
    let status = again.room.status;
    const live = !!(again.st && again.st.game && again.st.game.winner < 0);
    const meNow = again.players.find((p) => p.id === me.id) || me;
    if (live) {
      autoAdvance(again.st, again.players);
      if (again.st.game.winner >= 0) { await finishGame(again.room, again.st, again.players); status = 'ended'; }
    }

    /* 캐시 방: 지금 판에 앉아 있지 않으면 바로 돌려받고,
       판 도중이면 그 판이 끝날 때(finishGame) 돌려받는다 */
    let cashout = null;
    if (room.stake && me.user_id) {
      const stillPlaying = again.st && again.st.game && again.st.game.winner < 0 && isSeated(meNow);
      if (!stillPlaying && hasStack(meNow)) {
        cashout = await seatCashout(again.room, me.user_id);
        if (!again.st) again.st = { totals: {}, log: [], round: 0 };
        addLog(again.st, `— ${me.name} 나감 · ${cashout.toLocaleString()}코인 돌려받음 —`);
        meNow.stack = null;
      } else if (stillPlaying) {
        addLog(again.st, `— ${me.name} 나감 · 이번 판이 끝나면 남은 코인을 돌려받아요 —`);
      }
    }
    const pub = await saveRoom(again.room, again.players, again.st, status);
    return json({ state: pub, cashout });
  }

  if (action === 'view' || action === 'play' || action === 'pass') {
    if (!me.present) {
      await upd(`/room_players?id=eq.${me.id}`, { present: true });
      const p = players.find((x) => x.id === me.id);
      if (p) p.present = true;
    }

    if (!st || !st.game) {
      const pub = buildPublic(room, players, st);
      return json({ state: pub, hand: [], seat: me.seat });
    }
    const g = st.game;
    let changed = false;

    /* 시간이 지났거나 자리를 비운 사람 차례를 먼저 정리 */
    if (g.winner < 0) {
      const before = JSON.stringify([g.turn, g.played, g.winner]);
      autoAdvance(st, players);
      if (JSON.stringify([g.turn, g.played, g.winner]) !== before) changed = true;
    }

    if (g.winner >= 0 && (action === 'play' || action === 'pass')) {
      return fail('이미 끝난 판이에요.');
    }
    if (g.winner < 0 && (action === 'play' || action === 'pass')) {
      if (!isSeated(me)) return fail('이번 판에는 참여하지 않았어요.');
      if (g.turn !== me.seat) return fail('아직 내 차례가 아니에요.');

      const ms = legalMoves(g);
      let move = null;
      if (action === 'pass') move = ms.find((m) => m.type === PASS) || null;
      else {
        const want = maskFromCards((body.cards || []).map(Number).filter((c) => c >= 0 && c < 52));
        move = ms.find((m) => m.type !== PASS && maskEq(m, want)) || null;
      }
      if (!move) return fail(action === 'pass' ? '지금은 패스할 수 없어요.' : '낼 수 없는 조합이에요.');
      applyMove(st, players, move);
      changed = true;
      autoAdvance(st, players);
    }

    if (g.winner >= 0 && room.status === 'playing') {
      await finishGame(room, st, players);
      const pub = await saveRoom(room, players, st, 'ended');
      return json({ state: pub, hand: isSeated(me) ? cardsOf(g.hand[me.seat]) : [], seat: me.seat });
    }
    const pub = changed ? await saveRoom(room, players, st)
                        : buildPublic(room, players, st);
    return json({ state: pub, hand: isSeated(me) ? cardsOf(g.hand[me.seat]) : [], seat: me.seat });
  }

  return fail('알 수 없는 요청이에요.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  try {
    const body = await req.json();
    /* 누가 보냈는지는 서버가 직접 확인합니다. body.userId 는 쓰지 않습니다. */
    const uid = await authUser(req);
    return await handle(body, uid);
  } catch (e) {
    return fail('서버 오류: ' + ((e && e.message) || e), 500);
  }
});
