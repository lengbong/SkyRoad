import { describe, expect, it } from 'vitest';
import { MODELS } from './aircraft';
import { SHAPES } from './aircraftShapes';
import { planeImageUrl } from './PlaneImage';
import { FREIGHTER_SHAPES } from './freighterShapes';
import { NEUTRAL_LIVERY, companyLivery, planeMesh, renderPlaneSvg } from './plane3d';

describe('기종 그림 (SVG)', () => {
  it('모든 기종에 치수가 있다', () => {
    for (const m of MODELS) expect(SHAPES[m.id], m.id).toBeDefined();
  });

  it('모든 기종을 숫자 오류 없이 틀 안에 그린다', () => {
    for (const m of MODELS) {
      const svg = renderPlaneSvg(SHAPES[m.id], NEUTRAL_LIVERY);
      expect(svg, m.id).toMatch(/^<svg [^>]*viewBox="0 0 400 225"/);
      expect(svg, m.id).not.toMatch(/NaN|Infinity/);
      const nums = [...svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
      expect(nums.length, m.id).toBeGreaterThan(200);
      for (const [x, y] of nums) {
        expect(x, m.id).toBeGreaterThanOrEqual(-1);
        expect(x, m.id).toBeLessThanOrEqual(401);
        expect(y, m.id).toBeGreaterThanOrEqual(-1);
        expect(y, m.id).toBeLessThanOrEqual(226);
      }
      // 너무 크지 않게 (한 장에 90KB 아래)
      expect(svg.length, m.id).toBeLessThan(90_000);
    }
  }, 60000);

  it('회사 칠에는 꼬리 무늬와 회사 색이 들어간다', () => {
    const svg = renderPlaneSvg(SHAPES.a320, companyLivery('#e5484d', '#b4282e', 'star'));
    expect(svg).toContain('transform="matrix(');
    expect(svg).toContain('#ffffff');
    expect(svg).not.toBe(renderPlaneSvg(SHAPES.a320, NEUTRAL_LIVERY));
  });

  it('같은 칠은 한 번만 그리고 data URL을 준다', () => {
    const a = planeImageUrl('b747-400');
    expect(a).toMatch(/^data:image\/svg\+xml/);
    expect(planeImageUrl('b747-400')).toBe(a);
    expect(planeImageUrl('b747-400', { main: '#3e63dd', dark: '#2a47a8' })).not.toBe(a);
    expect(planeImageUrl('nope')).toBeUndefined();
  });
});

describe('기종 3D 모형 (타 보기)', () => {
  const all = [...Object.entries(SHAPES), ...Object.entries(FREIGHTER_SHAPES)];

  it('모든 기종의 삼각형이 숫자 오류 없이 실제 길이·날개폭 안에 든다', () => {
    for (const [id, shape] of all) {
      const m = planeMesh(shape, companyLivery('#c8102e', '#5a0a16', 'star'));
      expect(m.positions.length % 9, id).toBe(0);
      expect(m.colors.length, id).toBe(m.positions.length);
      expect(m.positions.length / 9, id).toBeGreaterThan(300);
      expect(m.positions.every(Number.isFinite), id).toBe(true);
      expect(m.colors.every((v) => v >= 0 && v <= 1), id).toBe(true);
      // 코 0 · 꼬리 −길이, 양쪽 날개 끝이 반날개폭 (엔진 덮개·윙렛이 조금 튀어나올 수 있다)
      expect(m.max[0], id).toBeLessThan(shape.len * 0.06);
      expect(m.min[0], id).toBeGreaterThan(-shape.len * 1.12);
      expect(m.max[0] - m.min[0], id).toBeGreaterThan(shape.len * 0.95);
      expect(m.max[1], id).toBeGreaterThan((shape.span / 2) * 0.97);
      expect(m.max[1], id).toBeLessThan((shape.span / 2) * 1.06);
      expect(m.min[1], id).toBeCloseTo(-m.max[1], 3);
    }
  });

  it('왼쪽·오른쪽이 같은 모양이다 (창문·꼬리 무늬도 양쪽에)', () => {
    const m = planeMesh(SHAPES['b747-400'], companyLivery('#c8102e', '#5a0a16', 'star'));
    let left = 0;
    let right = 0;
    for (let i = 1; i < m.positions.length; i += 3) {
      if (m.positions[i] > 0.01) left++;
      else if (m.positions[i] < -0.01) right++;
    }
    expect(Math.abs(left - right) / (left + right)).toBeLessThan(0.02);
  });

  it('프로펠러기는 흐릿한 프로펠러 원판이 따로 있다', () => {
    expect(planeMesh(SHAPES['f27'], NEUTRAL_LIVERY).glass.positions.length).toBeGreaterThan(0);
    expect(planeMesh(SHAPES['b747-400'], NEUTRAL_LIVERY).glass.positions.length).toBe(0);
  });
});
