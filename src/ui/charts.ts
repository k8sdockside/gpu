// The DCGM charts, drawn small.
//
// The manifest declares them (`"attach": "overview"`) and the app asks the
// cluster's Prometheus; `charts()` hands the numbers over. Three answers are
// ordinary and each gets a sentence rather than an empty box: no Prometheus
// at all, a Prometheus with no DCGM exporter feeding it, and a chart whose
// query failed on its own.

import { el } from './dom.js';
import { block, svgEl } from './parts.js';

/** One series as a sparkline, in the first chart colour, y from zero. */
export function sparkline(points: K8sDockside.ChartPoint[], width = 220, height = 44, colour = 1): SVGElement {
    const line = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (points.length < 2) return line;
    const first = points[0]?.t ?? 0;
    const last = points[points.length - 1]?.t ?? 1;
    const top = Math.max(...points.map((p) => p.v), 0);
    const span = Math.max(1, last - first);
    const xy = points.map((p) => [((p.t - first) / span) * width, height - 2 - (top > 0 ? (p.v / top) * (height - 6) : 0)] as const);
    const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    line.append(
        svgEl('polygon', { points: `0,${height} ${path} ${width},${height}`, class: `spark-fill chart-fill-${colour}` }),
        svgEl('polyline', { points: path, fill: 'none', class: `spark-line chart-line-${colour}`, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }),
    );
    return line;
}

/** A value written the way its unit asks for. */
export function formatValue(unit: string, value: number): string {
    if (!Number.isFinite(value)) return '—';
    switch (unit) {
        case 'percent':
            return `${(value * 100).toFixed(0)}%`;
        case 'bytes': {
            const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
            let size = value;
            let index = 0;
            while (size >= 1024 && index < units.length - 1) {
                size /= 1024;
                index++;
            }
            return `${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
        }
        case 'count':
            return value.toFixed(0);
        default:
            return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
    }
}

/** The charts block, or the sentence that says why there are none. */
export async function chartsBlock(): Promise<HTMLElement | null> {
    let panel: K8sDockside.ChartsPanel;
    try {
        panel = await k8sdockside.charts({ minutes: 180 });
    } catch {
        return null;
    }
    if (!panel.attached) return null;
    const title = 'From DCGM, the last three hours';
    if (!panel.source.available) {
        return block(
            title,
            '',
            el(
                'p',
                { class: 'faint', style: 'margin:0' },
                panel.source.error || 'No Prometheus was found in this cluster, so there is no utilisation to show. Everything above comes from the Kubernetes API and does not need one.',
            ),
        );
    }
    const drawn = panel.charts.filter((chart) => chart.series.some((s) => s.points.length > 1));
    if (drawn.length === 0) {
        return block(
            title,
            '',
            el(
                'p',
                { class: 'faint', style: 'margin:0' },
                `Prometheus (${panel.source.describe}) has no DCGM metrics. NVIDIA's dcgm-exporter publishes them — the GPU Operator installs it — and run-ai's fake-gpu-operator simulates them on a cluster with no GPUs.`,
            ),
        );
    }
    const cards = el('div', { class: 'charts' });
    for (const chart of panel.charts) {
        const series = chart.series.filter((s) => s.points.length > 0);
        const total = series.length === 1 ? series[0] : undefined;
        const last = total?.points[total.points.length - 1];
        const card = el(
            'div',
            { class: 'chart', title: chart.description },
            el('div', { class: 'chart-head' }, el('span', { class: 'chart-label' }, chart.label), el('span', { class: 'chart-value' }, last ? formatValue(chart.unit, last.v) : '')),
        );
        if (series.length === 0) {
            card.append(el('p', { class: 'faint chart-empty' }, chart.error || 'No data in this window.'));
        } else if (total) {
            card.append(sparkline(total.points));
        } else {
            // Several series: one line each, the biggest few, with their last values.
            const shown = [...series].sort((a, b) => (b.points[b.points.length - 1]?.v ?? 0) - (a.points[a.points.length - 1]?.v ?? 0)).slice(0, 4);
            shown.forEach((s, i) => {
                const tail = s.points[s.points.length - 1];
                card.append(el('div', { class: 'chart-series' }, el('span', { class: `dot chart-dot-${i + 1}` }), el('span', { class: 'chart-series-name' }, s.name), el('span', { class: 'chart-series-value' }, tail ? formatValue(chart.unit, tail.v) : '—')));
                card.append(sparkline(s.points, 220, 22, i + 1));
            });
            if (series.length > shown.length) card.append(el('p', { class: 'faint chart-more' }, `and ${series.length - shown.length} more`));
        }
        cards.append(card);
    }
    return block(title, 'Utilisation and memory from NVIDIA’s DCGM exporter, through the cluster’s Prometheus.', cards);
}
