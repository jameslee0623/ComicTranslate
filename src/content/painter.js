/**
 * painter.js - erase the original lettering and draw the translation on top.
 *
 * Runs as a content script against a canvas that already has the source image
 * drawn into it. Erasing is deliberately simple and colour-based: comic
 * lettering sits on flat speech-bubble white, so sampling the dominant colour
 * around the text box reproduces the bubble almost perfectly, and it costs
 * nothing compared to a real inpaint pass over a multi-megabyte webtoon strip.
 */
'use strict';

if (typeof globalThis.CTPainter === 'undefined') {
  /** Perceptual luminance, used to pick black or white text. */
  function luminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  /**
   * Dominant colour of a pixel set, via a coarse 3D histogram. Quantising to 16
   * levels per channel collapses JPEG ringing into one bucket while still
   * separating white bubbles from off-white paper texture.
   */
  function dominantColor(pixels) {
    const buckets = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
      if (a < 32) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let entry = buckets.get(key);
      if (!entry) {
        entry = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(key, entry);
      }
      entry.count++;
      entry.r += r; entry.g += g; entry.b += b;
    }
    let best = null;
    for (const entry of buckets.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    if (!best) return { r: 255, g: 255, b: 255, a: 255, count: 0 };
    return {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
      a: 255,
      count: best.count
    };
  }

  /**
   * Sample a ring just outside the text box. Sampling outside rather than inside
   * matters: the inside is full of glyph pixels, so an inside sample returns an
   * average of text and background and paints a grey smudge.
   */
  function sampleRingColor(ctx, box, imageWidth, imageHeight, ring) {
    const pad = ring == null ? 3 : ring;
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(imageWidth, Math.ceil(box.x + box.w + pad));
    const y1 = Math.min(imageHeight, Math.ceil(box.y + box.h + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return { r: 255, g: 255, b: 255, a: 255, count: 0 };

    const data = ctx.getImageData(x0, y0, w, h).data;
    const border = Math.max(1, pad);
    const pixels = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isBorder = x < border || y < border || x >= w - border || y >= h - border;
        if (!isBorder) continue;
        const i = (y * w + x) * 4;
        pixels.push(data[i], data[i + 1], data[i + 2], data[i + 3]);
      }
    }
    return dominantColor(pixels);
  }

  /** Grow a box outward by `px`, clamped to the image. */
  function expandBox(box, px, imageWidth, imageHeight) {
    const x = Math.max(0, box.x - px);
    const y = Math.max(0, box.y - px);
    return {
      x,
      y,
      w: Math.min(imageWidth, box.x + box.w + px) - x,
      h: Math.min(imageHeight, box.y + box.h + px) - y
    };
  }

  function fillBox(ctx, box, color) {
    ctx.save();
    ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  /**
   * Render one page's worth of regions.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} regions  normalised regions from CTEngines.normaliseRegion
   * @returns {{drawn: number, skipped: number, backgrounds: Array}}
   */
  function renderRegions(ctx, regions, options) {
    const opts = options || {};
    const imageWidth = ctx.canvas.width;
    const imageHeight = ctx.canvas.height;
    const grow = opts.growBox == null ? 2 : opts.growBox;
    const padding = opts.padding == null ? 3 : opts.padding;
    let drawn = 0;
    let skipped = 0;
    const backgrounds = [];

    for (const region of regions) {
      const text = region.translated || region.text;
      if (!text || !text.trim()) { skipped++; continue; }

      // Ignore single stray characters; they are almost always OCR noise.
      if (text.trim().length < 2) { skipped++; continue; }

      const box = expandBox(region.bbox, grow, imageWidth, imageHeight);
      if (box.w < 4 || box.h < 4) { skipped++; continue; }

      const bg = sampleRingColor(ctx, region.bbox, imageWidth, imageHeight, opts.ringSize);
      fillBox(ctx, box, bg);
      backgrounds.push(bg);

      const auto = luminance(bg.r, bg.g, bg.b) > 0.55 ? '#000000' : '#ffffff';
      const layout = CTTextLayout.fitText(ctx, {
        text,
        boxW: box.w,
        boxH: box.h,
        fontFamily: opts.fontFamily,
        minFontSize: opts.minFontSize || 8,
        maxFontSize: opts.maxFontSize || 96,
        padding,
        align: opts.align
      });
      if (!layout.lines.length) { skipped++; continue; }

      CTTextLayout.drawText(ctx, layout, box, {
        color: opts.color || auto,
        fontFamily: opts.fontFamily,
        align: opts.align,
        padding,
        stroke: opts.stroke,
        strokeColor: auto === '#000000' ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)'
      });
      drawn++;
    }

    return { drawn, skipped, backgrounds };
  }

  globalThis.CTPainter = {
    luminance,
    dominantColor,
    sampleRingColor,
    expandBox,
    fillBox,
    renderRegions
  };
}
