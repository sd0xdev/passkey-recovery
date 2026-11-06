// Plate geometry for the Home mechanism plates (6-recovery-atlas.md §2). Two compositions of the same
// primitives: `wide` (the hero, ≥ 561 px) and `tall` (phones, and the three static plates). The station — the
// wallet address — sits at one fixed point per composition and never moves between shots.

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A closed, gently irregular ring around (cx, cy): an ellipse whose radius wobbles with two low harmonics.
 *  Deterministic, so every visitor and screenshot sees the same chart. */
export function ring(cx: number, cy: number, rx: number, ry: number, phase: number): string {
  const pts: Array<[number, number]> = [];
  const n = 48;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.09 * Math.sin(3 * a + phase) + 0.05 * Math.cos(5 * a - phase * 1.7);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  // Catmull-Rom through the points, as cubic Béziers: smooth like a drawn depth line.
  let d = `M${r1(pts[0]![0])} ${r1(pts[0]![1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    d += `C${r1(p1[0] + (p2[0] - p0[0]) / 6)} ${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)} ${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return `${d}Z`;
}

export type Shot = 0 | 1 | 2 | 3;
export const SHOTS: readonly Shot[] = [0, 1, 2, 3];

export type Layout = {
  readonly name: 'wide' | 'tall';
  readonly W: number;
  readonly H: number;
  /** The station (the address): fixed for every shot. */
  readonly sx: number;
  readonly sy: number;
  /** The wallet structure around the station. */
  readonly bw: number;
  readonly bh: number;
  /** Callouts: leader start (x, y) → label baseline (x, y). */
  readonly notes: ReadonlyArray<readonly [number, number, number, number]>;
  readonly built: readonly [number, number];
  readonly next: readonly [number, number];
};

export const WIDE: Layout = {
  name: 'wide',
  W: 680,
  H: 500,
  sx: 230,
  sy: 250,
  bw: 156,
  bh: 120,
  notes: [
    [308, 210, 356, 176],
    [308, 250, 356, 256],
    [308, 290, 356, 336],
  ],
  built: [48, 352],
  next: [340, 460],
};

export const TALL: Layout = {
  name: 'tall',
  W: 358,
  H: 520,
  sx: 179,
  sy: 170,
  bw: 132,
  bh: 112,
  notes: [
    [179, 226, 48, 290],
    [179, 226, 48, 326],
    [179, 226, 48, 362],
  ],
  built: [28, 404],
  next: [28, 434],
};

/** Depth lines around the station and in two corners, from the same generator as the route chart. */
export function contours(l: Layout): string[] {
  const { W, H, sx, sy } = l;
  const spec: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [sx + 40, sy - 10, 200, 150, 0.3],
    [sx + 40, sy - 10, 150, 110, 1.1],
    [sx + 40, sy - 10, 100, 72, 2],
    [W - 60, H - 40, 140, 90, 0.7],
    [W - 60, H - 40, 90, 58, 1.6],
    [60, H + 10, 120, 80, 2.4],
  ];
  return spec.map(([cx, cy, rx, ry, ph]) => ring(cx, cy, rx, ry, ph));
}

/** The neatline's graduation: a tick every 40 units, a longer one every 80. */
export function ticks(l: Layout): string {
  const { W, H } = l;
  let d = '';
  for (let x = 16; x <= W - 16; x += 40) {
    const k = x % 80 === 16 ? 8 : 4;
    d += `M${x} 10v${k}M${x} ${H - 10}v${-k}`;
  }
  for (let y = 16; y <= H - 16; y += 40) {
    const k = y % 80 === 16 ? 8 : 4;
    d += `M10 ${y}h${k}M${W - 10} ${y}h${-k}`;
  }
  return d;
}
