import { MODEL } from './aircraft';
import { AIRPORT_LL } from './airportCoords';
import { cityAirport } from './airports';
import type { AirportMapData } from './airportTypes';
import { CITY } from './cities';
import type { ModelDef } from './types';

/**
 * '타 보기'(운항 중인 비행기에 타 보기)의 비행 길.
 *
 * 지구는 반지름 6,371 km의 공으로 보고, 출발 공항 활주로 끝에서 이륙 활주 → 상승하며 곧게 → 선회 →
 * 대권 항로로 순항 → 강하 → 선회해 최종 접근(3° 활공각) → 착륙 → 착륙 활주로 멈출 때까지를 계산한다.
 * 공항은 모두 바다 높이(0 m)로 본다. 바람은 없다.
 *
 * 화면(three.js)과 상관없는 계산만 둔다 (node에서 테스트한다).
 */

export const EARTH_R = 6_371_000;
const D2R = Math.PI / 180;
const G = 9.81;

/** [위도, 경도] (도) */
export type LL = readonly [number, number];
export type V3 = [number, number, number];

// ------------------------------------------------------------------ 지구 위 계산

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 0 … 2π */
const wrap2Pi = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 위도·경도 → 지구 중심에서 본 단위 벡터 (x: 경도 0, y: 동경 90°, z: 북극) */
export function llToVec(ll: LL): V3 {
  const la = ll[0] * D2R;
  const lo = ll[1] * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function vecToLl(v: V3): LL {
  const n = norm3(v);
  return [Math.asin(clamp(n[2], -1, 1)) / D2R, Math.atan2(n[1], n[0]) / D2R];
}

/** 그 자리의 동·북·위 방향 (지구 중심 좌표의 단위 벡터) */
export function enuBasis(ll: LL): { e: V3; n: V3; u: V3 } {
  const la = ll[0] * D2R;
  const lo = ll[1] * D2R;
  return {
    e: [-Math.sin(lo), Math.cos(lo), 0],
    n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    u: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
  };
}

/** 두 점 사이 대권 거리 (m) */
export function gcDistance(a: LL, b: LL): number {
  const va = llToVec(a);
  const vb = llToVec(b);
  const c: V3 = [va[1] * vb[2] - va[2] * vb[1], va[2] * vb[0] - va[0] * vb[2], va[0] * vb[1] - va[1] * vb[0]];
  return Math.atan2(len3(c), dot3(va, vb)) * EARTH_R;
}

/** a에서 b로 가는 대권의 처음 방위 (라디안, 북 0·동 π/2) */
export function bearing(a: LL, b: LL): number {
  const la1 = a[0] * D2R;
  const la2 = b[0] * D2R;
  const dl = (b[1] - a[1]) * D2R;
  return Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl));
}

/** a에서 방위 brg로 d(m) 간 곳 */
export function destination(a: LL, brg: number, d: number): LL {
  const la1 = a[0] * D2R;
  const lo1 = a[1] * D2R;
  const dr = d / EARTH_R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(brg));
  const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
  return [la2 / D2R, wrapPi(lo2) / D2R];
}

/** 기준점 둘레의 평면 좌표 (동 e, 북 n; m) → 위도·경도 (방위 등거리: 기준점에서 잰 거리·방위가 그대로) */
export function localToLl(origin: LL, e: number, n: number): LL {
  const d = Math.hypot(e, n);
  return d < 1e-6 ? origin : destination(origin, Math.atan2(e, n), d);
}

/** 위도·경도 → 기준점 둘레의 평면 좌표 [동, 북] (m) */
export function llToLocal(origin: LL, p: LL): [number, number] {
  const d = gcDistance(origin, p);
  if (d < 1e-6) return [0, 0];
  const b = bearing(origin, p);
  return [Math.sin(b) * d, Math.cos(b) * d];
}

// ------------------------------------------------------------------ 공항

export interface RideAirport {
  city: string;
  icao: string;
  iata: string;
  /** 공항 한글 이름 */
  name: string;
  map: AirportMapData;
  /** 도면의 (cx, cy)가 놓이는 위도·경도 */
  ll: LL;
  /** 활주로 한가운데들의 평균 (도면 좌표, m) — 공항 기준점에 맞춘다 */
  cx: number;
  cy: number;
}

/** 그 해 그 도시의 대표 공항 (도면이 없으면 null) */
export function rideAirport(cityId: string, year: number): RideAirport | null {
  const ap = cityAirport(cityId, year);
  const city = CITY[cityId];
  if (!ap?.map || !city) return null;
  const map = ap.map;
  let cx = map.w / 2;
  let cy = map.h / 2;
  if (map.rwy.length) {
    cx = map.rwy.reduce((a, r) => a + (r[0] + r[2]) / 2, 0) / map.rwy.length;
    cy = map.rwy.reduce((a, r) => a + (r[1] + r[3]) / 2, 0) / map.rwy.length;
  }
  const ll = AIRPORT_LL[ap.info.icao] ?? ([city.lat, city.lon] as const);
  return { city: cityId, icao: ap.info.icao, iata: ap.info.iata, name: ap.info.name, map, ll, cx, cy };
}

/** 도면 좌표 (x 동쪽, y 남쪽; m) → 공항 평면 좌표 [동, 북] */
export function frameToLocal(ap: RideAirport, x: number, y: number): [number, number] {
  return [x - ap.cx, ap.cy - y];
}

/** 한 방향으로 쓰는 활주로 */
export interface RunwayDir {
  /** '16L' 같은 이름 (이 방향으로 뜨고 내린다) */
  name: string;
  /** 활주로 문턱 (이 방향의 시작 끝, 공항 평면 좌표) */
  thr: [number, number];
  /** 반대쪽 끝 */
  end: [number, number];
  /** 방위 (라디안) */
  hdg: number;
  len: number;
  width: number;
}

export function runwayDirs(ap: RideAirport): RunwayDir[] {
  const out: RunwayDir[] = [];
  for (const [x1, y1, x2, y2, width, name] of ap.map.rwy) {
    const a = frameToLocal(ap, x1, y1);
    const b = frameToLocal(ap, x2, y2);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 300) continue;
    const [n1, n2] = name.split('/');
    out.push({ name: n1 || name, thr: a, end: b, hdg: Math.atan2(b[0] - a[0], b[1] - a[1]), len, width });
    out.push({ name: n2 || name, thr: b, end: a, hdg: Math.atan2(a[0] - b[0], a[1] - b[1]), len, width });
  }
  if (!out.length) {
    // 활주로가 없는 도면: 기준점에 3 km 활주로를 남북으로 둔다
    out.push({ name: '36', thr: [0, -1500], end: [0, 1500], hdg: 0, len: 3000, width: 45 });
    out.push({ name: '18', thr: [0, 1500], end: [0, -1500], hdg: Math.PI, len: 3000, width: 45 });
  }
  return out;
}

/** 원하는 방향에 가장 가깝고 길이가 넉넉한 활주로 */
export function pickRunway(dirs: readonly RunwayDir[], want: number, need: number): RunwayDir {
  let best = dirs[0];
  let bestScore = Infinity;
  for (const d of dirs) {
    const turn = Math.abs(wrapPi(d.hdg - want));
    const short = Math.max(0, need - d.len) / 500;
    const score = turn + short - d.len / 40000;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// ------------------------------------------------------------------ 기종 성능 (게임용 어림)

export interface Performance {
  /** 이륙 활주 거리 (m) */
  roll: number;
  /** 바퀴가 뜨는 속도 (m/s) */
  vr: number;
  /** 최종 접근 속도 (m/s) */
  vapp: number;
  /** 순항 속도 (m/s) */
  vcr: number;
  /** 순항 고도 (m) */
  alt: number;
}

export function performance(m: ModelDef): Performance {
  const prop = m.body === 'prop';
  const sst = m.body === 'sst';
  const roll = prop ? 900 : sst ? 2400 : [0, 1300, 1700, 2100, 2400][m.runway] ?? 1800;
  const vr = clamp(Math.sqrt(2 * (prop ? 1.6 : 2.0) * roll), 48, 105);
  return {
    roll,
    vr,
    vapp: clamp(vr * 0.98, 50, 95),
    vcr: m.speed / 3.6,
    alt: sst ? 17000 : prop ? 6500 : 10700,
  };
}

// ------------------------------------------------------------------ 비행 길

export type RidePhase = 'roll' | 'climb' | 'cruise' | 'descent' | 'approach' | 'landing' | 'arrived';

export const PHASE_NAMES: Record<RidePhase, string> = {
  roll: '이륙 활주',
  climb: '상승',
  cruise: '순항',
  descent: '강하',
  approach: '착륙 접근',
  landing: '착륙 활주',
  arrived: '도착',
};

/** 어느 순간의 비행기 */
export interface RideState {
  /** 지금 자리 (지구 중심에서 본 단위 벡터) */
  pos: V3;
  ll: LL;
  /** 높이 (m) */
  alt: number;
  /** 속도 (m/s) */
  speed: number;
  /** 방위·기수 들림·기울기 (라디안; 오른쪽 날개가 내려가면 +) */
  heading: number;
  pitch: number;
  bank: number;
  /** 바퀴를 내렸는지 */
  gear: boolean;
  phase: RidePhase;
  /** 지나온 길 (m) · 남은 길 (m) */
  s: number;
  left: number;
  /** 지난 시간 · 남은 시간 (초, 비행 속 시간) */
  t: number;
  tLeft: number;
}

/** 이 지점을 지나면 빨리감기를 이만큼까지 줄인다 (착륙을 놓치지 않게) */
export interface SpeedCap {
  s: number;
  max: number;
}

export interface RideFlight {
  from: RideAirport;
  to: RideAirport;
  dep: RunwayDir;
  arr: RunwayDir;
  model: ModelDef;
  perf: Performance;
  /** 실제로 오르는 순항 고도 (짧은 노선은 낮다) */
  cruiseAlt: number;
  /** 길 전체 (m) · 걸리는 시간 (초) */
  total: number;
  duration: number;
  /** 단계가 바뀌는 자리 (m) */
  marks: { lift: number; toc: number; tod: number; faf: number; thr: number; td: number; stop: number };
  caps: SpeedCap[];
  /** 지도·지구본에 그릴 길 (단위 벡터, 듬성듬성) */
  track: V3[];
  at(t: number): RideState;
}

const TURN_BANK = 25 * D2R;
/** 최종 접근 거리 (m) */
const FINAL = 18000;
const GLIDE = Math.tan(3 * D2R);
const CLIMB1 = 0.08;
const CLIMB2 = 0.045;
const H_STEP = 3000;
/** 문턱을 지나는 높이 (m) · 문턱에서 바퀴가 닿는 곳의 거리 (m) */
const THR_H = 15;
const TD_DIST = 420;
const FLARE_W = 200;
const LIFT_W = 300;

/** 땅 위 길: 단위 벡터 점들과 쌓인 거리 */
class Track {
  pts: V3[] = [];
  s: number[] = [];
  push(v: V3) {
    const n = this.pts.length;
    if (n) {
      const p = this.pts[n - 1];
      const d = Math.acos(clamp(dot3(p, v), -1, 1)) * EARTH_R;
      if (d < 0.5) return;
      this.s.push(this.s[n - 1] + d);
    } else this.s.push(0);
    this.pts.push(v);
  }
  get total() {
    return this.s[this.s.length - 1];
  }
  at(s: number): V3 {
    const S = this.s;
    if (s <= 0) return this.pts[0];
    if (s >= this.total) return this.pts[this.pts.length - 1];
    let lo = 0;
    let hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const k = (s - S[lo]) / (S[hi] - S[lo]);
    const a = this.pts[lo];
    const b = this.pts[hi];
    return norm3([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
  }
}

const fwd = (h: number): [number, number] => [Math.sin(h), Math.cos(h)];
const right = (h: number): [number, number] => [Math.cos(h), -Math.sin(h)];

/** 공항 평면 위 선회: 지금 자리·방향에서 반지름 r 원을 따라 돈다 */
function arcPoints(c: [number, number], r: number, side: number, h0: number, sweep: number, step = 60): [number, number][] {
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / step));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const h = h0 + (side * sweep * i) / n;
    const rt = right(h);
    out.push([c[0] - side * r * rt[0], c[1] - side * r * rt[1]]);
  }
  return out;
}

/** 순항 고도: 오르고 내리는 길이 노선 안에 들어가게 */
function fitCruise(want: number, room: number): number {
  const climb = (h: number) => (h <= H_STEP ? h / CLIMB1 : H_STEP / CLIMB1 + (h - H_STEP) / CLIMB2);
  const descent = (h: number) => Math.max(0, h - FINAL * GLIDE) / GLIDE;
  if (climb(want) + descent(want) <= room) return want;
  let lo = FINAL * GLIDE + 200;
  let hi = want;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (climb(mid) + descent(mid) <= room) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** 꺾인 선을 둥글게: 꺾이는 곳마다 폭 w 안에서 기울기가 고르게 바뀐다 */
interface Knot {
  s: number;
  h: number;
  w: number;
}
function filletProfile(knots: Knot[]): (s: number) => { h: number; slope: number } {
  const n = knots.length;
  const slope = (i: number) => (i < 0 || i >= n - 1 ? 0 : (knots[i + 1].h - knots[i].h) / Math.max(1e-9, knots[i + 1].s - knots[i].s));
  return (s: number) => {
    // 둥글린 구간 안이면 포물선
    for (let k = 0; k < n; k++) {
      const K = knots[k];
      if (K.w > 0 && s > K.s - K.w && s < K.s + K.w) {
        const g1 = slope(k - 1);
        const g2 = slope(k);
        const x = s - (K.s - K.w);
        const h0 = K.h - g1 * K.w;
        return { h: h0 + g1 * x + ((g2 - g1) * x * x) / (4 * K.w), slope: g1 + ((g2 - g1) * x) / (2 * K.w) };
      }
    }
    if (s <= knots[0].s) return { h: knots[0].h, slope: 0 };
    for (let k = 0; k < n - 1; k++) {
      if (s <= knots[k + 1].s) {
        const g = slope(k);
        return { h: knots[k].h + g * (s - knots[k].s), slope: g };
      }
    }
    return { h: knots[n - 1].h, slope: 0 };
  };
}

/** 속도: 구간마다 고르게 빨라지거나 느려진다 (v²가 거리에 따라 곧게 바뀐다) */
interface VKnot {
  s: number;
  v: number;
  t: number;
}

export interface RideOptions {
  /** 그 해 (공항이 시대마다 다르다) */
  year: number;
}

/** 두 도시 사이 비행 (도면이 없거나 같은 도시면 null) */
export function planRide(modelId: string, fromCity: string, toCity: string, opts: RideOptions): RideFlight | null {
  const model = MODEL[modelId];
  const from = rideAirport(fromCity, opts.year);
  const to = rideAirport(toCity, opts.year);
  if (!model || !from || !to || fromCity === toCity) return null;
  const perf = performance(model);

  // 활주로: 가려는 쪽에 가까운 것
  const course = bearing(from.ll, to.ll);
  const inbound = wrapPi(bearing(to.ll, from.ll) + Math.PI);
  const dep = pickRunway(runwayDirs(from), course, perf.roll + 400);
  const arr = pickRunway(runwayDirs(to), inbound, perf.roll * 0.8 + 400);

  const track = new Track();
  const toVec = (ap: RideAirport, p: [number, number]) => llToVec(localToLl(ap.ll, p[0], p[1]));

  // --- 출발: 활주로 문턱에서 줄을 서고, 뜨고 나서 5 km 곧게, 그리고 선회
  const roll = Math.min(perf.roll, dep.len - 250);
  const lineUp = 60;
  const start: [number, number] = [dep.thr[0] + fwd(dep.hdg)[0] * lineUp, dep.thr[1] + fwd(dep.hdg)[1] * lineUp];
  const straight = roll + LIFT_W + 5000;
  const p1: [number, number] = [start[0] + fwd(dep.hdg)[0] * straight, start[1] + fwd(dep.hdg)[1] * straight];
  const v1 = 140;
  const r1 = (v1 * v1) / (G * Math.tan(TURN_BANK));
  const depPts: [number, number][] = [start];
  for (let d = 50; d < straight; d += 50) depPts.push([start[0] + fwd(dep.hdg)[0] * d, start[1] + fwd(dep.hdg)[1] * d]);
  depPts.push(p1);
  {
    let best: { side: number; sweep: number; c: [number, number] } | null = null;
    for (const side of [1, -1]) {
      const rt = right(dep.hdg);
      const c: [number, number] = [p1[0] + side * r1 * rt[0], p1[1] + side * r1 * rt[1]];
      const b = bearing(localToLl(from.ll, c[0], c[1]), to.ll);
      const sweep = side > 0 ? wrap2Pi(b - dep.hdg) : wrap2Pi(dep.hdg - b);
      if (!best || sweep < best.sweep) best = { side, sweep, c };
    }
    if (best && best.sweep > 2 * D2R) depPts.push(...arcPoints(best.c, r1, best.side, dep.hdg, best.sweep).slice(1));
  }
  for (const p of depPts) track.push(toVec(from, p));
  const depExit = track.pts[track.pts.length - 1];

  // --- 도착: 문턱 앞 18 km에서 활주로 방향으로 들어오게 거꾸로 짓는다
  const faf: [number, number] = [arr.thr[0] - fwd(arr.hdg)[0] * FINAL, arr.thr[1] - fwd(arr.hdg)[1] * FINAL];
  const v2 = 130;
  const r2 = (v2 * v2) / (G * Math.tan(TURN_BANK));
  let arrArc: [number, number][] = [faf];
  {
    const exitLl = vecToLl(depExit);
    let best: { side: number; sweep: number; c: [number, number]; bIn: number } | null = null;
    for (const side of [1, -1]) {
      const rt = right(arr.hdg);
      const c: [number, number] = [faf[0] + side * r2 * rt[0], faf[1] + side * r2 * rt[1]];
      const bIn = wrapPi(bearing(localToLl(to.ll, c[0], c[1]), exitLl) + Math.PI);
      const sweep = side > 0 ? wrap2Pi(arr.hdg - bIn) : wrap2Pi(bIn - arr.hdg);
      if (!best || sweep < best.sweep) best = { side, sweep, c, bIn };
    }
    if (best && best.sweep > 2 * D2R) arrArc = arcPoints(best.c, r2, best.side, best.bIn, best.sweep);
  }
  const arrEntry = toVec(to, arrArc[0]);

  // --- 순항: 대권 (2 km마다 점)
  {
    const a = depExit;
    const b = arrEntry;
    const ang = Math.acos(clamp(dot3(a, b), -1, 1));
    const n = Math.max(1, Math.ceil((ang * EARTH_R) / 2000));
    const sinA = Math.sin(ang) || 1;
    for (let i = 1; i < n; i++) {
      const k = i / n;
      const wa = ang < 1e-9 ? 1 - k : Math.sin((1 - k) * ang) / sinA;
      const wb = ang < 1e-9 ? k : Math.sin(k * ang) / sinA;
      track.push(norm3([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]));
    }
  }
  for (const p of arrArc) track.push(toVec(to, p));
  for (let d = FINAL - 100; d > 0; d -= 100) track.push(toVec(to, [arr.thr[0] - fwd(arr.hdg)[0] * d, arr.thr[1] - fwd(arr.hdg)[1] * d]));
  track.push(toVec(to, arr.thr));
  const sThr = track.total;

  // 착륙 활주: 바퀴가 닿은 뒤 고르게 느려져 활주로 안에서 멈춘다
  const vtd = perf.vapp * 0.95;
  const td = TD_DIST + FLARE_W;
  const taxiV = 12;
  const crawl = 40;
  // 보통은 1.8 m/s²로 느려지고, 활주로가 짧으면 더 세게 (그래도 활주로 끝 30 m 앞에서 멈춘다)
  const easy = (vtd * vtd - taxiV * taxiV) / (2 * 1.8);
  const stopAt = Math.max(td + 200, Math.min(arr.len - 30, td + easy + crawl));
  const rollout = Math.max(100, stopAt - td - crawl);
  for (let d = 50; d < stopAt; d += 50) track.push(toVec(to, [arr.thr[0] + fwd(arr.hdg)[0] * d, arr.thr[1] + fwd(arr.hdg)[1] * d]));
  track.push(toVec(to, [arr.thr[0] + fwd(arr.hdg)[0] * stopAt, arr.thr[1] + fwd(arr.hdg)[1] * stopAt]));
  const total = track.total;

  // --- 높이
  const sLift = roll + LIFT_W;
  const sFaf = sThr - FINAL;
  const sTd = sThr + td;
  const sStop = total;
  const roomCruise = sFaf - sLift - 20000;
  const alt = fitCruise(perf.alt, Math.max(10000, roomCruise));
  const hFaf = FINAL * GLIDE;
  const climbLen = (h: number) => (h <= H_STEP ? h / CLIMB1 : H_STEP / CLIMB1 + (h - H_STEP) / CLIMB2);
  const sToc = sLift + climbLen(alt);
  const sTod = Math.max(sToc, sFaf - Math.max(0, alt - hFaf) / GLIDE);
  const knots: Knot[] = [
    { s: 0, h: 0, w: 0 },
    { s: sLift, h: 0, w: LIFT_W },
  ];
  if (alt > H_STEP + 500) knots.push({ s: sLift + H_STEP / CLIMB1, h: H_STEP, w: 4000 });
  const cruiseLen = sTod - sToc;
  knots.push({ s: sToc, h: alt, w: Math.min(15000, Math.max(2000, cruiseLen / 2 + 2000)) });
  if (cruiseLen > 1) knots.push({ s: sTod, h: alt, w: Math.min(10000, Math.max(1000, cruiseLen / 2)) });
  else knots[knots.length - 1].w = Math.min(6000, (sTod - sLift) / 4);
  knots.push({ s: sFaf, h: hFaf, w: 0 });
  knots.push({ s: sThr, h: THR_H, w: 150 });
  knots.push({ s: sThr + TD_DIST, h: 0, w: FLARE_W });
  knots.push({ s: sStop, h: 0, w: 0 });
  // 둥글리는 폭이 이웃 구간의 절반을 넘지 않게
  for (let i = 1; i < knots.length - 1; i++) {
    const room2 = Math.min(knots[i].s - knots[i - 1].s, knots[i + 1].s - knots[i].s) / 2;
    knots[i].w = Math.max(0, Math.min(knots[i].w, room2 - 1));
  }
  const profile = filletProfile(knots);

  // --- 속도
  const vcr = perf.vcr;
  const vRaw: { s: number; v: number }[] = [
    { s: 0, v: 0 },
    { s: roll, v: perf.vr },
  ];
  if (alt > H_STEP + 500) vRaw.push({ s: sLift + H_STEP / CLIMB1, v: Math.min(130, vcr) });
  vRaw.push({ s: sToc, v: vcr });
  if (sTod > sToc + 1) vRaw.push({ s: sTod, v: vcr });
  if (alt > H_STEP + 500) vRaw.push({ s: sFaf - (H_STEP - hFaf) / GLIDE, v: Math.min(130, vcr) });
  vRaw.push({ s: sFaf, v: perf.vapp });
  vRaw.push({ s: sTd, v: vtd });
  vRaw.push({ s: sTd + rollout, v: taxiV });
  vRaw.push({ s: sStop, v: 0 });
  const vk: VKnot[] = [];
  for (const k of vRaw) {
    if (vk.length && k.s <= vk[vk.length - 1].s + 0.5) continue;
    const prev = vk[vk.length - 1];
    const t = prev ? prev.t + (2 * (k.s - prev.s)) / Math.max(1e-6, prev.v + k.v) : 0;
    vk.push({ s: k.s, v: k.v, t });
  }
  const duration = vk[vk.length - 1].t;
  const sAt = (t: number): { s: number; v: number } => {
    if (t <= 0) return { s: 0, v: 0 };
    if (t >= duration) return { s: vk[vk.length - 1].s, v: 0 };
    let i = 0;
    while (i < vk.length - 2 && vk[i + 1].t < t) i++;
    const a = vk[i];
    const b = vk[i + 1];
    const L = b.s - a.s;
    const acc = (b.v * b.v - a.v * a.v) / (2 * L);
    const tau = t - a.t;
    return { s: Math.min(b.s, a.s + a.v * tau + 0.5 * acc * tau * tau), v: Math.max(0, a.v + acc * tau) };
  };

  const headingAt = (s: number, ds = 15): number => {
    const a = track.at(Math.max(0, s - ds));
    const b = track.at(Math.min(total, s + ds));
    const p = track.at(s);
    const ll = vecToLl(p);
    const { e, n } = enuBasis(ll);
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    return Math.atan2(dot3(d, e), dot3(d, n));
  };
  // 맨 끝처럼 길이 다한 곳에서는 바로 앞 방향을 쓴다
  const endHeading = arr.hdg;

  const marks = { lift: roll, toc: sToc, tod: sTod, faf: sFaf, thr: sThr, td: sTd, stop: sStop };
  const caps: SpeedCap[] = [
    { s: sTod, max: 100 },
    { s: sFaf - 12000, max: 10 },
    { s: sThr - 8000, max: 1 },
  ];
  const coarse: V3[] = [];
  for (let s = 0; s < total; s += Math.max(500, total / 600)) coarse.push(track.at(s));
  coarse.push(track.at(total));

  const at = (tIn: number): RideState => {
    const t = clamp(tIn, 0, duration);
    const { s, v } = sAt(t);
    const pos = track.at(s);
    const ll = vecToLl(pos);
    const { h, slope } = profile(s);
    const altNow = Math.max(0, h);
    const onGround = s < roll || s >= sThr + TD_DIST + FLARE_W - 1;
    const heading = s > total - 20 ? endHeading : s < 20 ? dep.hdg : headingAt(s);
    // 기울기: 앞뒤 몇 초 동안의 방향 바뀜 (선회를 부드럽게 들어가고 나온다)
    let bank = 0;
    if (!onGround && altNow > 3) {
      const W = Math.max(150, v * 3);
      const dpsi = wrapPi(headingAt(Math.min(total, s + W), 30) - headingAt(Math.max(0, s - W), 30));
      const kappa = dpsi / (2 * W);
      bank = clamp(Math.atan((v * v * kappa) / G), -30 * D2R, 30 * D2R) * smooth(3, 60, altNow);
    }
    // 기수: 비행 경로각 + 받음각
    const gamma = Math.atan(slope);
    let aoa = 0;
    if (s < sLift) aoa = 7 * D2R * smooth(roll - 250, roll + 50, s);
    else if (s < sLift + 800) aoa = (7 - 4 * smooth(sLift, sLift + 800, s)) * D2R;
    else if (s < sFaf) aoa = 3 * D2R;
    else if (s < sThr) aoa = (3 + 1.5 * smooth(sFaf, sFaf + 3000, s)) * D2R;
    else if (s < sThr + TD_DIST + FLARE_W) aoa = (4.5 + 2 * smooth(sThr, sThr + TD_DIST + FLARE_W, s)) * D2R;
    else aoa = 6.5 * D2R * (1 - smooth(sTd, sTd + 350, s));
    const pitch = gamma + aoa;
    const gear = s < sLift + 2600 || s > sFaf - 4000;
    let phase: RidePhase;
    if (t >= duration) phase = 'arrived';
    else if (s < roll) phase = 'roll';
    else if (s < sToc) phase = 'climb';
    else if (s < sTod) phase = 'cruise';
    else if (s < sFaf) phase = 'descent';
    else if (s < sTd) phase = 'approach';
    else phase = 'landing';
    return { pos, ll, alt: altNow, speed: v, heading, pitch, bank, gear, phase, s, left: total - s, t, tLeft: duration - t };
  };

  return { from, to, dep, arr, model, perf, cruiseAlt: alt, total, duration, marks, caps, track: coarse, at };
}
