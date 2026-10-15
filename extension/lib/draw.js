// SPDX-License-Identifier: GPL-3.0-or-later
// Paints graphs on a Cairo context. Shared by the top bar (St.DrawingArea)
// and the preview in Settings (Gtk.DrawingArea), so both look the same.
// No imports: the context comes from the caller.

/**
 * Sparkline pieces from sparklinePieces. `rgbOf(level)` gives a piece's
 * color as [r, g, b] (0–1); `fill` shades the area under the line.
 */
export function paintPieces(cr, height, pieces, rgbOf, {fill = false, alpha = 1} = {}) {
    cr.setLineWidth(1.5);
    for (const {points, level} of pieces) {
        const [r, g, b] = rgbOf(level);
        const [[x0, y0], ...rest] = points;
        if (rest.length === 0) {
            cr.setSourceRGBA(r, g, b, alpha);
            cr.rectangle(x0 - 1, y0 - 1, 2, 2); // a lone reading between gaps
            cr.fill();
            continue;
        }
        if (fill) {
            cr.setSourceRGBA(r, g, b, alpha * 0.35);
            cr.moveTo(x0, height);
            for (const [x, y] of points)
                cr.lineTo(x, y);
            cr.lineTo(points[points.length - 1][0], height);
            cr.closePath();
            cr.fill();
        }
        cr.setSourceRGBA(r, g, b, alpha);
        cr.moveTo(x0, y0);
        for (const [x, y] of rest)
            cr.lineTo(x, y);
        cr.stroke();
    }
}

/** Bars from barPieces; `rgbOf` as in paintPieces. */
export function paintBars(cr, bars, rgbOf) {
    for (const {x, y, width, height, level} of bars) {
        const [r, g, b] = rgbOf(level);
        cr.setSourceRGBA(r, g, b, 1);
        cr.rectangle(x, y, width, height);
        cr.fill();
    }
}
