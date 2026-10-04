/* ============================================================
   PharmaFind — pwa.js   (ADD-ON: installable app)
   ------------------------------------------------------------
   Turns the website into an app people can install:
     • Android / Chrome / Edge: an "Install app" button appears;
       one tap adds PharmaFind to the home screen. It then opens
       full-screen with its own icon, like any other app.
     • iPhone / iPad (Safari): a one-line hint explains
       Share → "Add to Home Screen" (Apple has no install button).
   It is the SAME app and the same code — every feature works
   exactly as on the website.

   Needs: the site served over https:// (or localhost), plus
   manifest.webmanifest, sw.js and the icons/ folder.

   To switch this OFF set PWA_ENABLED to false — the website
   then behaves exactly as it did before this file existed.
   ============================================================ */

export const PWA_ENABLED = true;

const DISMISS_KEY = "pf-install-dismissed";      // remembers "not now"
const DISMISS_DAYS = 14;

let installEvent = null;                         // the browser's saved install prompt
let bar = null;

/* true when PharmaFind is running as an installed app (not in a browser tab). */
export function isInstalledApp(){
  try{
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }catch(_){ return false; }
}

function dismissedRecently(){
  try{
    const t = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return t > 0 && Date.now() - t < DISMISS_DAYS * 86400000;
  }catch(_){ return false; }
}
function rememberDismiss(){ try{ localStorage.setItem(DISMISS_KEY, String(Date.now())); }catch(_){} }

function hideBar(){ if(bar){ bar.remove(); bar = null; } }

/* A small bar at the bottom of the page. Built here so no other file needs to change. */
function showBar(text, buttonLabel, onButton){
  hideBar();
  bar = document.createElement("div");
  bar.id = "pwa-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Install PharmaFind");
  bar.style.cssText = [
    "position:fixed", "left:12px", "right:12px", "bottom:calc(12px + env(safe-area-inset-bottom, 0px))", "z-index:80",
    "max-width:440px", "margin:0 auto", "display:flex", "align-items:center", "gap:10px",
    "background:var(--surface,#fff)", "color:var(--ink,#17211d)", "border:1px solid var(--border-strong,#cdd5cf)",
    "border-radius:14px", "padding:10px 12px", "box-shadow:0 8px 24px rgba(0,0,0,.18)", "font-size:13.5px", "line-height:1.4",
  ].join(";");

  const msg = document.createElement("div");
  msg.style.cssText = "flex:1;min-width:0";
  msg.textContent = text;
  bar.appendChild(msg);

  if(buttonLabel){
    const go = document.createElement("button");
    go.id = "pwa-install";
    go.type = "button";
    go.className = "btn primary sm";
    go.textContent = buttonLabel;
    go.onclick = onButton;
    bar.appendChild(go);
  }

  const close = document.createElement("button");
  close.id = "pwa-close";
  close.type = "button";
  close.className = "btn ghost sm";
  close.setAttribute("aria-label", "Not now");
  close.textContent = "✕";
  close.onclick = () => { rememberDismiss(); hideBar(); };
  bar.appendChild(close);

  document.body.appendChild(bar);
}

function offerInstall(){
  if(!installEvent || isInstalledApp() || dismissedRecently()) return;
  showBar("📲 Install PharmaFind as an app on this device.", "Install app", async () => {
    const ev = installEvent;
    if(!ev) return;
    hideBar();
    try{
      ev.prompt();
      const choice = await ev.userChoice;
      if(choice && choice.outcome !== "accepted") rememberDismiss();
    }catch(_){ /* the browser refused to show it — nothing to do */ }
    installEvent = null;
  });
}

function offerIosHint(){
  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if(!isIos || !isSafari || isInstalledApp() || dismissedRecently()) return;
  showBar("📲 To install PharmaFind: tap the Share button, then “Add to Home Screen”.", "", null);
}

function start(){
  if(!PWA_ENABLED) return;

  // 1) the service worker (needs https or localhost)
  if("serviceWorker" in navigator && window.isSecureContext){
    navigator.serviceWorker.register("./sw.js").catch(e => console.warn("[pwa.js] service worker not registered", e));
  }

  // 2) the install button
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                 // we show our own button instead of the browser's mini-bar
    installEvent = e;
    offerInstall();
  });
  window.addEventListener("appinstalled", () => { installEvent = null; hideBar(); });

  offerIosHint();
}

start();
