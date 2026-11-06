// One mechanism plate (6-recovery-atlas.md §2.1): the station (the address), the funds on it, the wallet
// structure (dashed = not deployed, solid = deployed), registration marks and three callouts. Decorative:
// aria-hidden, every label has its HTML counterpart in the caption or the plate text beside it. States are
// CSS-driven from `data-shot`, and only opacity / transform change, so the station never moves.
import { useId } from 'react';
import { useT, type MsgKey } from '../../i18n';
import { contours, ticks, type Layout, type Shot } from './geometry';

const NUMERAL = ['I', 'II', 'III', 'III'] as const;

function Reg({ x, y }: { x: number; y: number }) {
  return (
    <>
      <path d={`M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}`} />
      <circle cx={x} cy={y} r={6} />
    </>
  );
}

export function Plate({ layout: l, shot, station }: { layout: Layout; shot: Shot; station?: string }) {
  const { t } = useT();
  const hatch = `lb-at-hatch-${useId().replace(/:/g, '')}`;
  const { W, H, sx, sy, bw, bh } = l;
  const bx = sx - bw / 2;
  const by = sy - bh / 2;
  const corner = (x: number, y: number, dx: number, dy: number) => `M${x} ${y + 14 * dy}V${y}H${x + 14 * dx}`;
  return (
    <svg className={`lb-at-plate lb-at-${l.name}`} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false" data-shot={shot}>
      <defs>
        <pattern id={hatch} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" className="lb-at-hatchline" />
        </pattern>
      </defs>
      <rect className="lb-at-neat" x="10" y="10" width={W - 20} height={H - 20} />
      <path className="lb-at-tick" d={ticks(l)} />
      {contours(l).map((d, i) => (
        <path key={i} className="lb-contour" d={d} />
      ))}
      <text className="lb-at-no" x="28" y="40">
        {NUMERAL[shot]}
      </text>
      <g className="lb-at-layers">
        <rect className="lb-at-hatch" x={bx} y={by} width={bw} height={bh} rx="3" fill={`url(#${hatch})`} />
        <rect className="lb-at-planned" x={bx} y={by} width={bw} height={bh} rx="3" />
        <rect className="lb-at-built" x={bx} y={by} width={bw} height={bh} rx="3" />
        <g className="lb-at-reg">
          <path d={corner(bx - 10, by - 10, 1, 1) + corner(bx + bw + 10, by - 10, -1, 1) + corner(bx - 10, by + bh + 10, 1, -1) + corner(bx + bw + 10, by + bh + 10, -1, -1)} />
          <Reg x={bx - 26} y={sy} />
          <Reg x={bx + bw + 26} y={sy} />
        </g>
        {l.notes.map(([ex, ey, tx, ty], i) => (
          <g key={i} className={`lb-at-note lb-at-note-${i}`}>
            <line x1={ex} y1={ey} x2={tx - 12} y2={ty - 5} />
            <circle cx={tx - 4} cy={ty - 5} r="5" />
            <text x={tx + 8} y={ty}>
              {t(`atlas.n${i + 1}` as MsgKey)}
            </text>
          </g>
        ))}
        <text className="lb-at-builtnote" x={l.built[0]} y={l.built[1]}>
          {t('atlas.built')}
        </text>
      </g>
      <g className="lb-at-station" data-testid={station}>
        <rect className="lb-at-cargo" x={sx - 34} y={sy + 14} width="12" height="12" />
        <rect className="lb-at-cargo" x={sx - 20} y={sy + 14} width="12" height="12" />
        <rect className="lb-at-cargo" x={sx - 27} y={sy + 1} width="12" height="12" />
        <path className="lb-at-cross" d={`M${sx - 24} ${sy}H${sx + 24}M${sx} ${sy - 24}V${sy + 24}`} />
        <circle className="lb-at-ring" cx={sx} cy={sy} r="9" pathLength={1} />
        <circle className="lb-at-dot" cx={sx} cy={sy} r="2.5" />
        <path className="lb-at-pointer" d={`M${bx - 10} ${by - 38}l7 -11l7 11z`} />
        <text className="lb-at-coord" x={bx + 6} y={by - 38}>
          {t('atlas.same')}
        </text>
        <text className="lb-at-coordsub" x={bx + 6} y={by - 22}>
          chain 9745
        </text>
      </g>
      <text className="lb-at-next" x={l.next[0]} y={l.next[1]}>
        {t('atlas.next')}
      </text>
      <g className="lb-at-legend">
        <text x="28" y={H - 52}>
          {t('atlas.illus')}
        </text>
        <line className="lb-at-legend-planned" x1="28" y1={H - 32} x2="52" y2={H - 32} />
        <text x="58" y={H - 28}>
          {t('atlas.planned')}
        </text>
        <line x1="150" y1={H - 32} x2="174" y2={H - 32} />
        <text x="180" y={H - 28}>
          {t('atlas.deployed')}
        </text>
      </g>
    </svg>
  );
}
