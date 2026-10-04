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


/* Reads the text in a photo.
   source     : a File / Blob / data-URL / canvas
   onProgress : (percent 0-100, label) => void
   returns    : the text found (may be empty) */
export async function readText(source, onProgress){
  const T = await loadReader();
  const say = (p, label) => { if(onProgress) try{ onProgress(Math.max(0, Math.min(100, Math.round(p))), label); }catch(_){} };

  say(5, "Preparing the reader…");
  let worker = null;
  try{
    worker = await T.createWorker("eng", 1, {
      logger: (m) => {
        if(!m || typeof m.progress !== "number") return;
        if(m.status === "recognizing text") say(40 + m.progress * 60, "Reading your prescription…");
        else say(5 + m.progress * 35, "Preparing the reader…");
      },
    });
    const out = await worker.recognize(source);
    say(100, "Done");
    return (out && out.data && out.data.text) || "";
  }catch(e){
    throw new Error("Couldn't read that photo. Try a sharper, well-lit photo taken straight from above.");
  }finally{
    if(worker) try{ await worker.terminate(); }catch(_){}
  }
}


/* ---------------- matching text → catalog ---------------- */

// Words that describe the form or dose, not the medicine itself.
const STOP = new Set([
  "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syrup", "syp", "inj", "injection",
  "powder", "sachet", "salts", "drops", "cream", "gel", "ointment", "suspension", "solution",
  "mg", "mcg", "ml", "gm", "iu", "the", "and", "for", "with",
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
