/* ============================================================
   PharmaFind — rxscan.js   (ADD-ON: search by prescription)
   ------------------------------------------------------------
   The patient picks a photo of a prescription. This file
     1) reads the text in the photo  (Tesseract.js — runs fully
        in the browser: free, no account, the photo is NOT sent
        to any server), and
     2) matches the text against the medicine catalog, allowing
        for small reading mistakes.

   It only SUGGESTS medicines. The patient always checks them
   against the paper prescription before reserving.

   Honest limits: clear PRINTED prescriptions read well.
   Handwriting often does not — then the patient types the name.

   To switch the feature OFF set SCAN_ENABLED to false — the app
   then behaves exactly as it did before this file existed.
   ============================================================ */

export const SCAN_ENABLED = true;

const TESSERACT_JS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let libPromise = null;


/* Loads the text reader once, the first time it is needed (a few MB). */
export function loadReader(){
  if(window.Tesseract) return Promise.resolve(window.Tesseract);
  if(libPromise) return libPromise;

  libPromise = new Promise((resolve, reject) => {
    const js = document.createElement("script");
    js.src = TESSERACT_JS;
    js.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("The text reader failed to start."));
    js.onerror = () => { libPromise = null; reject(new Error("Couldn't download the text reader. Check your internet connection.")); };
    document.head.appendChild(js);
  });
  return libPromise;
}


/* ---------------- image clean-up (straighten · crop · black-on-white) ----------------
   Phone photos are often tilted, far away, or shadowed. This finds the writing,
   turns it level, crops to it and makes it crisp black on white — which is what
   the reader is good at. Returns a list of views to try in order — each is
   { quarters, size, draw() } where draw() gives a canvas — or [] if no writing
   was found. */

function loadPicture(source){
  if(window.createImageBitmap && (source instanceof Blob)){
    return createImageBitmap(source).catch(() => loadPictureViaImg(source));
  }
  return loadPictureViaImg(source);
}

function loadPictureViaImg(source){
  return new Promise((resolve, reject) => {
    const url = (source instanceof Blob) ? URL.createObjectURL(source) : String(source);
    const img = new Image();
    img.onload  = () => { if(source instanceof Blob) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if(source instanceof Blob) URL.revokeObjectURL(url); reject(new Error("Couldn't open that photo.")); };
    img.src = url;
  });
}

export async function prepareForReading(source){
  const pic = await loadPicture(source);
  const MAX = 1400;
  const sc = Math.min(1, MAX / Math.max(pic.width, pic.height));
  const W = Math.max(1, Math.round(pic.width * sc)), H = Math.max(1, Math.round(pic.height * sc));

  const base = document.createElement("canvas");
  base.width = W; base.height = H;
  const bctx = base.getContext("2d", { willReadFrequently: true });
  bctx.fillStyle = "#fff"; bctx.fillRect(0, 0, W, H);
  bctx.drawImage(pic, 0, 0, W, H);
  const px = bctx.getImageData(0, 0, W, H).data;

  // 1) grey + local background (box blur via a summed-area table)
  const N = W * H;
  const grey = new Uint8Array(N);
  for(let i = 0, j = 0; i < N; i++, j += 4) grey[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;

  const SW = W + 1;
  const sat = new Uint32Array(SW * (H + 1));
  for(let y = 0; y < H; y++){
    let row = 0;
    for(let x = 0; x < W; x++){
      row += grey[y * W + x];
      sat[(y + 1) * SW + (x + 1)] = sat[y * SW + (x + 1)] + row;
    }
  }
  const R = Math.max(8, Math.round(W / 40));
  const ink = new Uint8Array(N);                    // 1 = darker than its surroundings
  for(let y = 0; y < H; y++){
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for(let x = 0; x < W; x++){
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const sum = sat[y1 * SW + x1] - sat[y0 * SW + x1] - sat[y1 * SW + x0] + sat[y0 * SW + x0];
      const bg = sum / ((x1 - x0) * (y1 - y0));
      if(grey[y * W + x] < bg - 18) ink[y * W + x] = 1;
    }
  }

  // 2) keep the writing, drop specks and solid blobs (shadows, table edges)
  const C = 8, gw = Math.ceil(W / C), gh = Math.ceil(H / C);
  const cnt = new Uint16Array(gw * gh);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++) if(ink[y * W + x]) cnt[((y / C) | 0) * gw + ((x / C) | 0)]++;

  // The paper's edge against a darker table also looks like "ink". Writing sits on
  // evenly-lit paper; an edge sits on a jump in brightness. So note how bright the
  // surface is in every square (its brightest pixel — pen strokes don't change that) …
  const light = new Uint8Array(gw * gh);
  for(let y = 0; y < H; y++){
    const row = ((y / C) | 0) * gw;
    for(let x = 0; x < W; x++){
      const g = row + ((x / C) | 0), v = grey[y * W + x];
      if(v > light[g]) light[g] = v;
    }
  }
  // … and treat a square as "on an edge" if the surface brightness jumps within 5 squares of it.
  const E = 5, JUMP = 30;
  const known = (g) => cnt[g] < C * C * 0.9;         // a square that is all ink says nothing about the surface
  const onEdge = (gx, gy) => {
    let lo = 255, hi = 0;
    for(let dy = -E; dy <= E; dy++){
      const yy = gy + dy; if(yy < 0 || yy >= gh) continue;
      for(let dx = -E; dx <= E; dx++){
        const xx = gx + dx; if(xx < 0 || xx >= gw) continue;
        const g = yy * gw + xx; if(!known(g)) continue;
        const v = light[g];
        if(v < lo) lo = v;
        if(v > hi) hi = v;
      }
    }
    return hi - lo > JUMP;
  };

  const texty = new Uint8Array(gw * gh);            // squares that contain ink — but not lone specks of dust
  for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
    if(cnt[gy * gw + gx] < 2) continue;
    if(onEdge(gx, gy)) continue;
    let around = 0;
    for(let dy = -2; dy <= 2; dy++){
      const yy = gy + dy; if(yy < 0 || yy >= gh) continue;
      for(let dx = -2; dx <= 2; dx++){
        const xx = gx + dx; if(xx < 0 || xx >= gw) continue;
        around += cnt[yy * gw + xx];
      }
    }
    if(around >= 30) texty[gy * gw + gx] = 1;
  }

  const D = 4;                                      // join letters/lines that are close together
  const grown = new Uint8Array(gw * gh);
  for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
    if(!texty[gy * gw + gx]) continue;
    for(let dy = -D; dy <= D; dy++){
      const yy = gy + dy; if(yy < 0 || yy >= gh) continue;
      for(let dx = -D; dx <= D; dx++){
        const xx = gx + dx; if(xx < 0 || xx >= gw) continue;
        grown[yy * gw + xx] = 1;
      }
    }
  }

  const label = new Int32Array(gw * gh).fill(-1);
  const weight = [];                                // ink in each shape
  const cells = [];                                 // inked squares in each shape
  const full = [];                                  // squares that are completely filled
  const stack = [];
  for(let i = 0; i < grown.length; i++){
    if(!grown[i] || label[i] !== -1) continue;
    const id = weight.length; weight.push(0); cells.push(0); full.push(0);
    stack.push(i); label[i] = id;
    while(stack.length){
      const k = stack.pop();
      if(texty[k]){ weight[id] += cnt[k]; cells[id]++; if(cnt[k] >= C * C * 0.88) full[id]++; }
      const kx = k % gw, ky = (k / gw) | 0;
      if(kx > 0      && grown[k - 1]  && label[k - 1]  === -1){ label[k - 1]  = id; stack.push(k - 1); }
      if(kx < gw - 1 && grown[k + 1]  && label[k + 1]  === -1){ label[k + 1]  = id; stack.push(k + 1); }
      if(ky > 0      && grown[k - gw] && label[k - gw] === -1){ label[k - gw] = id; stack.push(k - gw); }
      if(ky < gh - 1 && grown[k + gw] && label[k + gw] === -1){ label[k + gw] = id; stack.push(k + gw); }
    }
  }
  // Writing is made of strokes with gaps; a shadow or table edge is one solid blob.
  // Judge each whole shape (not each square) so thick pen strokes are kept.
  const solid = weight.map((w, id) => cells[id] > 0 &&
    (w / (cells[id] * C * C) > 0.62 || full[id] / cells[id] > 0.22));
  const top = Math.max(0, ...weight.map((w, id) => solid[id] ? 0 : w));
  if(top < 60) return [];                           // nothing that looks like writing
  const keep = weight.map((w, id) => !solid[id] && w >= top * 0.15);

  // ink points that belong to the writing
  const pts = [];
  for(let y = 0; y < H; y++){
    const gy = (y / C) | 0;
    for(let x = 0; x < W; x++){
      if(!ink[y * W + x]) continue;
      const g = gy * gw + ((x / C) | 0);
      if(texty[g] && keep[label[g]]) pts.push(x, y); else ink[y * W + x] = 0;
    }
  }
  const total = pts.length / 2;
  if(total < 60) return [];
  if(total > N * 0.2) return [];                    // "ink" nearly everywhere = texture or noise, not writing

  // 3) find the tilt: the angle at which the lines of writing stack up most sharply
  const step = Math.max(1, Math.floor(total / 15000));
  const cx = W / 2, cy = H / 2, diag = Math.ceil(Math.hypot(W, H));
  const bins = new Float32Array(Math.ceil(diag / 2) + 4);
  const sharpness = (deg) => {
    const t = deg * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
    bins.fill(0);
    for(let i = 0; i < total; i += step){
      const yy = (pts[2 * i] - cx) * sn + (pts[2 * i + 1] - cy) * cs + diag / 2;
      bins[(yy / 2) | 0]++;
    }
    let s = 0;
    for(let i = 1; i < bins.length; i++){ const d = bins[i] - bins[i - 1]; s += d * d; }
    return s;
  };
  let best = 0, bestScore = -1;
  for(let a = -90; a < 90; a += 2){ const s = sharpness(a); if(s > bestScore){ bestScore = s; best = a; } }
  for(let a = best - 1.5; a <= best + 1.5; a += 0.5){ const s = sharpness(a); if(s > bestScore){ bestScore = s; best = a; } }

  // 4) where the writing ends up after turning by that angle
  const t = best * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
  const xs = [], ys = [];
  for(let i = 0; i < total; i += step){
    const dx = pts[2 * i] - cx, dy = pts[2 * i + 1] - cy;
    xs.push(dx * cs - dy * sn); ys.push(dx * sn + dy * cs);
  }
  // how tall one line of writing is (the reader works best at a certain letter size)
  let yMin = Infinity, yMax = -Infinity;
  for(const v of ys){ if(v < yMin) yMin = v; if(v > yMax) yMax = v; }
  const rows = new Float32Array(Math.max(1, Math.ceil(yMax - yMin) + 1));
  for(const v of ys) rows[(v - yMin) | 0]++;
  let rowTop = 0;
  for(let i = 0; i < rows.length; i++) if(rows[i] > rowTop) rowTop = rows[i];
  const bands = [];
  for(let i = 0, start = -1; i <= rows.length; i++){
    const on = i < rows.length && rows[i] > rowTop * 0.08;
    if(on && start < 0) start = i;
    if(!on && start >= 0){ if(i - start >= 6) bands.push(i - start); start = -1; }
  }
  bands.sort((a, b) => a - b);

  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * f)))];
  let x0 = q(xs, 0.003), x1 = q(xs, 0.997), y0 = q(ys, 0.003), y1 = q(ys, 0.997);
  const pad = Math.max(24, (x1 - x0) * 0.06);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const bw = x1 - x0, bh = y1 - y0;
  if(bw < 8 || bh < 8) return [];

  // 5) draw it: black ink on white, level, cropped, enlarged
  const inkCanvas = document.createElement("canvas");
  inkCanvas.width = W; inkCanvas.height = H;
  const ictx = inkCanvas.getContext("2d");
  const out = ictx.createImageData(W, H);
  for(let i = 0, j = 0; i < N; i++, j += 4){
    const v = ink[i] ? 0 : 255;
    out.data[j] = v; out.data[j + 1] = v; out.data[j + 2] = v; out.data[j + 3] = 255;
  }
  ictx.putImageData(out, 0, 0);

  const lineH = bands.length ? bands[bands.length >> 1] : (y1 - y0) / 3;
  const zoomFor = (target) => Math.max(0.3, Math.min(3, target / lineH, 2200 / Math.max(bw, bh)));
  const level = (target) => {                       // straightened + cropped, letters about `target` pixels tall
    const zoom = zoomFor(target);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bw * zoom)); c.height = Math.max(1, Math.round(bh * zoom));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.scale(zoom, zoom);
    g.translate(-x0, -y0);
    g.rotate(t);
    g.translate(-cx, -cy);
    g.drawImage(inkCanvas, 0, 0);
    return c;
  };
  const turned = (src, quarters) => {               // the same picture turned by 0 / 90 / 180 / 270 degrees
    if(!quarters) return src;
    const c = document.createElement("canvas");
    const side = quarters % 2 === 1;
    c.width = side ? src.height : src.width; c.height = side ? src.width : src.height;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    g.rotate(quarters * Math.PI / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  };

  // The tilt tells us the writing is level — not which way is up, and for a short
  // list it can even be off by a quarter turn. So offer every way up, most likely
  // first, each at the letter sizes the reader copes with best. Views are only
  // drawn when asked for (they can be large).
  const views = [];
  for(const quarters of [0, 2, 1, 3]){
    for(const size of READ_SIZES) views.push({ quarters, size, draw: () => turned(level(size), quarters) });
  }
  return views;
}

const READ_SIZES = [68, 96];                         // letter heights (pixels) to try; each catches words the other misses


/* ---------------- reading ---------------- */

async function withReader(onStatus, job){
  const T = await loadReader();
  let worker = null;
  try{
    worker = await T.createWorker("eng", 1, { logger: (m) => { if(m && typeof m.progress === "number") onStatus(m); } });
    return await job(worker);
  }finally{
    if(worker) try{ await worker.terminate(); }catch(_){}
  }
}

/* Reads the text in a photo exactly as it is (no clean-up).
   source     : a File / Blob / data-URL / canvas
   onProgress : (percent 0-100, label) => void
   returns    : the text found (may be empty) */
export async function readText(source, onProgress){
  const say = (p, label) => { if(onProgress) try{ onProgress(Math.max(0, Math.min(100, Math.round(p))), label); }catch(_){} };
  say(5, "Preparing the reader…");
  try{
    return await withReader(
      (m) => m.status === "recognizing text" ? say(40 + m.progress * 60, "Reading your prescription…") : say(5 + m.progress * 35, "Preparing the reader…"),
      async (worker) => { const out = await worker.recognize(source); say(100, "Done"); return (out && out.data && out.data.text) || ""; });
  }catch(e){
    throw new Error("Couldn't read that photo. Try a sharper, well-lit photo taken straight from above.");
  }
}

const SCAN_TIME_LIMIT = 45000;                      // never keep the patient waiting longer than this (ms)

/* A smaller copy of a photo (longest side at most `max` pixels). Small photos are returned as they are. */
async function shrink(source, max){
  const pic = await loadPicture(source);
  const sc = Math.min(1, max / Math.max(pic.width, pic.height));
  if(sc === 1) return source;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(pic.width * sc)); c.height = Math.max(1, Math.round(pic.height * sc));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(pic, 0, 0, c.width, c.height);
  return c;
}

/* The full "search by prescription" job.
   1) read the photo as it is — clear printed prescriptions are done here;
   2) if that read poorly, straighten / crop / clean the photo and read again (both ways up);
   3) match everything that was read against the catalog.
   returns { text, matches, cleaned }   (cleaned = true if step 2 was needed) */
export async function scanPrescription(file, medicines, onProgress){
  const say = (p, label) => { if(onProgress) try{ onProgress(Math.max(0, Math.min(100, Math.round(p))), label); }catch(_){} };
  let stage = { from: 5, to: 40, label: "Preparing the reader…" };
  say(5, stage.label);

  try{
    return await withReader(
      (m) => {
        if(m.status === "recognizing text") say(stage.from + m.progress * (stage.to - stage.from), stage.label);
        else if(stage.label === "Preparing the reader…") say(5 + m.progress * 30, stage.label);
      },
      async (worker) => {
        const passes = [];
        const deadline = Date.now() + SCAN_TIME_LIMIT;
        // Reads one picture. Returns false if the time budget ran out before it finished.
        const read = async (src, from, to, label) => {
          const left = deadline - Date.now();
          if(left < 1500) return false;
          stage = { from, to, label };
          say(from, label);
          let timer = null;
          const out = await Promise.race([
            worker.recognize(src),
            new Promise(done => { timer = setTimeout(() => done(null), left); }),
          ]);
          clearTimeout(timer);
          if(!out) return false;
          const text = (out.data && out.data.text) || "";
          passes.push({ text, confidence: (out.data && out.data.confidence) || 0, matches: matchMedicines(text, medicines) });
          return true;
        };

        // phone photos are huge; the reader is no better (and far slower) above ~2000px
        let firstView = file;
        try{ firstView = await shrink(file, 2000); }catch(_){ firstView = file; }
        if(!(await read(firstView, 35, 60, "Reading your prescription…"))) throw new Error("slow");
        const first = passes[0];
        const clearlyRead = first.confidence >= 65 && first.text.trim().length >= 8;

        let cleaned = false;
        if(!clearlyRead){
          say(60, "Straightening the photo…");
          let views = [];
          try{ views = await prepareForReading(file); }catch(_){ views = []; }
          if(views.length){
            cleaned = true;
            // one "way up" at a time (all its letter sizes); stop at the first way up that finds a medicine
            const span = 36 / views.length;
            let lastTurn = null;
            for(let i = 0; i < views.length; i++){
              const v = views[i];
              if(v.quarters !== lastTurn && passes.some(p => p.matches.length)) break;
              lastTurn = v.quarters;
              const label = v.quarters === 0 ? "Reading it again, straightened…" : "Trying it another way up…";
              if(!(await read(v.draw(), 62 + span * i, 62 + span * (i + 1), label))) break;
            }
          }
        }

        // every medicine found in any pass (best score wins) …
        const byId = new Map();
        passes.forEach(p => p.matches.forEach(m => { if(!byId.has(m.id) || byId.get(m.id).score < m.score) byId.set(m.id, m); }));
        const matches = [...byId.values()].sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

        // … and the pass that read best, to show as "the text the app read"
        const bestPass = passes.slice().sort((a, b) => (b.matches.length - a.matches.length) || (b.confidence - a.confidence))[0];
        say(100, "Done");
        return { text: bestPass.text, matches, cleaned };
      });
  }catch(e){
    if(e && e.message === "slow") throw new Error("That photo is taking too long to read. Crop it to just the medicine names and try again.");
    throw new Error("Couldn't read that photo. Try a sharper, well-lit photo taken straight from above.");
  }
}


/* ---------------- matching text → catalog ---------------- */

// Words that describe the form or dose, not the medicine itself.
const STOP = new Set([
  "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syrup", "syp", "inj", "injection",
  "powder", "sachet", "salts", "drops", "cream", "gel", "ointment", "suspension", "solution",
  "mg", "mcg", "ml", "gm", "iu", "the", "and", "for", "with",
]);

// Everyday words found in dosage instructions. They are never treated as a piece of a medicine name.
const COMMON = new Set([
  "a", "an", "at", "as", "be", "by", "do", "if", "in", "is", "it", "no", "of", "on", "or", "so", "to", "up",
  "after", "before", "food", "meal", "meals", "day", "days", "week", "weeks", "one", "two", "three", "ten",
  "take", "then", "than", "from", "once", "twice", "daily", "night", "morning", "water", "not", "but", "per",
]);

function norm(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

/* Splits the reader's text into clean tokens:
   "Dolo650" → dolo 650,  "650mg" → 650 mg,  "Do1o650mg" → dolo 650 mg
   (a digit inside a word is a common misread: 0→o, 1→l, 5→s). */
function tokenize(text){
  const out = [];
  norm(text).split(" ").forEach(t => {
    if(!t) return;
    let word = t, tail = [];

    const strength = t.match(/^(.*?)(\d{2,4})(mg|mcg|ml|gm|g|iu)?$/);     // name + strength (+ unit) stuck together
    if(strength && /[a-z]/.test(strength[1])){
      word = strength[1];
      tail = [strength[2]].concat(strength[3] ? [strength[3]] : []);
    } else {
      const unit = t.match(/^(\d{1,4})([a-z]+)$/);                         // "650mg"
      if(unit){ out.push(unit[1], unit[2]); return; }
    }

    if(/[a-z]/.test(word) && /\d/.test(word)) word = word.replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s");
    if(word) out.push(word);
    tail.forEach(x => out.push(x));
  });
  return out;
}

function keyWords(s){
  return norm(s).split(" ").filter(w => w && !STOP.has(w) && /[a-z]/.test(w) && !/^\d/.test(w));
}

function numbersIn(s){ return (norm(s).match(/\b\d{2,4}\b/g) || []); }

// How many letter mistakes we forgive, by word length (short words must match exactly).
function allowedMistakes(len){
  if(len <= 4)  return 0;
  if(len <= 7)  return 1;
  if(len <= 11) return 2;
  return 3;
}

function editDistance(a, b, max){
  if(Math.abs(a.length - b.length) > max) return max + 1;
  let prev = [];
  for(let j = 0; j <= b.length; j++) prev[j] = j;
  for(let i = 1; i <= a.length; i++){
    const cur = [i];
    let rowMin = cur[0];
    for(let j = 1; j <= b.length; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if(cur[j] < rowMin) rowMin = cur[j];
    }
    if(rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/* Looks for `key` (one or more words) in the token list, word by word.
   Every word must be close enough on its own, so "vitamin d" never matches "vitamin c".
   Returns { score 0-1, at (token index), words } or null. */
function findKey(key, tokens){
  const parts = key.split(" ");
  const n = parts.length;
  const total = parts.join("").length;
  let best = null;

  for(let i = 0; i + n <= tokens.length; i++){
    let mistakes = 0, ok = true;
    for(let k = 0; k < n; k++){
      const max = allowedMistakes(parts[k].length);
      const d = editDistance(parts[k], tokens[i + k], max);
      if(d > max){ ok = false; break; }
      mistakes += d;
    }
    if(!ok) continue;
    const score = 1 - mistakes / total;
    if(!best || score > best.score) best = { score, at: i, words: n };
    if(mistakes === 0) break;
  }

  // Handwriting is often read in pieces. For a long one-word name, also try
  // 2 or 3 neighbouring pieces joined together (letters only).
  if(!best && n === 1 && total >= 8){
    const max = allowedMistakes(total);
    for(let join = 2; join <= 3; join++){
      for(let i = 0; i + join <= tokens.length; i++){
        const piece = tokens.slice(i, i + join);
        if(piece.some(p => !/^[a-z]+$/.test(p) || COMMON.has(p) || STOP.has(p))) continue;   // real words are not pieces of a name
        const cand = piece.join("");
        if(Math.abs(cand.length - total) > max) continue;
        const d = editDistance(key, cand, max);
        if(d <= max){
          const score = (1 - d / total) * 0.95;            // slightly less sure than a whole word
          if(!best || score > best.score) best = { score, at: i, words: join };
        }
      }
    }
  }
  return best;
}

/* text       : what the reader found
   medicines  : [{ id, name, generic, mfr }]  (the catalog)
   returns    : [{ id, name, generic, score, via, found, strengthSeen }] best first */
export function matchMedicines(text, medicines){
  const tokens = tokenize(text);
  if(!tokens.length) return [];
  const results = [];

  (medicines || []).forEach(m => {
    const brandKey   = keyWords(m.name).join(" ");
    const genericKey = keyWords(m.generic).join(" ");

    let hit = null, via = "";
    if(brandKey){
      const h = findKey(brandKey, tokens);
      if(h){ hit = h; via = "name"; }
    }
    if(genericKey && genericKey !== brandKey){
      const h = findKey(genericKey, tokens);
      if(h && (!hit || h.score > hit.score)){ hit = h; via = "salt"; }
    }
    // A short brand name must normally match exactly. One exception: one wrong letter
    // is forgiven when the right strength is written straight after it ("Delo 650" → Dolo 650).
    if(!hit && /^[a-z]{4}$/.test(brandKey)){
      const strengths = numbersIn(m.name);
      for(let i = 0; i + 1 < tokens.length && strengths.length; i++){
        if(tokens[i].length === 4 && strengths.includes(tokens[i + 1]) && editDistance(brandKey, tokens[i], 1) === 1){
          hit = { score: 0.7, at: i, words: 1 }; via = "name";
          break;
        }
      }
    }
    if(!hit) return;

    // Is the strength (e.g. 650, 500) written near the name? Shown as a hint only.
    const wanted = numbersIn(m.name).concat(numbersIn(m.generic));
    const near = tokens.slice(Math.max(0, hit.at - 2), hit.at + hit.words + 4);
    const strengthSeen = wanted.length ? wanted.some(n => near.includes(n)) : null;

    results.push({
      id: m.id, name: m.name, generic: m.generic,
      score: hit.score, via,
      found: tokens.slice(hit.at, hit.at + hit.words).join(" "),
      strengthSeen,
    });
  });

  // If two strengths of the same medicine matched, prefer the one whose strength was seen.
  results.sort((a, b) => (b.score - a.score) || ((b.strengthSeen === true) - (a.strengthSeen === true)) || a.name.localeCompare(b.name));
  return results;
}
