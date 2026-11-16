import {
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { SHAPES } from './aircraftShapes';
import type { AirportMapData } from './airportTypes';
import { FREIGHTER_SHAPES } from './freighterShapes';
import { planeMesh, type Livery, type PlaneMesh, type PlaneShape } from './plane3d';
import { EARTH_R, destination, enuBasis, gcDistance, llToVec, type LL, type RideAirport, type RideFlight, type RideState, type V3 } from './rideFlight';
import { LAND, WATER } from './worldmap';

/**
 * '타 보기' 3D 장면 (three.js).
 *
 * 좌표: 매 그림마다 비행기 바로 아래 땅을 원점으로, x 동쪽 · y 위 · z 남쪽 (m).
 * 지구·공항·발밑 땅은 각자 자기 좌표로 만들어 두고, 그릴 때마다 이 원점으로 옮기는 행렬만 새로 셈한다.
 * (지구 중심에서 6,371 km나 떨어진 자리를 GPU의 32비트 숫자로 바로 다루면 비행기가 떨려 보여서)
 *
 * - 지구: 직접 그린 세계 지도(worldmap.ts)를 입힌 공. 실제보다 400 m 낮게 두고,
 * - 발밑 땅: 낮게 날 때만, 비행기 둘레 80 km를 실제 높이의 고운 그물로 덮는다.
 * - 공항: 오픈스트리트맵 도면을 바닥 그림(잔디·계류장·유도로)과 활주로(표시 포함)·건물·관제탑·주기장 비행기로 세운다.
 */

const R = EARTH_R;
const D2R = Math.PI / 180;

// ------------------------------------------------------------------ 색

const OCEAN = '#1f5482';
const SHALLOW = '#2f6f99';
const LAND_C = '#6e8c53';
const FIELD = '#7d9b5b';
const APRON = '#b8bbbf';
const TWY = '#585c62';
const TWY_LINE = '#d9b43a';
const ASPHALT = '#3a3d42';
const SKY_TOP = new Color('#3d7cc2');
const SKY_HORIZON = new Color('#cfe1f0');
const SPACE = new Color('#050a16');

// ------------------------------------------------------------------ 작은 셈

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 지구 중심 좌표 → 장면 좌표 행렬 (원점 O, 그 자리의 동·북·위) */
function sceneFromEcef(o: V3, e: V3, n: V3, u: V3, out: Matrix4): Matrix4 {
  const d = (a: V3) => a[0] * o[0] + a[1] * o[1] + a[2] * o[2];
  return out.set(e[0], e[1], e[2], -d(e), u[0], u[1], u[2], -d(u), -n[0], -n[1], -n[2], d(n), 0, 0, 0, 1);
}

/** 그 자리의 평면 좌표 (x 동 · y 위 · z 남; 원점은 그 자리 땅) → 지구 중심 좌표 */
function ecefFromLocal(ll: LL): Matrix4 {
  const { e, n, u } = enuBasis(ll);
  const o: V3 = [u[0] * R, u[1] * R, u[2] * R];
  return new Matrix4().set(e[0], u[0], -n[0], o[0], e[1], u[1], -n[1], o[1], e[2], u[2], -n[2], o[2], 0, 0, 0, 1);
}

/** 그 자리 둘레 평면 좌표로 본 지구 위 점 (y는 높이, 땅이 둥글어 멀수록 낮다) */
function localOfVec(ll: LL, v: V3, h = 0): [number, number, number] {
  const { e, n, u } = enuBasis(ll);
  const q: V3 = [v[0] * (R + h) - u[0] * R, v[1] * (R + h) - u[1] * R, v[2] * (R + h) - u[2] * R];
  const dot = (a: V3) => a[0] * q[0] + a[1] * q[1] + a[2] * q[2];
  return [dot(e), dot(u), -dot(n)];
}

/** SVG 경로 글자(M m L l Z z) → 점 줄들 */
export function pathRings(d: string): [number, number][][] {
  const out: [number, number][][] = [];
  const tok = d.match(/[MmLlZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let cmd = 'M';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let ring: [number, number][] | null = null;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      if (cmd === 'Z' || cmd === 'z') {
        cx = sx;
        cy = sy;
        ring = null;
      }
      continue;
    }
    const x = Number(t);
    const y = Number(tok[++i]);
    if (cmd === 'M' || cmd === 'm') {
      if (cmd === 'm') {
        cx += x;
        cy += y;
      } else {
        cx = x;
        cy = y;
      }
      sx = cx;
      sy = cy;
      ring = [[cx, cy]];
      out.push(ring);
      cmd = cmd === 'm' ? 'l' : 'L';
    } else {
      if (cmd === 'l') {
        cx += x;
        cy += y;
      } else {
        cx = x;
        cy = y;
      }
      if (!ring) {
        ring = [[sx, sy]];
        out.push(ring);
      }
      ring.push([cx, cy]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 지구 그림

let worldCanvas: HTMLCanvasElement | null = null;

/** 직접 그린 세계 지도 → 정거원통 그림 (4096 × 2048, 한 번만 그려 둔다) */
function worldTextureCanvas(): HTMLCanvasElement {
  if (worldCanvas) return worldCanvas;
  const W = 4096;
  const H = 2048;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const X = (lon: number) => ((lon + 180) / 360) * W;
  const Y = (lat: number) => ((90 - lat) / 180) * H;
  g.fillStyle = OCEAN;
  g.fillRect(0, 0, W, H);
  // 바다 깊이 느낌: 적도 쪽이 조금 밝다
  const sea = g.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, 'rgba(10,30,60,0.35)');
  sea.addColorStop(0.5, 'rgba(60,120,170,0.12)');
  sea.addColorStop(1, 'rgba(10,30,60,0.35)');
  g.fillStyle = sea;
  g.fillRect(0, 0, W, H);
  const shapePath = (pts: readonly (readonly [number, number])[]) => {
    // 경도를 이어 붙이고, 지도 끝을 넘으면 반대쪽에 한 번 더
    const p: [number, number][] = [];
    let prev: number | null = null;
    for (const [lon0, lat] of pts) {
      let lon = lon0;
      if (prev !== null) {
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      p.push([lon, lat]);
      prev = lon;
    }
    const path = new Path2D();
    const minLon = Math.min(...p.map((v) => v[0]));
    const maxLon = Math.max(...p.map((v) => v[0]));
    const shifts = [0];
    if (maxLon > 180) shifts.push(-360);
    if (minLon < -180) shifts.push(360);
    for (const s of shifts) {
      p.forEach(([lon, lat], i) => (i ? path.lineTo(X(lon + s), Y(lat)) : path.moveTo(X(lon + s), Y(lat))));
      path.closePath();
    }
    return path;
  };
  const land = new Path2D();
  for (const s of LAND) land.addPath(shapePath(s.pts));
  // 남극 (세계 지도에는 없다)
  land.rect(0, Y(-66), W, H - Y(-66));
  // 얕은 바다
  g.strokeStyle = SHALLOW;
  g.lineJoin = 'round';
  g.lineWidth = 14;
  g.stroke(land);
  g.lineWidth = 6;
  g.strokeStyle = '#3c7ea6';
  g.stroke(land);
  g.fillStyle = LAND_C;
  g.fill(land);
  // 땅 무늬: 위도에 따라 (열대 짙은 초록 → 온대 → 툰드라 → 얼음) + 얼룩
  g.save();
  g.clip(land);
  const lat = g.createLinearGradient(0, 0, 0, H);
  const stops: [number, string][] = [
    [90, '#eef2f4'],
    [74, '#e2e8ea'],
    [66, '#a7a98f'],
    [56, '#7e8d62'],
    [40, '#7d8f58'],
    [30, '#a59a6c'],
    [20, '#8f915e'],
    [8, '#4f7a3f'],
    [-8, '#4f7a3f'],
    [-22, '#94905f'],
    [-34, '#7c8c58'],
    [-50, '#82906a'],
    [-62, '#c9d2d4'],
    [-66, '#eef2f4'],
    [-90, '#f2f5f7'],
  ];
  for (const [la, c] of stops) lat.addColorStop((90 - la) / 180, c);
  g.fillStyle = lat;
  g.globalAlpha = 0.8;
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 1;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const blots = ['rgba(60,90,40,0.18)', 'rgba(140,130,90,0.16)', 'rgba(90,110,60,0.18)', 'rgba(170,160,120,0.12)', 'rgba(40,70,35,0.16)'];
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 2 + rnd() * rnd() * 22;
    g.fillStyle = blots[i % blots.length];
    g.beginPath();
    g.ellipse(x, y, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // 호수
  g.fillStyle = SHALLOW;
  for (const s of WATER) g.fill(shapePath(s.pts));
  worldCanvas = cv;
  return cv;
}

let detailCv: HTMLCanvasElement | null = null;

/** 땅 무늬 (회색, 둘레가 이어지는 512 × 512): 줄지어 난 밭 + 숲 얼룩 */
function detailCanvas(): HTMLCanvasElement {
  if (detailCv) return detailCv;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgb(140,140,140)';
  g.fillRect(0, 0, S, S);
  let seed = 777;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // 둘레가 이어지게 아홉 번 찍는다
  const wrap = (f: (dx: number, dy: number) => void) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) f(dx, dy);
  };
  for (let i = 0; i < 420; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const w = 10 + rnd() * 46;
    const h = 8 + rnd() * 30;
    const a = (rnd() - 0.5) * 0.5;
    const v = Math.round(95 + rnd() * 110);
    g.fillStyle = `rgb(${v},${v},${v})`;
    wrap((dx, dy) => {
      g.save();
      g.translate(x + dx, y + dy);
      g.rotate(a);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
    });
  }
  for (let i = 0; i < 160; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 6 + rnd() * 30;
    const v = Math.round(60 + rnd() * 40);
    g.fillStyle = `rgba(${v},${v},${v},0.7)`;
    wrap((dx, dy) => {
      g.beginPath();
      g.ellipse(x + dx, y + dy, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    });
  }
  detailCv = cv;
  return cv;
}

// ------------------------------------------------------------------ 공항 그림

/** 공항 바닥 그림: 잔디·계류장·유도로·물. 가장자리는 둘레 땅에 스며들게 흐리게 */
function airportGroundCanvas(map: AirportMapData): { canvas: HTMLCanvasElement; k: number } {
  const k = Math.min(0.6, 2560 / Math.max(map.w, map.h));
  const W = Math.max(16, Math.round(map.w * k));
  const H = Math.max(16, Math.round(map.h * k));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = map.sea ? OCEAN : LAND_C;
  g.fillRect(0, 0, W, H);
  g.setTransform(k, 0, 0, k, 0, 0);
  if (map.sea && map.land) {
    g.fillStyle = LAND_C;
    g.fill(new Path2D(map.land));
  }
  if (map.water) {
    g.fillStyle = SHALLOW;
    g.fill(new Path2D(map.water));
  }
  g.fillStyle = FIELD;
  g.fill(new Path2D(map.field));
  // 잔디 깎은 줄무늬
  g.save();
  g.clip(new Path2D(map.field));
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 30;
  for (let x = -map.h; x < map.w; x += 90) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + map.h, map.h);
    g.stroke();
  }
  g.restore();
  if (map.apron) {
    g.fillStyle = APRON;
    g.fill(new Path2D(map.apron));
  }
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [w, d] of map.twy ?? []) {
    g.strokeStyle = TWY;
    g.lineWidth = Math.max(w, 2 / k);
    g.stroke(new Path2D(d));
  }
  // 건물 그림자 자리
  g.fillStyle = 'rgba(40,44,50,0.55)';
  for (const d of [map.term, map.hangar, map.bldg]) if (d) g.fill(new Path2D(d));
  g.setTransform(1, 0, 0, 1, 0, 0);
  // 가장자리 흐리게: destination-out은 칠한 곳만 지운다 (destination-in은 칠하지 않은 곳을 모두 지워 버린다)
  g.globalCompositeOperation = 'destination-out';
  const fade = (x0: number, y0: number, x1: number, y1: number) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, 'rgba(0,0,0,1)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    return gr;
  };
  const fw = Math.round(Math.min(W, H) * 0.08);
  g.fillStyle = fade(0, 0, fw, 0);
  g.fillRect(0, 0, fw, H);
  g.fillStyle = fade(W, 0, W - fw, 0);
  g.fillRect(W - fw, 0, fw, H);
  g.fillStyle = fade(0, 0, 0, fw);
  g.fillRect(0, 0, W, fw);
  g.fillStyle = fade(0, H, 0, H - fw);
  g.fillRect(0, H - fw, W, fw);
  g.globalCompositeOperation = 'source-over';
  return { canvas: cv, k };
}

/** 활주로 그림 (캔버스 아래쪽이 이름 앞쪽 끝): 가장자리 선·가운데 점선·문턱 줄무늬·번호·착지 표시 */
function runwayCanvas(len: number, width: number, n1: string, n2: string): HTMLCanvasElement {
  const W = 128;
  const H = 2048;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const my = H / len;
  const mx = W / width;
  g.fillStyle = ASPHALT;
  g.fillRect(0, 0, W, H);
  // 바퀴 자국 (가운데가 조금 어둡다)
  const tire = g.createLinearGradient(0, 0, W, 0);
  tire.addColorStop(0, 'rgba(0,0,0,0)');
  tire.addColorStop(0.35, 'rgba(0,0,0,0.12)');
  tire.addColorStop(0.5, 'rgba(0,0,0,0.04)');
  tire.addColorStop(0.65, 'rgba(0,0,0,0.12)');
  tire.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = tire;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#f2f2ee';
  // 가장자리 선
  const edge = Math.max(2, 0.9 * mx);
  g.fillRect(edge, 0, edge, H);
  g.fillRect(W - 2 * edge, 0, edge, H);
  // 한쪽 끝 표시 (end=0: 캔버스 아래 = 앞쪽 번호, 1: 위 = 뒤쪽 번호)
  const markEnd = (end: 0 | 1, name: string) => {
    // 끝에서 d(m) 떨어진 곳의 캔버스 y
    const y = (d: number) => (end === 0 ? H - d * my : d * my);
    // 문턱 줄무늬
    const keys = width >= 55 ? 16 : width >= 42 ? 12 : 8;
    const kw = (width * 0.8) / (keys * 2 - 1);
    for (let i = 0; i < keys; i++) {
      const x = (width * 0.1 + i * 2 * kw) * mx;
      const y0 = y(6);
      const y1 = y(36);
      g.fillRect(x, Math.min(y0, y1), kw * mx, Math.abs(y1 - y0));
    }
    // 번호: 그쪽에서 들어오는 비행기가 바로 읽게 (글자 높이 18 m, 오른쪽·왼쪽 글자는 문턱 쪽에)
    const num = name.replace(/[LRC]$/, '');
    const side = name.match(/[LRC]$/)?.[0] ?? '';
    const text = (t: string, d: number) => {
      g.save();
      g.translate(W / 2, y(d));
      if (end === 1) g.rotate(Math.PI);
      // 캔버스는 가로·세로 축척이 달라서 (가로가 훨씬 촘촘하다) 세로로 눌러 그린다
      g.scale(1, my / mx);
      g.font = `bold ${Math.round(18 * mx)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(t, 0, 0);
      g.restore();
    };
    if (side) text(side, 56);
    text(num, side ? 82 : 60);
    // 착지 표시 (300 m)·조준점 (400 m)
    for (const d of [150, 300, 450, 600]) {
      const yy = y(d + 22);
      for (const sx of [0.22, 0.66]) g.fillRect(sx * W, Math.min(yy, y(d)), 0.12 * W, Math.abs(yy - y(d)));
    }
    const a0 = y(400);
    const a1 = y(445);
    g.fillRect(0.18 * W, Math.min(a0, a1), 0.18 * W, Math.abs(a1 - a0));
    g.fillRect(0.64 * W, Math.min(a0, a1), 0.18 * W, Math.abs(a1 - a0));
  };
  markEnd(0, n1);
  markEnd(1, n2);
  // 가운데 점선 (36 m 칠하고 24 m 쉰다), 번호 사이만
  const cw = Math.max(2, 0.9 * mx);
  for (let d = 90; d < len - 90; d += 60) {
    const y0 = H - d * my;
    const y1 = H - Math.min(len - 90, d + 36) * my;
    g.fillRect(W / 2 - cw / 2, y1, cw, y0 - y1);
  }
  return cv;
}

// ------------------------------------------------------------------ 비행기 그물

const meshCache = new Map<string, PlaneMesh>();

function shapeOf(model: string): PlaneShape | undefined {
  return SHAPES[model] ?? FREIGHTER_SHAPES[model];
}

function cachedMesh(model: string, liv: Livery): PlaneMesh | null {
  const shape = shapeOf(model);
  if (!shape) return null;
  const key = `${model}|${liv.cheat}|${liv.tail}|${liv.logo ?? ''}`;
  let m = meshCache.get(key);
  if (!m) {
    m = planeMesh(shape, liv);
    meshCache.set(key, m);
    if (meshCache.size > 40) meshCache.delete(meshCache.keys().next().value as string);
  }
  return m;
}

function geometryOf(positions: Float32Array, colors: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  const lin = new Float32Array(colors.length);
  for (let i = 0; i < colors.length; i++) lin[i] = srgbToLinear(colors[i]);
  g.setAttribute('color', new BufferAttribute(lin, 3));
  g.computeBoundingSphere();
  return g;
}

/** 모형 좌표(x 앞 · y 왼쪽 · z 위)를 three 물체로 (모형 좌표 그대로) */
function planeObject(m: PlaneMesh, mats: { solid: Material; glass: Material }): Group {
  const grp = new Group();
  grp.add(new Mesh(geometryOf(m.positions, m.colors), mats.solid));
  if (m.glass.positions.length) {
    const glass = new Mesh(geometryOf(m.glass.positions, m.glass.colors), mats.glass);
    glass.renderOrder = 2;
    grp.add(glass);
  }
  return grp;
}

/** 비행기 그림자: 위에서 본 모양을 검게 칠한 그림 */
function shadowTexture(m: PlaneMesh): { tex: CanvasTexture; w: number; h: number; cx: number; cy: number } {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d')!;
  const w = m.max[0] - m.min[0];
  const h = m.max[1] - m.min[1];
  const k = (S - 8) / Math.max(w, h);
  // 알파 그림은 초록 채널을 읽는다: 검은 바탕에 흰 모양
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#fff';
  // x 앞 → 캔버스 오른쪽, y 왼쪽 → 캔버스 위
  const px = (x: number) => 4 + (x - m.min[0]) * k;
  const py = (y: number) => 4 + (m.max[1] - y) * k;
  const p = m.positions;
  for (let i = 0; i < p.length; i += 9) {
    g.beginPath();
    g.moveTo(px(p[i]), py(p[i + 1]));
    g.lineTo(px(p[i + 3]), py(p[i + 4]));
    g.lineTo(px(p[i + 6]), py(p[i + 7]));
    g.closePath();
    g.fill();
  }
  const tex = new CanvasTexture(cv);
  return { tex, w: (S - 8) / k + 8 / k, h: (S - 8) / k + 8 / k, cx: m.min[0] - 4 / k + S / k / 2, cy: m.max[1] + 4 / k - S / k / 2 };
}

// ------------------------------------------------------------------ 장면

/** 주기장에 세울 비행기 (도면 좌표) */
export interface ParkedRender {
  x: number;
  y: number;
  /** 코 방향 (도, 0 동쪽 · 90 남쪽) */
  hdg: number;
  model: string;
  livery: Livery;
}

export interface RideSceneInit {
  flight: RideFlight;
  livery: Livery;
  /** 회사 색 (지구본에 그리는 길) */
  color: string;
  parkedFrom: ParkedRender[];
  parkedTo: ParkedRender[];
}

interface AirportObj {
  ap: RideAirport;
  group: Group;
  ecefFromLocal: Matrix4;
  built: boolean;
  parked: ParkedRender[];
}

/** 카메라: 비행기를 둘러싼 공 위 (yaw는 비행기 기수에서 잰 각, π면 바로 뒤) */
export interface ChaseCamera {
  yaw: number;
  el: number;
  dist: number;
}

export class RideScene {
  readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly flight: RideFlight;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly earth: Mesh;
  private cap: Mesh | null = null;
  private capCenter: LL | null = null;
  private capFrame = new Matrix4();
  private readonly airports: AirportObj[];
  private readonly plane: Group;
  private readonly gear: Group;
  private readonly shadow: Mesh;
  private readonly track: Line;
  private readonly sky: Mesh;
  /** 지구본으로 볼 때 지구 둘레의 푸른 대기 */
  private readonly halo: Sprite;
  private readonly sun: DirectionalLight;
  private readonly fog: Fog;
  private readonly len: number;
  /** 모형 좌표의 주 바퀴 자리 (x)와 바퀴 바닥 (z) */
  private readonly pivot: [number, number];
  private readonly planeMats: { solid: MeshLambertMaterial; glass: MeshBasicMaterial };
  cam: ChaseCamera;
  private readonly defaultCam: ChaseCamera;
  private readonly tmpM = new Matrix4();

  constructor(canvas: HTMLCanvasElement, init: RideSceneInit) {
    this.flight = init.flight;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.camera = new PerspectiveCamera(55, 1, 0.5, 6e7);
    const scene = this.scene;
    scene.background = SKY_HORIZON.clone();
    this.fog = new Fog(SKY_HORIZON.clone(), 1000, 60000);
    scene.fog = this.fog;

    // 빛: 하늘빛 + 해 (늘 낮)
    scene.add(new HemisphereLight('#e2eeff', '#5f6d4f', 1.7));
    scene.add(new AmbientLight('#ffffff', 0.25));
    this.sun = new DirectionalLight('#fff4e2', 2.3);
    this.sun.position.set(0.45, 1, 0.3);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // 하늘: 카메라를 둘러싼 공, 위로 갈수록 짙은 파랑
    {
      const g = new SphereGeometry(1, 32, 16);
      const pos = g.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const c = new Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        c.copy(SKY_HORIZON).lerp(SKY_TOP, smooth(0, 0.7, y));
        col.set([c.r, c.g, c.b], i * 3);
      }
      g.setAttribute('color', new BufferAttribute(col, 3));
      // 불투명하게 두고 맨 먼저 그린다 (반투명이면 three.js가 땅·비행기를 그린 뒤에 덮어 그린다)
      const m = new MeshBasicMaterial({ vertexColors: true, side: BackSide, depthWrite: false, depthTest: false, fog: false });
      this.sky = new Mesh(g, m);
      this.sky.renderOrder = -10;
      this.sky.frustumCulled = false;
      scene.add(this.sky);
      this.disposables.push(g, m);
    }

    // 대기 테두리: 지구 가운데에 늘 카메라를 보는 판을 두고, 지구 가장자리에 맞춰 푸른 고리를 그린다
    {
      const S = 512;
      const cv = document.createElement('canvas');
      cv.width = S;
      cv.height = S;
      const g = cv.getContext('2d')!;
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(110,170,255,0)');
      gr.addColorStop(0.77, 'rgba(110,170,255,0)');
      gr.addColorStop(0.8, 'rgba(150,200,255,0.75)');
      gr.addColorStop(0.84, 'rgba(90,150,255,0.3)');
      gr.addColorStop(0.92, 'rgba(60,110,230,0.08)');
      gr.addColorStop(1, 'rgba(60,110,230,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      const m = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
      this.halo = new Sprite(m);
      this.halo.frustumCulled = false;
      this.halo.visible = false;
      scene.add(this.halo);
      this.disposables.push(tex, m);
    }

    // 지구 (실제보다 400 m 낮게)
    {
      const rows = 180;
      const cols = 360;
      const rg = R - 400;
      const pos = new Float32Array((rows + 1) * (cols + 1) * 3);
      const uv = new Float32Array((rows + 1) * (cols + 1) * 2);
      for (let i = 0; i <= rows; i++) {
        const lat = 90 - (180 * i) / rows;
        for (let j = 0; j <= cols; j++) {
          const lon = -180 + (360 * j) / cols;
          const v = llToVec([lat, lon]);
          const k = i * (cols + 1) + j;
          pos.set([v[0] * rg, v[1] * rg, v[2] * rg], k * 3);
          uv.set([j / cols, 1 - i / rows], k * 2);
        }
      }
      const idx: number[] = [];
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          const a = i * (cols + 1) + j;
          const b = a + cols + 1;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('uv', new BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const tex = new CanvasTexture(worldTextureCanvas());
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const m = new MeshLambertMaterial({ map: tex });
      // 땅 무늬: 거친 세계 지도 위에 10 km·1 km 크기의 밭·숲 무늬를 겹친다 (낮게 날 때 밋밋하지 않게)
      const detail = new CanvasTexture(detailCanvas());
      detail.wrapS = RepeatWrapping;
      detail.wrapT = RepeatWrapping;
      detail.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      m.onBeforeCompile = (sh) => {
        sh.uniforms.detailMap = { value: detail };
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D detailMap;').replace(
          '#include <map_fragment>',
          [
            '#include <map_fragment>',
            '{',
            '  float d1 = texture2D(detailMap, vMapUv * vec2(4000.0, 2000.0)).r;',
            '  float d2 = texture2D(detailMap, vMapUv * vec2(40000.0, 20000.0) + 0.37).r;',
            '  float land = smoothstep(-0.01, 0.06, diffuseColor.g - diffuseColor.b);',
            '  diffuseColor.rgb *= mix(1.0, 0.62 + 0.76 * (0.55 * d1 + 0.45 * d2), land * 0.85);',
            '}',
          ].join('\n'),
        );
      };
      this.earth = new Mesh(g, m);
      this.earth.matrixAutoUpdate = false;
      this.earth.frustumCulled = false;
      scene.add(this.earth);
      this.disposables.push(g, m, tex, detail);
    }

    // 지구본에 그리는 길
    {
      const pts: number[] = [];
      for (const v of this.flight.track) pts.push(v[0] * (R + 600), v[1] * (R + 600), v[2] * (R + 600));
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pts, 3));
      const m = new LineBasicMaterial({ color: new Color(init.color).lerp(new Color('#ffffff'), 0.25), transparent: true, opacity: 0, fog: false, depthWrite: false });
      this.track = new Line(g, m);
      this.track.matrixAutoUpdate = false;
      this.track.frustumCulled = false;
      this.track.renderOrder = 3;
      scene.add(this.track);
      this.disposables.push(g, m);
    }

    // 공항 (출발은 바로, 도착은 조금 뒤에 짓는다)
    this.airports = [
      { ap: this.flight.from, group: new Group(), ecefFromLocal: ecefFromLocal(this.flight.from.ll), built: false, parked: init.parkedFrom },
      { ap: this.flight.to, group: new Group(), ecefFromLocal: ecefFromLocal(this.flight.to.ll), built: false, parked: init.parkedTo },
    ];
    for (const a of this.airports) {
      a.group.matrixAutoUpdate = false;
      scene.add(a.group);
    }
    this.planeMats = {
      solid: new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide }),
      glass: new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false }),
    };
    this.disposables.push(this.planeMats.solid, this.planeMats.glass);
    this.buildAirport(this.airports[0]);

    // 타는 비행기
    const shape = shapeOf(this.flight.model.id)!;
    const pm = planeMesh(shape, init.livery);
    this.len = shape.len;
    const clearance = 0.45 + 0.08 * shape.dia;
    const bottom = pm.min[2] - clearance;
    this.pivot = [-0.5 * shape.len, bottom];
    this.plane = new Group();
    this.plane.matrixAutoUpdate = false;
    const body = planeObject(pm, this.planeMats);
    body.position.set(-this.pivot[0], 0, -this.pivot[1]);
    this.plane.add(body);
    this.gear = this.makeGear(shape, pm, bottom);
    this.gear.position.copy(body.position);
    this.plane.add(this.gear);
    scene.add(this.plane);
    for (const o of body.children) this.disposables.push((o as Mesh).geometry);

    // 그림자 (땅 가까이 있을 때만)
    {
      const st = shadowTexture(pm);
      const g = new PlaneGeometry(st.w, st.h);
      const m = new MeshBasicMaterial({ alphaMap: st.tex, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, color: '#000000' });
      this.shadow = new Mesh(g, m);
      this.shadow.renderOrder = 5;
      this.shadow.matrixAutoUpdate = false;
      this.shadow.userData = { cx: st.cx - this.pivot[0], cy: st.cy };
      scene.add(this.shadow);
      this.disposables.push(g, m, st.tex);
    }

    this.defaultCam = { yaw: Math.PI - 0.35, el: 10 * D2R, dist: shape.len * 1.9 + 22 };
    this.cam = { ...this.defaultCam };
  }

  /** 바퀴: 주 바퀴 둘(날개 밑)과 앞바퀴 */
  private makeGear(shape: PlaneShape, pm: PlaneMesh, bottom: number): Group {
    const grp = new Group();
    const wheelR = 0.35 + 0.005 * shape.len;
    const tireM = new MeshLambertMaterial({ color: '#25282d' });
    const strutM = new MeshLambertMaterial({ color: '#a7b0ba' });
    this.disposables.push(tireM, strutM);
    const wheelG = new CylinderGeometry(wheelR, wheelR, wheelR * 0.7, 14);
    wheelG.rotateX(Math.PI / 2);
    this.disposables.push(wheelG);
    const strut = (x: number, y: number, top: number) => {
      const h = Math.max(0.3, top - (bottom + wheelR));
      const g = new CylinderGeometry(wheelR * 0.18, wheelR * 0.18, h, 8);
      g.rotateX(Math.PI / 2);
      this.disposables.push(g);
      const m = new Mesh(g, strutM);
      m.position.set(x, y, bottom + wheelR + h / 2);
      grp.add(m);
    };
    const wheels = (x: number, y: number, pairs: number) => {
      for (let i = 0; i < pairs; i++) {
        for (const s of [-1, 1]) {
          const w = new Mesh(wheelG, tireM);
          w.position.set(x - i * wheelR * 2.3, y + s * wheelR * 0.55, bottom + wheelR);
          grp.add(w);
        }
      }
    };
    const yG = Math.max(shape.dia * 0.75, 0.085 * shape.span);
    const mainX = this.pivot[0];
    const pairs = shape.len > 50 ? 2 : 1;
    const bodyBottom = Math.min(pm.min[2] + 0.45 + 0.08 * shape.dia, 0) + 0.6;
    for (const s of [-1, 1]) {
      wheels(mainX + (pairs > 1 ? wheelR * 1.15 : 0), s * yG, pairs);
      strut(mainX, s * yG, bodyBottom);
    }
    const noseX = -0.1 * shape.len;
    wheels(noseX, 0, 1);
    strut(noseX, 0, bodyBottom);
    return grp;
  }

  /** 공항 하나를 세운다 (바닥·활주로·건물·관제탑·주기장 비행기) */
  private buildAirport(a: AirportObj) {
    if (a.built) return;
    a.built = true;
    const { ap, group } = a;
    const map = ap.map;
    const L = (x: number, y: number): [number, number] => [x - ap.cx, ap.cy - y];
    // 바닥
    {
      const { canvas } = airportGroundCanvas(map);
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const g = new PlaneGeometry(map.w, map.h);
      g.rotateX(-Math.PI / 2);
      const m = new MeshLambertMaterial({ map: tex, transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1 });
      const mesh = new Mesh(g, m);
      const [e, n] = L(map.w / 2, map.h / 2);
      mesh.position.set(e, 0.25, -n);
      mesh.renderOrder = 1;
      group.add(mesh);
      this.disposables.push(g, m, tex);
    }
    // 활주로
    for (const [x1, y1, x2, y2, width, name] of map.rwy) {
      const a1 = L(x1, y1);
      const a2 = L(x2, y2);
      const len = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
      if (len < 100) continue;
      const [n1, n2] = name.split('/');
      const tex = new CanvasTexture(runwayCanvas(len, width, n1 ?? name, n2 ?? name));
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const d = [(a2[0] - a1[0]) / len, (a2[1] - a1[1]) / len];
      const rt = [d[1], -d[0]];
      const hw = width / 2;
      // 장면 좌표 (x 동, z 남)
      const P = (p: [number, number], s: number) => [p[0] + rt[0] * hw * s, 0.45, -(p[1] + rt[1] * hw * s)];
      const v = [...P(a1, -1), ...P(a1, 1), ...P(a2, 1), ...P(a2, -1)];
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(v, 3));
      g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setAttribute('normal', new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = new MeshLambertMaterial({ map: tex, side: DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: -2 });
      const mesh = new Mesh(g, m);
      mesh.renderOrder = 2;
      group.add(mesh);
      this.disposables.push(g, m, tex);
    }
    // 유도로: 바닥 그림은 멀리서 보는 용, 가까이는 또렷한 띠 (가운데 노란 선)
    {
      const twyPos: number[] = [];
      const linePos: number[] = [];
      const ribbon = (out: number[], pts: [number, number][], w: number, y: number, joints: boolean) => {
        const hw = w / 2;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const l = Math.hypot(dx, dy);
          if (l < 0.01) continue;
          const nx = (-dy / l) * hw;
          const ny = (dx / l) * hw;
          const q = (p: [number, number], s2: number) => [p[0] + nx * s2, y, -(p[1] + ny * s2)];
          const v = [q(a, 1), q(b, 1), q(b, -1), q(a, 1), q(b, -1), q(a, -1)];
          for (const t of v) out.push(t[0], t[1], t[2]);
        }
        if (!joints) return;
        // 꺾이는 곳 메우기 (작은 여덟모)
        for (let i = 1; i < pts.length - 1; i++) {
          const c = pts[i];
          for (let j = 0; j < 8; j++) {
            const a0 = (j / 8) * Math.PI * 2;
            const a1 = ((j + 1) / 8) * Math.PI * 2;
            out.push(c[0], y, -c[1], c[0] + Math.cos(a1) * hw, y, -(c[1] + Math.sin(a1) * hw), c[0] + Math.cos(a0) * hw, y, -(c[1] + Math.sin(a0) * hw));
          }
        }
      };
      for (const [w, d] of map.twy ?? []) {
        for (const ring of pathRings(d)) {
          const pts = ring.map(([x, y]) => L(x, y));
          ribbon(twyPos, pts, w, 0.33, true);
          ribbon(linePos, pts, Math.min(0.9, Math.max(0.45, w * 0.025)), 0.37, false);
        }
      }
      const flat = (arr: number[], color: string, factor: number) => {
        if (!arr.length) return;
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(arr, 3));
        const nor = new Float32Array(arr.length);
        for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
        g.setAttribute('normal', new BufferAttribute(nor, 3));
        g.computeBoundingSphere();
        // 평면 음영: 면을 감은 방향과 상관없이 보는 쪽을 향한다 (뒤집힌 면이 검게 보이지 않게)
        const m = new MeshLambertMaterial({ color, side: DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: factor });
        const mesh = new Mesh(g, m);
        mesh.renderOrder = 2;
        group.add(mesh);
        this.disposables.push(g, m);
      };
      flat(twyPos, TWY, -1.5);
      flat(linePos, TWY_LINE, -1.8);
    }
    // 건물
    const extrude = (d: string | undefined, height: number, color: string) => {
      if (!d) return;
      const geoms: BufferGeometry[] = [];
      for (const ring of pathRings(d)) {
        if (ring.length < 3) continue;
        const pts = ring.map(([x, y]) => {
          const [e, n] = L(x, y);
          return new Vector2(e, n);
        });
        // 아주 작은 조각은 건너뛴다
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          area += p.x * q.y - q.x * p.y;
        }
        if (Math.abs(area) / 2 < 60) continue;
        const h = height * (0.75 + 0.5 * ((Math.abs(area) % 7) / 7));
        const g = new ExtrudeGeometry(new Shape(pts), { depth: h, bevelEnabled: false, curveSegments: 1 });
        g.rotateX(-Math.PI / 2);
        geoms.push(g.index ? g.toNonIndexed() : g);
      }
      if (!geoms.length) return;
      const merged = mergeGeometries(geoms);
      for (const g of geoms) g.dispose();
      const m = new MeshLambertMaterial({ color });
      const mesh = new Mesh(merged, m);
      mesh.position.y = 0.3;
      group.add(mesh);
      this.disposables.push(merged, m);
    };
    extrude(map.term, 18, '#d6dde5');
    extrude(map.hangar, 22, '#aab5c0');
    extrude(map.bldg, 11, '#c2bbae');
    // 관제탑
    if (map.tower) {
      const [e, n] = L(map.tower[0], map.tower[1]);
      const shaftG = new CylinderGeometry(3.2, 4.5, 48, 12);
      const cabG = new CylinderGeometry(7.5, 6, 7, 12);
      const roofG = new CylinderGeometry(6.5, 8, 1.5, 12);
      const shaftM = new MeshLambertMaterial({ color: '#dfe4ea' });
      const cabM = new MeshLambertMaterial({ color: '#27394d' });
      const shaft = new Mesh(shaftG, shaftM);
      shaft.position.set(e, 24, -n);
      const cab = new Mesh(cabG, cabM);
      cab.position.set(e, 51.5, -n);
      const roof = new Mesh(roofG, shaftM);
      roof.position.set(e, 55.7, -n);
      group.add(shaft, cab, roof);
      this.disposables.push(shaftG, cabG, roofG, shaftM, cabM);
    }
    // 주기장 비행기: 기종·칠마다 한 번만 만들고 여러 자리에 찍는다
    const byKey = new Map<string, ParkedRender[]>();
    for (const p of a.parked) {
      const key = `${p.model}|${p.livery.cheat}|${p.livery.tail}|${p.livery.logo ?? ''}`;
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    const tmp = new Object3D();
    for (const list of byKey.values()) {
      const m = cachedMesh(list[0].model, list[0].livery);
      const shape = shapeOf(list[0].model);
      if (!m || !shape) continue;
      const geo = geometryOf(m.positions, m.colors);
      // 모형 좌표 (x 앞 · y 왼쪽 · z 위) → 장면 (x 동 · y 위 · z 남): 코를 동쪽에 두고 돌린다
      geo.applyMatrix4(new Matrix4().set(1, 0, 0, 0.45 * shape.len, 0, 0, 1, -(m.min[2] - 0.45 - 0.08 * shape.dia), 0, -1, 0, 0, 0, 0, 0, 1));
      const inst = new InstancedMesh(geo, this.planeMats.solid, list.length);
      list.forEach((p, i) => {
        const [e, n] = L(p.x, p.y);
        tmp.position.set(e, 0.35, -n);
        // hdg: 0 동쪽 · 90 남쪽 (도면) → 장면에서 y축으로 −hdg 만큼 돌린다
        tmp.rotation.set(0, -p.hdg * D2R, 0);
        tmp.updateMatrix();
        inst.setMatrixAt(i, tmp.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
      this.disposables.push(geo);
    }
  }

  /** 낮게 날 때 쓰는 발밑 땅 (실제 높이의 고운 그물, 반지름 80 km) */
  private buildCap(center: LL) {
    if (this.cap) {
      this.scene.remove(this.cap);
      this.cap.geometry.dispose();
    }
    const RINGS = 64;
    const SEG = 96;
    const RAD = 80000;
    const pos: number[] = [];
    const uv: number[] = [];
    const lon0 = center[1];
    const push = (ll: LL) => {
      const v = llToVec(ll);
      const p = localOfVec(center, v);
      pos.push(p[0], p[1], p[2]);
      let lon = ll[1];
      while (lon - lon0 > 180) lon -= 360;
      while (lon - lon0 < -180) lon += 360;
      uv.push((lon + 180) / 360, (ll[0] + 90) / 180);
    };
    push(center);
    for (let i = 1; i <= RINGS; i++) {
      const r = RAD * Math.pow(i / RINGS, 1.5);
      for (let j = 0; j < SEG; j++) push(destination(center, (2 * Math.PI * j) / SEG, r));
    }
    const idx: number[] = [];
    for (let j = 0; j < SEG; j++) idx.push(0, 1 + j, 1 + ((j + 1) % SEG));
    for (let i = 1; i < RINGS; i++) {
      const a0 = 1 + (i - 1) * SEG;
      const b0 = 1 + i * SEG;
      for (let j = 0; j < SEG; j++) {
        const j1 = (j + 1) % SEG;
        idx.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (!this.cap) {
      this.cap = new Mesh(g, this.earth.material as Material);
      this.cap.matrixAutoUpdate = false;
      this.cap.frustumCulled = false;
    } else this.cap.geometry = g;
    this.scene.add(this.cap);
    this.capCenter = center;
    this.capFrame = ecefFromLocal(center);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  orbit(dx: number, dy: number) {
    this.cam.yaw -= dx * 0.006;
    this.cam.el = clamp(this.cam.el + dy * 0.005, -0.15, 1.53);
  }

  zoom(f: number) {
    this.cam.dist = clamp(this.cam.dist * f, this.len * 0.8 + 8, 2.5e7);
  }

  resetCamera() {
    this.cam = { ...this.defaultCam };
  }

  /** 멀리서 지구본처럼 보기 ↔ 가까이 */
  globeView(on: boolean) {
    this.cam = on ? { yaw: Math.PI, el: 0.9, dist: 9.5e6 } : { ...this.defaultCam };
  }

  /** 이 순간의 비행기에 맞춰 모든 것을 옮긴다 */
  update(st: RideState) {
    const { e, n, u } = enuBasis(st.ll);
    const O: V3 = [st.pos[0] * R, st.pos[1] * R, st.pos[2] * R];
    const M = sceneFromEcef(O, e, n, u, this.tmpM);
    this.earth.matrix.copy(M);
    this.earth.matrixWorldNeedsUpdate = true;
    this.track.matrix.copy(M);
    this.track.matrixWorldNeedsUpdate = true;

    // 공항: 도착 공항은 비행기가 가까워지기 전에 짓는다
    let lift = 0.45;
    for (const a of this.airports) {
      if (!a.built && gcDistance(st.ll, a.ap.ll) < 900000) this.buildAirport(a);
      a.group.matrix.multiplyMatrices(M, a.ecefFromLocal);
      a.group.matrixWorldNeedsUpdate = true;
      // 공항 바닥은 평평하고 땅은 둥글다: 공항 가운데에서 멀수록 조금 들어 올린다
      const d = gcDistance(st.ll, a.ap.ll);
      if (d < 9000) lift = Math.max(lift, 0.45 + (d * d) / (2 * R));
    }

    // 비행기 자세: 앞 f · 왼쪽 l · 위 w (장면 좌표)
    const ch = Math.cos(st.heading);
    const sh = Math.sin(st.heading);
    const cp = Math.cos(st.pitch);
    const sp = Math.sin(st.pitch);
    const f = new Vector3(sh * cp, sp, -ch * cp);
    const r0 = new Vector3(ch, 0, sh);
    const w0 = new Vector3().crossVectors(r0, f);
    const cb = Math.cos(st.bank);
    const sb = Math.sin(st.bank);
    const r = r0.clone().multiplyScalar(cb).addScaledVector(w0, -sb);
    const w = w0.clone().multiplyScalar(cb).addScaledVector(r0, sb);
    const l = r.clone().negate();
    const camDist = this.cam.dist;
    const scale = Math.max(1, camDist / (this.len * 16));
    const y = st.alt + lift;
    this.plane.matrix.set(f.x * scale, l.x * scale, w.x * scale, 0, f.y * scale, l.y * scale, w.y * scale, y, f.z * scale, l.z * scale, w.z * scale, 0, 0, 0, 0, 1);
    this.plane.matrixWorldNeedsUpdate = true;
    this.gear.visible = st.gear;

    // 그림자: 비행기 바로 밑 땅에, 높을수록 옅게
    {
      const op = 0.38 * (1 - smooth(5, 350, st.alt));
      this.shadow.visible = op > 0.01 && scale < 3;
      (this.shadow.material as MeshBasicMaterial).opacity = op;
      const fh = new Vector3(sh, 0, -ch);
      const lh = new Vector3(-ch, 0, -sh);
      const { cx, cy } = this.shadow.userData as { cx: number; cy: number };
      const px = fh.x * cx * scale + lh.x * cy * scale;
      const pz = fh.z * cx * scale + lh.z * cy * scale;
      // 평면 그림: 그림의 x → 앞, 그림의 y → 왼쪽, 바닥에 눕힌다
      this.shadow.matrix.set(fh.x * scale, lh.x * scale, 0, px, 0, 0, 1, lift + 0.06, fh.z * scale, lh.z * scale, 0, pz, 0, 0, 0, 1);
      this.shadow.matrixWorldNeedsUpdate = true;
    }

    // 카메라: 비행기 둘레 (수평 기수 방향 기준)
    const cam = this.cam;
    const fh = new Vector3(sh, 0, -ch);
    const rh = new Vector3(ch, 0, sh);
    const target = new Vector3(0, y + this.len * 0.08 * Math.min(scale, 1), 0);
    let el = cam.el;
    const camPos = new Vector3();
    for (let i = 0; i < 90; i++) {
      const dir = fh
        .clone()
        .multiplyScalar(Math.cos(el) * Math.cos(cam.yaw))
        .addScaledVector(rh, Math.cos(el) * Math.sin(cam.yaw))
        .addScaledVector(new Vector3(0, 1, 0), Math.sin(el));
      camPos.copy(target).addScaledVector(dir, camDist);
      // 카메라가 땅속으로 들어가지 않게
      const q: V3 = [O[0] + e[0] * camPos.x + u[0] * camPos.y - n[0] * camPos.z, O[1] + e[1] * camPos.x + u[1] * camPos.y - n[1] * camPos.z, O[2] + e[2] * camPos.x + u[2] * camPos.y - n[2] * camPos.z];
      const camAlt = Math.hypot(q[0], q[1], q[2]) - R;
      if (camAlt > lift + 1.5 || el > 1.5) break;
      el += 0.01;
    }
    this.camera.position.copy(camPos);
    // 공을 따라 도는 카메라의 위쪽: 수평으로 볼 때는 하늘, 내려다볼수록 보는 쪽
    const lookH = fh.clone().multiplyScalar(-Math.cos(cam.yaw)).addScaledVector(rh, -Math.sin(cam.yaw));
    this.camera.up.set(0, 1, 0).multiplyScalar(Math.cos(el)).addScaledVector(lookH, Math.sin(el)).normalize();
    this.camera.lookAt(target);
    const camQ: V3 = [O[0] + e[0] * camPos.x + u[0] * camPos.y - n[0] * camPos.z, O[1] + e[1] * camPos.x + u[1] * camPos.y - n[1] * camPos.z, O[2] + e[2] * camPos.x + u[2] * camPos.y - n[2] * camPos.z];
    const camAlt = Math.max(1, Math.hypot(camQ[0], camQ[1], camQ[2]) - R);
    this.camera.near = clamp(camDist * 0.004, 0.3, 5000);
    this.camera.far = camDist + 3e7;
    this.camera.updateProjectionMatrix();

    // 낮을 때만 발밑 고운 땅
    const low = camAlt < 6000 || st.alt < 6000;
    if (low) {
      if (!this.capCenter || gcDistance(this.capCenter, st.ll) > 25000) this.buildCap(st.ll);
      this.cap!.visible = true;
      this.cap!.matrix.multiplyMatrices(M, this.capFrame);
      this.cap!.matrixWorldNeedsUpdate = true;
    } else if (this.cap) this.cap.visible = false;

    // 하늘·안개: 높이 올라가면 우주
    const space = smooth(40000, 250000, camAlt);
    const horizon = Math.sqrt(2 * R * camAlt + camAlt * camAlt);
    const far = horizon * 1.3 + 45000;
    this.fog.far = space > 0.98 ? 1e12 : far / (1 - space * 0.98);
    this.fog.near = this.fog.far * 0.04;
    this.fog.color.copy(SKY_HORIZON).lerp(SPACE, space);
    (this.scene.background as Color).copy(SKY_HORIZON).lerp(SPACE, space);
    this.sky.visible = space < 0.995;
    // 우주로 나갈수록 어둡게 (우주 색은 거의 검정)
    (this.sky.material as MeshBasicMaterial).color.setScalar(1 - space);
    this.sky.position.copy(camPos);
    this.sky.scale.setScalar(Math.max(10, camDist * 2));
    // 대기 테두리: 카메라에서 본 지구 가장자리 반지름에 고리(그림 반지름의 0.8)를 맞춘다
    {
      const center = new Vector3(0, -R, 0);
      const D = camPos.distanceTo(center);
      const show = smooth(150000, 1200000, camAlt);
      this.halo.visible = show > 0.01 && D > R * 1.001;
      if (this.halo.visible) {
        const rs = R / Math.sqrt(1 - Math.min(0.999999, (R / D) ** 2));
        this.halo.position.copy(center);
        this.halo.scale.setScalar((2 * rs) / 0.8);
        (this.halo.material as SpriteMaterial).opacity = show;
      }
    }
    // 길은 멀리서만
    (this.track.material as LineBasicMaterial).opacity = 0.9 * smooth(20000, 200000, camDist);
    this.track.visible = camDist > 20000;
    // 해: 장면 위쪽에서 비스듬히 (늘 낮)
    this.sun.position.set(0.45, 1, 0.3).multiplyScalar(1000).add(target);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** 화면 위 공항 자리 (이름표용). 화면 밖이거나 지구 뒤면 null */
  screenOf(which: 'from' | 'to', st: RideState, w: number, h: number): { x: number; y: number } | null {
    const ap = which === 'from' ? this.flight.from : this.flight.to;
    const { e, n, u } = enuBasis(st.ll);
    const O: V3 = [st.pos[0] * R, st.pos[1] * R, st.pos[2] * R];
    const M = sceneFromEcef(O, e, n, u, new Matrix4());
    const v = llToVec(ap.ll);
    const p = new Vector3(v[0] * R, v[1] * R, v[2] * R).applyMatrix4(M);
    // 지구 뒤에 숨었는지: 카메라에서 그 점까지 선이 지구를 지나는지
    const camQ = this.camera.position.clone();
    const toP = p.clone().sub(camQ);
    const center = new Vector3(0, -R, 0);
    const dirN = toP.clone().normalize();
    const oc = camQ.clone().sub(center);
    const b = oc.dot(dirN);
    const c = oc.lengthSq() - (R - 1000) * (R - 1000);
    const disc = b * b - c;
    if (disc > 0) {
      const t = -b - Math.sqrt(disc);
      if (t > 0 && t < toP.length() - 2000) return null;
    }
    const s = p.clone().project(this.camera);
    if (s.z > 1 || s.x < -1.2 || s.x > 1.2 || s.y < -1.2 || s.y > 1.2) return null;
    return { x: ((s.x + 1) / 2) * w, y: ((1 - s.y) / 2) * h };
  }

  dispose() {
    for (const a of this.airports) a.group.clear();
    if (this.cap) this.cap.geometry.dispose();
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** 여러 그물을 하나로 (위치·법선만, 모두 인덱스 없는 그물) */
function mergeGeometries(list: BufferGeometry[]): BufferGeometry {
  let n = 0;
  for (const g of list) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const q = g.getAttribute('normal');
    pos.set(p.array as Float32Array, o * 3);
    if (q) nor.set(q.array as Float32Array, o * 3);
    o += p.count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

