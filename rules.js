/* 규칙 탭 — 초심자가 읽고 바로 이해할 수 있게 실제 카드 그림으로 설명 */
(function buildRules() {
  const box = document.getElementById('viewRules');
  if (!box) return;

  const SUITS = { C: 0, H: 1, D: 2, S: 3 };
  const RANKS = { '3':0,'4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11,'2':12 };
  const idx = (t) => {
    const su = SUITS[t.slice(-1)];
    return RANKS[t.slice(0, -1)] * 4 + su;
  };
  /* "3C 4D" → 카드 그림 */
  const cards = (str, cls) => `<span class="row-cards">${str.split(' ').map((t) => cardHtml(idx(t), cls || 'sm')).join('')}</span>`;
  const row = (label, str, note) =>
    `<div class="rulerow"><span class="rulelabel">${label}</span>${cards(str)}${note ? `<span class="rulenote">${note}</span>` : ''}</div>`;

  box.innerHTML = `
  <div class="panel">
    <h2>한 줄 요약</h2>
    <p>13장을 나눠 받아서, <strong>먼저 손을 다 비우는 사람이 이깁니다.</strong>
       앞사람이 낸 것보다 센 패를 같은 장수로 내면 되고, 낼 게 없으면 패스합니다.
       끝났을 때 손에 남은 카드가 곧 벌점이에요.</p>
  </div>

  <div class="panel">
    <h2>카드의 세기</h2>
    <p>숫자는 <strong>3이 가장 약하고 2가 가장 셉니다.</strong> 에이스보다 2가 위라는 점이 다른 게임과 달라요.</p>
    ${cards('3S 4S 5S 6S 7S 8S 9S 10S JS QS KS AS 2S')}
    <p>숫자가 같으면 무늬로 가립니다. <strong>♠ &gt; ♦ &gt; ♥ &gt; ♣</strong> 순이에요.</p>
    ${cards('7C 7H 7D 7S')}
    <p class="note">숫자가 항상 먼저입니다. ♣8이 ♠7보다 셉니다.</p>
  </div>

  <div class="panel">
    <h2>낼 수 있는 조합</h2>
    <p>한 번에 낼 수 있는 모양은 아래 여덟 가지뿐이에요. 장수는 1장, 2장, 3장, 5장만 가능합니다.</p>
    ${row('싱글', '9D', '한 장')}
    ${row('페어', '9H 9S', '같은 숫자 2장')}
    ${row('트리플', '9C 9H 9S', '같은 숫자 3장')}
    ${row('스트레이트', '5C 6D 7H 8S 9C', '연속한 숫자 5장')}
    ${row('플러쉬', '3H 7H 9H JH KH', '같은 무늬 5장')}
    ${row('풀하우스', '8C 8H 8D QH QS', '트리플 + 페어')}
    ${row('포카드', 'JC JH JD JS 4C', '같은 숫자 4장 + 아무 1장')}
    ${row('스트레이트플러쉬', '5D 6D 7D 8D 9D', '무늬까지 같은 연속 5장')}
  </div>

  <div class="panel">
    <h2>어떻게 이기나</h2>
    <p><strong>장수가 같아야 하고, 더 세야 합니다.</strong> 페어에는 페어로, 5장에는 5장으로 받습니다.
       장수가 다르면 받을 수 없어요.</p>
    ${row('앞사람', '7C 7H', '')}
    ${row('가능', '9D 9S', '더 높은 페어')}
    ${row('가능', '7D 7S', '같은 7이지만 무늬가 위')}
    ${row('불가능', '9C 9H 9S', '장수가 다름')}
    <p>1·2·3장짜리는 <strong>가장 높은 카드</strong>로 비교합니다. 숫자가 같으면 무늬로 갈려요.</p>
  </div>

  <div class="panel">
    <h2>5장 족보의 서열</h2>
    <p>5장짜리끼리는 종류가 다르면 아래 순서로 이깁니다. 종류가 같을 때만 안에서 세기를 따져요.</p>
    <div class="ladder">
      <div class="lstep"><span class="lname">스트레이트플러쉬</span><span class="lnote">가장 셈</span></div>
      <div class="lstep"><span class="lname">포카드</span></div>
      <div class="lstep"><span class="lname">풀하우스</span></div>
      <div class="lstep"><span class="lname">플러쉬</span></div>
      <div class="lstep"><span class="lname">스트레이트</span><span class="lnote">가장 약함</span></div>
    </div>
    <p class="note">그래서 9스트레이트 위에 8풀하우스를 낼 수 있어요. 숫자가 낮아도 족보가 위면 이깁니다.</p>
    <p>같은 종류끼리는 이렇게 비교해요.</p>
    <ul class="rulelist">
      <li><strong>플러쉬</strong> — 가장 높은 카드</li>
      <li><strong>풀하우스</strong> — 트리플 쪽 숫자</li>
      <li><strong>포카드</strong> — 4장인 숫자</li>
      <li><strong>스트레이트</strong> — 아래의 특별한 순서</li>
    </ul>
  </div>

  <div class="panel">
    <h2>스트레이트의 순서</h2>
    <p>이 게임의 스트레이트는 조금 특이해요. <strong>A-2-3-4-5가 가장 세고</strong>, 3-4-5-6-7이 가장 약합니다.</p>
    ${row('1위', 'AC 2D 3H 4S 5C')}
    ${row('2위', '2C 3D 4H 5S 6C')}
    ${row('3위', '10C JD QH KS AC')}
    ${row('…', '9C 10D JH QS KC')}
    ${row('꼴찌', '3C 4D 5H 6S 7C')}
    <p class="note">2를 넘어서 이어지는 건 안 됩니다. J-Q-K-A-2 나 Q-K-A-2-3 은 스트레이트가 아니에요.</p>
    <p>숫자 구성이 같으면 가장 높은 카드의 무늬로 가립니다.</p>
  </div>

  <div class="panel">
    <h2>한 판의 흐름</h2>
    <ol class="rulelist">
      <li><strong>첫 수</strong> — 가장 낮은 카드를 가진 사람이 먼저 냅니다. 4명이면 ♣3이에요.
          그 카드를 반드시 포함해서 내야 합니다. 싱글로 내도 되고, 그 카드가 들어간 페어나 스트레이트로 내도 돼요.</li>
      <li><strong>돌아가며</strong> — 앞사람보다 센 패를 같은 장수로 냅니다. 낼 수 없거나 내기 싫으면 패스합니다.</li>
      <li><strong>패스해도 끝이 아님</strong> — 한 번 패스해도 다음 차례가 오면 다시 낼 수 있어요.</li>
      <li><strong>모두 패스하면</strong> — 마지막으로 낸 사람이 선이 됩니다. 바닥이 치워지고 원하는 족보를 새로 낼 수 있어요.</li>
      <li><strong>끝</strong> — 누군가 손을 다 비우면 그 판이 끝납니다.</li>
    </ol>
  </div>

  <div class="panel">
    <h2>땁 규칙</h2>
    <p>누군가 카드가 <strong>1장만 남으면 "땁"</strong>이라고 알립니다. 그 사람 <strong>바로 앞 순서</strong>는
       그냥 넘어갈 수 없어요.</p>
    <ul class="rulelist">
      <li><strong>따라 낼 때</strong> — 이길 수 있는 수 중 <strong>가장 센 것</strong>만 낼 수 있고, 패스도 못 합니다.
          이길 패가 아예 없을 때만 패스할 수 있어요.</li>
      <li><strong>내가 선일 때</strong> — 싱글을 낸다면 <strong>내 손에서 가장 높은 카드</strong>여야 합니다.
          페어나 5장짜리는 평소처럼 자유롭게 낼 수 있어요.</li>
    </ul>
    <p class="note">땁인 사람이 쉽게 이기지 못하도록 앞사람이 최선을 다하게 하는 규칙이에요.
       2장 남으면 "투카드"라고 알리지만, 여기엔 제한이 없어요.</p>
  </div>

  <div class="panel">
    <h2>점수 계산</h2>
    <p>판이 끝나면 손에 남은 카드로 벌점을 매깁니다.</p>
    <ul class="rulelist">
      <li>기본은 <strong>남은 장수</strong>만큼</li>
      <li>손에 <strong>2가 있으면 한 장당 2배</strong></li>
      <li><strong>10장 이상</strong> 남았으면 다시 2배</li>
    </ul>
    <div class="example">
      <p><strong>예시</strong> — 11장이 남았고 그중 2가 두 장이면</p>
      <p class="calc">11 × 2 × 2 × 2 = <strong>88점</strong></p>
      <p class="note">장수 11 → 2가 두 장이라 2배를 두 번 → 10장 이상이라 다시 2배</p>
    </div>
    <p>이긴 사람은 벌점이 0입니다. 그다음 모두가 <strong>벌점 차이만큼 서로 주고받아요.</strong>
       내 점수는 항상 다른 사람들의 손해에서 나오기 때문에, 한 판의 점수를 모두 더하면 0이 됩니다.</p>
    <p class="note">그래서 이기지 못할 것 같으면 <strong>2와 큰 카드부터 털어내는 게</strong> 중요해요.
       못 이겨도 잃는 점수를 줄일 수 있거든요.</p>
  </div>

  <div class="panel">
    <h2>용어</h2>
    <ul class="rulelist">
      <li><strong>선</strong> — 바닥이 비어서 원하는 족보를 새로 낼 수 있는 차례</li>
      <li><strong>바닥</strong> — 지금 받아쳐야 하는, 마지막에 나온 패</li>
      <li><strong>투카드</strong> — 카드가 2장 남았을 때 알리는 말</li>
      <li><strong>땁</strong> — 카드가 1장 남았을 때 알리는 말</li>
    </ul>
  </div>

  <div class="panel">
    <h2>이제 해 볼까요</h2>
    <p>AI와 두면서 익히는 게 가장 빨라요. 낼 수 없는 카드는 흐리게 표시되고,
       고른 카드가 어떤 족보인지 바로 알려줘요. <strong>힌트</strong> 버튼을 누르면 AI가 추천하는 수도 볼 수 있어요.</p>
    <div class="actions">
      <button class="btn primary" id="rulesGoSolo">AI와 연습하기</button>
      <button class="btn" id="rulesGoMp">친구와 대전</button>
      <button class="btn" id="rulesClose">규칙 닫기</button>
    </div>
  </div>`;

  const go = (id, tab) => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => { showTab(tab); toggleRules(false); };
  };
  go('rulesGoSolo', 'solo');
  go('rulesGoMp', 'mp');
  const close = document.getElementById('rulesClose');
  if (close) close.onclick = () => toggleRules(false);
})();
