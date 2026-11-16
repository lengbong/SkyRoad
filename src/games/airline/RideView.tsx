import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MODEL } from './aircraft';
import { SHAPES } from './aircraftShapes';
import { parkPlanes, visitingPlanes, type ParkedPlane } from './airportScene';
import { SEAT_SHAPES } from './Art';
import { coColors } from './brand';
import { CITY } from './cities';
import { FREIGHTER_SHAPES } from './freighterShapes';
import { NEUTRAL_LIVERY, companyLivery, type Livery } from './plane3d';
import { PHASE_NAMES, planRide, type RideFlight, type RidePhase, type RideState } from './rideFlight';
import { RideScene, type ParkedRender } from './rideScene';
import { routeOf } from './simulate';
import { yearOf } from './time';
import type { AirlineState, Company } from './types';

/**
 * 운항 중인 비행기에 타 보기: 회사 비행기가 띄우는 노선 하나를 골라, 출발 공항 활주로에서 뜨고
 * 대권 항로로 날아 도착 공항 활주로에 내릴 때까지 3D로 따라가며 본다.
 * 이륙·착륙은 실제 빠르기, 순항은 빨리감기(×10~×1000). 착륙이 가까워지면 빨리감기를 저절로 줄인다.
 */

interface RideViewProps {
  state: AirlineState;
  company: number;
  plane: number;
  /** 처음에 탈 노선 (없으면 그 비행기의 첫 노선) */
  route?: number;
  onClose: () => void;
}

const SPEEDS = [0, 1, 10, 100, 1000] as const;
type Speed = (typeof SPEEDS)[number];

/** 게임에 없는 다른 항공사: 회색 칠 */
const OTHER_LIVERY: Livery = { ...NEUTRAL_LIVERY, cheat: '#8f9aa6', tail: '#a3adb8', engine: '#c9d0d8' };

function liveryOf(c: Company): Livery {
  const col = coColors(c);
  return companyLivery(col.main, col.dark, SEAT_SHAPES[c.seat]);
}

function hm(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}시간 ${m % 60}분` : `${m}분`;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

interface Hud {
  phase: RidePhase;
  alt: number;
  speed: number;
  left: number;
  tLeft: number;
  s: number;
}

export function RideView({ state, company, plane, route, onClose }: RideViewProps) {
  const co = state.companies[company];
  const p = co?.planes.find((x) => x.id === plane);
  const year = yearOf(state.q);
  const legs = useMemo(() => (p ? p.legs.map((l) => routeOf(co, l.route)).filter((r) => !!r) : []), [p, co]);
  const [routeId, setRouteId] = useState<number | undefined>(() => (route !== undefined && legs.some((r) => r.id === route) ? route : legs[0]?.id));
  const r = legs.find((x) => x.id === routeId) ?? legs[0];
  // 본사에서 떠나는 쪽부터
  const [flip, setFlip] = useState(() => !!r && r.b === co?.hub && r.a !== co?.hub);
  const fromCity = r ? (flip ? r.b : r.a) : '';
  const toCity = r ? (flip ? r.a : r.b) : '';
  const hasModel = !!p && !!(SHAPES[p.model] ?? FREIGHTER_SHAPES[p.model]);
  const flight = useMemo<RideFlight | null>(() => (p && r && hasModel ? planRide(p.model, fromCity, toCity, { year }) : null), [p, r, hasModel, fromCity, toCity, year]);

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RideScene | null>(null);
  const timeRef = useRef(0);
  const speedRef = useRef<Speed>(1);
  const lastS = useRef(0);
  const stRef = useRef<RideState | null>(null);
  const fromLabel = useRef<HTMLSpanElement>(null);
  const toLabel = useRef<HTMLSpanElement>(null);
  const [speed, setSpeedState] = useState<Speed>(1);
  const [hud, setHud] = useState<Hud | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globe, setGlobe] = useState(false);
  const [run, setRun] = useState(0);
  const close = useRef<HTMLButtonElement>(null);

  const setSpeed = useCallback((s: Speed) => {
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  // 주기장 비행기 (2D 공항 도면과 같은 자리·같은 칠)
  const parked = useMemo(() => {
    if (!flight || !p) return { from: [] as ParkedRender[], to: [] as ParkedRender[] };
    const toRender = (list: ParkedPlane[]): ParkedRender[] =>
      list.map((x) => ({ x: x.x, y: x.y, hdg: x.hdg, model: x.model, livery: x.company === null ? OTHER_LIVERY : liveryOf(state.companies[x.company]) }));
    const at = (city: string, icao: string, skipMine: boolean) => {
      let visiting = visitingPlanes(state, city, company);
      if (skipMine) {
        // 지금 타는 비행기는 활주로에 있으니 주기장에서 한 대 뺀다
        const i = visiting.findIndex((v) => v.company === company && v.model === p.model);
        if (i >= 0) visiting = [...visiting.slice(0, i), ...visiting.slice(i + 1)];
      }
      const ap = city === flight.from.city ? flight.from : flight.to;
      return toRender(parkPlanes(ap.map, icao, city, year, visiting).slice(0, 60));
    };
    return { from: at(flight.from.city, flight.from.icao, true), to: at(flight.to.city, flight.to.icao, false) };
  }, [flight, p, state, company, year]);

  // 장면 만들기 · 그리기
  useEffect(() => {
    const stage = stageRef.current;
    if (!flight || !stage || !co) return;
    // 장면마다 새 캔버스 (닫을 때 WebGL을 바로 돌려주므로 같은 캔버스를 다시 쓸 수 없다)
    const canvas = document.createElement('canvas');
    canvas.className = 'al-ride-canvas';
    canvas.setAttribute('aria-label', `${co.name} 3D 화면: 끌어서 돌려 보고, 휠로 멀리·가까이 볼 수 있어요`);
    stage.prepend(canvas);
    let scene: RideScene;
    try {
      scene = new RideScene(canvas, { flight, livery: liveryOf(co), color: coColors(co).main, parkedFrom: parked.from, parkedTo: parked.to });
    } catch (e) {
      console.error(e);
      canvas.remove();
      setError('이 컴퓨터의 브라우저에서는 3D 그림(WebGL)을 그릴 수 없어요. 브라우저의 하드웨어 가속 설정을 켜 보세요.');
      return;
    }
    // 끌어서 돌려 보기 · 휠로 멀리/가까이 · 두 번 눌러 처음 자리
    let drag: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      scene.orbit(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scene.zoom(Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.004));
    };
    const onDbl = () => scene.resetCamera();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    setError(null);
    sceneRef.current = scene;
    timeRef.current = 0;
    lastS.current = 0;
    setSpeed(1);
    setGlobe(false);
    setNote(null);
    const fit = () => scene.resize(stage.clientWidth, stage.clientHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    // 개발할 때만: 브라우저 시험에서 비행 시간을 건너뛴다 (window.__ride.seek(0~1))
    if (import.meta.env.DEV) (window as unknown as { __ride?: unknown }).__ride = { seek: (f: number) => (timeRef.current = f * flight.duration), flight };
    let raf = 0;
    let last = performance.now();
    let hudAt = 0;
    const frame = (now: number) => {
      // 느린 컴퓨터에서 그림이 드문드문해도 비행 시간은 제 빠르기로 (한 번에 0.25초까지만)
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      timeRef.current = Math.min(flight.duration, timeRef.current + dt * speedRef.current);
      const st = flight.at(timeRef.current);
      // 착륙이 가까워지면 빨리감기를 줄인다
      for (const cap of flight.caps) {
        if (lastS.current < cap.s && st.s >= cap.s && speedRef.current > cap.max) {
          const over = speedRef.current;
          setSpeed(cap.max as Speed);
          setNote(cap.max === 1 ? '곧 착륙해요. 실제 빠르기로 바꿨어요.' : `착륙 준비: 빨리감기를 ×${over}에서 ×${cap.max}로 줄였어요.`);
        }
      }
      lastS.current = st.s;
      stRef.current = st;
      scene.update(st);
      scene.render();
      // 지구본으로 멀리 볼 때 공항 이름표
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      for (const [which, el] of [
        ['from', fromLabel.current],
        ['to', toLabel.current],
      ] as const) {
        if (!el) continue;
        const pos = scene.cam.dist > 60000 ? scene.screenOf(which, st, w, h) : null;
        el.style.display = pos ? '' : 'none';
        if (pos) el.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
      }
      if (now - hudAt > 120) {
        hudAt = now;
        setHud({ phase: st.phase, alt: st.alt, speed: st.speed, left: st.left, tLeft: st.tLeft, s: st.s });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.dispose();
      canvas.remove();
      sceneRef.current = null;
    };
  }, [flight, co, parked, setSpeed, run]);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 4200);
    return () => window.clearTimeout(id);
  }, [note]);

  useEffect(() => close.current?.focus(), []);

  const toggleGlobe = useCallback(() => {
    setGlobe((g) => {
      sceneRef.current?.globeView(!g);
      return !g;
    });
  }, []);

  const restart = useCallback(() => setRun((n) => n + 1), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Tab' || (t && ['SELECT', 'INPUT'].includes(t.tagName) && e.key !== 'Escape')) return;
      // 게임 단축키(Enter로 달 마치기 등)가 뒤에서 움직이지 않게
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === ' ') {
        e.preventDefault();
        setSpeed(speedRef.current === 0 ? 1 : 0);
      } else if (e.key >= '1' && e.key <= '4') setSpeed(SPEEDS[Number(e.key)]);
      else if (e.key === '+' || e.key === '=') sceneRef.current?.zoom(0.8);
      else if (e.key === '-' || e.key === '_') sceneRef.current?.zoom(1.25);
      else if (e.key === '0') sceneRef.current?.resetCamera();
      else if (e.key === 'g' || e.key === 'G') toggleGlobe();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, setSpeed, toggleGlobe]);

  if (!co || !p) return null;
  const m = MODEL[p.model];
  const from = CITY[fromCity];
  const to = CITY[toCity];
  const arrived = hud?.phase === 'arrived';

  return createPortal(
    <div className="al-ride-overlay" role="dialog" aria-modal="true" aria-labelledby="al-ride-title" data-testid="al-ride">
      <div className="al-ride-stage" ref={stageRef}>
        {flight && (
          <>
            <span ref={fromLabel} className="al-ride-pin" style={{ display: 'none' }}>
              <b>🛫 {from?.name}</b>
            </span>
            <span ref={toLabel} className="al-ride-pin" style={{ display: 'none' }}>
              <b>🛬 {to?.name}</b>
            </span>
          </>
        )}
      </div>

      <header className="al-ride-head">
        <div className="al-ride-title">
          <h2 id="al-ride-title">
            ✈️ {co.name} · {m?.name}
          </h2>
          {flight && (
            <p>
              {from?.name} <small>{flight.from.iata}</small> {flight.dep.name} → {to?.name} <small>{flight.to.iata}</small> {flight.arr.name}
            </p>
          )}
        </div>
        <div className="al-ride-pick">
          {legs.length > 1 && (
            <select
              value={r?.id}
              onChange={(e) => {
                const next = legs.find((x) => x.id === Number(e.target.value));
                setRouteId(next?.id);
                setFlip(!!next && next.b === co.hub && next.a !== co.hub);
              }}
              aria-label="탈 노선"
              data-testid="al-ride-route"
            >
              {legs.map((x) => (
                <option key={x.id} value={x.id}>
                  {CITY[x.a].name} ⇄ {CITY[x.b].name}
                </option>
              ))}
            </select>
          )}
          {r && (
            <button type="button" className="btn btn-small" onClick={() => setFlip((f) => !f)} title="반대 방향 편에 타요" data-testid="al-ride-flip">
              ⇄ 반대 방향
            </button>
          )}
          <button ref={close} type="button" className="btn btn-ghost btn-small al-ride-close" onClick={onClose} aria-label="내리기 (Esc)" data-testid="al-ride-close">
            ✕ 내리기
          </button>
        </div>
      </header>

      {!flight && <p className="al-ride-msg">{!r ? '이 비행기는 지금 쉬는 중이라 탈 수 있는 편이 없어요.' : !hasModel ? '이 기종은 아직 3D 모형이 없어서 탈 수 없어요.' : '이 노선의 공항 도면이 없어서 탈 수 없어요.'}</p>}
      {error && <p className="al-ride-msg">{error}</p>}

      {flight && hud && !error && (
        <>
          <div className="al-ride-stats" aria-live="off">
            <span className="al-ride-phase" data-testid="al-ride-phase">
              {PHASE_NAMES[hud.phase]}
            </span>
            <span>
              <small>고도</small>
              <b>{fmt(hud.alt)} m</b>
            </span>
            <span>
              <small>속도</small>
              <b>{fmt(hud.speed * 3.6)} km/h</b>
            </span>
            <span>
              <small>남은 거리</small>
              <b>{fmt(hud.left / 1000)} km</b>
            </span>
            <span>
              <small>남은 시간</small>
              <b>{hm(hud.tLeft)}</b>
            </span>
          </div>

          <div className="al-ride-progress" aria-hidden="true">
            <i style={{ width: `${(100 * hud.s) / flight.total}%` }} />
            {[flight.marks.toc, flight.marks.tod].map((s, i) => (
              <em key={i} style={{ left: `${(100 * s) / flight.total}%` }} />
            ))}
          </div>

          <footer className="al-ride-bar">
            <div className="al-ride-speeds" role="group" aria-label="빨리감기">
              {SPEEDS.map((s) => (
                <button key={s} type="button" className={`al-chip${speed === s ? ' al-on' : ''}`} onClick={() => setSpeed(s)} aria-pressed={speed === s} data-testid={`al-ride-speed-${s}`}>
                  {s === 0 ? '⏸ 멈춤' : `×${s}`}
                </button>
              ))}
            </div>
            <div className="al-ride-cams" role="group" aria-label="카메라">
              <button type="button" className="al-map-btn" onClick={() => sceneRef.current?.zoom(0.75)} aria-label="가까이 (+)" title="가까이 (+)">
                ＋
              </button>
              <button type="button" className="al-map-btn" onClick={() => sceneRef.current?.zoom(1 / 0.75)} aria-label="멀리 (−)" title="멀리 (−)">
                －
              </button>
              <button type="button" className={`al-chip${globe ? ' al-on' : ''}`} onClick={toggleGlobe} aria-pressed={globe} title="지구본처럼 멀리서 보기 (G)" data-testid="al-ride-globe">
                🌏 지구본
              </button>
              <button
                type="button"
                className="al-chip"
                onClick={() => {
                  sceneRef.current?.resetCamera();
                  setGlobe(false);
                }}
                title="비행기 뒤로 (0)"
              >
                🎥 뒤에서
              </button>
            </div>
          </footer>
          {note && (
            <p className="al-ride-note" role="status">
              {note}
            </p>
          )}
          {arrived && (
            <div className="al-ride-done" role="status" data-testid="al-ride-done">
              <h3>🛬 {to?.name}에 내렸어요</h3>
              <p>
                {from?.name}에서 {fmt(flight.total / 1000)} km, 비행 시간 {hm(flight.duration)}
              </p>
              <div>
                <button type="button" className="btn btn-primary" onClick={() => setFlip((f) => !f)}>
                  ⇄ 돌아오는 편 타기
                </button>
                <button type="button" className="btn" onClick={restart}>
                  ↺ 다시 타기
                </button>
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  내리기
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <p className="al-ride-help">끌어서 돌려 보기 · 휠로 멀리/가까이 · Space 멈춤 · 1~4 빨리감기 · G 지구본 · Esc 내리기</p>
    </div>,
    document.body,
  );
}
