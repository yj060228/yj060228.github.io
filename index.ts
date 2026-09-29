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

async function q(path, init) {
  const res = await fetch(DB + path, { ...init, headers: { ...HEAD, ...(init && init.headers) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const sel    = (p) => q(p);
const ins    = (t, body) => q('/' + t, { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } });
const upd    = (p, body) => q(p, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } });
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

/* 판돈: 100 ~ 10000 코인, 100 단위. 바이인은 100점분. */
const STAKE_MIN = 100, STAKE_MAX = 10000, STAKE_STEP = 100, BUYIN_POINTS = 100;
const buyinOf = (stake) => stake * BUYIN_POINTS;
function normStake(v) {
  const n = Math.floor(Number(v) || 0);
  if (!n) return 0;
  if (n < STAKE_MIN || n > STAKE_MAX || n % STAKE_STEP !== 0) return -1;
  return n;
}
const gameRef = (code, round) => `room:${code}:${round}`;

/* 코인 함수는 심판만 부를 수 있습니다 (SQL 에서 권한을 그렇게 걸어 뒀습니다) */
const rpc = (fn, args) => q('/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) });

/* ───────── 공개 상태 만들기 ───────── */
function buildPublic(room, players, st) {
  const g = st && st.game;
  const seated = players.filter((p) => p.seat !== null && p.seat !== undefined)
                        .sort((a, b) => a.seat - b.seat);
  return {
    code: room.code,
    status: room.status,
    nPlayers: room.n_players,
    hostPlayer: room.host_player,
    stake: room.stake || 0,
    buyin: room.stake ? buyinOf(room.stake) : 0,
    round: (st && st.round) || 0,
    cash: (st && st.cash) || null,
    players: (room.status === 'waiting' ? players : seated).map((p) => ({
      id: p.id, name: p.name, seat: p.seat, present: p.present,
      guest: !p.user_id,
      cards: g && p.seat !== null && p.seat !== undefined ? popc(g.hand[p.seat]) : 0,
      passed: g && p.seat !== null && p.seat !== undefined ? !!g.passed[p.seat] : false,
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
    deadline: (st && st.deadline) || 0,
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

async function loadRoom(code) {
  const rooms = await sel(`/rooms?code=eq.${encodeURIComponent(code)}&select=*`);
  if (!rooms.length) return null;
  const players = await sel(`/room_players?room_code=eq.${encodeURIComponent(code)}&select=*&order=created_at`);
  const games = await sel(`/room_games?room_code=eq.${encodeURIComponent(code)}&select=*`);
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

/* ───────── 캐시 게임 ─────────
 * 코인은 여기서만 움직입니다. 금액은 서버가 들고 있는 카드와 승점으로만 정해지고,
 * 브라우저가 보낸 숫자는 하나도 쓰지 않습니다. */

/* 판을 시작하기 전에 참가자마다 바이인을 묶어 둔다.
   한 사람이라도 코인이 모자라면 판이 시작되지 않는다. */
async function cashLock(room, players, round) {
  if (!room.stake) return null;
  const seated = players
    .filter((p) => p.seat !== null && p.seat !== undefined)
    .sort((a, b) => a.seat - b.seat);
  if (seated.some((p) => !p.user_id)) {
    throw new Error('캐시 게임은 로그인한 사람만 할 수 있어요.');
  }
  const ids = seated.map((p) => p.user_id);
  if (new Set(ids).size !== ids.length) throw new Error('같은 계정이 두 자리에 앉아 있어요.');

  const ref = gameRef(room.code, round);
  const buyin = buyinOf(room.stake);
  try {
    await rpc('cash_start', {
      p_ref: ref, p_room: room.code, p_users: ids, p_buyin: buyin, p_stake: room.stake,
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m.includes('코인이 모자란')) {
      throw new Error(`코인이 모자란 사람이 있어요. 캐시 게임을 하려면 ${buyin.toLocaleString()}코인이 필요해요.`);
    }
    throw new Error('판돈을 묶지 못했어요: ' + m.slice(0, 120));
  }
  return { ref, buyin, stake: room.stake, seats: ids };
}

/* 판이 끝나면 벌점 1점당 판돈만큼 주고받는다 */
async function cashSettle(st, players, pts) {
  const c = st.cashLock;
  if (!c) return null;
  const seated = players
    .filter((p) => p.seat !== null && p.seat !== undefined)
    .sort((a, b) => a.seat - b.seat);
  const ids = seated.map((p) => p.user_id);
  const points = seated.map((p) => pts[p.seat]);
  /* 묶을 때와 정산할 때의 사람이 같아야 한다 (SQL 에서도 한 번 더 확인한다) */
  const same = ids.length === c.seats.length && ids.every((x, i) => x === c.seats[i]);
  try {
    if (!same) { await rpc('cash_refund', { p_ref: c.ref }); return { refunded: true, stake: c.stake }; }
    await rpc('cash_settle', { p_ref: c.ref, p_users: ids, p_points: points });
  } catch (_) {
    try { await rpc('cash_refund', { p_ref: c.ref }); } catch (__) {}
    return { refunded: true, stake: c.stake };
  }
  return {
    stake: c.stake, buyin: c.buyin,
    rows: seated.map((p) => ({ seat: p.seat, name: p.name, points: pts[p.seat] })),
  };
}

/* ───────── 판 종료 ───────── */
async function finishGame(st, players) {
  const g = st.game;
  const pts = finalPoints(g);
  st.totals = st.totals || {};
  const names = [];
  for (const p of players) {
    if (p.seat === null || p.seat === undefined) continue;
    const v = pts[p.seat];
    st.totals[p.id] = (st.totals[p.id] || 0) + v;
    names.push(`${p.name} ${v > 0 ? '+' : ''}${v}`);
  }
  addLog(st, `${seatName(players, g.winner)} 승리 — ${names.join(' / ')}`);

  /* 캐시 게임이면 코인 정산 */
  const cash = await cashSettle(st, players, pts);
  st.cashLock = null;
  st.cash = null;
  if (cash) {
    if (cash.refunded) {
      addLog(st, '— 자리가 바뀌어 판돈을 그대로 돌려줬어요 —');
    } else {
      st.cash = cash;
      addLog(st, '— 정산 · ' + cash.rows
        .map((r) => `${r.name} ${r.points > 0 ? '+' : ''}${(r.points * cash.stake).toLocaleString()}`)
        .join(' / ') + ' 코인 —');
    }
  }

  await saveLog({
    source: 'mp', roomCode: g.n && players[0] ? players[0].room_code : null,
    nPlayers: g.n, winnerSeat: g.winner,
    seats: players
      .filter((p) => p.seat !== null && p.seat !== undefined)
      .map((p) => ({ seat: p.seat, name: p.name, user_id: p.no_log ? null : (p.user_id || null), guest: !p.user_id, ai: false })),
    deal: st.deal || [], moves: st.moves || [], points: pts,
  });

  /* 로그인한 사람은 멀티플레이 전적에 반영 */
  for (const p of players) {
    if (!p.user_id || p.seat === null || p.seat === undefined) continue;
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
function startRound(st, players, nPlayers) {
  seedRng(randomSeed());
  const g = initState(nPlayers);
  st.game = g;
  st.deal = g.hand.slice(0, nPlayers).map(cardsOf);
  st.moves = [];
  st.round = (st.round || 0) + 1;
  st.deadline = nowMs() + TURN_SECONDS * 1000;
  addLog(st, `— ${st.round}번째 판 시작 · ${seatName(players, g.turn)} 선 —`);
}

/* 캐시 게임이면 판돈을 먼저 묶고 나서 카드를 돌린다 */
async function beginRound(room, st, players, n) {
  st.cashLock = await cashLock(room, players, (st.round || 0) + 1);
  st.cash = null;
  startRound(st, players, n);
  if (st.cashLock) {
    addLog(st, `— 캐시 게임 · 1점당 ${room.stake.toLocaleString()}코인 (바이인 ${st.cashLock.buyin.toLocaleString()}) —`);
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

/* ───────── 요청 처리 ───────── */
async function handle(body, uid) {
  const action = body.action;

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
    if (stake < 0) return fail('판돈은 100 ~ 10000 코인 사이에서 100 단위로 골라 주세요.');
    if (stake) {
      if (!uid) return fail('캐시 게임은 로그인해야 만들 수 있어요.', 401);
      if (!(await hasCoins(uid, buyinOf(stake)))) {
        return fail(`코인이 모자라요. 1점당 ${stake.toLocaleString()}코인 방은 ${buyinOf(stake).toLocaleString()}코인이 있어야 해요.`);
      }
    }

    await q('/rpc/cleanup_old_rooms', { method: 'POST', body: '{}' }).catch(() => {});
    await q('/rpc/cleanup_cash', { method: 'POST', body: '{}' }).catch(() => {});

    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const c = makeCode();
      const exist = await sel(`/rooms?code=eq.${c}&select=code`);
      if (!exist.length) code = c;
    }
    if (!code) return fail('방 코드를 만들지 못했어요. 다시 시도해 주세요.');

    const token = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await ins('rooms', { code, host_player: playerId, n_players: n, status: 'waiting', stake, public_state: {} });
    await ins('room_players', {
      id: playerId, room_code: code, token, user_id: uid, name, present: true,
      no_log: !!body.noLog,
    });
    const { room, players } = await loadRoom(code);
    const pub = await saveRoom(room, players, null);
    return json({ code, token, playerId, state: pub });
  }

  if (action === 'join') {
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim().slice(0, 16);
    if (!name) return fail('닉네임을 입력해 주세요.');
    const found = await loadRoom(code);
    if (!found) return fail('그런 방이 없어요. 코드를 다시 확인해 주세요.', 404);
    const { room, players, st } = found;

    /* 캐시 방은 로그인과 바이인이 필요하다 */
    if (room.stake) {
      if (!uid) return fail('이 방은 캐시 게임이라 로그인해야 들어올 수 있어요.', 401);
      if (!players.some((p) => p.user_id === uid)
          && !(await hasCoins(uid, buyinOf(room.stake)))) {
        return fail(`코인이 모자라요. 이 방은 ${buyinOf(room.stake).toLocaleString()}코인이 있어야 들어올 수 있어요.`);
      }
    }

    /* 같은 계정으로 다시 들어오면 원래 자리로 복귀 */
    if (uid) {
      const mine = players.find((p) => p.user_id === uid);
      if (mine) {
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

  if (action === 'start') {
    if (room.host_player !== me.id) return fail('방장만 시작할 수 있어요.');
    if (room.status === 'playing') return fail('이미 진행 중이에요.');
    const joined = players.filter((p) => p.present);
    if (joined.length < 2) return fail('두 명 이상 있어야 시작할 수 있어요.');

    /* 자리 배정 */
    const order = joined.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i < order.length; i++) await upd(`/room_players?id=eq.${order[i].id}`, { seat: i });
    for (const p of players) if (!p.present) await upd(`/room_players?id=eq.${p.id}`, { seat: null });

    players = (await loadRoom(room.code)).players;
    st = { totals: (st && st.totals) || {}, log: [], round: (st && st.round) || 0 };
    try {
      await beginRound(room, st, players, order.length);
    } catch (e) {
      /* 판돈을 못 묶으면 카드를 돌리지 않는다 */
      for (const p of players) await upd(`/room_players?id=eq.${p.id}`, { seat: null });
      return fail((e && e.message) || '판을 시작하지 못했어요.');
    }
    await upd(`/rooms?code=eq.${room.code}`, { n_players: order.length });
    room.n_players = order.length;
    const mine = players.find((p) => p.id === me.id);
    const pub = await saveRoom(room, players, st, 'playing');
    return json({
      state: pub, seat: mine ? mine.seat : null,
      hand: mine && mine.seat !== null && mine.seat !== undefined ? cardsOf(st.game.hand[mine.seat]) : [],
    });
  }

  if (action === 'again') {
    if (room.host_player !== me.id) return fail('방장만 새 판을 시작할 수 있어요.');
    if (!st || !st.game || st.game.winner < 0) return fail('아직 판이 끝나지 않았어요.');
    const seated = players.filter((p) => p.seat !== null && p.seat !== undefined && p.present);
    if (seated.length < 2) return fail('두 명 이상 있어야 해요.');
    st.log = [];
    try {
      await beginRound(room, st, players, room.n_players);
    } catch (e) {
      return fail((e && e.message) || '새 판을 시작하지 못했어요.');
    }
    const pub = await saveRoom(room, players, st, 'playing');
    return json({ state: pub });
  }

  if (action === 'leave') {
    await upd(`/room_players?id=eq.${me.id}`, { present: false });
    const again = await loadRoom(room.code);
    let status = again.room.status;
    if (again.st && again.st.game && again.st.game.winner < 0) {
      autoAdvance(again.st, again.players);
      if (again.st.game.winner >= 0) { await finishGame(again.st, again.players); status = 'ended'; }
    }
    const pub = await saveRoom(again.room, again.players, again.st, status);
    return json({ state: pub });
  }

  if (action === 'view' || action === 'play' || action === 'pass') {
    if (!me.present) await upd(`/room_players?id=eq.${me.id}`, { present: true });

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
      if (me.seat === null || me.seat === undefined) return fail('이번 판에는 참여하지 않았어요.');
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
      await finishGame(st, players);
      const pub = await saveRoom(room, players, st, 'ended');
      return json({ state: pub, hand: me.seat !== null ? cardsOf(g.hand[me.seat]) : [], seat: me.seat });
    }
    const pub = changed ? await saveRoom(room, players, st)
                        : buildPublic(room, players, st);
    return json({ state: pub, hand: me.seat !== null && me.seat !== undefined ? cardsOf(g.hand[me.seat]) : [], seat: me.seat });
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
