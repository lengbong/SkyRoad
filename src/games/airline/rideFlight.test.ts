import { describe, expect, it } from 'vitest';
import { CITIES } from './cities';
import { EARTH_R, bearing, destination, gcDistance, llToLocal, llToVec, localToLl, planRide, rideAirport, runwayDirs, vecToLl, type LL, type RideFlight } from './rideFlight';

const deg = (r: number) => (r * 180) / Math.PI;
const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** 비행기 자리를 공항 평면 좌표로 */
function localOf(f: RideFlight, which: 'from' | 'to', ll: LL): [number, number] {
  return llToLocal(f[which].ll, ll);
}

/** 점에서 활주로 가운데 선까지 거리와, 문턱에서 잰 활주로 방향 거리 */
function onRunway(p: [number, number], thr: [number, number], hdg: number): { off: number; along: number } {
  const dx = p[0] - thr[0];
  const dy = p[1] - thr[1];
  const fx = Math.sin(hdg);
  const fy = Math.cos(hdg);
  return { along: dx * fx + dy * fy, off: Math.abs(dx * fy - dy * fx) };
}

const ROUTES: [string, string, string, number][] = [
  ['b747-400', 'seoul', 'newyork', 2003],
  ['a380', 'singapore', 'london', 2015],
  ['concorde', 'london', 'newyork', 1977],
  ['f27', 'seoul', 'busan', 1970],
  ['b737-200', 'milan', 'zurich', 1983],
  ['b747-200', 'hongkong', 'bangkok', 1983],
  ['b777-9', 'sydney', 'losangeles', 2026],
];

describe('지구 위 계산', () => {
  it('방위 등거리 평면 좌표가 오가며 같다', () => {
    const o: LL = [37.46, 126.44];
    for (const [e, n] of [
      [0, 0],
      [5000, -3000],
      [-12000, 8000],
    ]) {
      const back = llToLocal(o, localToLl(o, e, n));
      expect(back[0]).toBeCloseTo(e, 3);
      expect(back[1]).toBeCloseTo(n, 3);
    }
  });

  it('대권 거리·방위·목적지가 서로 맞다', () => {
    const a: LL = [51.47, -0.45];
    const b: LL = [40.64, -73.78];
    const d = gcDistance(a, b);
    expect(d / 1000).toBeGreaterThan(5500);
    expect(d / 1000).toBeLessThan(5600);
    const c = destination(a, bearing(a, b), d);
    expect(gcDistance(b, c)).toBeLessThan(1);
    const v = vecToLl(llToVec(b));
    expect(v[0]).toBeCloseTo(b[0], 9);
    expect(v[1]).toBeCloseTo(b[1], 9);
    expect(EARTH_R).toBe(6371000);
  });
});

describe('타 보기 비행 길', () => {
  it('모든 도시에 그 해 공항과 활주로가 있다', () => {
    for (const c of CITIES) {
      for (const y of [1963, 1983, 2003, 2026, 2080]) {
        const ap = rideAirport(c.id, y);
        expect(ap, `${c.id} ${y}`).not.toBeNull();
        expect(runwayDirs(ap!).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  for (const [model, a, b, year] of ROUTES) {
    it(`${model} ${a} → ${b} (${year})`, () => {
      const f = planRide(model, a, b, { year })!;
      expect(f).not.toBeNull();
      const d = gcDistance(f.from.ll, f.to.ll);
      // 길: 대권보다 조금 길고 (선회·접근) 너무 멀리 돌지 않는다
      expect(f.total).toBeGreaterThan(d * 0.99);
      expect(f.total).toBeLessThan(d + 120000);
      // 시간: 순항 속도로 곧장 가는 것보다 조금 길고, 게임의 운항 시간(거리 ÷ 속도 + 땅에서 45분)보다는 짧다
      const hours = f.duration / 3600;
      const direct = d / 1000 / f.model.speed;
      expect(hours).toBeGreaterThan(direct);
      expect(hours).toBeLessThan(direct + 0.75);

      // 처음: 출발 활주로 문턱 위에 서 있다
      const s0 = f.at(0);
      expect(s0.speed).toBe(0);
      expect(s0.alt).toBe(0);
      expect(s0.phase).toBe('roll');
      expect(deg(angDiff(s0.heading, f.dep.hdg))).toBeLessThan(1);
      const r0 = onRunway(localOf(f, 'from', s0.ll), f.dep.thr, f.dep.hdg);
      expect(r0.off).toBeLessThan(2);
      expect(r0.along).toBeGreaterThan(0);
      expect(r0.along).toBeLessThan(200);

      // 끝: 도착 활주로 위에 멈춘다
      const s1 = f.at(f.duration);
      expect(s1.speed).toBe(0);
      expect(s1.alt).toBe(0);
      expect(s1.phase).toBe('arrived');
      const r1 = onRunway(localOf(f, 'to', s1.ll), f.arr.thr, f.arr.hdg);
      expect(r1.off).toBeLessThan(2);
      expect(r1.along).toBeGreaterThan(600);
      expect(r1.along).toBeLessThan(f.arr.len);

      // 가는 동안
      let maxAlt = 0;
      let prevS = -1;
      let prevT = -1;
      let lifted = -1;
      let wasAirborne = false;
      const n = 3000;
      for (let i = 0; i <= n; i++) {
        const t = (f.duration * i) / n;
        const st = f.at(t);
        expect(st.s).toBeGreaterThanOrEqual(prevS);
        expect(st.t).toBeGreaterThan(prevT);
        prevS = st.s;
        prevT = st.t;
        expect(st.alt).toBeGreaterThanOrEqual(0);
        expect(Math.abs(deg(st.bank))).toBeLessThanOrEqual(30.01);
        expect(deg(st.pitch)).toBeGreaterThan(-8);
        expect(deg(st.pitch)).toBeLessThan(15);
        expect(st.speed).toBeLessThanOrEqual(f.perf.vcr + 1e-6);
        maxAlt = Math.max(maxAlt, st.alt);
        if (st.alt > 1 && lifted < 0) lifted = st.s;
        if (st.alt > 100) wasAirborne = true;
      }
      expect(wasAirborne).toBe(true);
      expect(maxAlt).toBeLessThanOrEqual(f.perf.alt + 1);
      expect(maxAlt).toBeCloseTo(f.cruiseAlt, -1);
      // 활주로 안에서 뜬다
      expect(lifted).toBeLessThan(f.dep.len);
    });
  }

  it('짧은 노선은 낮게 날고, 긴 노선은 순항 고도까지 오른다', () => {
    const short = planRide('b737-200', 'milan', 'zurich', { year: 1983 })!;
    const long = planRide('b747-400', 'seoul', 'newyork', { year: 2003 })!;
    expect(short.cruiseAlt).toBeLessThan(long.cruiseAlt);
    expect(long.cruiseAlt).toBe(10700);
    expect(planRide('concorde', 'london', 'newyork', { year: 1977 })!.cruiseAlt).toBe(17000);
  });

  it('바람이 없으면 가려는 쪽 활주로를 고른다 (인천 → 뉴욕은 북쪽으로 뜬다)', () => {
    const f = planRide('b747-400', 'seoul', 'newyork', { year: 2003 })!;
    expect(f.from.icao).toBe('RKSI');
    expect(f.to.icao).toBe('KJFK');
    // 뉴욕은 북동쪽: 34(북북서)나 33(북서)보다 15/16(남동)이 아니라 북쪽 방향 활주로
    expect(Math.cos(f.dep.hdg)).toBeGreaterThan(0);
  });

  it('착륙이 가까워지면 빨리감기를 줄이는 자리가 차례로 있다', () => {
    const f = planRide('a380', 'singapore', 'london', { year: 2015 })!;
    const caps = f.caps.map((c) => c.s);
    expect([...caps].sort((x, y) => x - y)).toEqual(caps);
    expect(f.caps[f.caps.length - 1].max).toBe(1);
    expect(caps[caps.length - 1]).toBeLessThan(f.marks.thr);
  });

  it('시대마다 공항이 바뀐다 (홍콩 1983 카이탁, 2003 첵랍콕)', () => {
    expect(planRide('b747-200', 'hongkong', 'bangkok', { year: 1983 })!.from.icao).toBe('VHHX');
    expect(planRide('b747-400', 'hongkong', 'bangkok', { year: 2003 })!.from.icao).toBe('VHHH');
  });

  it('없는 기종이나 같은 도시는 null', () => {
    expect(planRide('nope', 'seoul', 'tokyo', { year: 2003 })).toBeNull();
    expect(planRide('b747-400', 'seoul', 'seoul', { year: 2003 })).toBeNull();
  });
});
