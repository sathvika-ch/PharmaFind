/* ============================================================
   PharmaFind — prescription.js   (ADD-ON, step 2)
   ------------------------------------------------------------
   Lets a patient attach a photo of their prescription to a
   reservation. The photo is shrunk in the browser to a small
   JPEG and stored in Firestore (no paid file storage needed).

   Who can see it: the patient, the pharmacy that received the
   reservation, and the admin. Nobody else (see firestore.rules).

   This file only prepares / checks images. app.js does the
   saving. To switch the whole feature OFF, set RX_ENABLED to
   false — the app then behaves exactly as it did before.
   ============================================================ */

export const RX_ENABLED = true;

export const RX_PREFIX    = "data:image/jpeg;base64,";
export const RX_MAX_CHARS = 900000;            // must match the limit in firestore.rules
const MAX_FILE_BYTES      = 15 * 1024 * 1024;  // biggest photo we accept before shrinking

// Tried in order until the picture fits: [longest side in px, JPEG quality]
const ATTEMPTS = [[1600, 0.75], [1600, 0.6], [1280, 0.6], [1024, 0.6], [1024, 0.45], [800, 0.45], [640, 0.4]];


/* Only a plain base64 JPEG of the allowed size may ever be shown in the page. */
export function isSafeImage(s){
  return typeof s === "string"
    && s.length <= RX_MAX_CHARS
    && s.startsWith(RX_PREFIX)
    && /^[A-Za-z0-9+/=]+$/.test(s.slice(RX_PREFIX.length));
}


function loadBitmap(file){
  if(window.createImageBitmap){
    return createImageBitmap(file).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This file isn't a picture the browser can open. Use a JPG or PNG photo.")); };
    img.src = url;
  });
}


/* Shrinks a photo. Returns { dataUrl, width, height, kb }. Throws an Error with a
   message that is safe to show to the user. */
export async function compressImage(file){
  if(!file) throw new Error("Choose a photo first.");
  if(!/^image\//.test(file.type || "")) throw new Error("Please choose a photo (JPG or PNG). PDFs aren't supported yet.");
  if(file.size > MAX_FILE_BYTES) throw new Error("That photo is too large (over 15 MB). Take a new one or crop it.");

  let src;
  try{ src = await loadBitmap(file); }
  catch(e){ throw new Error(e && e.message ? e.message : "Couldn't open that photo."); }

  const sw = src.width, sh = src.height;
  if(!sw || !sh) throw new Error("Couldn't read that photo.");

  for(const [maxSide, quality] of ATTEMPTS){
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";                 // transparent PNGs get a white page
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if(isSafeImage(dataUrl)){
      if(src.close) try{ src.close(); }catch(_){}
      return { dataUrl, width: w, height: h, kb: Math.round(dataUrl.length * 0.75 / 1024) };
    }
  }
  throw new Error("Couldn't make that photo small enough. Try a clearer, closer photo of just the prescription.");
}


/* For "open full size": turns the stored picture into a temporary link. */
export function toObjectUrl(dataUrl){
  if(!isSafeImage(dataUrl)) return null;
  const bin = atob(dataUrl.slice(RX_PREFIX.length));
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
