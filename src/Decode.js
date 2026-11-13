// Barcode finding in a photo: pure JS on a grey image {w, h, data}, ZXing passed in so the same code runs in the phone page (copied by
// clientLib_) and in Node (tests/decode_test.js). One call returns EVERY readable barcode, because a label carries several (a DigiKey label
// has a Data Matrix plus 1D bars; a Mouser label has one 1D bar per field and no part number in its 2D code).
// Passes, cheapest first: whole image, label region (largest bright blob), horizontal bands (1D bars), tiles (dense Data Matrix at full
// resolution). Stops at the time budget. Names ending _ are hidden from google.script.run.

function makeDecoder_(zx) {
  var F = zx.BarcodeFormat, H = zx.DecodeHintType;
  var DM = [F.DATA_MATRIX], ONE = [F.CODE_128, F.CODE_39, F.PDF_417, F.QR_CODE];

  function gray(rgba, w, h) {   // RGBA bytes -> grey
    var g = new Uint8ClampedArray(w * h);
    for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return { w: w, h: h, data: g };
  }
  function crop(img, x, y, w, h) {
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    w = Math.min(img.w - x, Math.round(w)); h = Math.min(img.h - y, Math.round(h));
    var d = new Uint8ClampedArray(w * h);
    for (var r = 0; r < h; r++) d.set(img.data.subarray((y + r) * img.w + x, (y + r) * img.w + x + w), r * w);
    return { w: w, h: h, data: d };
  }
  function shrink(img, f) {   // area average, f < 1
    var w = Math.max(1, Math.round(img.w * f)), h = Math.max(1, Math.round(img.h * f)), d = new Uint8ClampedArray(w * h);
    var sx = img.w / w, sy = img.h / h;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy)), s = 0, n = 0;
      for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) { s += img.data[yy * img.w + xx]; n++; }
      d[y * w + x] = s / n;
    }
    return { w: w, h: h, data: d };
  }
  function rotate90(img) {
    var w = img.h, h = img.w, d = new Uint8ClampedArray(w * h);
    for (var y = 0; y < img.h; y++) for (var x = 0; x < img.w; x++) d[x * w + (img.h - 1 - y)] = img.data[y * img.w + x];
    return { w: w, h: h, data: d };
  }

  function read(img, formats, invert) {
    var hints = new Map();
    hints.set(H.POSSIBLE_FORMATS, formats); hints.set(H.TRY_HARDER, true);
    var reader = new zx.MultiFormatReader(); reader.setHints(hints);
    var src = new zx.RGBLuminanceSource(img.data, img.w, img.h);
    if (invert) src = new zx.InvertedLuminanceSource(src);
    try { var r = reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(src))); return { text: r.getText(), format: F[r.getBarcodeFormat()] }; }
    catch (e) { return null; }
  }

  /** Bounding box of the largest bright blob (the white label on a dark bag or table), found on a small copy. null if it is not clearly a label. */
  function labelBox(img) {
    var f = Math.min(1, 160 / Math.max(img.w, img.h)), s = shrink(img, f), n = s.w * s.h, hist = new Array(256).fill(0), i;
    for (i = 0; i < n; i++) hist[s.data[i]]++;
    var sum = 0, wB = 0, sumB = 0, best = 0, thr = 128;   // Otsu
    for (i = 0; i < 256; i++) sum += i * hist[i];
    for (i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; var wF = n - wB; if (!wF) break; sumB += i * hist[i]; var mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
    var lab = new Int32Array(n), stack = [], bestBox = null, bestArea = 0, id = 0;
    for (i = 0; i < n; i++) {
      if (s.data[i] <= thr || lab[i]) continue;
      id++; var area = 0, x0 = s.w, y0 = s.h, x1 = 0, y1 = 0; stack.push(i); lab[i] = id;
      while (stack.length) {
        var p = stack.pop(), px = p % s.w, py = (p - px) / s.w; area++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && s.data[p - 1] > thr && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
        if (px < s.w - 1 && s.data[p + 1] > thr && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
        if (py > 0 && s.data[p - s.w] > thr && !lab[p - s.w]) { lab[p - s.w] = id; stack.push(p - s.w); }
        if (py < s.h - 1 && s.data[p + s.w] > thr && !lab[p + s.w]) { lab[p + s.w] = id; stack.push(p + s.w); }
      }
      if (area > bestArea) { bestArea = area; bestBox = [x0, y0, x1 - x0 + 1, y1 - y0 + 1]; }
    }
    if (!bestBox || bestArea < n * 0.08 || bestBox[2] * bestBox[3] > n * 0.97) return null;   // tiny, or it is the whole frame anyway
    var pad = 0.03;
    return [bestBox[0] / f - img.w * pad, bestBox[1] / f - img.h * pad, bestBox[2] / f + img.w * pad * 2, bestBox[3] / f + img.h * pad * 2];
  }

  /** All distinct barcodes in the image. opts.budgetMs (default 4000), opts.now (clock, default Date.now), opts.fast (live video: whole frame + label only). */
  function decodeAll(img, opts) {
    opts = opts || {};
    var now = opts.now || Date.now, t0 = now(), budget = opts.budgetMs || 4000, found = [], seen = {};
    var out = function () { return now() - t0 > budget; };
    function add(r) { if (r && !seen[r.text]) { seen[r.text] = 1; found.push(r); } return !!r; }
    function passes(im, bands) {   // one region: whole, then bands for 1D bars, then tiles for a dense Data Matrix
      var big = Math.max(im.w, im.h), full = big > 2200 ? shrink(im, 2200 / big) : im;
      add(read(full, DM)); add(read(full, ONE));
      if (opts.fast || out()) return;
      var k, bh, y, x, tw, th;
      if (bands) { bh = full.h * 0.16; for (y = 0; y < full.h - bh * 0.5 && !out(); y += bh * 0.5) add(read(crop(full, 0, y, full.w, bh), ONE)); }
      tw = full.w / 2 * 1.3; th = full.h / 2 * 1.3;   // 2x2 overlapping tiles
      for (k = 0; k < 4 && !out(); k++) { var tile = crop(full, (k % 2) * (full.w - tw), Math.floor(k / 2) * (full.h - th), tw, th); add(read(tile, DM)); }
      tw = full.w / 3 * 1.4; th = full.h / 3 * 1.4;   // 3x3
      for (k = 0; k < 9 && !out(); k++) { var t3 = crop(full, (k % 3) * (full.w - tw) / 2, Math.floor(k / 3) * (full.h - th) / 2, tw, th); add(read(t3, DM)); }
    }
    var box = labelBox(img);
    if (box) passes(crop(img, box[0], box[1], box[2], box[3]), true);
    if (!opts.fast && !out()) passes(img, true);
    if (!found.length && !opts.fast && !out()) {   // last resorts: inverted print, rotated photo
      add(read(img, DM, true)); add(read(rotate90(img), DM)); add(read(rotate90(img), ONE));
    }
    return found;
  }

  return { gray: gray, crop: crop, shrink: shrink, decodeAll: decodeAll, labelBox: labelBox };
}

/** zxing-wasm (zxing-cpp compiled to WebAssembly): handles perspective, glare, many symbols and full resolution far better than the JS port.
 *  wasm = the ZXingWASM global in the page or require('zxing-wasm/reader') in Node; imageData = {width, height, data} RGBA. Promise of [{text, format}]. */
function decodeWasm_(wasm, imageData, fast, formats) {   // formats: DigiKey mode passes ['DataMatrix'] (much faster); default reads everything
  return wasm.readBarcodes(imageData, { formats: formats || ['DataMatrix', 'Code128', 'Code39', 'QRCode', 'PDF417'], tryHarder: !fast, tryRotate: true, tryInvert: !fast, tryDownscale: true, maxNumberOfSymbols: 16 })
    .then(function (rs) { return rs.filter(function (r) { return r.isValid !== false && r.text; }).map(function (r) { return { text: r.text, format: r.format, position: r.position }; }); });
}

// Mouser label layout, in Data Matrix sizes (s) from the 2D code's top-left corner, along its own axes (so tilt and rotation do not matter).
// The 1D bars sit left of and below the 2D code. ponytail: fitted to the Mouser label template seen in Nov 2026; retune here if Mouser changes it.
var MOUSER_BARS = { u0: -5.8, u1: 0.2, v0: -0.3, v1: 5.0, h: 0.35, step: 0.15, px: 330 };

/** One horizontal strip of the label, cut along the Data Matrix axes and scaled in a single bilinear pass over the RGBA image (deskew + crop +
 *  upscale without touching the rest of the photo). tl = 2D top-left corner, a = its angle, s = its size, v = strip top in s units, k = output px per source px. */
function labelStrip_(img, tl, a, s, v, k) {
  var L = MOUSER_BARS, w = Math.round((L.u1 - L.u0) * s * k), h = Math.max(4, Math.round(L.h * s * k)), out = new Uint8ClampedArray(w * h * 4);
  var c = Math.cos(a), sn = Math.sin(a), W = img.width, H = img.height, d = img.data;
  for (var j = 0; j < h; j++) {
    var vv = (v * s) + j / k;
    for (var i = 0; i < w; i++) {
      var uu = L.u0 * s + i / k, x = tl.x + uu * c - vv * sn, y = tl.y + uu * sn + vv * c, o = (j * w + i) * 4;
      if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
      var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = (y0 * W + x0) * 4, q = p + W * 4;
      for (var ch = 0; ch < 3; ch++) out[o + ch] = (d[p + ch] * (1 - fx) + d[p + 4 + ch] * fx) * (1 - fy) + (d[q + ch] * (1 - fx) + d[q + 4 + ch] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Mouser mode: read the 2D code; if it has no manufacturer PN (orders with a customer P/N replace 1P by P), read the 1D bars as thin deskewed
 *  strips anchored on the 2D code, top to bottom, Code128 only, stopping at the first Mouser PN (NNN-...). Without a 2D code: plain 1D read.
 *  Promise of [{text, format}]. Low compute: a few small strips instead of the whole photo at full resolution. */
function mouserRead_(wasm, img, fast) {
  return decodeWasm_(wasm, img, fast, ['DataMatrix']).then(function (dm) {
    var two = dm.filter(function (r) { return r.text.indexOf('[)>') >= 0; })[0];
    if (!two || !two.position) return decodeWasm_(wasm, img, fast, ['Code128', 'DataMatrix']);
    if (/[\x1d␝]1P[^\x1d␝\x1e␞]/.test(two.text)) return [two];   // 2D already names the part
    var P = two.position, tl = P.topLeft, a = Math.atan2(P.topRight.y - tl.y, P.topRight.x - tl.x), s = Math.sqrt(Math.pow(P.topRight.x - tl.x, 2) + Math.pow(P.topRight.y - tl.y, 2));
    var L = MOUSER_BARS, k = Math.max(1, L.px / s), found = [two], seen = {}, rows = [];
    for (var v = L.v0; v < L.v1; v += L.step) rows.push(v);
    function next(i) {
      if (i >= rows.length) return found;
      return wasm.readBarcodes(labelStrip_(img, tl, a, s, rows[i], k), { formats: ['Code128'], tryHarder: true, tryRotate: false, maxNumberOfSymbols: 2 }).then(function (rs) {
        var hit = false;
        rs.forEach(function (r) { if (r.text && r.isValid !== false && !seen[r.text]) { seen[r.text] = 1; found.push({ text: r.text, format: r.format }); if (/^\d{2,3}-\S+/.test(r.text)) hit = true; } });
        return hit ? found : next(i + 1);
      });
    }
    return next(0);
  });
}
