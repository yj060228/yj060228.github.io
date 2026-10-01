/* AI 계산 전용 워커 — 화면이 멈추지 않도록 별도 스레드에서 돌립니다. */
importScripts('engine.js' + self.location.search);   /* 워커와 같은 버전의 엔진 */

let net = null, runner = null;

self.onmessage = (e) => {
  const d = e.data;
  try {
    if (d.cmd === 'model') {
      if (d.buf) { net = parseWeights(d.buf); runner = new NetRunner(net); }
      else { net = null; runner = null; }
      self.postMessage({ id: d.id, ok: true, H: net ? net.H : 0 });
      return;
    }
    if (d.cmd === 'think') {
      seedRng((Math.random() * 4294967296) | 0);
      const r = runner ? ismctsNN(d.state, d.iters, runner, d.blend)
                       : ismctsPlain(d.state, d.iters);
      const total = r.stats.reduce((a, s) => a + s.visits, 0) || 1;
      self.postMessage({ id: d.id, ok: true, move: r.move,
        stats: r.stats.slice(0, 4).map((s) => ({ move: s.move, share: s.visits / total })) });
      return;
    }
    if (d.cmd === 'analyze') {
      self.postMessage({ id: d.id, ok: true, ...analyzePosition(d, runner) });
      return;
    }
    if (d.cmd === 'value') {
      if (!runner) { self.postMessage({ id: d.id, ok: true, value: null }); return; }
      const vals = new Float32Array(d.state.n);
      runner.values(d.state, vals);
      self.postMessage({ id: d.id, ok: true, value: vals[d.seat] * POINT_SCALE });
      return;
    }
    /* 모르는 요청에도 꼭 대답한다. 대답이 없으면 화면이 영원히 기다린다 */
    self.postMessage({ id: d.id, ok: false, error: '알 수 없는 요청: ' + d.cmd });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });
  }
};
