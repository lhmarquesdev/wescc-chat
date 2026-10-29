import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Empty } from '../../components/ui';

// Gráficos da administração: desenhados em pixels na largura medida, para que
// barras e linhas não se deformem. Grade e eixos discretos, texto nos tokens de texto, dica no hover e no foco.

const nf = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const EMPTY_HINT = 'Escolha outro período ou departamento.';

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Topo do eixo em passos inteiros "redondos" (1, 2, 5 × 10^k), com até 4 divisões.
function niceScale(max: number) {
  const raw = Math.max(1, max) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10);
  const top = step * Math.max(1, Math.ceil(max / step));
  return {
    top,
    ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step),
  };
}

// Barra com o topo arredondado (4px) e a base reta, apoiada no eixo.
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

// Índice ativo pelo teclado: setas, Home e End; Esc some com a dica.
function keyNav(e: KeyboardEvent, n: number, i: number | null, set: (v: number | null) => void) {
  const cur = i ?? n - 1;
  const next = e.key === 'ArrowRight' ? cur + 1 : e.key === 'ArrowLeft' ? cur - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
  if (e.key === 'Escape') return set(null);
  if (next === null) return;
  e.preventDefault();
  set(Math.min(n - 1, Math.max(0, next)));
}

function ChartEmpty({ hint }: { hint?: string }) {
  return (
    <div className="chart chart-empty">
      <Empty icon="reports" title="Sem dados no período">
        {hint ?? EMPTY_HINT}
      </Empty>
    </div>
  );
}

type Point = { x: string; y: number };

export function BarChart({
  data,
  height = 180,
  label,
  unit,
  emptyHint,
}: {
  data: Point[];
  height?: number;
  // Texto completo da dica; sem ele, "x" e o valor (com a unidade, se houver).
  label?: (d: Point) => string;
  unit?: [string, string];
  emptyHint?: string;
}) {
  const [ref, w] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.y));
  if (!data.length || max === 0) return <ChartEmpty hint={emptyHint} />;

  const { top, ticks } = niceScale(max);
  const L = 36;
  const R = 16;
  const T = 8;
  const B = 24;
  const pw = Math.max(0, w - L - R);
  const ph = height - T - B;
  const band = pw / data.length;
  const bw = Math.max(2, Math.min(24, band * 0.7, band - 2));
  const y = (v: number) => T + ph - (v / top) * ph;
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(pw / 52))));
  const value = (d: Point) => (unit ? `${nf.format(d.y)} ${d.y === 1 ? unit[0] : unit[1]}` : nf.format(d.y));
  const tip = active !== null ? data[active] : null;
  const total = data.reduce((n, d) => n + d.y, 0);

  return (
    <div className="chart" ref={ref}>
      <div className="chart-plot">
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="img"
            tabIndex={0}
            aria-label={`${data.length} barras, de ${data[0].x} a ${data[data.length - 1].x}; total ${nf.format(total)}, máximo ${nf.format(max)}. Use as setas para ler cada valor.`}
            onKeyDown={(e) => keyNav(e, data.length, active, setActive)}
            onBlur={() => setActive(null)}
            onMouseLeave={() => setActive(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 && <line className="chart-grid" x1={L} x2={w - R} y1={y(t)} y2={y(t)} />}
                <text className="chart-tick" x={L - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compact.format(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const h = y(0) - y(d.y);
              return h > 0 ? (
                <path key={i} className={active === null ? 'chart-bar' : active === i ? 'chart-bar on' : 'chart-bar dim'} d={barPath(L + i * band + (band - bw) / 2, y(d.y), bw, h)} />
              ) : null;
            })}
            <line className="chart-base" x1={L} x2={w - R} y1={y(0)} y2={y(0)} />
            {data.map((d, i) =>
              i % every === 0 ? (
                <text key={i} className="chart-tick" x={L + i * band + band / 2} y={height - 6} textAnchor="middle">
                  {d.x}
                </text>
              ) : null,
            )}
            {data.map((_, i) => (
              <rect key={i} className="chart-hit" x={L + i * band} y={T} width={band} height={ph} onMouseEnter={() => setActive(i)} />
            ))}
          </svg>
        )}
        {tip && active !== null && (
          <div
            className="chart-tip"
            role="status"
            style={{
              left: Math.min(w - 8, Math.max(8, L + active * band + band / 2)),
              top: y(tip.y) - 8,
            }}
          >
            {label ? (
              label(tip)
            ) : (
              <>
                <span className="chart-tip-x">{tip.x}</span>
                <strong>{value(tip)}</strong>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type Series = { name: string; values: number[] };

// Linhas de 2px (até 8 séries, cores s1…s8 na ordem fixa), legenda em cima e cruz com a dica no hover.
export function LineChart({ x, series, height = 200, emptyHint }: { x: string[]; series: Series[]; height?: number; emptyHint?: string }) {
  const [ref, w] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = x.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  if (!n || max === 0) return <ChartEmpty hint={emptyHint} />;

  const { top, ticks } = niceScale(max);
  const labeled = series.length <= 4;
  const L = 36;
  // Espaço dos rótulos no fim das linhas: o mesmo texto da legenda, ~7px por letra no corpo 12.
  const R = labeled ? Math.max(48, 16 + 7 * Math.max(...series.map((s) => s.name.length))) : 16;
  const T = 10;
  const B = 24;
  const pw = Math.max(0, w - L - R);
  const ph = height - T - B;
  const px = (i: number) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const py = (v: number) => T + ph - (v / top) * ph;
  // Séries com o mesmo valor num ponto correm lado a lado (2,5px entre os centros) em vez de uma esconder a outra;
  // a de índice maior fica por cima, como nas contagens acumuladas (dia ≤ 7 dias ≤ 30 dias).
  const sy = (si: number, k: number) => {
    const v = series[si].values[k] ?? 0;
    const same = series.map((s, j) => j).filter((j) => (series[j].values[k] ?? 0) === v);
    return py(v) + ((same.length - 1) / 2 - same.indexOf(si)) * 2.5;
  };
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 52))));
  // Rótulos diretos no fim das linhas, afastados para não se sobreporem (14px no mínimo).
  const ends = series
    .map((s, i) => ({
      i,
      name: s.name,
      y: sy(i, n - 1),
    }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setActive(Math.min(n - 1, Math.max(0, Math.round(((e.clientX - box.left) / Math.max(1, box.width)) * (n - 1)))));
  };

  return (
    <div className="chart" ref={ref}>
      <div className="legend">
        {series.map((s, i) => (
          <span key={s.name} className={`legend-item s${i + 1}`}>
            {s.name}
          </span>
        ))}
      </div>
      <div className="chart-plot">
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="img"
            tabIndex={0}
            aria-label={`${series.map((s) => `${s.name}: ${nf.format(s.values[n - 1] ?? 0)}`).join('; ')} em ${x[n - 1]}. Use as setas para ler cada dia.`}
            onKeyDown={(e) => keyNav(e, n, active, setActive)}
            onBlur={() => setActive(null)}
            onMouseLeave={() => setActive(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className={t > 0 ? 'chart-grid' : 'chart-base'} x1={L} x2={L + pw} y1={py(t)} y2={py(t)} />
                <text className="chart-tick" x={L - 8} y={py(t)} dy="0.32em" textAnchor="end">
                  {compact.format(t)}
                </text>
              </g>
            ))}
            {x.map((d, i) =>
              i % every === 0 ? (
                <text key={i} className="chart-tick" x={px(i)} y={height - 6} textAnchor="middle">
                  {d}
                </text>
              ) : null,
            )}
            {active !== null && <line className="chart-cross" x1={px(active)} x2={px(active)} y1={T} y2={T + ph} />}
            {series.map((s, i) => (
              <polyline key={s.name} className={`chart-line s${i + 1}`} fill="none" points={s.values.map((_, k) => `${px(k)},${sy(i, k)}`).join(' ')} />
            ))}
            {active !== null && series.map((s, i) => <circle key={s.name} className={`chart-dot s${i + 1}`} cx={px(active)} cy={sy(i, active)} r={4} />)}
            {labeled &&
              ends.map((e) => (
                <text key={e.i} className="chart-end" x={L + pw + 8} y={e.y} dy="0.32em">
                  {e.name}
                </text>
              ))}
            <rect className="chart-hit" x={L} y={T} width={pw} height={ph} onMouseMove={onMove} />
          </svg>
        )}
        {active !== null && (
          <div className={px(active) > w / 2 ? 'chart-tip side flip' : 'chart-tip side'} role="status" style={{ left: Math.min(w - 8, Math.max(8, px(active))), top: T }}>
            <span className="chart-tip-x">{x[active]}</span>
            {series.map((s, i) => (
              <span key={s.name} className={`legend-item s${i + 1}`}>
                {s.name} <strong>{nf.format(s.values[active] ?? 0)}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
