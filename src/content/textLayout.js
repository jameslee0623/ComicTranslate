/**
 * textLayout.js - fit translated text into a detected bounding box.
 *
 * Runs as a content script. Text metrics need a real layout engine, so this
 * measures with the destination canvas's own 2D context rather than estimating
 * character widths. Never imported by the background context.
 */
'use strict';

if (typeof globalThis.CTTextLayout === 'undefined') {
  /** Hebrew + Arabic blocks: text that must be laid out RTL. */
  const RTL_RE = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;

  /** CJK + Hangul: scripts with no spaces, so lines may break anywhere. */
  const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\uAC00-\uD7AF\u3040-\u30FF]/;

  const DEFAULT_FONT_STACK =
    '"Comic Sans MS", "Comic Neue", "Noto Sans", "Helvetica Neue", Arial, ' +
    '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "Microsoft YaHei", ' +
    '"Noto Sans CJK JP", "Noto Sans Arabic", "Noto Sans Hebrew", sans-serif';

  function isRtl(text) {
    return RTL_RE.test(text || '');
  }

  /**
   * Split into layout tokens. Latin/other scripts break on whitespace so words
   * stay intact; CJK is split per character because those scripts wrap anywhere.
   */
  function tokenize(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];

    const tokens = [];
    let latin = '';
    const flush = () => {
      if (latin) {
        tokens.push({ text: latin, breakable: false });
        latin = '';
      }
    };

    for (const ch of Array.from(clean)) {
      if (CJK_RE.test(ch)) {
        flush();
        tokens.push({ text: ch, breakable: true });
      } else if (ch === ' ') {
        flush();
        tokens.push({ text: ' ', breakable: true });
      } else {
        latin += ch;
      }
    }
    flush();
    return tokens;
  }

  /** Greedy line breaking against the measured width of the current font. */
  function wrapTokens(ctx, tokens, maxWidth) {
    const lines = [];
    let line = '';
    let pendingSpace = false;

    for (const token of tokens) {
      if (token.text === ' ') {
        pendingSpace = !!line;
        continue;
      }

      let word = token.text;
      const withWord = pendingSpace ? line + ' ' + word : line + word;

      if (line && ctx.measureText(withWord).width > maxWidth) {
        lines.push(line);
        line = '';
        pendingSpace = false;
      }

      // Hard-break a word that cannot fit on a line by itself. Without this a
      // long compound or a URL overflows the box, and fitText then shrinks the
      // whole block to the minimum font size trying to compensate.
      while (ctx.measureText(word).width > maxWidth) {
        let cut = 1;
        while (cut < word.length &&
               ctx.measureText(word.slice(0, cut + 1)).width <= maxWidth) {
          cut++;
        }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
        pendingSpace = false;
      }

      if (line) line = pendingSpace ? line + ' ' + word : line + word;
      else line = word;
      pendingSpace = false;
    }

    if (line) lines.push(line);
    return lines;
  }

  function setFont(ctx, fontSize, opts) {
    const weight = opts.weight || 'bold';
    const style = opts.style || 'normal';
    const family = opts.fontFamily || DEFAULT_FONT_STACK;
    ctx.font = `${style} ${weight} ${fontSize}px ${family}`;
  }

  /**
   * Find the largest font size whose wrapped text fits the box. Sizes are
   * searched as integers; a 4px floor keeps absurdly small boxes from looping.
   */
  function fitText(ctx, opts) {
    const boxW = Math.max(4, opts.boxW);
    const boxH = Math.max(4, opts.boxH);
    const padding = opts.padding == null ? 2 : opts.padding;
    const innerW = Math.max(2, boxW - padding * 2);
    const innerH = Math.max(2, boxH - padding * 2);
    const lineHeightRatio = opts.lineHeightRatio || 1.12;
    const tokens = opts.tokens || tokenize(opts.text);

    if (!tokens.length) return { fontSize: 0, lines: [], lineHeight: 0, tokens };

    let lo = opts.minFontSize || 4;
    let hi = Math.max(lo, Math.min(opts.maxFontSize || 96, Math.floor(innerH)));
    let best = null;

    // Binary search: fits(size) is monotonic, so this converges in ~6 probes.
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      setFont(ctx, mid, opts);
      const lines = wrapTokens(ctx, tokens, innerW);
      const lineHeight = mid * lineHeightRatio;
      const fits = lines.length * lineHeight <= innerH &&
                   lines.every((l) => ctx.measureText(l).width <= innerW);
      if (fits) {
        best = { fontSize: mid, lines, lineHeight, tokens };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best) return best;

    // Nothing fit even at the floor: fall back to the minimum size and let the
    // renderer overflow slightly rather than dropping the translation entirely.
    setFont(ctx, opts.minFontSize || 4, opts);
    const size = opts.minFontSize || 4;
    return {
      fontSize: size,
      lines: wrapTokens(ctx, tokens, innerW),
      lineHeight: size * lineHeightRatio,
      tokens,
      overflow: true
    };
  }

  /**
   * Vertical centring plus horizontal centring for short lines gives the look
   * readers expect inside a speech bubble; long lines read better aligned to the
   * box edge, which is what `align: 'edge'` does.
   */
  function drawText(ctx, layout, box, opts) {
    const options = opts || {};
    const rtl = isRtl(layout.tokens.map((t) => t.text).join(''));
    const align = options.align || 'center';
    const padding = options.padding == null ? 2 : options.padding;

    const totalHeight = layout.lines.length * layout.lineHeight;
    const startY = box.y + (box.h - totalHeight) / 2 + layout.lineHeight / 2;
    const cx = box.x + box.w / 2;

    ctx.save();
    setFont(ctx, layout.fontSize, options);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = options.color || '#000';

    // An outline is drawn per line instead of via strokeText on the whole block,
    // so the halo hugs each glyph rather than the line box.
    const useStroke = !!options.stroke;
    if (useStroke) {
      ctx.lineWidth = options.strokeWidth || Math.max(2, layout.fontSize * 0.16);
      ctx.strokeStyle = options.strokeColor || 'rgba(255,255,255,0.92)';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }

    const edge = rtl ? box.x + box.w - padding : box.x + padding;
    ctx.textAlign = rtl ? 'right' : 'left';

    const paint = (line, x, y) => {
      if (useStroke) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    };

    layout.lines.forEach((line, i) => {
      const y = startY + i * layout.lineHeight;
      const isShort = ctx.measureText(line).width < box.w * 0.55;
      if (align === 'center' && (isShort || layout.lines.length === 1)) {
        ctx.textAlign = 'center';
        paint(line, cx, y);
        ctx.textAlign = rtl ? 'right' : 'left';
      } else {
        paint(line, edge, y);
      }
    });

    ctx.restore();
  }

  globalThis.CTTextLayout = {
    isRtl,
    tokenize,
    wrapTokens,
    fitText,
    drawText,
    setFont,
    DEFAULT_FONT_STACK,
    RTL_RE,
    CJK_RE
  };
}
