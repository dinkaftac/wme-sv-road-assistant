// ==UserScript==
// @name         WME Street View Road Assistant
// @namespace    https://github.com/dinkaftac/wme-sv-road-assistant
// @version      1.0.0-beta
// @description  Manual assistance for editors: the script proposes draft segments over Street View coverage gaps. Every draft must be reviewed by the editor, aligned to the road centerline, and confirmed against the latest satellite imagery before WME's native Save. Nothing is ever saved automatically, and no existing road is modified. Built to assist a human editor, not to mass-edit: the tool proposes, the editor decides.
// @author       dinkaftac (https://github.com/dinkaftac)
// @license      MIT
// @homepageURL  https://github.com/dinkaftac/wme-sv-road-assistant
// @supportURL   https://github.com/dinkaftac/wme-sv-road-assistant/issues
// @copyright    2026, dinkaftac
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/editor/sdk*
// @exclude      https://www.waze.com/*/editor/sdk*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      mts0.google.com
// @connect      mts1.google.com
// @connect      mts2.google.com
// @connect      mts3.google.com
// @run-at       document-end
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const SCRIPT_ID = 'wme-sv-road-assistant';
  const SCRIPT_NAME = 'WME Street View Road Assistant';
  const LAYER_COVERAGE = 'Street View Coverage';
  const LAYER_CANDIDATE = 'SV Candidate Roads';

  const TILE_FILE = 'mapslt?lyrs=svv&x=${x}&y=${y}&z=${z}&w=256&h=256&style=40';
  const TILE_SERVERS = ['https://mts0.google.com', 'https://mts1.google.com', 'https://mts2.google.com', 'https://mts3.google.com'];
  const CELL_PX = 2;
  const MAX_TILES = 40;
  const TILE_CONCURRENCY = 6;
  const PRESETS = [
    { key: 'street', label: 'Street', roadType: 1 },
    { key: 'primary', label: 'Primary Street', roadType: 2 },
    { key: 'minor', label: 'Minor Highway', roadType: 7 },
    { key: 'major', label: 'Major Highway', roadType: 6 },
    { key: 'private', label: 'Private Road', roadType: 17 },
    { key: 'parking', label: 'Parking Road', roadType: 20 }
  ];

  const NEVER_CONNECT = [5, 10, 15, 16, 18, 19];
  const SAFE_PENDING_LIMIT = 30;
  const FINAL_VIEW_PAUSE_MS = 2000;   // let the editor see the last draft before the view snaps back
  // How long an acknowledgement is remembered before the dialog can reappear.
  // Set to 3 days by default; users who want it longer can adjust.
  const RESPONSIBILITY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
  const ORIENT_REACH = 6;
  const ROAD_TYPE_NAMES = {
    1: 'Street', 2: 'Primary Street', 3: 'Freeway', 4: 'Ramp', 5: 'Walking Trail', 6: 'Major Highway', 7: 'Minor Highway',
    8: 'Off-road', 10: 'Pedestrian Boardwalk', 15: 'Ferry', 16: 'Stairway', 17: 'Private Road', 18: 'Railroad',
    19: 'Runway/Taxiway', 20: 'Parking Lot Road', 22: 'Alley'
  };
  const roadTypeName = (rt) => ROAD_TYPE_NAMES[rt] || (rt === undefined ? '?' : `type ${rt}`);

  const DEFAULT_SETTINGS = {
    detectionRadius: 20,
    minCandidateLength: 30,
    maxCandidatesStorage: 1000,
    maxDraftCreationBatch: 1,      // author-recommended: one draft per sub-batch, each checked against loaded tiles
    maxConvertPerClick: 10,
    maxPendingEdits: 300,          // reminder threshold (0 = never remind)
    unverifiedSoftStopPct: 150,    // reminder when unsaved script drafts reach this % of the per-click cap (0 = off)
    batchPauseMs: 2000,
    convertDelayMs: 300,
    tileSettleMs: 1500,
    convertZoom: 14,
    minScanZoom: 16,
    focusZoom: 18,
    settingsRev: 16,
    highLockBuffer: 5,
    roadPreset: 'street',
    autoCoverage: true,
    splitAtJunctions: true,
    autoSampleZoom: true,
    sampleZoom: 17,
    maxSampleTiles: 40,
    cellPx: 2,
    showGuide: false,
    responsibilityAcknowledged: false,
    responsibilityAcknowledgedAt: 0
  };
  let sdk = null;

  const Log = {
    debug: (() => { try { return localStorage.getItem('wme-svra-debug') === '1'; } catch (e) { return false; } })(),
    d(...a) { if (this.debug) console.debug(`[${SCRIPT_NAME}]`, ...a); },
    i(...a) { console.info(`[${SCRIPT_NAME}]`, ...a); },
    w(...a) { console.warn(`[${SCRIPT_NAME}]`, ...a); },
    e(...a) { console.error(`[${SCRIPT_NAME}]`, ...a); }
  };
  function safe(label, fn, fallback) {
    try { return fn(); } catch (err) { Log.e(`${label} failed`, err); return fallback; }
  }
  function isPromise(v) { return v && typeof v.then === 'function'; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ===== GEOMETRY ===== */
  const Geo = {
    R: 6378137,
    rad: (d) => (d * Math.PI) / 180,
    deg: (r) => (r * 180) / Math.PI,
    haversine(a, b) {
      const dLat = Geo.rad(b[1] - a[1]);
      const dLon = Geo.rad(b[0] - a[0]);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(Geo.rad(a[1])) * Math.cos(Geo.rad(b[1])) * Math.sin(dLon / 2) ** 2;
      return 2 * Geo.R * Math.asin(Math.min(1, Math.sqrt(s)));
    },
    length(coords) { let sum = 0; for (let i = 1; i < coords.length; i++) sum += Geo.haversine(coords[i - 1], coords[i]); return sum; },
    xy(c, refLat) { return [c[0] * 111320 * Math.cos(Geo.rad(refLat)), c[1] * 110540]; },
    ll(p, refLat) { return [p[0] / (111320 * Math.cos(Geo.rad(refLat))), p[1] / 110540]; },
    nearestOnSeg(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const q = [a[0] + t * dx, a[1] + t * dy];
      return { t, q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
    },
    nearestOnLine(coord, line) {
      const ref = coord[1];
      const p = Geo.xy(coord, ref);
      let best = null;
      for (let i = 1; i < line.length; i++) {
        const r = Geo.nearestOnSeg(p, Geo.xy(line[i - 1], ref), Geo.xy(line[i], ref));
        if (!best || r.d < best.dist) best = { dist: r.d, point: Geo.ll(r.q, ref), index: i - 1, t: r.t };
      }
      return best;
    },
    bbox(coords) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const c of coords) { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; }
      return [w, s, e, n];
    },
    bboxOverlap(a, b) { return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]); },
    bboxPad(b, m) {
      const dLat = m / 110540;
      const dLon = m / (111320 * Math.cos(Geo.rad((b[1] + b[3]) / 2)));
      return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
    },
    simplify(coords, eps) {
      if (coords.length < 3) return coords.slice();
      const ref = coords[0][1];
      const pts = coords.map((c) => Geo.xy(c, ref));
      const keep = new Array(pts.length).fill(false);
      keep[0] = keep[pts.length - 1] = true;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [s, e] = stack.pop();
        let maxD = 0, idx = -1;
        for (let i = s + 1; i < e; i++) {
          const d = Geo.nearestOnSeg(pts[i], pts[s], pts[e]).d;
          if (d > maxD) { maxD = d; idx = i; }
        }
        if (idx !== -1 && maxD > eps) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
      }
      return coords.filter((_, i) => keep[i]);
    },
    densify(coords, step) {
      const out = [coords[0]];
      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i];
        const n = Math.max(1, Math.ceil(Geo.haversine(a, b) / step));
        for (let k = 1; k <= n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      return out;
    },
    mercY: (lat) => Math.log(Math.tan(Math.PI / 4 + Geo.rad(lat) / 2)),
    invMercY: (y) => Geo.deg(2 * Math.atan(Math.exp(y)) - Math.PI / 2),
    pixelToLonLat(px, py, z) {
      const size = 256 * 2 ** z;
      return [(px / size) * 360 - 180, Geo.deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / size))))];
    },
    lonLatToTile(lon, lat, z) {
      const n = 2 ** z;
      const x = Math.floor(((lon + 180) / 360) * n);
      const y = Math.floor(((1 - Math.asinh(Math.tan(Geo.rad(lat))) / Math.PI) / 2) * n);
      return [x, y];
    }
  };

  /* ===== FAST ROAD PROXIMITY INDEX ===== */
  function buildRoadIndex(segs, ref, bucket) {
    const kx = 111320 * Math.cos(Geo.rad(ref[1])), ky = 110540;
    const K = 1 << 20, OFF = 524288;
    const key = (i, j) => (i + OFF) * K + (j + OFF);
    const grid = new Map();
    const edges = [];
    for (const s of segs) {
      const c = s.coords;
      for (let i = 1; i < c.length; i++) {
        const ax = (c[i - 1][0] - ref[0]) * kx, ay = (c[i - 1][1] - ref[1]) * ky;
        const bx = (c[i][0] - ref[0]) * kx, by = (c[i][1] - ref[1]) * ky;
        const e = edges.length / 4;
        edges.push(ax, ay, bx, by);
        const i0 = Math.floor(Math.min(ax, bx) / bucket), i1 = Math.floor(Math.max(ax, bx) / bucket);
        const j0 = Math.floor(Math.min(ay, by) / bucket), j1 = Math.floor(Math.max(ay, by) / bucket);
        for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
          const k = key(gi, gj);
          let a = grid.get(k);
          if (!a) { a = []; grid.set(k, a); }
          a.push(e);
        }
      }
    }
    return {
      near(lon, lat, r) {
        const px = (lon - ref[0]) * kx, py = (lat - ref[1]) * ky;
        const gi = Math.floor(px / bucket), gj = Math.floor(py / bucket);
        const r2 = r * r;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const a = grid.get(key(gi + di, gj + dj));
          if (!a) continue;
          for (let q = 0; q < a.length; q++) {
            const o = a[q] * 4;
            const ax = edges[o], ay = edges[o + 1], dx = edges[o + 2] - ax, dy = edges[o + 3] - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - px, ey = ay + t * dy - py;
            if (ex * ex + ey * ey <= r2) return true;
          }
        }
        return false;
      }
    };
  }

  /* ===== TILE FETCH + CACHE ===== */
  function fetchTile(x, y, z) {
    const url = `${TILE_SERVERS[x % TILE_SERVERS.length]}/${TILE_FILE}`.replace('${x}', x).replace('${y}', y).replace('${z}', z);
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'blob', timeout: 15000,
          onload: (r) => (r.status >= 200 && r.status < 300 && r.response && r.response.size
            ? createImageBitmap(r.response).then(resolve, reject)
            : reject(new Error(`empty/HTTP ${r.status}`))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout'))
        });
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image load failed'));
        img.src = url;
      }
    });
  }

  const TILE_CACHE = new Map();
  const TILE_CACHE_MAX = 100;
  function closeBitmapLater(p) {
    p.then((b) => { try { if (b && typeof b.close === 'function') b.close(); } catch (e) { /* ignore */ } }).catch(() => {});
  }
  function fetchTileCached(x, y, z) {
    const key = `${z}/${x}/${y}`;
    const hit = TILE_CACHE.get(key);
    if (hit) return hit;
    const p = fetchTile(x, y, z).catch(() => fetchTile(x, y, z));
    TILE_CACHE.set(key, p);
    p.catch(() => { if (TILE_CACHE.get(key) === p) TILE_CACHE.delete(key); });
    // Never evict below one full scan's worth of tiles, or an in-flight bitmap could be closed early.
    if (TILE_CACHE.size > Math.max(TILE_CACHE_MAX, (Settings.get('maxSampleTiles') || MAX_TILES) + 20)) {
      const oldKey = TILE_CACHE.keys().next().value;
      const old = TILE_CACHE.get(oldKey);
      TILE_CACHE.delete(oldKey);
      if (old) closeBitmapLater(old);
    }
    return p;
  }

  /* ===== SCAN PLAN ===== */
  function pickSampleZoom(extent, maxTiles) {
    const [w, s, e, n] = extent;
    for (let z = 20; z >= 16; z--) {
      const [x0, y1] = Geo.lonLatToTile(w, s, z);
      const [x1, y0] = Geo.lonLatToTile(e, n, z);
      const tiles = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (tiles <= maxTiles) return { zoom: z, tiles };
    }
    return { zoom: 16, tiles: Infinity };
  }

  function planScan(extent) {
    const maxTiles = Settings.get('maxSampleTiles') || MAX_TILES;
    const auto = !!Settings.get('autoSampleZoom');
    const zoom = auto ? pickSampleZoom(extent, maxTiles).zoom : Math.max(16, Math.min(20, Settings.get('sampleZoom') || 17));
    let [w, s, e, n] = extent;
    let x0, x1, y0, y1, shrunk = false;
    for (let i = 0; i < 80; i++) {
      [x0, y1] = Geo.lonLatToTile(w, s, zoom);
      [x1, y0] = Geo.lonLatToTile(e, n, zoom);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) break;
      const cx = (w + e) / 2, cy = (s + n) / 2, hw = ((e - w) / 2) * 0.93, hh = ((n - s) / 2) * 0.93;
      w = cx - hw; e = cx + hw; s = cy - hh; n = cy + hh; shrunk = true;
    }
    return { zoom, auto, extent: [w, s, e, n], x0, x1, y0, y1, tiles: (x1 - x0 + 1) * (y1 - y0 + 1), shrunk, maxTiles };
  }

  /* ===== SCAN FRAME / GUIDE OVERLAY ===== */
  const SCAN_FRAME_LAYER = 'SVRA.ScanFrame';
  let scanFrameLayerReady = false;

  function ensureScanFrameLayer() {
    if (scanFrameLayerReady) return;
    try {
      sdk.Map.addLayer({
        layerName: SCAN_FRAME_LAYER,
        zIndexing: true,
        styleRules: [
          { predicate: (p) => p.featureType === 'scanFrame',
            style: { strokeColor: '#00c853', strokeWidth: 3, strokeDashstyle: 'dash', strokeOpacity: 1, fillColor: '#00c853', fillOpacity: 0.08 } },
          { predicate: (p) => p.featureType === 'scanGuide',
            style: { strokeColor: '#ff9800', strokeWidth: 3, strokeDashstyle: 'dash', strokeOpacity: 1, fillColor: '#ff9800', fillOpacity: 0.06 } },
          { predicate: (p) => p.featureType === 'scanTile',
            style: { strokeColor: '#1a73e8', strokeWidth: 1, strokeDashstyle: 'dot', strokeOpacity: 0.6, fillOpacity: 0 } }
        ]
      });
      scanFrameLayerReady = true;
    } catch (e) { Log.w('scan frame layer already exists', e.message); scanFrameLayerReady = true; }
  }

  function showScanFrame(extent, tileInfo, kind = 'scanFrame') {
    if (!extent) return;
    ensureScanFrameLayer();
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: SCAN_FRAME_LAYER }); } catch (e) {}

    const [w, s, e, n] = extent;
    const features = [{
      type: 'Feature',
      id: `svra-${kind}`,
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      properties: { featureType: kind }
    }];

    if (Log.debug && tileInfo && typeof tileInfo === 'object') {
      const { x0, x1, y0, y1, zoom } = tileInfo;
      const n2 = 2 ** zoom;
      const tileLon = (px) => (px / n2) * 360 - 180;
      const tileLat = (py) => Geo.deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n2))));
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          const tw = tileLon(tx), te = tileLon(tx + 1);
          const tn = tileLat(ty), ts = tileLat(ty + 1);
          features.push({
            type: 'Feature',
            id: `svra-tile-${tx}-${ty}`,
            geometry: { type: 'Polygon', coordinates: [[[tw, ts], [te, ts], [te, tn], [tw, tn], [tw, ts]]] },
            properties: { featureType: 'scanTile' }
          });
        }
      }
    }
    try { sdk.Map.addFeaturesToLayer({ layerName: SCAN_FRAME_LAYER, features }); }
    catch (err) { Log.w('showScanFrame add failed', err); }
  }

  function clearScanFrame() {
    if (!scanFrameLayerReady) return;
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: SCAN_FRAME_LAYER }); } catch (e) {}
  }

  /* ===== TRACE PROFILES ===== */
  const TRACE_PROFILES = {
    coarse:   { label: 'Coarse - straight, fewest nodes',   straightenTol: 3.0, simplifyTol: 3.0, maxNodes: 40 },
    balanced: { label: 'Balanced (default)',                 straightenTol: 1.5, simplifyTol: 1.5, maxNodes: 90 },
    sharp:    { label: 'Sharp - keeps gentle curves',        straightenTol: 0.8, simplifyTol: 1.0, maxNodes: 160 },
    precise:  { label: 'Precise - smooth winding roads',     straightenTol: 0.4, simplifyTol: 0.6, maxNodes: 250 }
  };
  const DEFAULT_TRACE_PROFILE = 'balanced';
  function traceOpts() {
    const p = TRACE_PROFILES[DEFAULT_TRACE_PROFILE];
    return { straightenTol: p.straightenTol, simplifyTol: p.simplifyTol, maxNodes: p.maxNodes };
  }

  function shapeLine(coords, o) {
    if (!coords || coords.length < 3) return coords ? coords.map((c) => c.slice()) : coords;
    const opt = o || traceOpts();
    const straightTol = opt.straightenTol ?? 1.5;
    const simpTol = opt.simplifyTol ?? 1.5;
    const maxNodes = Math.max(2, opt.maxNodes ?? 90);
    const first = coords[0].slice(), last = coords[coords.length - 1].slice();
    const total = Geo.length(coords);
    if (total < 6) return [first, last];

    const ref = first[1];
    const P = coords.map((c) => Geo.xy(c, ref));
    const step = 2;
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const n = Math.max(2, Math.round(cum[cum.length - 1] / step));
    const R = [];
    for (let k = 0, j = 1; k <= n; k++) {
      const t = (k / n) * cum[cum.length - 1];
      while (j < P.length - 1 && cum[j] < t) j++;
      const f = (t - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
      R.push([P[j - 1][0] + (P[j][0] - P[j - 1][0]) * f, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * f]);
    }
    let S = R;
    for (let pass = 0; pass < 2; pass++) {
      S = S.map((p, i) => {
        if (i === 0 || i === S.length - 1) return p;
        const a = Math.max(0, i - 2), b = Math.min(S.length - 1, i + 2);
        let sx = 0, sy = 0, c = 0;
        for (let q = a; q <= b; q++) { sx += S[q][0]; sy += S[q][1]; c++; }
        return [sx / c, sy / c];
      });
    }
    S[0] = P[0]; S[S.length - 1] = P[P.length - 1];
    R[0] = P[0]; R[R.length - 1] = P[P.length - 1];

    const A = S[0], B = S[S.length - 1];
    let maxDev = 0;
    for (const p of S) maxDev = Math.max(maxDev, Geo.nearestOnSeg(p, A, B).d);
    if (maxDev <= straightTol) return [first, last];

    const dp = (tol) => {
      const keep = new Array(S.length).fill(false);
      keep[0] = keep[S.length - 1] = true;
      const st = [[0, S.length - 1]];
      while (st.length) {
        const [s, e] = st.pop();
        let md = 0, ix = -1;
        for (let i = s + 1; i < e; i++) { const d = Geo.nearestOnSeg(S[i], S[s], S[e]).d; if (d > md) { md = d; ix = i; } }
        if (ix !== -1 && md > tol) { keep[ix] = true; st.push([s, ix], [ix, e]); }
      }
      return R.filter((_, i) => keep[i]);
    };
    let tol = Math.max(0.3, simpTol), out = dp(tol);
    for (let g = 0; out.length > maxNodes && g < 40; g++) { tol *= 1.25; out = dp(tol); }
    const res = out.map((p) => Geo.ll(p, ref));
    res[0] = first; res[res.length - 1] = last;
    return res;
  }

  const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

  /* ===== FLOW HELPERS ===== */
  function alongLine(line, pt) {
    const r = Geo.nearestOnLine(pt, line);
    if (!r) return 0;
    let d = 0;
    for (let i = 1; i <= r.index; i++) d += Geo.haversine(line[i - 1], line[i]);
    return d + r.t * Geo.haversine(line[r.index], line[r.index + 1]);
  }
  function matchFlow(joined, ref) {
    const a = alongLine(joined, ref[0]), b = alongLine(joined, ref[ref.length - 1]);
    return b < a ? joined.slice().reverse() : joined;
  }
  function flowChevron(coords) {
    const total = Geo.length(coords);
    if (total < 8) return null;
    const ref = coords[0][1];
    const target = total * 0.5;
    let cum = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = Geo.haversine(coords[i - 1], coords[i]);
      if (cum + seg >= target && seg > 0) {
        const a = Geo.xy(coords[i - 1], ref), b = Geo.xy(coords[i], ref);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
        const f = (target - cum) / seg;
        const tip = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        const L = Math.max(4, Math.min(9, total * 0.15));
        const th = Geo.rad(28);
        const wing = (s) => {
          const bx = -ux, by = -uy;
          return [tip[0] + L * (bx * Math.cos(s * th) - by * Math.sin(s * th)), tip[1] + L * (bx * Math.sin(s * th) + by * Math.cos(s * th))];
        };
        return [Geo.ll(wing(1), ref), Geo.ll(tip, ref), Geo.ll(wing(-1), ref)];
      }
      cum += seg;
    }
    return null;
  }

  function isConnectable(rt) {
    if (NEVER_CONNECT.includes(rt)) return false;
    try { return !!sdk.DataModel.Segments.isRoadTypeDrivable({ roadType: rt }); } catch (e) { return true; }
  }
  const lockOf = (s) => (typeof s.lockRank === 'number' ? s.lockRank : (typeof s.rank === 'number' ? s.rank : 0));
  const lockLabel = (r) => `L${r + 1}`;

  /* ===== JUNCTIONS ===== */
  const Junctions = {
    detect(coords, pool, cutRadius) {
      if (!Settings.get('splitAtJunctions') || !coords || coords.length < 3) return [];
      const cuts = new Set();
      const reach = Math.max(3, cutRadius || Settings.get('detectionRadius') || 20);
      const pts = Geo.densify(coords, 3);
      if (pool && pool.length) {
        for (let i = 1; i < pts.length - 1; i++) {
          const p = pts[i];
          const hit = WazeData.nearest(p, reach, pool);
          if (!hit) continue;
          const t = hit.seg;
          const atFirst = Geo.haversine(hit.point, t.coords[0]) <= 3;
          const atLast = Geo.haversine(hit.point, t.coords[t.coords.length - 1]) <= 3;
          if (atFirst !== atLast) { cuts.add(this._nearestIndex(coords, hit.point)); }
          else if (hit.dist <= 3) { cuts.add(this._nearestIndex(coords, hit.point)); }
        }
      }
      const angles = [];
      for (let i = 1; i < coords.length - 1; i++) {
        const a = coords[i - 1], b = coords[i], c = coords[i + 1];
        const ref = b[1];
        const pa = Geo.xy(a, ref), pb = Geo.xy(b, ref), pc = Geo.xy(c, ref);
        const v1 = [pb[0] - pa[0], pb[1] - pa[1]], v2 = [pc[0] - pb[0], pc[1] - pb[1]];
        const l1 = Math.hypot(v1[0], v1[1]) || 1, l2 = Math.hypot(v2[0], v2[1]) || 1;
        const dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
        angles.push({ i, dev: Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI });
      }
      for (const { i, dev } of angles) {
        if (dev < 70) continue;
        const before = Geo.haversine(coords[Math.max(0, i - 2)], coords[i]);
        const after = Geo.haversine(coords[i], coords[Math.min(coords.length - 1, i + 2)]);
        if (before >= 8 && after >= 8) cuts.add(i);
      }
      return [...cuts].filter((i) => i > 0 && i < coords.length - 1).sort((x, y) => x - y);
    },
    _nearestIndex(coords, pt) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < coords.length; i++) { const d = Geo.haversine(coords[i], pt); if (d < bd) { bd = d; best = i; } }
      return best;
    },
    split(coords, cuts) {
      if (!cuts || !cuts.length) return [{ coords, jStart: false, jEnd: false }];
      const out = [];
      let prev = 0;
      let jStart = false;
      for (const c of [...cuts, coords.length - 1]) {
        const piece = coords.slice(prev, c + 1);
        if (piece.length >= 2) out.push({ coords: piece, jStart, jEnd: false });
        prev = c;
        jStart = true;
      }
      if (out.length) { out.forEach((p, i) => { p.jStart = i > 0; p.jEnd = i < out.length - 1; }); }
      return out.length ? out : [{ coords, jStart: false, jEnd: false }];
    }
  };

  /* ===== CHAIN BOUNDARY / LINKS =====
   * Only boundary detection and neighbour lookup are kept. Compass-based orientation was
   * removed: the SDK defines no preferred A->B direction, so orientation comes solely from
   * adjacent existing segments (boundary constraints) or the traced order. */
  const Chain = {
    boundary(pieces, pool) {
      if (!pieces.length) return [];
      const reach = ORIENT_REACH;
      const out = [];
      const first = pieces[0], last = pieces[pieces.length - 1];
      for (const [which, idx, piece] of [['start', 0, first], ['end', last.coords.length - 1, last]]) {
        const pt = piece.coords[idx];
        const hit = WazeData.nearest(pt, reach, pool);
        if (!hit) continue;
        const t = hit.seg;
        const atFirst = Geo.haversine(hit.point, t.coords[0]) <= 3;
        const atLast = Geo.haversine(hit.point, t.coords[t.coords.length - 1]) <= 3;
        if (atFirst === atLast) continue;
        if (!t.connectable || NEVER_CONNECT.includes(t.roadType)) continue;
        if (lockOf(t) > State.editorRank) continue;
        const oldNode = atFirst ? 'A' : 'B';
        const wantNode = oldNode === 'A' ? 'B' : 'A';
        out.push({ which, segId: t.id, segDir: atFirst ? 'A>B' : 'B>A', oldNode, wantNode, lock: lockOf(t), roadType: t.roadType });
      }
      return out;
    },
    // Which existing segment wins when two ends disagree: higher lock first, then higher road type.
    strength(c) { return (c.lock || 0) * 100 + (c.roadType || 0); },

    // Decide whether a candidate should be reversed so its ends meet the adjacent existing segments
    // cleanly (A|B seams). Both orientations are scored by how many boundary constraints they satisfy;
    // on a tie the orientation that honours the STRONGER existing segment wins. No compass rule:
    // orientation comes only from adjacent segments or the traced order.
    solve(coords, pool) {
      const cons = this.boundary([{ coords }], pool);
      if (!cons.length) return { flipped: false, cons, breaks: {} };
      const evaluate = (flipped) => {
        let n = 0, weight = 0;
        const breaks = {};
        for (const c of cons) {
          const present = c.which === 'start' ? (flipped ? 'B' : 'A') : (flipped ? 'A' : 'B');
          if (present === c.wantNode) { n++; weight += this.strength(c); } else breaks[c.which] = c;
        }
        return { n, weight, breaks };
      };
      const normal = evaluate(false), flip = evaluate(true);
      const useFlip = flip.n > normal.n || (flip.n === normal.n && flip.weight > normal.weight);
      return { flipped: useFlip, cons, breaks: (useFlip ? flip : normal).breaks };
    },

    links(cand) {
      const reach = 3;
      const out = [];
      const ends = [cand.coords[0], cand.coords[cand.coords.length - 1]];
      for (const other of State.candidates.values()) {
        if (other === cand || other.status !== 'Candidate') continue;
        const oe = [other.coords[0], other.coords[other.coords.length - 1]];
        const linked = ends.some((a) => oe.some((b) => Geo.haversine(a, b) <= reach));
        if (linked) out.push(other);
      }
      return out;
    }
  };

  /* ===== SETTINGS ===== */
  const Settings = {
    data: { ...DEFAULT_SETTINGS },
    load() {
      try {
        const saved = JSON.parse(localStorage.getItem('wme-svra-settings') || '{}');
        Object.assign(this.data, saved);
        if (saved.settingsRev !== DEFAULT_SETTINGS.settingsRev) {
          ['minScanZoom', 'focusZoom', 'maxDraftCreationBatch', 'convertDelayMs', 'splitAtJunctions', 'maxPendingEdits', 'settingsRev']
            .forEach((k) => { this.data[k] = DEFAULT_SETTINGS[k]; });
        }
        if (this.data.roadPreset === 'service') this.data.roadPreset = 'street';
        ['traceProfile', 'smoothStraightenTol', 'smoothSimplifyTol', 'smoothMaxNodes']
          .forEach((k) => { delete this.data[k]; });
        // Respect the acknowledgement cooldown: if the last ack was more than
        // RESPONSIBILITY_COOLDOWN_MS ago, forget it so the user is asked again.
        if (saved.responsibilityAcknowledged === true) {
          const ackedAt = saved.responsibilityAcknowledgedAt || 0;
          const age = Date.now() - ackedAt;
          if (ackedAt === 0 || age < RESPONSIBILITY_COOLDOWN_MS) {
            this.data.responsibilityAcknowledged = true;
            this.data.responsibilityAcknowledgedAt = ackedAt;
          } else {
            this.data.responsibilityAcknowledged = false;
            this.data.responsibilityAcknowledgedAt = 0;
          }
        }
        this.save();
      } catch (e) { /* keep defaults */ }
    },
    save() { try { localStorage.setItem('wme-svra-settings', JSON.stringify(this.data)); } catch (e) {} },
    get(k) { return this.data[k]; },
    set(k, v) { this.data[k] = v; this.save(); },
    roadTypeFor(key) {
      const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
      const types = safe('getRoadTypes', () => sdk.DataModel.Segments.getRoadTypes(), []) || [];
      if (types.length && !types.some((t) => t.id === preset.roadType)) {
        Log.w(`roadTypeFor: road type ${preset.roadType} (${preset.label}) not in getRoadTypes() — falling back to Street. SDK shape may have changed.`);
        return 1;
      }
      return preset.roadType;
    }
  };
  /* ===== STATE ===== */
  const State = {
    candidates: new Map(),
    generated: new Map(),
    counters: { C: 0, S: 0, seq: 0 },
    trash: [],
    scanning: false,
    editorRank: 0
  };
  const nextId = (p) => `${p}-${String(++State.counters[p]).padStart(3, '0')}`;

  /* ===== SEGMENT CACHE ===== */
  const SEG_CACHE = new Map();
  const SEG_CACHE_MAX = 200;

  /* ===== WAZE DATA ===== */
  const WazeData = {
    cache: null,
    cacheAt: 0,
    refreshing: null,
    CACHE_TTL_MS: 2 * 60 * 1000,

    all() { return this.cache || []; },
    invalidate() { this.cache = null; this.cacheAt = 0; SEG_CACHE.clear(); },
    stale(ttlMs = 1500) { return !this.cache || (Date.now() - this.cacheAt) >= ttlMs; },

    async refresh(force = false) {
      // Only reuse a NON-EMPTY cache. An empty result (WME not loaded yet) must never be cached.
      if (!force && this.cache && this.cache.length && (Date.now() - this.cacheAt) < this.CACHE_TTL_MS) return;
      if (this.refreshing) return this.refreshing;
      this.refreshing = (async () => {
        try {
          await null;
          let segs = sdk.DataModel.Segments.getAll();
          if (isPromise(segs)) segs = await segs;
          const ownDraftIds = new Set();
          State.generated.forEach((g) => {
            if (!g.saved && g.allIds && g.allIds.length) g.allIds.forEach((id) => ownDraftIds.add(id));
          });
          this.cache = (segs || [])
            .filter((s) => s && s.geometry && s.geometry.coordinates && s.geometry.coordinates.length > 1 && !ownDraftIds.has(s.id))
            .map((s) => ({
              id: s.id,
              roadType: s.roadType,
              lockRank: (typeof s.lockRank === 'number' ? s.lockRank : (typeof s.rank === 'number' ? s.rank : 0)),
              connectable: isConnectable(s.roadType),
              isBtoA: !!s.isBtoA,
              coords: s.geometry.coordinates,
              bbox: Geo.bbox(s.geometry.coordinates)
            }));
          this.cacheAt = Date.now();
        } catch (err) {
          Log.e('WazeData.refresh failed', err);
        } finally {
          this.refreshing = null;
        }
      })();
      return this.refreshing;
    },
    inBox(box) { return this.all().filter((s) => Geo.bboxOverlap(s.bbox, box)); },

    nearest(coord, maxM, pool) {
      const box = Geo.bboxPad([coord[0], coord[1], coord[0], coord[1]], maxM);
      let best = null;
      for (const s of pool || this.inBox(box)) {
        if (!Geo.bboxOverlap(s.bbox, box)) continue;
        const r = Geo.nearestOnLine(coord, s.coords);
        if (r && r.dist <= maxM && (!best || r.dist < best.dist)) best = { seg: s, dist: r.dist, point: r.point, index: r.index };
      }
      return best;
    }
  };

  /* ===== MAP HELPERS ===== */
  const MapUtil = {
    async extent() {
      let e = sdk.Map.getMapExtent();
      if (isPromise(e)) e = await e;
      let a = Array.isArray(e) ? e : [e.left ?? e.west ?? e.minX, e.bottom ?? e.south ?? e.minY, e.right ?? e.east ?? e.maxX, e.top ?? e.north ?? e.maxY];
      if (a[0] > a[2]) a = [a[2], a[1], a[0], a[3]];
      if (a[1] > a[3]) a = [a[0], a[3], a[2], a[1]];
      return a;
    },
    viewportEl() { return safe('getMapViewportElement', () => sdk.Map.getMapViewportElement()) || document.querySelector('#WazeMap, .olMap'); },
    async centerNow() {
      try {
        let c = sdk.Map.getMapCenter();
        if (isPromise(c)) c = await c;
        return c && typeof c.lon === 'number' && typeof c.lat === 'number' ? c : null;
      } catch (err) { Log.w('getMapCenter failed', err); return null; }
    },
    async zoom() {
      try { let z = sdk.Map.getZoomLevel(); if (isPromise(z)) z = await z; return typeof z === 'number' ? z : null; }
      catch (err) { Log.w('getZoomLevel failed', err); return null; }
    },
    async focus(coord, zoomLevel) {
      const z = zoomLevel ?? Settings.get('focusZoom');
      try { await sdk.Map.setMapCenter({ lonLat: { lon: coord[0], lat: coord[1] }, zoomLevel: z }); return; }
      catch (err) { Log.w('setMapCenter with zoomLevel failed, trying separately', err); }
      await this.center(coord);
      try { await sdk.Map.setZoomLevel({ zoomLevel: z }); } catch (err) { Log.w('setZoomLevel failed', err); }
    },
    async center(coord) {
      try { await sdk.Map.setMapCenter({ lonLat: { lon: coord[0], lat: coord[1] } }); }
      catch (err) { Log.e('setMapCenter failed', err); }
    }
  };

  /* ===== COVERAGE LAYER ===== */
  const Coverage = {
    visible: false, created: false, manual: false,
    init() {
      try {
        sdk.Map.addTileLayer({
          layerName: LAYER_COVERAGE,
          layerOptions: { tileHeight: 256, tileWidth: 256, url: { fileName: TILE_FILE, servers: TILE_SERVERS } }
        });
        this.created = true;
      } catch (err) { Log.e('coverage tile layer', err); }
      safe('coverage checkbox', () => sdk.LayerSwitcher.addLayerCheckbox({ isChecked: false, name: LAYER_COVERAGE }));
      this.setVisible(false);
    },
    setVisible(v) {
      this.visible = v;
      if (this.created) safe('cov vis', () => sdk.Map.setLayerVisibility({ layerName: LAYER_COVERAGE, visibility: v }));
      safe('cov cb', () => sdk.LayerSwitcher.setLayerCheckboxChecked({ isChecked: v, name: LAYER_COVERAGE }));
    },
    toggle() { this.manual = !this.visible; this.setVisible(!this.visible); },
    watchStreetView() {
      const show = () => { if (Settings.get('autoCoverage')) this.setVisible(true); };
      const hide = () => {
        if (!Settings.get('autoCoverage') || this.manual) return;
        if (safe('svActive', () => (sdk.StreetView && typeof sdk.StreetView.isActive === 'function' ? sdk.StreetView.isActive() : sdk.Map.isStreetViewActive()), false)) return;
        this.setVisible(false);
      };
      safe('sv-activated', () => sdk.Events.on({ eventName: 'wme-street-view-button-activated', eventHandler: show }));
      safe('sv-deactivated', () => sdk.Events.on({ eventName: 'wme-street-view-button-deactivated', eventHandler: hide }));
      safe('sv-visibility', () => sdk.Events.on({ eventName: 'wme-street-view-panel-visibility-changed', eventHandler: (a) => (a.isVisible ? show() : hide()) }));
    }
  };

  /* ===== CELL / PATH EXTRACTION ===== */
  const CELL_KEY = 16777216;
  const cellKey = (gx, gy) => gx * CELL_KEY + gy;
  const cellXY = (k) => { const gy = k % CELL_KEY; return [(k - gy) / CELL_KEY, gy]; };
  function bfs(start, set) {
    const parent = new Map([[start, null]]);
    const dist = new Map([[start, 0]]);
    const queue = [start];
    let far = start;
    for (let h = 0; h < queue.length; h++) {
      const k = queue[h];
      const [gx, gy] = cellXY(k);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nk = cellKey(gx + dx, gy + dy);
        if (!set.has(nk) || parent.has(nk)) continue;
        parent.set(nk, k); dist.set(nk, dist.get(k) + 1); queue.push(nk);
        if (dist.get(nk) > dist.get(far)) far = nk;
      }
    }
    return { far, parent };
  }

  function components(set) {
    const seen = new Set(), out = [];
    for (const k of set) {
      if (seen.has(k)) continue;
      const comp = new Set();
      const stack = [k]; seen.add(k);
      while (stack.length) {
        const c = stack.pop(); comp.add(c);
        const [gx, gy] = cellXY(c);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nk = cellKey(gx + dx, gy + dy);
          if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
      out.push(comp);
    }
    return out;
  }

  function extractPaths(cells, minCells) {
    const paths = [];
    const queue = components(cells).filter((c) => c.size >= minCells);
    let guard = 0;
    while (queue.length && guard++ < 2000) {
      const comp = queue.pop();
      const a = bfs(comp.values().next().value, comp).far;
      const { far: b, parent } = bfs(a, comp);
      const path = [];
      for (let k = b; k !== null && k !== undefined; k = parent.get(k)) path.push(k);
      if (path.length >= minCells) paths.push(path);
      const rest = new Set(comp);
      for (const k of path) {
        const [gx, gy] = cellXY(k);
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) rest.delete(cellKey(gx + dx, gy + dy));
      }
      components(rest).filter((c) => c.size >= minCells).forEach((c) => queue.push(c));
    }
    return paths;
  }

  /* ===== CANDIDATES ===== */
  const Candidates = {
    _canvas: null, _ctx: null,
    _getCanvas() {
      if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._canvas.width = this._canvas.height = 256;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      }
      return this._ctx;
    },

    async sampleCoverage(plan) {
      const { zoom: SAMPLE_ZOOM, x0, x1, y0, y1 } = plan;
      const CPT = 256 / CELL_PX;
      this._origin = [x0 * CPT - 16, y0 * CPT - 16];
      Log.i(`scan plan: z${SAMPLE_ZOOM}, ${plan.tiles} tiles (budget ${plan.maxTiles})${plan.shrunk ? ', centre area only' : ''}`);
      if (plan.shrunk) UI.notify('Viewport large: scanning the framed centre area only.', 'info');

      showScanFrame(plan.extent, { x0, x1, y0, y1, zoom: SAMPLE_ZOOM }, 'scanFrame');
      const cells = new Set();
      const ctx = this._getCanvas();
      let ok = 0, attempted = 0, firstFail = null;
      const queue = [];
      for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) queue.push([tx, ty]);
      const tStart = performance.now();
      const last = CELL_PX - 1;

      const worker = async () => {
        while (queue.length) {
          const [tx, ty] = queue.pop();
          attempted++;
          let bmp;
          try {
            bmp = await fetchTileCached(tx, ty, SAMPLE_ZOOM);
          } catch (err) {
            if (!firstFail) firstFail = `tile ${tx},${ty},${SAMPLE_ZOOM}: ${err.message}`;
            Log.w('tile FAIL', tx, ty, SAMPLE_ZOOM, err.message);
            continue;
          }
          let data;
          try {
            ctx.clearRect(0, 0, 256, 256);
            ctx.drawImage(bmp, 0, 0);
            data = ctx.getImageData(0, 0, 256, 256).data;
          } catch (err) {
            TILE_CACHE.delete(`${SAMPLE_ZOOM}/${tx}/${ty}`);
            if (err && err.name === 'SecurityError') throw new Error('Canvas tainted (CORS). Coverage cannot be sampled.');
            continue;
          }
          ok++;
          for (let cy = 0; cy < CPT; cy++) {
            const baseY = cy * CELL_PX;
            for (let cx = 0; cx < CPT; cx++) {
              const baseX = cx * CELL_PX;
              if (data[(baseY * 256 + baseX) * 4 + 3] > 40 || data[((baseY + last) * 256 + baseX + last) * 4 + 3] > 40) {
                cells.add(cellKey(tx * CPT + cx - this._origin[0], ty * CPT + cy - this._origin[1]));
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: TILE_CONCURRENCY }, worker));
      this._scanTiming = { fetchMs: Math.round(performance.now() - tStart), tiles: ok };
      if (!ok) {
        throw new Error(
          `No coverage tiles loaded. Attempted ${attempted} tiles at z${SAMPLE_ZOOM} ` +
          `(x ${x0}-${x1}, y ${y0}-${y1}). First failure: ${firstFail || 'none reported'}`
        );
      }
      Log.i(`tiles loaded: ${ok}/${attempted}`);
      return cells;
    },

    async scan() {
      if (State.scanning) return 0;
      if (Generated.busy || Generated._waiting) {
        UI.notify('A conversion batch is running. Let it finish (or stop it) before scanning again.', 'warn');
        return 0;
      }
      State.scanning = true; UI.setBusy(true, 'Scanning viewport...');
      const t0 = performance.now();
      try {
        await WazeData.refresh(true);
        let zoom = await MapUtil.zoom();
        if (zoom !== null && zoom < Settings.get('minScanZoom')) {
          const need = Settings.get('minScanZoom');
          const ext0 = await MapUtil.extent();
          const cx = (ext0[0] + ext0[2]) / 2, cy = (ext0[1] + ext0[3]) / 2;
          Log.i(`auto-zoom from ${zoom} to ${need} to bring every street into view`);
          // WME loads the editable segments only at zoom 16+, and sends its "map data loaded" event a few
          // seconds after the zoom. Wait for that event (not just a fixed delay) before reading the roads.
          UI.setBusy(true, 'Zooming in and waiting for WME to load the roads...');
          const loadedAfterZoom = MapLoad.wait({ timeoutMs: 8000, quietMs: 900 });
          await MapUtil.focus([cx, cy], need);
          if (!(await loadedAfterZoom)) Log.d('no map-data event after the auto-zoom; checking the road count instead');
          await WazeData.refresh(true);
          zoom = await MapUtil.zoom();
          if (zoom !== null && zoom < need) {
            throw new Error(`Still at zoom ${zoom} (needed ${need}); WME refused to zoom. Zoom in manually and Scan again.`);
          }
        }
        // Roads for the new view may still be arriving (after an auto-zoom or a recent pan). Scanning now
        // would miss them and propose candidates on roads that are already mapped.
        UI.setBusy(true, 'Waiting for WME to finish loading the roads...');
        {
          // Ready = the road count in view has not changed over two checks and no map-data event arrived
          // for 0.9 s.
          let prevN = -1, stable = 0;
          const giveUp = Date.now() + 8000;
          while (Date.now() < giveUp) {
            await WazeData.refresh(true);
            const n = WazeData.inBox(await MapUtil.extent()).length;
            const quiet = Date.now() - MapLoad.lastAt >= 900;
            // An empty view must stay empty much longer (about 3 s): at zoom 16 WME can take a while to
            // deliver the first segments, and accepting "0 roads" too early is how candidates end up on mapped roads.
            const need = (n === 0 && WazeData.all().length === 0) ? 6 : 2;
            if (n === prevN && quiet) { if (++stable >= need) break; } else stable = 0;
            prevN = n;
            await sleep(500);
          }
          if (Date.now() >= giveUp) Log.w('road data was still changing after 8 s; scanning with what is loaded');
        }
        let extent = await MapUtil.extent();
        if (!WazeData.all().length) { await sleep(700); await WazeData.refresh(true); }
        const inView = WazeData.inBox(extent).length;
        Log.i(`scan: ${WazeData.all().length} roads known to the script, ${inView} in view`);
        if (State.candidates.size) Candidates.pruneMapped();

        const detection = Settings.get('detectionRadius');
        const plan = planScan(extent);
        const cells = await this.sampleCoverage(plan);
        extent = plan.extent;
        const SAMPLE_ZOOM = plan.zoom;
        const wazeSegs = WazeData.inBox(Geo.bboxPad(extent, detection + 50));
        const cellCenter = (k) => {
          const [gx, gy] = cellXY(k);
          return Geo.pixelToLonLat((gx + this._origin[0] + 0.5) * CELL_PX, (gy + this._origin[1] + 0.5) * CELL_PX, SAMPLE_ZOOM);
        };
        const midLat = (extent[1] + extent[3]) / 2;
        const index = wazeSegs.length ? buildRoadIndex(wazeSegs, [(extent[0] + extent[2]) / 2, midLat], Math.max(detection, 10)) : null;
        const free = new Set();

        const candSegs = [];
        for (const c of State.candidates.values()) {
          if (c.status === 'Candidate' || c.status === 'Drafted') {
            for (let i = 1; i < c.coords.length; i++) candSegs.push([c.coords[i - 1], c.coords[i]]);
          }
        }
        const candIndex = candSegs.length ? buildRoadIndex(candSegs.map((e) => ({ coords: e })), [(extent[0] + extent[2]) / 2, midLat], Math.max(detection, 25)) : null;

        for (const k of cells) {
          const c = cellCenter(k);
          if (c[0] < extent[0] || c[0] > extent[2] || c[1] < extent[1] || c[1] > extent[3]) continue;
          if (index && index.near(c[0], c[1], detection)) continue;
          if (candIndex && candIndex.near(c[0], c[1], Math.max(detection, 25))) continue;
          free.add(k);
        }
        const cellM = (CELL_PX * 156543.03392 * Math.cos(Geo.rad(midLat))) / 2 ** SAMPLE_ZOOM;
        const minCells = Math.max(4, Math.ceil(Settings.get('minCandidateLength') / cellM));
        const paths = extractPaths(free, minCells);
        const stats = { added: 0, merged: 0, duplicate: 0, full: 0, split: 0 };
        for (const path of paths) {
          const coords = Geo.simplify(path.map(cellCenter), 1);
          if (coords.length < 2 || Geo.length(coords) < Settings.get('minCandidateLength')) continue;
          this.absorb(coords, stats, wazeSegs);
        }
        const t = this._scanTiming || {};
        Log.i(`scan timings: total ${Math.round(performance.now() - t0)} ms, fetch+decode ${t.fetchMs ?? '?'} ms for ${t.tiles ?? '?'} tiles, ` +
              `candidates: ${stats.added} new / ${stats.merged} merged / ${stats.split} split / ${stats.duplicate} dup`);
        UI.notify(`Scan: +${stats.added} new, ${stats.merged} continued, ${stats.split} split at junctions, ${stats.duplicate} dup${stats.full ? `, ${stats.full} storage full` : ''}. Candidates: ${this.liveCount()}.${inView ? '' : ' (No mapped roads in view.)'}`,
          stats.added || stats.merged ? 'ok' : 'info');
        UI.changed();
        return stats.added + stats.merged;
      } catch (err) {
        Log.e('scan', err);
        UI.notify(`Scan failed: ${err.message}`, 'err');
        return 0;
      } finally {
        State.scanning = false;
        UI.setBusy(false);
        clearScanFrame();
        try { CandidateLayer.refresh(); } catch (e) { Log.e('cand layer refresh', e); }
        UI.changed();
        UI.updateGuide();
      }
    },

    liveCount() { return [...State.candidates.values()].filter((c) => c.status === 'Candidate').length; },

    splitByProtection(coords) {
      const buf = Settings.get('highLockBuffer');
      const search = buf + 10;
      const pool = WazeData.inBox(Geo.bboxPad(Geo.bbox(coords), search));
      if (!pool.length) return [{ coords, review: null, origStart: null, origEnd: null }];
      const pts = Geo.densify(coords, 3);
      const keep = [];
      let review = null;
      for (const p of pts) {
        let blocked = false;
        for (const s of pool) {
          const isHigh = s.lockRank > State.editorRank;
          const isProt = NEVER_CONNECT.includes(s.roadType);
          if (!isHigh && !isProt) continue;
          const r = Geo.nearestOnLine(p, s.coords);
          if (!r) continue;
          if (r.dist <= search) {
            blocked = true;
            if (!review) review = isProt ? `near ${roadTypeName(s.roadType)} #${s.id}` : `near ${lockLabel(s.lockRank)} #${s.id}`;
            break;
          }
        }
        keep.push({ p, blocked });
      }
      const bufferCells = Math.ceil(buf / 3);
      keep.forEach((k, i) => {
        if (!k.blocked) return;
        for (let j = Math.max(0, i - bufferCells); j <= Math.min(keep.length - 1, i + bufferCells); j++) keep[j].blocked = true;
      });

      const runs = [];
      let cur = [];
      let gapBefore = null;
      for (let i = 0; i < keep.length; i++) {
        const k = keep[i];
        if (k.blocked) {
          if (cur.length >= 2) {
            runs.push({ coords: Geo.simplify(cur.map((x) => x.p), 1), review, origStart: gapBefore, origEnd: k.p });
          }
          cur = [];
          gapBefore = k.p;
        } else cur.push(k);
      }
      if (cur.length >= 2) runs.push({ coords: Geo.simplify(cur.map((x) => x.p), 1), review, origStart: gapBefore, origEnd: null });
      return runs.length ? runs : [{ coords, review, origStart: null, origEnd: null }];
    },

    absorb(coords, stats, wazeSegs) {
      const COVER = 8;
      const pts = Geo.densify(coords, 3);
      const candSegs = [];
      for (const c of State.candidates.values()) {
        if (c.status !== 'Candidate' && c.status !== 'Drafted') continue;
        const cc = c.coords;
        for (let i = 1; i < cc.length; i++) candSegs.push([cc[i - 1], cc[i]]);
      }
      const CELL = COVER;
      const grid = new Map();
      for (const [a, b] of candSegs) {
        const ref = a[1];
        const ax = a[0] * 111320 * Math.cos(Geo.rad(ref)), ay = a[1] * 110540;
        const bx = b[0] * 111320 * Math.cos(Geo.rad(ref)), by = b[1] * 110540;
        const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
        const j0 = Math.floor(Math.min(ay, by) / CELL), j1 = Math.floor(Math.max(ay, by) / CELL);
        for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
          const k = `${gi},${gj}`;
          let a2 = grid.get(k); if (!a2) { a2 = []; grid.set(k, a2); }
          a2.push([ax, ay, bx, by]);
        }
      }
      const covered = pts.map((p) => {
        const ref = p[1];
        const px = p[0] * 111320 * Math.cos(Geo.rad(ref)), py = p[1] * 110540;
        const gi = Math.floor(px / CELL), gj = Math.floor(py / CELL);
        const r2 = COVER * COVER;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const a = grid.get(`${gi + di},${gj + dj}`);
          if (!a) continue;
          for (const [ax, ay, bx, by] of a) {
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - px, ey = ay + t * dy - py;
            if (ex * ex + ey * ey <= r2) return true;
          }
        }
        return false;
      });
      if (covered.every(Boolean)) { stats.duplicate++; return; }

      const pool = wazeSegs && wazeSegs.length ? wazeSegs : WazeData.inBox(Geo.bboxPad(Geo.bbox(coords), Settings.get('detectionRadius') + 30));
      const cuts = Junctions.detect(coords, pool, Settings.get('detectionRadius'));
      const pieces = Junctions.split(coords, cuts);

      if (pieces.length > 1) stats.split += pieces.length - 1;

      let anyPlaced = false;
      for (const piece of pieces) {
        const sub = this._uncoveredRuns(piece.coords, covered, pts, coords, stats, piece);
        for (const run of sub) {
          const isProtected = this.splitByProtection(run.coords);
          for (let ri = 0; ri < isProtected.length; ri++) {
            const r = isProtected[ri];
            const isFirst = ri === 0;
            const isLast = ri === isProtected.length - 1;
            const junctionInfo = {
              jStart: isFirst && !!run.jStart,
              jEnd: isLast && !!run.jEnd
            };
            const ok = this.place(r.coords, r.review, stats, r.origStart, r.origEnd, junctionInfo);
            if (ok) anyPlaced = true;
          }
        }
      }
    },

    _uncoveredRuns(pieceCoords, coveredPts, allPts, allCoords, stats, pieceJ) {
      const piecePts = Geo.densify(pieceCoords, 3);
      const KEY = 1e5;
      const cell = (lon, lat) => `${Math.round(lon * KEY)},${Math.round(lat * KEY)}`;
      const covMap = new Map();
      for (let i = 0; i < allPts.length; i++) {
        const k = cell(allPts[i][0], allPts[i][1]);
        if (!covMap.has(k)) covMap.set(k, coveredPts[i]);
      }
      const lookup = (p) => {
        const lon0 = Math.round(p[0] * KEY), lat0 = Math.round(p[1] * KEY);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const v = covMap.get(`${lon0 + dx},${lat0 + dy}`);
          if (v !== undefined) return v;
        }
        return false;
      };
      const isCov = piecePts.map(lookup);
      const minLen = Settings.get('minCandidateLength');
      const out = [];
      let i = 0;
      while (i < piecePts.length) {
        if (isCov[i]) { i++; continue; }
        let j = i;
        while (j + 1 < piecePts.length && !isCov[j + 1]) j++;
        const slice = piecePts.slice(Math.max(0, i - 1), Math.min(piecePts.length - 1, j + 1) + 1);
        const simp = Geo.simplify(slice, 1);
        if (Geo.length(simp) >= minLen) {
          out.push({
            coords: simp,
            jStart: i === 0 && !!(pieceJ && pieceJ.jStart),
            jEnd: j === piecePts.length - 1 && !!(pieceJ && pieceJ.jEnd)
          });
        }
        i = j + 1;
      }
      return out;
    },

    place(piece, review, stats, origStart, origEnd, junctionInfo) {
      if (!piece || piece.length < 2) return false;
      if (Geo.length(piece) < Settings.get('minCandidateLength')) return false;

      const live = [...State.candidates.values()].filter((c) => c.status === 'Candidate');
      for (const c of live) {
        const cJ = { jStart: !!c.jStart, jEnd: !!c.jEnd };
        const pJ = { jStart: !!(junctionInfo && junctionInfo.jStart), jEnd: !!(junctionInfo && junctionInfo.jEnd) };
        const joined = this.tryJoinJunctionAware(piece, c.coords, 15, pJ, cJ);
        if (joined) {
          c.coords = matchFlow(joined, c.coords);
          c.length = Geo.length(c.coords);
          if (review) c.review = review;
          if (origStart) c.origStart = origStart;
          if (origEnd) c.origEnd = origEnd;
          // Merge-time flag update: take the OR of the two sides at each end. The join
          // helper already refuses to join across junction ends, so no junction can become
          // interior to the merged line.
          const pJm = junctionInfo || {};
          c.jStart = !!(c.jStart || pJm.jStart);
          c.jEnd = !!(c.jEnd || pJm.jEnd);
          // Re-stamp seams from boundary constraints against the new geometry.
          this.restampSeams(c);
          stats.merged++;
          return true;
        }
      }
      if (this.liveCount() >= Settings.get('maxCandidatesStorage')) { stats.full++; return false; }

      let coords = piece, os = origStart || null, oe = origEnd || null;
      let reversed = false;
      const reverse = () => { coords = coords.slice().reverse(); const t = os; os = oe; oe = t; reversed = !reversed; };

      // Boundary orientation: Chain.solve scores both orientations against the adjacent existing
      // segments (stronger segment wins a tie). No compass rule (SDK has none).
      const pool = WazeData.inBox(Geo.bboxPad(Geo.bbox(coords), ORIENT_REACH + 20));
      if (Chain.solve(coords, pool).flipped) reverse();

      Log.d(`candidate placed: ${reversed ? 'reversed' : 'as-traced'}, ${coords.length} nodes, ${Math.round(Geo.length(coords))} m`);
      const id = nextId('C');
      const c = {
        id, coords, length: Geo.length(coords),
        selected: false, status: 'Candidate', connected: false,
        review: review || null,
        origStart: os,
        origEnd: oe,
        oneWay: false,
        flowLocked: false,
        jStart: !!(junctionInfo && junctionInfo.jStart),
        jEnd: !!(junctionInfo && junctionInfo.jEnd),
        seamStart: { state: 'clean' },
        seamEnd: { state: 'clean' }
      };
      this.restampSeams(c, pool);
      State.candidates.set(id, c);
      stats.added++;
      return true;
    },
    // Recompute the seam badges of a candidate from the existing segments next to its two ends.
    restampSeams(c, pool) {
      const p = pool || WazeData.inBox(Geo.bboxPad(Geo.bbox(c.coords), ORIENT_REACH + 20));
      c.seamStart = { state: 'clean' };
      c.seamEnd = { state: 'clean' };
      for (const b of Chain.boundary([c], p)) {
        const terminalIsStart = b.which === 'start';
        const point = terminalIsStart ? c.coords[0] : c.coords[c.coords.length - 1];
        if (!this._nodeAt(c.coords, point, b.wantNode)) {
          const seam = { state: 'break-old-locked', segId: b.segId, segDir: b.segDir };
          if (terminalIsStart) c.seamStart = seam; else c.seamEnd = seam;
        }
      }
    },
    _nodeAt(coords, point, wantNode) {
      const dFirst = Geo.haversine(point, coords[0]);
      const dLast = Geo.haversine(point, coords[coords.length - 1]);
      const present = dFirst <= dLast ? 'A' : 'B';
      return present === wantNode;
    },


    tryJoinJunctionAware(a, b, m, pJ, cJ) {
      const ea = [a[0], a[a.length - 1]], eb = [b[0], b[b.length - 1]];
      const flagsA = [pJ.jStart, pJ.jEnd];
      const flagsB = [cJ.jStart, cJ.jEnd];
      let best = null;
      for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) {
        if (flagsA[i] || flagsB[k]) continue;
        const d = Geo.haversine(ea[i], eb[k]);
        if (d <= m && (!best || d < best.d)) best = { d, i, k };
      }
      if (!best) return null;
      const A = best.i === 1 ? a : a.slice().reverse();
      const B = best.k === 0 ? b : b.slice().reverse();
      return Geo.simplify([...A, ...(best.d < 1 ? B.slice(1) : B)], 1);
    },

    pruneMapped() {
      const det = Settings.get('detectionRadius');
      let n = 0;
      [...State.candidates.values()].forEach((c) => {
        if (c.status !== 'Candidate') return;
        const segs = WazeData.inBox(Geo.bboxPad(Geo.bbox(c.coords), det));
        if (!segs.length) return;
        const pts = Geo.densify(c.coords, 6);
        if (pts.filter((p) => WazeData.nearest(p, det, segs)).length / pts.length >= 0.7) { State.candidates.delete(c.id); n++; return; }
        const fine = Geo.densify(c.coords, 3);
        const on = fine.map((p) => !!WazeData.nearest(p, 3, segs));
        if (!on.some(Boolean)) return;
        const minLen = Settings.get('minCandidateLength');
        const runs = [];
        let cur = [];
        fine.forEach((p, i) => { if (on[i]) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(p); });
        if (cur.length > 1) runs.push(cur);
        const keep = runs.map((r) => Geo.simplify(r, 1)).filter((r) => Geo.length(r) >= minLen);
        n++;
        if (!keep.length) { State.candidates.delete(c.id); return; }
        c.coords = keep[0]; c.length = Geo.length(keep[0]); c.origStart = c.origEnd = null;
        keep.slice(1).forEach((r) => {
          const id = nextId('C');
          State.candidates.set(id, { ...c, id, coords: r, length: Geo.length(r), selected: false, jStart: false, jEnd: false, seamStart: { state: 'clean' }, seamEnd: { state: 'clean' } });
        });
      });
      return n;
    },

    selected() { return [...State.candidates.values()].filter((c) => c.selected && c.status === 'Candidate'); },
    selectAll(on) { State.candidates.forEach((c) => { if (c.status === 'Candidate') c.selected = !!on; }); },

    flip(c, visited) {
      visited = visited || new Set();
      if (visited.has(c.id)) return;
      visited.add(c.id);
      c.coords = c.coords.slice().reverse();
      const t = c.origStart; c.origStart = c.origEnd; c.origEnd = t;
      // The junction dot belongs to the physical end, so it moves to the other column with A/B.
      const jt = c.jStart; c.jStart = !!c.jEnd; c.jEnd = !!jt;
      c.flowLocked = true;
      // Seam badges depend on which end is A, so recompute them against the existing segments.
      try { this.restampSeams(c); } catch (e) { Log.w('restamp after flip failed', e); }

      const links = Chain.links(c);
      for (const nb of links) {
        if (nb.flowLocked) continue;
        if (visited.has(nb.id)) continue;
        // Propagate ONLY across seams that are junctions on BOTH sides.
        const near = (a, b) => Geo.haversine(a, b) <= 3;
        const cEnds = [
          { pt: c.coords[0],                     j: !!c.jStart },
          { pt: c.coords[c.coords.length - 1],   j: !!c.jEnd   }
        ];
        const nbEnds = [
          { pt: nb.coords[0],                    j: !!nb.jStart },
          { pt: nb.coords[nb.coords.length - 1], j: !!nb.jEnd   }
        ];
        const junctionSeam = cEnds.some((ce) =>
          ce.j && nbEnds.some((ne) => ne.j && near(ce.pt, ne.pt))
        );
        if (junctionSeam) this.flip(nb, visited);
      }
    },
    toggleOneWay(c) { c.oneWay = !c.oneWay; },

    removeSelected() {
      const list = this.selected();
      list.forEach((c) => { UI.trashCandidate(Generated.candSnapshot(c)); State.candidates.delete(c.id); });
      return list.length;
    },
    clear() { State.candidates.clear(); }
  };

  /* ===== MAP-LOAD WAITER ===== */
  const MapLoad = {
    waiters: new Set(),
    lastAt: 0,
    // Resolves once WME has sent no map-data event for quietMs (or after maxMs). Used so a scan or a
    // convert does not read the road data while WME is still loading it after a zoom or pan.
    async settle(quietMs = 900, maxMs = 8000) {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        if (Date.now() - this.lastAt >= quietMs) return true;
        await sleep(150);
      }
      return false;
    },
    notify() { this.lastAt = Date.now(); this.waiters.forEach((w) => w()); },
    wait({ timeoutMs = 10000, quietMs = 600 } = {}) {
      return new Promise((resolve) => {
        let quiet = null, hard = null, done = false;
        const finish = (v) => {
          if (done) return;
          done = true; clearTimeout(quiet); clearTimeout(hard);
          this.waiters.delete(onEvt); resolve(v);
        };
        const onEvt = () => { clearTimeout(quiet); quiet = setTimeout(() => finish(true), quietMs); };
        hard = setTimeout(() => finish(false), timeoutMs);
        this.waiters.add(onEvt);
      });
    }
  };

  /* ===== GENERATED SEGMENTS ===== */
  async function getSeg(id) {
    // Always read fresh: undo checks must see a deleted segment as gone, not a cached object.
    try { let s = sdk.DataModel.Segments.getById({ segmentId: id }); if (isPromise(s)) s = await s; return s || null; }
    catch (e) { return null; }
  }
  async function editCount() {
    try { let n = sdk.Editing.getUnsavedChangesCount(); if (isPromise(n)) n = await n; return typeof n === 'number' ? n : null; }
    catch (e) { return null; }
  }

  async function editingDraft() {
    try {
      let sel = sdk.Editing.getSelection(); if (isPromise(sel)) sel = await sel;
      if (!sel || sel.objectType !== 'segment' || !Array.isArray(sel.ids)) return false;
      const mine = new Set();
      State.generated.forEach((g) => (g.allIds || []).forEach((i) => mine.add(i)));
      return sel.ids.some((i) => mine.has(i) || (typeof i === 'number' && i < 0));
    } catch (e) { return false; }
  }

  const Generated = {
    busy: false,
    _waiting: false,
    _run: null,
    _rt: null,
    visible() { return [...State.generated.values()].filter((g) => g.status !== 'Undone'); },

    candSnapshot(c) {
      return {
        id: c.id, coords: c.coords, length: c.length, review: c.review || null,
        origStart: c.origStart || null, origEnd: c.origEnd || null,
        oneWay: !!c.oneWay, flowLocked: !!c.flowLocked,
        jStart: !!c.jStart, jEnd: !!c.jEnd,
        seamStart: c.seamStart || { state: 'clean' },
        seamEnd: c.seamEnd || { state: 'clean' }
      };
    },
    restoreCandidate(snap) {
      if (!snap || !snap.coords) return false;
      const live = State.candidates.get(snap.id);
      if (live && live.status === 'Candidate') return false;
      const det = Settings.get('detectionRadius');
      const segs = WazeData.inBox(Geo.bboxPad(Geo.bbox(snap.coords), det));
      if (segs.length) {
        const pts = Geo.densify(snap.coords, 6);
        if (pts.filter((p) => WazeData.nearest(p, det, segs)).length / pts.length >= 0.7) return false;
      }
      State.candidates.set(snap.id, { ...snap, selected: false, status: 'Candidate', connected: false });
      return true;
    },

    async _panTo(coord, zoom) {
      const dist = async () => {
        const c = await MapUtil.centerNow();
        return c ? Geo.haversine([c.lon, c.lat], coord) : Infinity;
      };
      const alreadyThere = (await dist()) <= 50 && (await MapUtil.zoom()) === zoom;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!alreadyThere || attempt > 0) {
          const loaded = MapLoad.wait();
          await MapUtil.focus(coord, zoom);
          // WME fires no load event when the data for the new view was already cached, so a timeout is normal.
          if (!(await loaded)) Log.d('no wme-map-data-loaded before timeout; verifying the map centre anyway');
        }
        await WazeData.refresh();
        const d = await dist();
        if (d <= 50) {
          Log.i(`centre verified: ${Math.round(d)} m from target (attempt ${attempt + 1})`);
          return { ok: true, dist: d };
        }
        Log.w(`map centre is ${Math.round(d)} m from the target (attempt ${attempt + 1})`);
      }
      return { ok: false, dist: await dist() };
    },

    async relocate(row, tol = 2.5) {
      await WazeData.refresh();
      const mine = WazeData.all().filter((s) => {
        if (row.segmentIds.includes(s.id)) return false;
        const pts = Geo.densify(s.coords, 4);
        return pts.filter((p) => { const r = Geo.nearestOnLine(p, row.coords); return r && r.dist <= tol; }).length / pts.length >= 0.8;
      }).map((s) => s.id);
      if (mine.length) { row.segmentIds = mine; mine.forEach((i) => { if (!row.allIds.includes(i)) row.allIds.push(i); }); }
    },

    async pendingCount() {
      const own = [...State.generated.values()]
        .filter((g) => g.segmentIds && g.segmentIds.length && g.status !== 'Saved' && g.status !== 'Undone' && g.status !== 'Error').length;
      const wme = await editCount();
      return Math.max(own, wme === null ? 0 : wme);
    },

    // Nearest-first order: candidates already inside the starting view first, then by distance from
    // the starting view centre. Candidates skipped in this run are left out.
    _orderPicked(list, run) {
      const rest = list.filter((c) => !(run.skipped && run.skipped.has(c.id)));
      const ctr = run.savedCenter, ext = run.startExtent;
      if (!ctr) return rest;
      const onScreen = (c) => !!ext && this._ptsInside(this._probePoints(c.coords), ext);
      const dist = (c) => { const b = Geo.bbox(c.coords); return Geo.haversine([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], [ctr.lon, ctr.lat]); };
      return rest.map((c) => ({ c, v: onScreen(c) ? 0 : 1, d: dist(c) }))
        .sort((x, y) => x.v - y.v || x.d - y.d).map((x) => x.c);
    },

    // Points that must be inside the loaded view for a candidate to be converted: both ends and the
    // middle vertex. (A long candidate may be larger than the view, so the whole bbox is not required.)
    _probePoints(coords) {
      return [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]];
    },
    _ptsInside(pts, ext) {
      if (!ext) return false;
      const padLat = 10 / 110540;
      return pts.every((p) => p[0] >= ext[0] && p[0] <= ext[2] && p[1] >= ext[1] + padLat && p[1] <= ext[3] - padLat);
    },

    // Wait until WME has really finished loading the map data around the batch. Creating a segment
    // while the area's tiles are still loading makes WME treat it as a suggested edit and send it
    // for review straight away, so Convert refuses to run until the data is loaded and steady.
    async _confirmTilesLoaded(first, mult = 1) {
      const settle = Math.min(20000, Math.max(500, Number(Settings.get('tileSettleMs')) || 1500) * mult);
      let probe = this._probePoints(first.coords);
      let why = 'timed out';

      // A candidate longer than the view cannot be shown whole. Visit each end first so WME loads
      // the tiles there, then come back to the middle and require only the middle to be in view.
      if (!this._ptsInside(probe, await MapUtil.extent())) {
        const zoom = (await MapUtil.zoom()) || 16;
        const fb = Geo.bbox(first.coords);
        const centre = [(fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2];
        Log.i(`${first.id} is larger than the view: loading its ends first`);
        for (const pt of [probe[0], probe[2], centre]) {
          const loaded = MapLoad.wait({ timeoutMs: settle + 500, quietMs: settle });
          await MapUtil.focus(pt, zoom);
          await loaded;
        }
        probe = [probe[1]];
      }
      // Poll instead of waiting for an event: WME fires no "map data loaded" event when the view was
      // already cached, and a sparsely mapped area can legitimately show zero roads. Ready = the probe
      // points are inside the view and no map-data event has arrived for `settle` ms.
      const t0 = Date.now();
      const limit = t0 + 8000 * mult + settle;
      while (Date.now() < limit) {
        if (this._stop) return { ok: false, why: 'stopped' };
        const ext = await MapUtil.extent();
        if (!this._ptsInside(probe, ext)) { why = 'the candidate is not inside the view'; await sleep(250); continue; }
        const quietFor = Date.now() - Math.max(MapLoad.lastAt, t0);
        if (quietFor >= settle) {
          await WazeData.refresh(true);
          const last = MapLoad.lastAt;
          const ext2 = await MapUtil.extent();
          if (last <= Math.max(0, Date.now() - settle) && this._ptsInside(probe, ext2)) {
            return { ok: true, roads: WazeData.inBox(ext2).length };
          }
        }
        why = 'map data is still changing';
        UI.setBusy(true, `Waiting for map data to settle (${Math.max(0, Math.ceil((settle - quietFor) / 100) / 10)} s quiet needed)...`);
        await sleep(250);
      }
      Log.w(`tile check failed for ${first.id}: ${why}`);
      return { ok: false, why };
    },

    async convertSelected(isContinuation = false) {
      if (this.busy || this._waiting) return;

      let picked = Candidates.selected();
      if (!picked.length) { UI.notify('Select candidate(s) first.', 'warn'); return; }

      const remindAt = Math.max(0, Number(Settings.get('maxPendingEdits')) || 0);

      if (!isContinuation) {
        this._stop = false;
        this._waiting = true;
        try {
          await WazeData.refresh(true);
          const removed = Candidates.pruneMapped();
          if (removed) { UI.notify(`${removed} candidate(s) removed.`, 'warn'); UI.changed(); }
          picked = Candidates.selected();
          if (!picked.length) return;

          const pending = await this.pendingCount();

          const per = Math.max(1, Settings.get('maxDraftCreationBatch'));
          const perClickCap = Math.min(50, Math.max(per, Number(Settings.get('maxConvertPerClick')) || per));
          const autoBatch = true;   // sub-batches continue silently until the per-click cap is reached

          const toConvert = autoBatch
            ? Math.min(picked.length, perClickCap)
            : Math.min(picked.length, per);

          const total = Math.ceil(toConvert / per);
          const risk = remindAt > 0 && pending + toConvert >= remindAt;

          // Friendly checkpoints: they advise the editor and never block the conversion.
          const notes = [];
          if (picked.length > perClickCap) {
            notes.push(`You ticked ${picked.length}; the cap is ${perClickCap}. This click will attempt ${perClickCap}. ${picked.length - perClickCap} stay ticked for the next pass.`);
          }
          if (remindAt > 0) {
            if (pending >= remindAt) {
              if (!this._remindFired) {
                notes.push(`You have ${pending} unsaved edits in WME (your reminder is set at ${remindAt}; script default 300). Finish aligning, connecting and saving the current drafts before adding more, so no work is lost. This is only a reminder; Convert continues.`);
                this._remindFired = true;
              }
            } else this._remindFired = false;
          }
          const pct = Math.max(0, Number(Settings.get('unverifiedSoftStopPct')) || 0);
          if (pct > 0) {
            const unverified = [...State.generated.values()]
              .filter((g) => g.segmentIds && g.segmentIds.length && g.status !== 'Saved' && g.status !== 'Undone' && g.status !== 'Error').length;
            const thr = Math.ceil(perClickCap * pct / 100);
            if (unverified >= thr) {
              if (!this._unverFired) {
                notes.push(`${unverified} drafts from this script are still unsaved (reminder at ${pct}% of the per-click cap = ${thr}; script default 150%). Align and verify them, then Save, before converting more. This is only a reminder; Convert continues.`);
                this._unverFired = true;
              }
            } else this._unverFired = false;
          }
          if (notes.length) UI.checkpoint(notes);
          const acked = !!Settings.get('responsibilityAcknowledged');
          const needsDialog = !acked;
          if (needsDialog) {
            const preset = PRESETS.find((p) => p.key === Settings.get('roadPreset')) || PRESETS[0];
            const go = await UI.confirmConvert({
              count: toConvert, ticked: picked.length, per, total, roadLabel: preset.label, limit: remindAt, risk, acked,
              autoBatch
            });
            if (!go) { UI.notify('Conversion cancelled. Nothing was created.', 'info'); return; }
          }
          this._runCreated = 0;
          this._run = {
            total: autoBatch ? total : 1, n: 0,
            clickBudget: toConvert,
            convertedThisClick: 0,
            savedCenter: await MapUtil.centerNow(),
            savedZoom: await MapUtil.zoom(),
            startExtent: await MapUtil.extent(),
            skipped: new Set()
          };
        } finally { this._waiting = false; }
      }
      if (!this._run) this._run = { total: 1, n: 0, savedCenter: null, savedZoom: null, skipped: new Set() };
      const run = this._run;
      run.n++;
      if (!run.skipped) run.skipped = new Set();
      // Nearest-first: candidates already on screen come first, then by distance from the starting view.
      picked = this._orderPicked(picked, run);

      const per = Math.max(1, Settings.get('maxDraftCreationBatch'));
      let batch;
      if (run.clickBudget === undefined || run.clickBudget === null) {
        batch = picked.slice(0, per);
      } else {
        const remainingBudget = Math.max(0, run.clickBudget - (run.convertedThisClick || 0));
        batch = picked.slice(0, Math.min(per, remainingBudget));
      }

      const lbl = () => `Batch ${run.n} (${Candidates.selected().filter((x) => !run.skipped.has(x.id)).length} left)`;
      const restoreView = async () => {
        if (run.savedCenter && run.savedZoom) {
          try { await sdk.Map.setMapCenter({ lonLat: run.savedCenter, zoomLevel: run.savedZoom }); }
          catch (err) { Log.w('restore view failed', err); }
        }
        this._run = null;
      };

      const viewMoved = async () => {
        if (!run.savedCenter) return false;
        const c = await MapUtil.centerNow(); const z = await MapUtil.zoom();
        if (!c) return true;
        return Geo.haversine([c.lon, c.lat], [run.savedCenter.lon, run.savedCenter.lat]) > 20 || (!!run.savedZoom && z !== run.savedZoom);
      };
      const skippedNote = () => (run.skipped.size
        ? ` ${run.skipped.size} skipped because WME had not finished loading the map around them (${[...run.skipped].join(', ')}); they stay ticked, so press Convert again.`
        : '');
      const finishNow = async (lead) => {
        if (await viewMoved()) {
          UI.setBusy(true, 'Returning to your starting view in 2 s...');
          await sleep(FINAL_VIEW_PAUSE_MS);
        }
        UI.setBusy(true, 'Restoring map view...');
        await restoreView();
        UI.setBusy(false);
        UI.notify(`${lead}${skippedNote()} Map view restored. Review each draft, align to the road centerline / satellite imagery, then press WME's Save. Nothing has been saved yet.`, run.skipped.size ? 'warn' : 'ok');
        UI.changed();
      };
      // Never abort the whole click for one candidate: skip it (it stays ticked) and carry on.
      const skipAndContinue = async (cand, why) => {
        run.skipped.add(cand.id);
        Log.w(`skipping ${cand.id}: ${why}`);
        UI.setBusy(false);
        const left = Candidates.selected().filter((x) => !run.skipped.has(x.id)).length;
        const budgetLeft = (run.clickBudget ?? Infinity) - (run.convertedThisClick ?? 0);
        if (left > 0 && budgetLeft > 0) return this.convertSelected(true);
        return finishNow(`${this._runCreated || 0} draft segment(s) created.`);
      };

      if (this._stop) { this._stop = false; UI.setConverting(false); return finishNow(`Stopped by you. ${this._runCreated || 0} draft segment(s) created.`); }
      if (!batch.length) { await finishNow(`${this._runCreated || 0} draft segment(s) created.`); return; }

      const firstCand = batch[0];
      const fb = Geo.bbox(firstCand.coords);
      const centerCoord = [(fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2];
      let pan;
      this._waiting = true;
      try {
        // A candidate that is already on screen is converted without moving the map.
        const ext0 = await MapUtil.extent();
        const z0 = await MapUtil.zoom();
        if (z0 !== null && z0 >= Settings.get('convertZoom') && this._ptsInside(this._probePoints(firstCand.coords), ext0)) {
          pan = { ok: true, dist: 0, stayed: true };
        } else {
          UI.setBusy(true, `Panning to ${firstCand.id} (${lbl()})...`);
          pan = await this._panTo(centerCoord, Math.max(10, Number(Settings.get('convertZoom')) || 14));
        }
      } finally { this._waiting = false; }
      if (!pan.ok) return skipAndContinue(firstCand, `the map did not centre on it (off by ${Math.round(pan.dist)} m)`);

      // Do not create anything until WME has finished loading the tiles for this area.
      let tiles;
      this._waiting = true;
      try {
        UI.setBusy(true, `${lbl()}: waiting for map tiles to finish loading...`);
        tiles = await this._confirmTilesLoaded(firstCand);
        if (!tiles.ok) {
          UI.setBusy(true, `${lbl()}: tiles still loading, waiting longer...`);
          tiles = await this._confirmTilesLoaded(firstCand, 2);
        }
      } finally { this._waiting = false; }
      if (this._stop) { this._stop = false; UI.setConverting(false); return finishNow(`Stopped by you. ${this._runCreated || 0} draft segment(s) created.`); }
      if (!tiles.ok) return skipAndContinue(firstCand, `tiles not confirmed (${tiles.why})`);
      Log.i(`tiles confirmed loaded (${tiles.roads} roads in view)`);
      {
        // Only convert candidates that sit fully inside the view that was just confirmed. The rest
        // stay ticked and are handled by the next batch, after the map pans to them.
        const ext = await MapUtil.extent();
        const fits = (c) => this._ptsInside(this._probePoints(c.coords), ext);
        const keep = batch.filter((c, i) => i === 0 || fits(c));
        if (keep.length && keep.length < batch.length) {
          Log.i(`batch trimmed to ${keep.length}/${batch.length} candidates inside the loaded view`);
          batch = keep;
        }
      }

      const rt = Settings.roadTypeFor(Settings.get('roadPreset'));
      let userStop = false, created = 0, failed = 0, consecFail = 0, rejected = 0, stoppedAt = null, hitLimit = false;
      const madeRows = [];

      this.busy = true; UI.setBusy(true, `${lbl()}: converting ${batch.length} candidate(s)...`);
      try {
        for (const [bi, c] of batch.entries()) {
          if (this._stop) { userStop = true; break; }
          const before = await editCount();
          const pendingNow = await this.pendingCount();

          UI.setBusy(true, `${lbl()}: converting ${c.id} (${bi + 1}/${batch.length}), unsaved edits ${pendingNow}...`);

          const coords = shapeLine(c.coords, traceOpts());
          let segmentId;
          try {
            segmentId = sdk.DataModel.Segments.addSegment({ geometry: { type: 'LineString', coordinates: coords }, roadType: rt });
            if (isPromise(segmentId)) segmentId = await segmentId;
          } catch (err) {
            failed++; consecFail++;
            Log.e('addSegment failed', c.id, err);
            // Keep going: tag this candidate, untick it so it is not retried in a loop, carry on.
            c.review = 'WME refused to create this draft'; c.selected = false;
            if (consecFail >= 3) { stoppedAt = c; break; }
            continue;
          }
          consecFail = 0;

          if (c.oneWay) {
            try {
              let dr = sdk.DataModel.Segments.updateSegment({ segmentId, direction: 'A_TO_B' });
              if (isPromise(dr)) await dr;
            } catch (derr) {
              Log.w(`could not set one-way on #${segmentId}: ${derr.message}`);
            }
          }

          const row = {
            id: nextId('S'), candId: c.id, cand: this.candSnapshot(c),
            segmentId, segmentIds: [segmentId], allIds: [segmentId], coords,
            status: c.review ? 'Needs Manual Review' : 'OK', review: c.review || null, errors: [],
            selected: false, saved: false, seq: ++State.counters.seq, countBefore: before, countAfter: null
          };
          State.generated.set(row.id, row); madeRows.push({ c, row });
          c.status = 'Drafted'; c.selected = false;
          created++;
          run.convertedThisClick = (run.convertedThisClick || 0) + 1;
          row.segmentId = row.segmentIds[0] || segmentId;
          row.countAfter = await editCount();
          await sleep(Settings.get('convertDelayMs'));
        }
      } finally { this.busy = false; UI.setBusy(false); }

      // WME can silently drop a new segment (toast "That change isn't allowed at this time"). Check once
      // that every draft is still there; put any that vanished back as candidates, tagged for review.
      if (madeRows.length) {
        await sleep(1500);
        for (const { c, row } of madeRows) {
          let gone = !(await getSeg(row.segmentId));
          if (gone) { await sleep(500); gone = !(await getSeg(row.segmentId)); }
          if (!gone) continue;
          State.generated.delete(row.id);
          c.status = 'Candidate'; c.selected = false; c.review = 'WME rejected this draft';
          created--; rejected++;
          run.convertedThisClick = Math.max(0, (run.convertedThisClick || 1) - 1);
          Log.w(`WME dropped the draft for ${c.id}; it is back in the list, unticked`);
        }
      }
      WazeData.invalidate(); await WazeData.refresh(true);
      await this.validate();
      this._runCreated = (this._runCreated || 0) + created;

      const remainingCount = Candidates.selected().filter((x) => !run.skipped.has(x.id)).length;
      const budgetRemaining = (run.clickBudget ?? Infinity) - (run.convertedThisClick ?? 0);
      const more = remainingCount > 0
        && !stoppedAt && !failed && !hitLimit && !userStop
        && budgetRemaining > 0;

      let message = (run.n > 1 || more)
        ? `${this._runCreated} draft segment(s) created so far (batch ${run.n}: ${created}).`
        : `${created} draft segment(s) created.`;
      if (userStop) { message += ' Stopped by you.'; this._stop = false; UI.setConverting(false); }
      if (failed) message += ` ${failed} refused.`;
      if (rejected) message += ` ${rejected} dropped by WME (not allowed at that spot); they are back in the list with a review tag.`;
      if (stoppedAt) {
        const stoppedIdx = batch.indexOf(stoppedAt);
        const notAttempted = stoppedIdx >= 0 ? batch.length - stoppedIdx - 1 : 0;
        message += ` Stopped at ${stoppedAt.id}.`;
        if (notAttempted > 0) message += ` ${notAttempted} not attempted, still ticked for retry.`;
      }
      if (more) message += ` ${remainingCount} left, continuing...`;
      else if (remainingCount > 0) message += ` ${remainingCount} still ticked.`;

      if (more) {
        UI.notify(message, 'warn');
        UI.changed();
        const pause = Math.max(0, Settings.get('batchPauseMs') || 0);
        UI.setBusy(true, `${lbl()} done. Next batch in ${(pause / 1000).toFixed(1)} s...`);
        await sleep(pause);
        UI.setBusy(false);
        return this.convertSelected(true);
      }

      if (await viewMoved()) {
        UI.setBusy(true, 'Last draft created. Returning to your starting view in 2 s...');
        await sleep(FINAL_VIEW_PAUSE_MS);
      }
      UI.setBusy(true, 'Restoring map view...');
      await restoreView();
      await sleep(300);
      UI.setBusy(false);
      UI.notify(`${message}${skippedNote()} Map view restored. Review each draft, align to the road centerline / satellite imagery, then press WME's Save. Nothing has been saved yet.`, (failed || remainingCount > 0 || hitLimit || run.skipped.size) ? 'warn' : 'ok');
      UI.changed();
    },
    async remove(rows) {
      if (this.busy) return { undone: 0, listed: 0, refused: 'Busy, try again in a moment.' };
      this.busy = true;
      const res = { undone: 0, listed: 0, refused: null };
      try {
        await this.reconcile(true);
        const listOnly = rows.filter((r) => !r.segmentIds.length || r.status === 'Saved' || r.status === 'Error');
        listOnly.forEach((r) => { State.generated.delete(r.id); res.listed++; });
        const pending = rows.filter((r) => !listOnly.includes(r) && State.generated.has(r.id)).sort((a, b) => b.seq - a.seq);
        for (const row of pending) {
          const alive = [...State.generated.values()].filter((g) => g.segmentIds.length && g.status !== 'Saved' && g.status !== 'Undone' && g.status !== 'Error').sort((a, b) => b.seq - a.seq);
          if (alive[0] !== row) { res.refused = `${alive[0].id} was created after ${row.id}; undo works newest-first. Tick ${alive[0].id} too, or press Ctrl+Z in WME.`; break; }
          const now = await editCount();
          if (now === null || row.countAfter === null) { res.refused = 'WME did not report its pending-edit count, so I cannot prove nothing else would be undone. Use Ctrl+Z in WME.'; break; }
          if (now !== row.countAfter) { res.refused = `Other edits were made after ${row.id} (WME has ${now} pending, expected ${row.countAfter}). Undo them with Ctrl+Z in WME first, so nothing else is lost.`; break; }
          const floor = row.countBefore;
          let tries = 0;
          const stillThere = async () => { for (const id of row.allIds) if (await getSeg(id)) return true; return false; };
          while ((await stillThere()) && tries++ < 8) {
            const c = await editCount();
            if (c !== null && floor !== null && c <= floor) break;
            let r = sdk.Editing.undo(); if (isPromise(r)) await r;
            await sleep(120);
          }
          if (await stillThere()) { res.refused = `Could not undo ${row.id} cleanly; nothing more was changed. Use Ctrl+Z in WME.`; break; }
          const after = await editCount();
          if (after !== null && floor !== null && after < floor) Log.w('undo went below the expected count', after, floor);
          row.status = 'Undone'; row.segmentIds = []; row.selected = false;
          UI.trashCandidate(row.cand);
          res.undone++;
        }
        WazeData.invalidate(); await WazeData.refresh(true);
      } finally { this.busy = false; }
      return res;
    },

    async reconcile(quiet) {
      if (this.busy && !quiet) { this.again = true; return; }
      let changed = false, recheck = false;
      await WazeData.refresh();
      for (const row of [...State.generated.values()]) {
        if (row.status === 'Error' || !row.allIds) continue;
        const present = [];
        for (const id of row.allIds) if (await getSeg(id)) present.push(id);
        if (row.status === 'Undone') {
          if (present.length) {
            row.segmentIds = present; row.status = row.review ? 'Needs Manual Review' : 'OK'; changed = true;
            const c = State.candidates.get(row.candId); if (c) c.status = 'Drafted';
            Log.i(`${row.id} came back (Redo)`);
          }
          continue;
        }
        if (present.length) {
          row._absentSince = null;
          if (present.join() !== row.segmentIds.join()) { row.segmentIds = present; row.segmentId = present[0]; changed = true; }
          continue;
        }
        const pts = Geo.densify(row.coords, 4);
        const covered = pts.filter((p) => WazeData.nearest(p, 8)).length / pts.length >= 0.8;
        if (row.saved) { State.generated.delete(row.id); changed = true; Log.i(`${row.id} is now a saved road, removed from the list`); continue; }
        if (covered) {
          await this.relocate(row, 8);
          if (row.segmentIds.length) { row.segmentId = row.segmentIds[0]; changed = true; Log.i(`${row.id} follows its edited segment(s): ${row.segmentIds.join(',')}`); }
          continue;
        }
        // The editor may have reshaped or reconnected the draft, which can give it new IDs and move it
        // well away from where it was created. Adopt such a segment before deciding it was undone.
        if (await this.adoptEdited(row)) { row._absentSince = null; changed = true; continue; }
        // Other scripts (road type, river tools...) edit a draft in several steps, so it can be missing
        // for a moment. Only call it undone if it is still missing a second later.
        if (!row._absentSince) { row._absentSince = Date.now(); recheck = true; continue; }
        if (Date.now() - row._absentSince < 1000) { recheck = true; continue; }
        row._absentSince = null;
        row.status = 'Undone'; row.segmentIds = []; row.selected = false; changed = true;
        if (this.restoreCandidate(row.cand)) UI.notify(`${row.id} was undone in WME: candidate ${row.cand.id} is back in the list.`, 'ok');
      }
      if (changed) UI.changed();
      if (recheck) setTimeout(() => this.reconcile().catch(() => {}), 1200);
      if (this.again) { this.again = false; setTimeout(() => this.reconcile().catch(() => {}), 200); }
    },

    // Finds the unsaved segment(s) the editor turned a draft into: new (negative-ID) segments that no other
    // row owns and that lie along the original draft line (within 40 m).
    async adoptEdited(row) {
      await WazeData.refresh(true);
      const claimed = new Set();
      State.generated.forEach((g) => { if (g !== row && g.allIds) g.allIds.forEach((i) => claimed.add(i)); });
      const rowPts = Geo.densify(row.coords, 6);
      const mine = WazeData.all().filter((sg) => {
        if (typeof sg.id !== 'number' || sg.id >= 0) return false;
        if (!claimed.has(sg.id)) {
          const pts = Geo.densify(sg.coords, 6);
          return pts.filter((p) => { const r = Geo.nearestOnLine(p, row.coords); return r && r.dist <= 40; }).length / pts.length >= 0.6;
        }
        // Already owned by another draft record: the editor merged two drafts into one segment. That
        // segment then runs along this draft's line too, so this record shares it instead of being undone.
        return rowPts.filter((p) => { const r = Geo.nearestOnLine(p, sg.coords); return r && r.dist <= 12; }).length / rowPts.length >= 0.85;
      }).map((sg) => sg.id);
      if (!mine.length) return false;
      row.segmentIds = mine; row.segmentId = mine[0];
      mine.forEach((i) => { if (!row.allIds.includes(i)) row.allIds.push(i); });
      Log.d(`${row.id} follows its edited segment(s): ${mine.join(',')}`);
      return true;
    },

    scheduleReconcile() {
      if (![...State.generated.values()].some((g) => g.allIds && g.allIds.length)) return;
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.reconcile().catch((e) => Log.e('reconcile', e)), 300);
    },

    purgeUndone() {
      let n = 0;
      [...State.generated.values()].forEach((g) => { if (g.status === 'Undone') { State.generated.delete(g.id); n++; } });
      if (n) Log.i(`purged ${n} undone row(s)`);
    },

    onSaved(ok) {
      if (!ok) return;
      const savedCandIds = new Set();
      State.generated.forEach((g) => {
        if (g.segmentIds.length) {
          g.saved = true; g.status = 'Saved'; g.errors = [];
          if (g.candId) savedCandIds.add(g.candId);
        }
      });
      savedCandIds.forEach((id) => {
        const c = State.candidates.get(id);
        if (c && c.status === 'Drafted') State.candidates.delete(id);
      });
      UI.notify('Saved. The generated segments are now normal roads.', 'ok');
      UI.changed();
      setTimeout(() => this.reconcile().catch(() => {}), 800);
    },
    onIdsChanged(list) {
      let n = 0;
      for (const ch of list) {
        if (!ch || ch.oldID === undefined || ch.newID === undefined) continue;
        State.generated.forEach((g) => {
          const i = g.segmentIds.indexOf(ch.oldID);
          if (i >= 0) { g.segmentIds[i] = ch.newID; g.segmentId = g.segmentIds[0]; n++; }
          if (g.allIds.includes(ch.oldID) && !g.allIds.includes(ch.newID)) g.allIds.push(ch.newID);
        });
      }
      if (n) { Log.i(`ids updated after save: ${n}`); UI.changed(); }
    },

    async validate() {
      for (const g of State.generated.values()) {
        if (g.status === 'Undone' || g.status === 'Error' || g.status === 'Saved' || !g.segmentIds.length) continue;
        g.errors = [];
        let external = false, bad = false;
        const own = new Set(g.segmentIds);
        for (const id of g.segmentIds) {
          const seg = await getSeg(id);
          if (!seg || !seg.geometry || !seg.geometry.coordinates || seg.geometry.coordinates.length < 2) { bad = true; continue; }
          if (lockOf(seg) > State.editorRank) g.errors.push(`Locked ${lockLabel(lockOf(seg))} (you ${lockLabel(State.editorRank)})`);
          for (const rev of [false, true]) {
            try {
              let cs = sdk.DataModel.Segments.getConnectedSegments({ segmentId: id, reverseDirection: rev });
              if (isPromise(cs)) cs = await cs;
              if ((cs || []).some((s) => !own.has(s.id))) external = true;
            } catch (e) { /* not available */ }
          }
        }
        if (bad) g.errors.push('Segment not found in model');
        if (!external && !g.errors.length) g.errors.push('Not connected to a road yet (connect or confirm dead end)');
        g.status = g.errors.length ? 'Warning' : (g.review ? 'Needs Manual Review' : 'OK');
      }
    },

    async zoomTo(g) {
      let m = null;
      if (g.coords && g.coords.length) m = g.coords[Math.floor(g.coords.length / 2)];
      else if (g.segmentIds && g.segmentIds[0]) {
        const seg = await getSeg(g.segmentIds[0]);
        if (seg && seg.geometry) { const cs = seg.geometry.coordinates; m = cs[Math.floor(cs.length / 2)]; }
      }
      if (m) await MapUtil.focus(m); else UI.notify('Cannot find this segment on the map.', 'warn');
    },
    async select(g) {
      if (!g.segmentIds.length) return;
      try { await sdk.Editing.setSelection({ selection: { ids: g.segmentIds, objectType: 'segment' } }); }
      catch (err) { Log.e('setSelection failed', err); }
    }
  };

  /* ===== UI ===== */
  const UI = {
    pane: null, status: null, busy: false, guide: null, zoom: undefined,

    async init() {
      const style = document.createElement('style');
      style.textContent = `
        .svra{
          --svra-bg:#ffffff; --svra-fg:#222222; --svra-fg-dim:#555555; --svra-fg-muted:#888888;
          --svra-border:#bbbbbb; --svra-border-soft:#e0e0e0; --svra-border-row:#eeeeee;
          --svra-btn-bg:#f5f5f5; --svra-btn-bg-hover:#e8f0fe; --svra-btn-fg:#222222;
          --svra-btn-primary-bg:#1a73e8; --svra-btn-primary-bg-hover:#1765cc; --svra-btn-primary-fg:#ffffff;
          --svra-btn-on-bg:#e6f7ec; --svra-btn-on-border:#00a844; --svra-btn-on-fg:#00793a;
          --svra-btn-danger-fg:#c62828; --svra-btn-danger-border:#e57373;
          --svra-row-selected-bg:#e6f7ec;
          --svra-msg-bg:#eeeef8; --svra-msg-ok-bg:#e6f7ec; --svra-msg-err-bg:#fdeaea; --svra-msg-warn-bg:#fff6e0;
          --svra-sub:#a15c00; --svra-chip-bg:#eeeeee;
          --svra-tag-ok:#00c853; --svra-tag-warn:#ff9800; --svra-tag-err:#e53935;
          --svra-seam-clean:#00897b; --svra-seam-old:#c62828; --svra-seam-user:#6a1b9a;
          --svra-zoom-ok-bg:#e6f7ec; --svra-zoom-ok-fg:#00793a;
          --svra-zoom-bad-bg:#fff6e0; --svra-zoom-bad-fg:#a15c00;
          --svra-guide-bg:#fff3e0; --svra-guide-fg:#8a4b00;
          --svra-jdot:#1a73e8;
          font-size:12px;line-height:1.35;background:var(--svra-bg);color:var(--svra-fg);
        }
        .svra h4{margin:6px 0 4px;font-size:13px;color:var(--svra-fg)}
        .svra button{margin:2px 2px 2px 0;padding:3px 7px;border:1px solid var(--svra-border);border-radius:4px;background:var(--svra-btn-bg);color:var(--svra-btn-fg);cursor:pointer;font-size:11px}
        .svra button:hover{background:var(--svra-btn-bg-hover)}
        .svra table{width:100%;border-collapse:collapse;margin-bottom:6px}
        .svra th,.svra td{padding:2px 3px;border-bottom:1px solid var(--svra-border-row);text-align:left;font-size:11px;color:var(--svra-fg)}
        .svra tr.sel td{background:var(--svra-row-selected-bg)}
        .svra .tag{display:inline-block;padding:0 5px;border-radius:8px;font-size:10px;color:#fff}
        .svra .t-ok{background:var(--svra-tag-ok)}.svra .t-warn{background:var(--svra-tag-warn)}.svra .t-err{background:var(--svra-tag-err)}.svra .t-cand{background:#7e57c2}
        .svra .msg{padding:4px 6px;border-radius:4px;margin:4px 0;background:var(--svra-msg-bg);color:var(--svra-fg)}
        .svra .msg.ok{background:var(--svra-msg-ok-bg)}.svra .msg.err{background:var(--svra-msg-err-bg)}.svra .msg.warn{background:var(--svra-msg-warn-bg)}
        .svra fieldset{border:1px solid var(--svra-border-soft);border-radius:4px;margin:6px 0;padding:4px 6px}
        .svra label{display:block;margin:2px 0;color:var(--svra-fg)}
        .svra input[type=number]{width:70px}
        .svra .zoom{font-size:11px;padding:3px 6px;border-radius:4px;margin-bottom:4px}
        .svra .zoom.ok{background:var(--svra-zoom-ok-bg);color:var(--svra-zoom-ok-fg)}
        .svra .zoom.bad{background:var(--svra-zoom-bad-bg);color:var(--svra-zoom-bad-fg)}
        .svra .zoom.guide{background:var(--svra-guide-bg);color:var(--svra-guide-fg);border-left:3px solid var(--svra-tag-warn)}
        .svra .top{display:flex;flex-wrap:nowrap;gap:3px;margin-bottom:4px}
        .svra .top button.wide{flex:2 1 0}
        .svra .top button{flex:1 1 0;min-width:0;margin:0;padding:6px 2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .svra button.primary{background:var(--svra-btn-primary-bg);border-color:var(--svra-btn-primary-bg);color:var(--svra-btn-primary-fg)}
        .svra button.primary:hover{background:var(--svra-btn-primary-bg-hover)}
        .svra button.on{background:var(--svra-btn-on-bg);border-color:var(--svra-btn-on-border);color:var(--svra-btn-on-fg)}
        .svra button.danger{color:var(--svra-btn-danger-fg);border-color:var(--svra-btn-danger-border)}
        .svra button:disabled{opacity:.45;cursor:default}
        .svra .sec{margin:8px 0}
        .svra .sech{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-bottom:3px;border-bottom:2px solid var(--svra-border-soft)}
        .svra .sech .n{background:var(--svra-chip-bg);border-radius:8px;padding:0 6px;font-size:11px;color:var(--svra-fg)}
        .svra .bar{margin-left:auto;display:flex;align-items:center;gap:3px;font-size:11px;color:var(--svra-fg-dim)}
        .svra td.act{text-align:right;white-space:nowrap}
        .svra td.act button{padding:1px 6px;margin:0 0 0 2px}
        .svra .sub{font-size:10px;color:var(--svra-sub)}
        .svra .empty{color:var(--svra-fg-muted);padding:6px 2px}
        .svra details.more{margin:6px 0;border:1px solid var(--svra-border-soft);border-radius:4px;padding:3px 6px}
        .svra details.more summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--svra-fg)}
        .svra details.more[open] summary{margin-bottom:4px}
        .svra .seam{font-size:10px;padding:0 4px;border-radius:6px;color:#fff;margin-left:2px}
        .svra .seam.clean{background:var(--svra-seam-clean)}
        .svra .seam.old{background:var(--svra-seam-old)}
        .svra .seam.user{background:var(--svra-seam-user)}
        .svra .jdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--svra-jdot);margin:0 1px;vertical-align:middle}
        .svra .checkpoint{position:relative;margin:4px 0 6px;padding:5px 24px 5px 7px;border:1px solid #f9a825;border-radius:4px;background:rgba(249,168,37,.14);font-size:12px}
        .svra .checkpoint .x{position:absolute;top:2px;right:2px;padding:0 5px;min-width:0;line-height:16px}
        .svra .checkpoint div{margin-top:3px}
        .svra details.notes{margin:4px 0 6px;border:1px solid var(--svra-border-soft);border-radius:4px;padding:3px 6px}
        .svra details.notes summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--svra-fg)}
        .svra details.notes[open] summary{margin-bottom:4px}
        .svra .notice{margin:4px 0 6px;padding:5px 8px;border-left:3px solid var(--svra-tag-warn);border-radius:3px;background:var(--svra-msg-warn-bg);color:var(--svra-fg);font-size:11px}
        .svra-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5)}
        .svra.svra-modal{box-sizing:border-box;width:min(480px,100%);max-height:90vh;overflow:auto;padding:18px 20px 16px;border:1px solid var(--svra-border);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.4);font-size:13px;line-height:1.45}
        .svra-modal h3{margin:0 0 6px;font-size:16px;font-weight:700;color:var(--svra-fg)}
        .svra-modal .lead{margin:0 0 10px;color:var(--svra-fg-dim)}
        .svra-modal h5{margin:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--svra-fg-muted)}
        .svra-modal ul{margin:0;padding-left:18px}
        .svra-modal li{margin:3px 0;color:var(--svra-fg)}
        .svra-modal .warnbox{margin:8px 0;padding:8px 10px;border-left:3px solid var(--svra-tag-err);border-radius:4px;background:var(--svra-msg-err-bg);color:var(--svra-fg)}
        .svra-modal .ack{display:flex;gap:8px;align-items:flex-start;margin:14px 0 4px;padding:8px 10px;border:1px solid var(--svra-border-soft);border-radius:6px;background:var(--svra-msg-bg);cursor:pointer}
        .svra-modal .ack input{margin-top:2px}
        .svra-modal .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
        .svra-modal .actions button{margin:0;padding:7px 14px;font-size:13px;border-radius:6px}
        @media (prefers-color-scheme: dark) {
          .svra{
            --svra-bg:#1f2328; --svra-fg:#e6e6e6; --svra-fg-dim:#c0c0c0; --svra-fg-muted:#9a9a9a;
            --svra-border:#4a4a4a; --svra-border-soft:#3a3a3a; --svra-border-row:#2f2f2f;
            --svra-btn-bg:#2d3136; --svra-btn-bg-hover:#3a3f45; --svra-btn-fg:#e6e6e6;
            --svra-btn-primary-bg:#3b82f6; --svra-btn-primary-bg-hover:#2563eb; --svra-btn-primary-fg:#ffffff;
            --svra-btn-on-bg:#1e3a2a; --svra-btn-on-border:#34d399; --svra-btn-on-fg:#a7f3d0;
            --svra-btn-danger-fg:#f87171; --svra-btn-danger-border:#b91c1c;
            --svra-row-selected-bg:#1e3a2a;
            --svra-msg-bg:#252a30; --svra-msg-ok-bg:#1a2f22; --svra-msg-err-bg:#3a1e1e; --svra-msg-warn-bg:#3a2e1a;
            --svra-sub:#fbbf24; --svra-chip-bg:#33383e;
            --svra-tag-ok:#22c55e; --svra-tag-warn:#f59e0b; --svra-tag-err:#ef4444;
            --svra-seam-clean:#14b8a6; --svra-seam-old:#ef4444; --svra-seam-user:#a855f7;
            --svra-zoom-ok-bg:#1a2f22; --svra-zoom-ok-fg:#86efac;
            --svra-zoom-bad-bg:#3a2e1a; --svra-zoom-bad-fg:#fcd34d;
            --svra-guide-bg:#3a2e1a; --svra-guide-fg:#fcd34d;
            --svra-jdot:#60a5fa;
          }
        }
      `;
      document.head.appendChild(style);
      const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
      tabLabel.textContent = 'SV Roads';
      tabLabel.title = SCRIPT_NAME;
      this.pane = tabPane;
      tabPane.classList.add('svra');
      tabPane.addEventListener('click', (e) => this.onClick(e));
      tabPane.addEventListener('change', (e) => this.onChange(e));
      this._wireUndoForwarding();
      this.refresh();
    },

    _wireUndoForwarding() {
      if (this._undoWired) return;
      this._undoWired = true;
      this.pane.addEventListener('keydown', (e) => {
        const isUndo = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey;
        const isRedo = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'y' || e.key === 'Y' || (((e.key === 'z' || e.key === 'Z') && e.shiftKey)));
        if (!isUndo && !isRedo) return;
        const t = e.target;
        const tag = t && t.tagName;
        if ((tag === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio' && t.type !== 'button') || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopPropagation();
        // Browsers do not let a script-made key event trigger WME's own shortcut, so call WME's
        // undo/redo through the SDK. Fall back to a synthetic key event only if the SDK has no such call.
        const fire = () => {
          const map = document.querySelector('#WazeMap, .olMap');
          (map || document.body).dispatchEvent(new KeyboardEvent('keydown', {
            key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
            ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
            bubbles: true, cancelable: true
          }));
        };
        (async () => {
          try {
            if (isUndo) {
              // 1) newest candidate-level action (flip, 1W/2W)
              const local = LocalUndo.undo();
              if (local) { UI.changed(); UI.notify(`Undid ${local.label}.`, 'info'); return; }
              // 2) nothing left in WME to undo: clear the ticked candidates instead
              const cnt = await editCount();
              const ticked = Candidates.selected().length;
              if (cnt === 0 && ticked > 0) {
                Candidates.selectAll(false); UI.changed();
                UI.notify(`Cleared ${ticked} ticked candidate(s).`, 'info');
                return;
              }
            }
            // 3) WME's own undo
            const fn = isUndo ? sdk.Editing.undo : sdk.Editing.redo;
            if (typeof fn !== 'function') { fire(); return; }
            let r = fn.call(sdk.Editing);
            if (isPromise(r)) r = await r;
          } catch (err) {
            Log.w(`${isUndo ? 'undo' : 'redo'} through the SDK failed, trying a key event`, err);
            fire();
          }
        })();
      }, true);
    },

    notify(msg, level = 'info') {
      Log.i(msg);
      this.status = { msg, level };
      const el = this.pane && this.pane.querySelector('#svra-msg');
      if (el) { el.className = `msg ${level}`; el.textContent = msg; }
    },
    setConverting(on) {
      this.converting = on;
      const old = this.pane && this.pane.querySelector('#svra-stop');
      if (old) old.remove();
      const msg = this.pane && this.pane.querySelector('#svra-msg');
      if (on && msg) {
        const btn = document.createElement('button');
        btn.id = 'svra-stop'; btn.type = 'button'; btn.textContent = 'Stop converting';
        btn.style.cssText = 'margin:4px 0;padding:4px 10px;background:#c62828;color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600';
        btn.addEventListener('click', () => { Generated._stop = true; btn.disabled = true; btn.textContent = 'Stopping...'; });
        msg.insertAdjacentElement('afterend', btn);
      }
    },
    setBusy(b, text) {
      this.busy = b;
      if (this.pane) {
        if (b) this.pane.querySelectorAll('button[data-action]').forEach((b2) => { b2.disabled = true; });
        else this.refresh(); // rebuild so Convert/Remove get their correct enabled state
        const el = this.pane.querySelector('#svra-msg');
        if (el && text) { el.className = 'msg info'; el.textContent = text; }
        if (this.converting && !this.pane.querySelector('#svra-stop')) this.setConverting(true);
      }
    },
    changed() { this.refresh(); try { CandidateLayer.refresh(); } catch (e) { Log.e('cand layer', e); } },

    async updateZoom() {
      this.zoom = await MapUtil.zoom();
      const el = this.pane && this.pane.querySelector('#svra-zoom');
      if (el) this.paintZoom(el);
    },
    paintZoom(el) {
      const need = Settings.get('minScanZoom');
      const z = this.zoom === undefined ? null : this.zoom;
      const ok = z === null || z >= need;
      el.className = `zoom ${ok ? 'ok' : 'bad'}`;
      el.textContent = z === null ? `Scan works best at zoom ${need}+` : (ok ? `Zoom ${z}: ready to scan` : `Zoom ${z}: zoom in to ${need}+ to scan (lower zooms miss small streets)`);
    },

    updateGuide() {
      clearTimeout(this._gt);
      this._gt = setTimeout(() => this._doGuide().catch((e) => Log.d('guide failed', e)), 150);
    },
    async _doGuide() {
      if (State.scanning || !sdk) return;
      if (!Settings.get('showGuide')) {
        clearScanFrame(); this.guide = null;
        const el0 = this.pane && this.pane.querySelector('#svra-guide');
        if (el0) this.paintGuide(el0);
        return;
      }
      const ext = await MapUtil.extent();
      const plan = planScan(ext);
      showScanFrame(plan.extent, null, 'scanGuide');
      const [w, s, e, n] = plan.extent;
      const midLat = (s + n) / 2, midLon = (w + e) / 2;
      const wm = Geo.haversine([w, midLat], [e, midLat]), hm = Geo.haversine([midLon, s], [midLon, n]);
      this.guide = {
        text: `Scan area (orange frame): ${fmtLen(wm)} x ${fmtLen(hm)}, z${plan.zoom}, ${plan.tiles} tile(s).` +
          (plan.shrunk ? ' Only the centre of the view is covered: move/zoom the map, or raise the tile budget / lower the zoom to cover more.' : ' Covers the whole view.')
      };
      const el = this.pane && this.pane.querySelector('#svra-guide');
      if (el) this.paintGuide(el);
    },
    paintGuide(el) {
      if (!this.guide) { el.style.display = 'none'; el.textContent = ''; return; }
      el.style.display = '';
      el.className = 'zoom guide';
      el.textContent = this.guide.text;
    },

    trashCandidate(snap) {
      if (!snap || !snap.coords) return;
      State.trash = State.trash.filter((t) => t.id !== snap.id);
      State.trash.push(snap);
      if (State.trash.length > 200) State.trash.shift();
    },

    async removeSelected() {
      const gens = Generated.visible().filter((g) => g.selected);
      const nC = Candidates.selected().length;
      if (!gens.length && !nC) { this.notify('Tick something to remove first.', 'warn'); return; }
      if (gens.length) {
        const pending = gens.filter((g) => g.segmentIds.length && g.status !== 'Saved').length;
        const text = `Remove ${gens.length} generated segment(s)?`
          + (pending ? `\n\n${pending} unsaved segment(s) will be undone with WME's Undo (newest first). Their candidates can be restored afterwards.` : '')
          + '\n\nSegments already saved are never touched, only removed from this list.';
        if (!W.confirm(text)) return;
      }
      const c = Candidates.removeSelected();
      const g = gens.length ? await Generated.remove(gens) : { undone: 0, listed: 0, refused: null };
      const parts = [];
      if (c) parts.push(`${c} candidate(s)`);
      if (g.undone) parts.push(`${g.undone} segment(s) undone`);
      if (g.listed) parts.push(`${g.listed} removed from the list only`);
      this.notify(`Removed: ${parts.join(', ') || 'nothing'}.${g.refused ? ` Stopped: ${g.refused}` : ''}${State.trash.length ? ' You can restore removed candidates below.' : ''}`, g.refused ? 'warn' : 'ok');
      this.changed();
    },

    restoreTrash() {
      let n = 0;
      State.trash.forEach((t) => { if (Generated.restoreCandidate(t)) n++; });
      State.trash = [];
      this.notify(n ? `${n} candidate(s) restored.` : 'Nothing to restore.', n ? 'ok' : 'info');
      this.changed();
    },

    confirmConvert({ count, ticked, per, total, roadLabel, limit, risk, acked, autoBatch }) {
      return new Promise((resolve) => {
        const prevFocus = document.activeElement;
        const riskNote = risk
          ? `<div class="warnbox"><b>You have a lot of unsaved edits.</b> WME's save system can occasionally fail on large batches and may report that a change is not allowed at this time. Saving every ~10 drafts is recommended to avoid losing work. Lower the <i>WME save-warning threshold</i> in Settings or Save more often if that happens.</div>`
          : '';
        const remainingAfter = Math.max(0, ticked - count);
        const lead = autoBatch
          ? `<p class="lead">This click will propose up to <b>${count}</b> draft segments, in <b>${total}</b> sub-batch(es) of up to <b>${per}</b>.${remainingAfter > 0 ? ` <b>${remainingAfter}</b> ticked candidate(s) will stay ticked after this click.` : ''} The map returns to your view when finished.</p>`
          : `<p class="lead">This click will propose up to <b>${count}</b> draft segments in a single sub-batch of up to <b>${per}</b>.${remainingAfter > 0 ? ` <b>${remainingAfter}</b> ticked candidate(s) will stay ticked — review the drafts, then click <b>Convert</b> again.` : ''} The map returns to your view when finished.</p>`;
        const body = `
            ${lead}${riskNote}
            <h5>What the script does</h5>
            <ul>
              <li>Proposes a draft <b>${roadLabel}</b> segment for each ticked candidate, shaped from the Street View coverage gap.</li>
              <li>Drafts are <b>not</b> connected to existing roads. No existing segment, junction, or turn setting is changed.</li>
              <li><b>Nothing is saved.</b> Drafts stay pending in WME until <b>you</b> press <b>Save</b>.</li>
            </ul>
            <h5>Your responsibility before saving</h5>
            <ul>
              <li>Align each generated segment to the <b>actual road centerline</b>.</li>
              <li>Confirm the shape against the <b>latest satellite imagery</b>.</li>
              <li>Connect intersections and correct geometry by hand.</li>
              <li>Undo at any time with <b>Remove</b> in this panel, or <b>Ctrl+Z</b> in WME.</li>
              <li>Follow your local community's editing standards.</li>
            </ul>`;
        const ackBlock = `<label class="ack"><input type="checkbox" id="svra-dlg-ack"><span>I understand this is manual assistance, and I will align every segment to the road centerline / satellite imagery and review it before saving.</span></label>`;
        const overlay = document.createElement('div');
        overlay.className = 'svra-overlay';
        overlay.innerHTML = `
          <div class="svra svra-modal" role="dialog" aria-modal="true" aria-labelledby="svra-dlg-title">
            <h3 id="svra-dlg-title">Convert ${count} candidates to draft segments?</h3>
            ${body}
            ${acked ? '' : ackBlock}
            <div class="actions">
              <button type="button" id="svra-dlg-cancel">Cancel</button>
              <button type="button" class="primary" id="svra-dlg-ok" ${acked ? '' : 'disabled'}>Convert ${count} candidates</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const ack = overlay.querySelector('#svra-dlg-ack');
        const ok = overlay.querySelector('#svra-dlg-ok');
        const cancel = overlay.querySelector('#svra-dlg-cancel');

        const close = (result) => {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
          try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* ignore */ }
          resolve(result);
        };
        const onKey = (e) => {
          if (!overlay.isConnected) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
          if (e.key === 'Tab') {
            const f = [ack, cancel, ok].filter((x) => x && !x.disabled);
            const i = f.indexOf(document.activeElement);
            const next = e.shiftKey ? f[(i <= 0 ? f.length : i) - 1] : f[(i + 1) % f.length];
            e.preventDefault(); next.focus();
          }
          e.stopPropagation();
        };
        document.addEventListener('keydown', onKey, true);
        if (ack) ack.addEventListener('change', () => { ok.disabled = !ack.checked; });
        ok.addEventListener('click', () => {
          if (ack && !ack.checked) return;
          if (!acked) {
            Settings.set('responsibilityAcknowledged', true);
            Settings.set('responsibilityAcknowledgedAt', Date.now());
          }
          close(true);
        });
        cancel.addEventListener('click', () => close(false));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
        if (ack) ack.focus(); else ok.focus();
      });
    },
    _esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    // Collapse the 'Manual review only' dropdown (used when the editor starts a Scan or Convert).
    _closeNotes() {
      this._notesOpen = false;
      const d = this.pane && this.pane.querySelector('details.notes');
      if (d) d.open = false;
    },
    // Friendly checkpoint: advises the editor, never blocks anything. Dismiss with the x.
    checkpoint(msgs) {
      const list = (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean);
      if (!list.length) return;
      this._checkpoint = list;
      list.forEach((m) => Log.i(`Reminder: ${m}`));
      this.refresh();
    },
    _checkpointHtml() {
      if (!this._checkpoint || !this._checkpoint.length) return '';
      return `<div class="checkpoint"><button data-action="checkpoint-close" class="x" title="Dismiss">&#10005;</button><b>Friendly reminder</b> (never stops Convert)${this._checkpoint.map((m) => `<div>${this._esc(m)}</div>`).join('')}</div>`;
    },
    _seamBadge(seam, endLabel) {
      if (!seam) return '';
      if (seam.state === 'break-old-locked') {
        return `<span class="seam old" title="${endLabel}: existing segment #${seam.segId} is ${seam.segDir} and cannot be reversed. Flow break here.">⚠ old #${seam.segId}</span>`;
      }
      if (seam.state === 'break-user') return `<span class="seam user" title="${endLabel}: flow break due to a hand-locked neighbour.">⚠ user</span>`;
      return `<span class="seam clean" title="${endLabel}: clean B|A seam.">✓</span>`;
    },

    _scrollParent() {
      for (let el = this.pane; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
      }
      return this.pane;
    },

    refresh() {
      if (!this.pane) return;
      // Keep the Settings drawer open and the scroll position across the full re-render.
      const prevDet = this.pane.querySelector('details.more');
      if (prevDet) this._settingsOpen = prevDet.open;
      const prevNotes = this.pane.querySelector('details.notes');
      if (prevNotes) this._notesOpen = prevNotes.open;
      const scroller = this._scrollParent();
      const prevTop = scroller ? scroller.scrollTop : 0;
      const s = Settings.data;
      const cands = [...State.candidates.values()].filter((c) => c.status === 'Candidate');
      const gens = Generated.visible();
      const selC = cands.filter((c) => c.selected).length;
      const selG = gens.filter((g) => g.selected).length;
      const allC = cands.length > 0 && selC === cands.length;
      const allG = gens.length > 0 && selG === gens.length;
      const warnings = gens.filter((g) => g.errors.length || g.status === 'Needs Manual Review').length;
      const off = this.busy ? 'disabled' : '';

      const candRows = cands.map((c) => {
        const seamBadges = `${c.jStart ? '<span class="jdot" title="A end is a junction"></span>' : ''}${this._seamBadge(c.seamStart, 'A end')}${c.jEnd ? '<span class="jdot" title="B end is a junction"></span>' : ''}`;
        return `
        <tr class="${c.selected ? 'sel' : ''}">
          <td><input type="checkbox" data-select-cand="${c.id}" ${c.selected ? 'checked' : ''}></td>
          <td>${c.id}</td>
          <td>${fmtLen(c.length)}</td>
          <td>${seamBadges}</td>
          <td>${c.review ? `<span class="tag t-warn" title="${this._esc(c.review)}">Review</span>` : ''}</td>
          <td class="act">
            <button data-action="flip-cand" data-id="${c.id}" title="Swap A and B (reverse node locations). Propagates along the junction chain.">&#8646;</button>
            <button data-action="oneway-cand" data-id="${c.id}" class="${c.oneWay ? 'on' : ''}" title="Switch between two-way (2W) and one-way A to B (1W)">${c.oneWay ? '1W' : '2W'}</button>
            <button data-action="zoom-cand" data-id="${c.id}" title="Zoom to">&#8982;</button>
          </td>
        </tr>`;
      }).join('');

      const genRows = gens.map((g) => {
        const cls = g.status === 'OK' || g.status === 'Saved' ? 't-ok' : g.status === 'Warning' || g.status === 'Needs Manual Review' ? 't-warn' : 't-err';
        const note = this._esc([g.review, ...g.errors].filter(Boolean).join('; '));
        return `
        <tr class="${g.selected ? 'sel' : ''}">
          <td><input type="checkbox" data-select-gen="${g.id}" ${g.selected ? 'checked' : ''}></td>
          <td>${g.id}${note ? `<div class="sub">${note}</div>` : ''}</td>
          <td>${g.segmentIds && g.segmentIds.length ? `${g.segmentIds[0]}${g.segmentIds.length > 1 ? ` <span class="sub">+${g.segmentIds.length - 1}</span>` : ''}` : '&mdash;'}</td>
          <td><span class="tag ${cls}">${g.status}</span></td>
          <td class="act"><button data-action="zoom-gen" data-id="${g.id}" title="Zoom to">&#8982;</button></td>
        </tr>`;
      }).join('');

      const table = (head, rows, empty) => (rows
        ? `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${empty}</div>`);
      const nSel = selC + selG;

      this.pane.innerHTML = `
        <div class="top">
          <button class="primary" data-action="scan" ${off}>Scan</button>
          <button class="primary wide" data-action="convert" ${off || (selC ? '' : 'disabled')} title="Turn the ticked candidates into editable WME segments. Repeat as needed — the script only warns near WME's technical limit; Save clears it.">Convert${selC ? ` (${selC})` : ''}</button>
          <button class="danger" data-action="remove-sel" ${off || (nSel ? '' : 'disabled')} title="Remove everything ticked below">Remove${nSel ? ` (${nSel})` : ''}</button>
        </div>
        <div class="sub" style="margin-bottom:4px">Draft proposal tool for manual editing. No automatic writes; no modification of existing map data. Built to assist a human editor, not to mass-edit: the tool proposes, the editor decides.</div>
        ${this._checkpointHtml()}
        <details class="notes"><summary>Manual review only</summary>
        <div class="notice"><b>Manual review only.</b> The script proposes draft segments; <b>you</b> decide what to keep, correct, and save. It is not an automated editor.</div>
        <div class="notice"><b>Before you press Save.</b> For every draft: align it to the <b>real road centerline</b>, then <b>verify its shape against the latest satellite imagery</b>. The geometry comes from a traced Street View coverage gap and is <i>not</i> final. Only WME's native <b>Save</b> commits it.</div>
        <div class="notice"><b>What the script never does.</b> It never saves, never edits existing segments, junctions, or turn restrictions, and never connects a draft to a road. Every draft stays pending until <b>you</b> press Save, and every draft can be undone with <b>Remove</b> or <b>Ctrl+Z</b> in WME.</div>
        </details>
        <div class="top">
          <button class="${Coverage.visible ? 'on' : ''}" data-action="cov-toggle" title="Street View coverage layer: green = ON, grey = OFF">Street View</button>
          <button class="${s.showGuide ? 'on' : ''}" data-action="guide-toggle" title="Orange scan-area frame: green = ON, grey = OFF">Guide</button>
        </div>
        <div id="svra-zoom" class="zoom"></div>
        <div id="svra-guide" class="zoom guide" style="display:none"></div>
        <div id="svra-msg" class="msg ${(this.status || {}).level || ''}">${(this.status || {}).msg || `Zoom in to ${s.minScanZoom}+ &rarr; Scan &rarr; tick candidates &rarr; Convert &rarr; review &rarr; WME Save. The script warns near WME's edit limit; WME's Save clears it.`}</div>
        ${State.trash.length ? `<div><button data-action="restore-trash" ${off}>Restore ${State.trash.length} removed candidate(s)</button></div>` : ''}

        <div class="sec">
          <div class="sech"><b>Candidates</b><span class="n">${cands.length}</span>
            <span class="bar">
              <button data-action="flip-sel" ${off} title="Swap A and B on the ticked candidates (propagates along junction chains)">&#8646; ticked</button>
              <button data-action="oneway-sel" ${off} title="Switch the ticked candidates between two-way and one-way">1W/2W ticked</button>
            </span>
          </div>
          ${table(`<th><input type="checkbox" data-selectall="cand" title="Select all candidates" ${allC ? 'checked' : ''}></th><th>ID</th><th>Length</th><th>Seam</th><th>Note</th><th></th>`, candRows, 'No candidates. Press Scan.')}
          <div class="sub">Flow is A&gt;B (A = first point / from-node, B = last point / to-node). Junction-split pieces are shown with a blue dot; a seam badge warns where an existing segment's orientation forces a flow break.</div>
        </div>

        <div class="sec">
          <div class="sech"><b>Generated segments</b><span class="n">${gens.length}</span>${warnings ? `<span class="tag t-warn">${warnings} to check</span>` : ''}</div>
          ${table(`<th><input type="checkbox" data-selectall="gen" title="Select all generated segments" ${allG ? 'checked' : ''}></th><th>ID</th><th>Segment</th><th>Status</th><th></th>`, genRows, 'Nothing converted yet.')}
        </div>

        <details class="more"><summary>Settings (saved on change)</summary>
          <label>Min map zoom to scan <input type="number" min="10" max="22" data-setting="minScanZoom" value="${s.minScanZoom}"></label>
          <label>Zoom button level <input type="number" min="10" max="22" data-setting="focusZoom" value="${s.focusZoom}"></label>
          <label>Detection radius (m) <input type="number" min="3" max="200" data-setting="detectionRadius" value="${s.detectionRadius}"></label>
          <label>Min candidate length (m) <input type="number" min="10" max="500" data-setting="minCandidateLength" value="${s.minCandidateLength}"></label>
          <label>Max candidates stored <input type="number" min="10" max="5000" data-setting="maxCandidatesStorage" value="${s.maxCandidatesStorage}"></label>
          <label>Drafts per sub-batch (continues silently after you accept the notice) <input type="number" min="1" max="50" data-setting="maxDraftCreationBatch" value="${s.maxDraftCreationBatch}"></label>
          <label>Drafts per convert click (max 50) <input type="number" min="1" max="50" data-setting="maxConvertPerClick" value="${s.maxConvertPerClick}"></label>
          <label>Remind me when unsaved edits reach (script default 300; 0 = never) <input type="number" min="0" max="1000" data-setting="maxPendingEdits" value="${s.maxPendingEdits}"></label>
          <label>Unverified-draft reminder at % of the per-click cap (script default 150; 0 = off) <input type="number" min="0" max="500" data-setting="unverifiedSoftStopPct" value="${s.unverifiedSoftStopPct}"></label>
          <label>Pause between batches (ms) <input type="number" min="0" max="20000" step="100" data-setting="batchPauseMs" value="${s.batchPauseMs}"></label>
          <label>Delay between segments (ms) <input type="number" min="0" max="5000" data-setting="convertDelayMs" value="${s.convertDelayMs}"></label>
          <label>Zoom level when panning to convert (12-18) <input type="number" min="12" max="18" step="1" data-setting="convertZoom" value="${s.convertZoom}"></label>
          <label>Wait for map tiles before Convert (ms) <input type="number" min="500" max="10000" step="100" data-setting="tileSettleMs" value="${s.tileSettleMs}"></label>
          <label>High-lock buffer (m) <input type="number" min="0" max="100" data-setting="highLockBuffer" value="${s.highLockBuffer}"></label>
          <label>Road type <select data-setting="roadPreset">${PRESETS.map((p) => `<option value="${p.key}" ${p.key === s.roadPreset ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
          <label><input type="checkbox" data-setting="splitAtJunctions" ${s.splitAtJunctions ? 'checked' : ''}> Split candidates at junctions (recommended)</label>
          <label><input type="checkbox" data-setting="autoSampleZoom" ${s.autoSampleZoom ? 'checked' : ''}> Auto scan resolution (scan the whole window)</label>
          <label>Tile budget per scan <input type="number" min="4" max="400" step="1" data-setting="maxSampleTiles" value="${s.maxSampleTiles}"></label>
          ${s.autoSampleZoom ? '' : `
            <label>Fixed sample zoom (an orange guide frame shows the scanned area)
              <select data-setting="sampleZoom">
                <option value="17" ${s.sampleZoom === 17 ? 'selected' : ''}>Coarse — z17 (~2.4 m/cell)</option>
                <option value="18" ${s.sampleZoom === 18 ? 'selected' : ''}>Normal — z18 (~1.2 m/cell)</option>
                <option value="19" ${s.sampleZoom === 19 ? 'selected' : ''}>Fine — z19 (~0.6 m/cell)</option>
                <option value="20" ${s.sampleZoom === 20 ? 'selected' : ''}>Very fine — z20 (~0.3 m/cell)</option>
              </select>
            </label>`}

          <label><input type="checkbox" data-setting="autoCoverage" ${s.autoCoverage ? 'checked' : ''}> Auto show/hide coverage with Street View</label>
          <label><input type="checkbox" data-setting="responsibilityAcknowledged" ${s.responsibilityAcknowledged ? 'checked' : ''}> I have read the responsibility statement (uncheck to be asked again)</label>
        </details>`;
      const newDet = this.pane.querySelector('details.more');
      if (newDet && this._settingsOpen) newDet.open = true;
      const newNotes = this.pane.querySelector('details.notes');
      if (newNotes && this._notesOpen) newNotes.open = true;
      if (scroller) scroller.scrollTop = prevTop;
      const zoomEl = this.pane.querySelector('#svra-zoom');
      if (zoomEl) this.paintZoom(zoomEl);
      const guideEl = this.pane.querySelector('#svra-guide');
      if (guideEl) this.paintGuide(guideEl);
    },

    onClick(e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.id;
      safe(`ui ${btn.dataset.action}`, () => {
        switch (btn.dataset.action) {
          case 'scan': this._closeNotes(); LocalUndo.clear(); Candidates.scan(); break;
          case 'remove-sel': LocalUndo.clear(); this.removeSelected().catch((e2) => Log.e('remove', e2)); break;
          case 'cov-toggle': Coverage.toggle(); this.refresh(); break;
          case 'guide-toggle': Settings.set('showGuide', !Settings.get('showGuide')); this.updateGuide(); this.refresh(); break;
          case 'checkpoint-close': this._checkpoint = null; this.refresh(); break;
          case 'flip-cand': { const c = State.candidates.get(id); if (c) { LocalUndo.push(`flip of ${c.id}`); Candidates.flip(c); this.changed(); } break; }
          case 'oneway-cand': { const c = State.candidates.get(id); if (c) { LocalUndo.push(`1W/2W change of ${c.id}`); Candidates.toggleOneWay(c); this.changed(); } break; }
          case 'flip-sel': {
            const list = Candidates.selected();
            if (!list.length) this.notify('Tick candidate(s) first.', 'warn');
            else { LocalUndo.push(`flip of ${list.length} candidate(s)`); list.forEach((c) => Candidates.flip(c)); this.changed(); }
            break;
          }
          case 'oneway-sel': {
            const list = Candidates.selected();
            if (!list.length) this.notify('Tick candidate(s) first.', 'warn');
            else { LocalUndo.push(`1W/2W change of ${list.length} candidate(s)`); const to = !list.every((c) => c.oneWay); list.forEach((c) => { c.oneWay = to; }); this.changed(); }
            break;
          }
          case 'convert': this._closeNotes(); LocalUndo.clear(); UI.setConverting(true); Generated.convertSelected().catch((e3) => Log.e('convert', e3)).finally(() => { Generated._stop = false; UI.setConverting(false); }); break;
          case 'zoom-cand': { const c = State.candidates.get(id); if (c) MapUtil.focus(c.coords[Math.floor(c.coords.length / 2)]).catch(() => {}); break; }
          case 'zoom-gen': { const g = State.generated.get(id); if (g) Generated.zoomTo(g).catch(() => {}); break; }
          case 'select-gen': { const g = State.generated.get(id); if (g) Generated.select(g).catch(() => {}); break; }
          case 'restore-trash': LocalUndo.clear(); this.restoreTrash(); break;
          default: break;
        }
      });
    },

    onChange(e) {
      const t = e.target;
      if (t.dataset.selectCand) { const c = State.candidates.get(t.dataset.selectCand); if (c) c.selected = !!t.checked; this.changed(); return; }
      if (t.dataset.selectGen) { const g = State.generated.get(t.dataset.selectGen); if (g) g.selected = !!t.checked; this.changed(); return; }
      if (t.dataset.selectall === 'cand') { Candidates.selectAll(t.checked); this.changed(); return; }
      if (t.dataset.selectall === 'gen') { Generated.visible().forEach((g) => { g.selected = !!t.checked; }); this.changed(); return; }
      const key = t.dataset.setting;
      if (!key) return;
      const NUMERIC_SETTINGS = new Set(['detectionRadius', 'minCandidateLength', 'maxCandidatesStorage', 'maxDraftCreationBatch', 'maxConvertPerClick', 'maxPendingEdits', 'unverifiedSoftStopPct', 'batchPauseMs', 'convertDelayMs', 'tileSettleMs', 'convertZoom', 'minScanZoom', 'focusZoom', 'highLockBuffer', 'sampleZoom', 'cellPx', 'maxSampleTiles']);
      const CLAMPS = {
        minScanZoom: [10, 22], focusZoom: [10, 22], detectionRadius: [3, 200],
        minCandidateLength: [10, 500], maxCandidatesStorage: [10, 5000],
        maxDraftCreationBatch: [1, 50], maxConvertPerClick: [1, 50], unverifiedSoftStopPct: [0, 500],
        maxPendingEdits: [0, 1000], batchPauseMs: [0, 20000],
        convertDelayMs: [0, 5000], tileSettleMs: [500, 10000], convertZoom: [12, 18], highLockBuffer: [0, 100],
        sampleZoom: [16, 20], cellPx: [1, 4], maxSampleTiles: [4, 400]
      };
      let val;
      if (t.type === 'checkbox') val = t.checked;
      else if (NUMERIC_SETTINGS.has(key)) {
        const n = Number(t.value);
        const [lo, hi] = CLAMPS[key] || [0, Infinity];
        val = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : (DEFAULT_SETTINGS[key] ?? lo);
      } else val = t.value;
      Settings.set(key, val);
      this.changed();
      if (['autoSampleZoom', 'sampleZoom', 'maxSampleTiles', 'splitAtJunctions'].includes(key)) this.updateGuide();
    }
  };

  /* ===== LOCAL UNDO (candidate-level actions: flip, 1W/2W) ===== */
  // These are not WME edits, so WME's undo cannot reverse them. Each action saves a snapshot of the
  // candidates' orientation fields first; Ctrl+Z in the panel restores the newest snapshot.
  const LocalUndo = {
    stack: [],
    push(label) {
      const snap = new Map();
      State.candidates.forEach((c, id) => {
        if (c.status !== 'Candidate') return;
        snap.set(id, {
          coords: c.coords, length: c.length, origStart: c.origStart, origEnd: c.origEnd,
          jStart: c.jStart, jEnd: c.jEnd, seamStart: c.seamStart, seamEnd: c.seamEnd,
          flowLocked: c.flowLocked, oneWay: c.oneWay
        });
      });
      this.stack.push({ label, snap });
      if (this.stack.length > 30) this.stack.shift();
    },
    clear() { this.stack.length = 0; },
    undo() {
      const e = this.stack.pop();
      if (!e) return null;
      let n = 0;
      e.snap.forEach((v, id) => {
        const c = State.candidates.get(id);
        if (c && c.status === 'Candidate') { Object.assign(c, v); n++; }
      });
      return { label: e.label, n };
    }
  };

  /* ===== MAP EVENTS ===== */
  function wireMapEvents() {
    sdk.Events.on({
      eventName: 'wme-layer-feature-clicked',
      eventHandler: async ({ featureId, layerName }) => {
        if (layerName !== LAYER_CANDIDATE || typeof featureId !== 'string') return;
        const m = /^(C-\d+)(?:-|$)/.exec(featureId);   // line, arrow and junction-dot ids all start with the candidate id
        const c = State.candidates.get(m ? m[1] : featureId);
        if (!c || c.status !== 'Candidate') return;
        // While the editor works on a draft segment, a click that lands on a nearby candidate line is
        // part of that edit (dragging a node, selecting the draft), not a request to tick the candidate.
        await sleep(60);
        if (await editingDraft()) { Log.d(`ignored click on ${c.id}: a draft segment is selected`); return; }
        c.selected = !c.selected; UI.changed();
      }
    });
    sdk.Events.on({
      eventName: 'wme-layer-checkbox-toggled',
      eventHandler: ({ name, checked }) => {
        if (name === LAYER_COVERAGE) { Coverage.manual = checked; Coverage.setVisible(checked); UI.refresh(); }
        else if (name === LAYER_CANDIDATE) safe('cand vis', () => sdk.Map.setLayerVisibility({ layerName: LAYER_CANDIDATE, visibility: checked }));
      }
    });
    sdk.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: () => { UI.updateZoom(); UI.updateGuide(); } });
    safe('map-move-end', () => sdk.Events.on({ eventName: 'wme-map-move-end', eventHandler: () => UI.updateGuide() }));

    let loadTimer = null;
    sdk.Events.on({
      eventName: 'wme-map-data-loaded',
      eventHandler: () => {
        MapLoad.notify();
        clearTimeout(loadTimer);
        loadTimer = setTimeout(async () => {
          try { await WazeData.refresh(); if (Candidates.pruneMapped()) UI.changed(); } catch (err) { Log.e('map-data-loaded', err); }
        }, 400);
      }
    });
    const rec = () => Generated.scheduleReconcile();
    safe('track segments', () => sdk.Events.trackDataModelEvents({ dataModelName: 'segments' }));
    ['wme-after-undo', 'wme-after-edit', 'wme-no-edits'].forEach((eventName) => sdk.Events.on({ eventName, eventHandler: rec }));
    ['wme-data-model-objects-added', 'wme-data-model-objects-removed'].forEach((eventName) => sdk.Events.on({
      eventName, eventHandler: (a) => { if (!a || a.dataModelName === 'segments') rec(); }
    }));
    sdk.Events.on({ eventName: 'wme-after-redo-clear', eventHandler: () => { Generated.purgeUndone(); rec(); } });
    sdk.Events.on({ eventName: 'wme-save-finished', eventHandler: (a) => Generated.onSaved(!a || a.success !== false) });
    sdk.Events.on({
      eventName: 'wme-data-model-object-changed-id',
      eventHandler: (a) => {
        if (a && a.dataModelName && a.dataModelName !== 'segments') return;
        const list = a && a.objectIds ? (Array.isArray(a.objectIds) ? a.objectIds : [a.objectIds]) : [];
        Generated.onIdsChanged(list);
      }
    });
  }

  /* ===== CANDIDATE VECTOR LAYER ===== */
  const CandidateLayer = {
    init() {
      try {
        sdk.Map.addLayer({
          layerName: LAYER_CANDIDATE,
          zIndexing: true,
          styleRules: [
            { style: { strokeColor: '#ff6600', strokeWidth: 4, strokeDashstyle: 'dash', strokeOpacity: 1, pointRadius: 6, fillColor: '#ff6600', fillOpacity: 1 } },
            { predicate: (p) => p.review && !p.selected, style: { strokeColor: '#ffb300', strokeWidth: 5, strokeDashstyle: 'dash' } },
            { predicate: (p) => p.selected, style: { strokeColor: '#00cc44', strokeWidth: 10, strokeDashstyle: 'solid', strokeOpacity: 1 } },
            { predicate: (p) => p.arrow, style: { strokeColor: '#111111', strokeWidth: 3, strokeDashstyle: 'solid', strokeOpacity: 1 } },
            { predicate: (p) => p.arrow && p.oneWay, style: { strokeColor: '#d50000', strokeWidth: 4 } },
            { predicate: (p) => p.junction, style: { strokeColor: '#1a73e8', strokeWidth: 1, strokeDashstyle: 'solid', strokeOpacity: 0, fillColor: '#1a73e8', fillOpacity: 1, pointRadius: 5 } }
          ]
        });
        Log.i('CandidateLayer.init: layer created');
      } catch (err) {
        Log.e('CandidateLayer.init: addLayer failed', err);
      }
      safe('cand cb', () => sdk.LayerSwitcher.addLayerCheckbox({ name: LAYER_CANDIDATE, isChecked: true }));
      safe('cand vis', () => sdk.Map.setLayerVisibility({ layerName: LAYER_CANDIDATE, visibility: true }));
      safe('track', () => sdk.Events.trackLayerEvents({ layerName: LAYER_CANDIDATE }));
    },

    refresh() {
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_CANDIDATE }); }
      catch (err) { Log.w('candidate layer: removeAll failed', err); }

      const features = [];
      State.candidates.forEach((c) => {
        if (c.status !== 'Candidate') return;
        features.push({
          type: 'Feature',
          id: c.id + (c.selected ? '-sel-' : '-u-') + Math.random().toString(36).slice(2, 6),
          geometry: { type: 'LineString', coordinates: c.coords },
          properties: { selected: !!c.selected, review: !!c.review }
        });
        const chev = flowChevron(c.coords);
        if (chev) {
          features.push({
            type: 'Feature',
            id: c.id + (c.selected ? '-sel-' : '-u-') + 'z' + Math.random().toString(36).slice(2, 6),
            geometry: { type: 'LineString', coordinates: chev },
            properties: { selected: false, review: false, arrow: true, oneWay: !!c.oneWay }
          });
        }
        for (const [flag, pt] of [[c.jStart, c.coords[0]], [c.jEnd, c.coords[c.coords.length - 1]]]) {
          if (!flag) continue;
          features.push({
            type: 'Feature',
            id: c.id + '-j-' + Math.random().toString(36).slice(2, 6),
            geometry: { type: 'Point', coordinates: pt },
            properties: { junction: true }
          });
        }
      });
      if (!features.length) return;
      try { sdk.Map.addFeaturesToLayer({ layerName: LAYER_CANDIDATE, features }); }
      catch (err) { Log.e('CandidateLayer.refresh: addFeaturesToLayer failed', err); }
    }
  };

  /* ===== BOOTSTRAP ===== */
  function waitFor(pred, timeoutMs = 30000, step = 250) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        const v = pred();
        if (v) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout'));
        setTimeout(tick, step);
      })();
    });
  }

  async function bootstrap() {
    try {
      await waitFor(() => W.SDK_INITIALIZED);
      await W.SDK_INITIALIZED;
      if (typeof W.getWmeSdk !== 'function') throw new Error('getWmeSdk not available');
      sdk = W.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
      Log.i('SDK initialized in async mode');
      await sdk.Events.once({ eventName: 'wme-ready' });
      Log.i('WME ready');

      try {
        let u = sdk.DataModel.Users.getCurrentUser();
        if (isPromise(u)) u = await u;
        State.editorRank = (u && typeof u.rank === 'number') ? u.rank : 0;
      } catch (err) {
        Log.w('Could not read editor rank, defaulting to L1', err);
        State.editorRank = 0;
      }

      Settings.load();
      await WazeData.refresh();
      Coverage.init();
      CandidateLayer.init();
      await UI.init();
      wireMapEvents();
      UI.updateZoom();
      UI.updateGuide();
      Coverage.watchStreetView();

      UI.changed();
      W.__SVRA__ = { State, Settings, Geo, Junctions, Chain, Candidates, Generated, Coverage };
      Log.i('Initialised v1.0.0-beta (build 2026-11-07-m: merged drafts, empty-view wait, author defaults)');
    } catch (err) {
      Log.e('Initialisation failed', err);
    }
  }

  bootstrap();
})();
