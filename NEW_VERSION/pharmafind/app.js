/* ============================================================
   PharmaFind — Firebase edition (passwordless email-link login)
   Roles: Admin · Medical (Pharmacy) · User (Patient)
   Backend: Firebase Authentication + Cloud Firestore (real-time)
   ------------------------------------------------------------
   • LOGIN: type your email → Firebase mails a one-tap link → in.
   • FIRST-TIME users pick patient / pharmacy (admin emails are
     detected automatically). Profile + store are written together
     in one batch, so you can't end up with half an account.
   • RESERVE: the patient's stock is HELD the moment they pay —
     one transaction lowers inventory and creates the reservation.
     Cancelling a reservation puts the stock back.
   • BILLING: one transaction checks stock, lowers it and writes
     the bill. firestore.rules re-check every line server-side.
   • PAYMENT is a MOCK card screen (no real money).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, runTransaction, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

/* ---------- Keep the app on the same domain as Firebase sign-in ----------
   Firebase Hosting serves this site on both <project>.web.app and
   <project>.firebaseapp.com. Google sign-in runs on authDomain
   (firebaseapp.com), so we always use that address — otherwise Chrome's
   privacy protections can break sign-in inside the Android app. */
(function(){
  const h=window.location.hostname, auth=firebaseConfig.authDomain;
  if(auth && h===firebaseConfig.projectId+".web.app"){
    window.location.replace("https://"+auth+window.location.pathname+window.location.search+window.location.hash);
  }
})();

/* running as an installed app (Android APK / home-screen app)? */
const IS_INSTALLED_APP =
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true ||
  String(document.referrer).startsWith("android-app://");

/* ---------- Firebase init ---------- */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const adminEmails = (ADMIN_EMAILS || []).map(e => String(e).trim().toLowerCase());
const isAdminEmail = (email) => adminEmails.includes(String(email||"").trim().toLowerCase());

/* ---------- Constants ---------- */
const EMAIL_KEY = "pf_emailForSignIn";
const LOC_KEY = "pf_userLoc";
const LOW_STOCK = 10;
const MAX_BILL_LINES = 8;                         // must match firestore.rules
const DEFAULT_LOC = { lat:17.3850, lng:78.4867 }; // Hyderabad city centre

const SAMPLE_MEDS = [
  ["Dolo 650","Paracetamol 650mg","Micro Labs"],
  ["Azithromycin 500","Azithromycin 500mg","Cipla"],
  ["Cetirizine 10","Cetirizine 10mg","Dr. Reddy's"],
  ["Amoxicillin 500","Amoxicillin 500mg","Sun Pharma"],
  ["Pantoprazole 40","Pantoprazole 40mg","Alkem"],
  ["ORS Powder","Oral Rehydration Salts","FDC"],
  ["Vitamin C 500","Ascorbic Acid 500mg","HealthVit"],
  ["Metformin 500","Metformin 500mg","USV"],
  ["Amlodipine 5","Amlodipine 5mg","Torrent"],
  ["Ibuprofen 400","Ibuprofen 400mg","Abbott"],
];

/* ---------- Small helpers ---------- */
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const money = (n) => "₹" + Number(n||0).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const round2 = (n) => Math.round(n*100)/100;

/* ============================================================
   LOCAL CACHE  (kept in sync by onSnapshot listeners)
   ============================================================ */
let ME = null;   // { uid, role, name, email, phone, address }
const cache = {
  users:[], pharmacies:[], medicines:[], inventory:[],
  reservations:[], bills:[], notifications:[],
};
const loaded = new Set();   // which collections have delivered their first snapshot
let listeners = [];
let modalOpen = false;
let pendingRefresh = false;
let completingLink = false;
let pointerDown = false;

const state = { view:null, searchQuery:"", billDraft:[], loc:loadSavedLoc() };

/* ---------- Lookups ---------- */
const getUser = (id) => cache.users.find(u => u.id === id);
const getMed  = (id) => cache.medicines.find(m => m.id === id);
const getPh   = (id) => cache.pharmacies.find(p => p.id === id);
const currentUser = () => ME;
const myPharmacy = () => ME ? cache.pharmacies.find(p => p.ownerUserId === ME.uid) : null;

function stockState(q){
  if(q <= 0) return { key:"out", label:"Out of stock" };
  if(q <= LOW_STOCK) return { key:"low", label:"Low stock" };
  return { key:"ok", label:"In stock" };
}
function distanceKm(lat, lng){
  if(typeof lat!=="number" || typeof lng!=="number") return null;
  const from=state.loc, R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat-from.lat), dLng=toRad(lng-from.lng);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(from.lat))*Math.cos(toRad(lat))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function unreadCount(userId){ return cache.notifications.filter(n => n.userId===userId && !n.read).length; }
function timeAgo(ts){
  const s=Math.floor((now()-(ts||0))/1000);
  if(s<60) return "just now";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}
function notify(userId, text, refId){
  if(!userId || !ME) return Promise.resolve();
  const data = { userId, text:String(text).slice(0,300), read:false, createdAt:now(), fromUid:ME.uid };
  if(refId) data.refId = refId;
  return addDoc(collection(db,"notifications"), data).catch(e => console.warn("notify failed", e));
}
function onlineRevenue(list){
  return list.filter(r=>r.status==="fulfilled").reduce((s,r)=>s+(r.amountPaid||0),0);
}

/* ---------- Location ---------- */
function loadSavedLoc(){
  try{
    const s=JSON.parse(sessionStorage.getItem(LOC_KEY)||"null");
    if(s && typeof s.lat==="number" && typeof s.lng==="number") return { ...s, source:"gps" };
  }catch(_){}
  return { ...DEFAULT_LOC, source:"default" };
}
function getPosition(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation) return reject(new Error("Location isn't supported on this device."));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat:p.coords.latitude, lng:p.coords.longitude }),
      e => reject(new Error(e.code===1 ? "Location permission was denied." : "Could not get your location.")),
      { enableHighAccuracy:true, timeout:10000, maximumAge:60000 });
  });
}
async function useMyLocation(){
  try{
    const p=await getPosition();
    state.loc={ ...p, source:"gps" };
    try{ sessionStorage.setItem(LOC_KEY, JSON.stringify(p)); }catch(_){}
    toast("Showing distances from your current location.", "good");
  }catch(e){ toast(e.message, "bad"); }
  if(ME && state.view==="search") viewSearch();
}

/* ---------- UI helpers ---------- */
function toast(msg, kind=""){
  const el=document.createElement("div");
  el.className="toast "+kind;
  el.textContent=msg;
  $("toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),300); }, 3200);
}
let modalCloser=null;
function openModal(html, opts={}){
  const root=$("modal-root");
  root.innerHTML=`<div class="modal-bg" data-modalbg><div class="modal ${opts.wide?'wide':''}">${html}</div></div>`;
  modalOpen=true;
  modalCloser=()=>{ root.innerHTML=""; modalCloser=null; modalOpen=false;
    if(pendingRefresh){ pendingRefresh=false; refresh(); } };
  root.querySelector("[data-modalbg]").addEventListener("mousedown", (e)=>{ if(e.target.dataset.modalbg!==undefined) modalCloser(); });
}
function closeModal(){ if(modalCloser) modalCloser(); }
window.closeModal = closeModal;

/* ---------- Live re-render that doesn't wipe what you're typing ---------- */
function captureForm(){
  const main=$("main"); if(!main) return null;
  const vals={};
  main.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{
    vals[el.id] = el.type==="checkbox" ? el.checked : el.value;
  });
  const a=document.activeElement;
  const focus = (a && a.id && main.contains(a)) ? { id:a.id, s:a.selectionStart, e:a.selectionEnd } : null;
  return { view:state.view, vals, focus };
}
function restoreForm(snap){
  if(!snap || snap.view!==state.view) return;
  Object.entries(snap.vals).forEach(([id,v])=>{
    const el=$(id); if(!el || el.disabled) return;
    if(el.tagName==="SELECT"){ if([...el.options].some(o=>o.value===v)) el.value=v; }
    else if(el.type==="checkbox") el.checked=v;
    else el.value=v;
  });
  if(snap.focus){
    const el=$(snap.focus.id);
    if(el){ el.focus(); try{ if(snap.focus.s!=null) el.setSelectionRange(snap.focus.s, snap.focus.e); }catch(_){} }
  }
}
function refresh(){
  if(!ME) return;
  if(modalOpen || pointerDown){ pendingRefresh=true; return; }
  const snap=captureForm();
  renderApp();
  restoreForm(snap);
}
document.addEventListener("pointerdown", ()=>{ pointerDown=true; }, true);
document.addEventListener("pointerup", ()=>{
  pointerDown=false;
  setTimeout(()=>{ if(pendingRefresh && !modalOpen){ pendingRefresh=false; refresh(); } }, 0);
}, true);
document.addEventListener("pointercancel", ()=>{ pointerDown=false; }, true);

/* ============================================================
   REAL-TIME LISTENERS
   ============================================================ */
function teardownListeners(){
  listeners.forEach(unsub => { try{ unsub(); }catch(_){} });
  listeners = [];
  loaded.clear();
  Object.keys(cache).forEach(k => cache[k] = []);
}
function setupListeners(){
  teardownListeners();
  const sub = (q, key) => {
    const unsub = onSnapshot(q,
      snap => { cache[key] = snap.docs.map(d => ({ id:d.id, ...d.data() })); loaded.add(key); refresh(); },
      err  => { console.error("listener error ["+key+"]", err); loaded.add(key); refresh(); });
    listeners.push(unsub);
  };
  sub(collection(db,"medicines"), "medicines");
  sub(collection(db,"inventory"), "inventory");

  if(ME.role === "patient"){
    sub(collection(db,"pharmacies"), "pharmacies");
    sub(query(collection(db,"reservations"), where("patientId","==",ME.uid)), "reservations");
    sub(query(collection(db,"notifications"), where("userId","==",ME.uid)), "notifications");
  } else if(ME.role === "pharmacy"){
    sub(query(collection(db,"pharmacies"), where("ownerUserId","==",ME.uid)), "pharmacies");
    sub(query(collection(db,"reservations"), where("pharmacyOwnerId","==",ME.uid)), "reservations");
    sub(query(collection(db,"bills"), where("ownerUserId","==",ME.uid)), "bills");
    sub(query(collection(db,"notifications"), where("userId","==",ME.uid)), "notifications");
  } else if(ME.role === "admin"){
    sub(collection(db,"users"), "users");
    sub(collection(db,"pharmacies"), "pharmacies");
    sub(collection(db,"reservations"), "reservations");
    sub(collection(db,"bills"), "bills");
    sub(query(collection(db,"notifications"), where("userId","==",ME.uid)), "notifications");
  }
}

/* ============================================================
   SESSION lifecycle (driven by Firebase auth state)
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
  if(user){ await routeSignedIn(user); }
  else {
    ME=null; teardownListeners();
    if(completingLink) renderLoading("Signing you in…");
    else renderAuth();
  }
});

async function routeSignedIn(user){
  let snap;
  try{ snap = await getDoc(doc(db,"users",user.uid)); }
  catch(e){ console.error(e); completingLink=false; renderLoadError(user, e); return; }

  completingLink=false;
  const portal = hashPortal() || storedPortal();
  const adminEmail = isAdminEmail(user.email);
  if(snap.exists()){
    const d=snap.data();
    if(d.role==="admin" && !adminEmail){ renderNotAdmin(user, true); return; }
    if(adminEmail && d.role!=="admin"){ renderAdminUpgrade(user, d); return; }
    if(d.role!=="admin" && portal && d.role && portal!==d.role && ["patient","pharmacy","admin"].includes(d.role)){
      renderPortalMismatch(user, d.role, portal); return;
    }
    if(d.role && PORTALS[d.role] && hashPortal()!==d.role){
      try{ localStorage.setItem(PORTAL_KEY, d.role); }catch(_){}
      window.history.replaceState({}, document.title, window.location.pathname + "#/" + d.role);
    }
    ME = { uid:user.uid, role:d.role, name:d.name||"", email:d.email||user.email||"",
           phone:d.phone||"", address:d.address||"" };
    if(!["patient","pharmacy","admin"].includes(ME.role)){
      ME=null; renderLoadError(user, new Error("Your account has an unknown role.")); return;
    }
    state.view=null; state.searchQuery=""; state.billDraft=[];
    setupListeners();
    renderApp();
  } else if(adminEmail){
    renderProfileSetup(user, "admin");          // the one admin email is always the admin
  } else if(portal==="admin"){
    renderNotAdmin(user);
  } else {
    renderProfileSetup(user, portal);
  }
}

function renderPortalMismatch(user, role, portal){
  const R=PORTALS[role], P=PORTALS[portal];
  $("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
    ${BRAND}
    <div style="font-size:38px; margin:16px 0 6px">${R.ic}</div>
    <h3 class="auth-title">This is a ${R.label} account</h3>
    <p class="auth-sub">You opened the <b>${P.label}</b> sign-in, but <b>${esc(user.email)}</b> is registered as a
      <b>${R.label}</b>. Each account has one role.</p>
    <button class="btn primary big" id="pm-open" style="width:100%">Open my ${R.label} dashboard</button>
    <button class="btn ghost" id="pm-out" style="width:100%; margin-top:8px">Sign out & use another account</button>
  </div></div>`;
  $("pm-open").onclick=()=>{ setPortal(role); renderLoading("Loading…"); routeSignedIn(user); };
  $("pm-out").onclick=logout;
}

function renderAdminUpgrade(user, d){
  $("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
    ${BRAND}
    <div style="font-size:38px; margin:16px 0 6px">🛡️</div>
    <h3 class="auth-title">This is the PharmaFind admin email</h3>
    <p class="auth-sub"><b>${esc(user.email)}</b> was registered earlier as a <b>${esc(ROLE_NAME[d.role]||d.role)}</b>.
      PharmaFind has one admin, and it's this email. Switch this account to admin to manage PharmaFind.</p>
    <div class="err" id="au-up-err"></div>
    <button class="btn primary big" id="au-up" style="width:100%">Switch to admin</button>
    <button class="btn ghost" id="au-up-out" style="width:100%; margin-top:8px">Sign out</button>
  </div></div>`;
  $("au-up-out").onclick=logout;
  $("au-up").onclick=async ()=>{
    const b=$("au-up"); b.disabled=true; b.textContent="Switching…";
    try{
      await updateDoc(doc(db,"users",user.uid), { role:"admin" });
      setPortal("admin"); renderLoading("Loading…"); await routeSignedIn(user);
      toast("You're now the PharmaFind admin.", "good");
    }catch(e){
      console.error(e);
      $("au-up-err").textContent = e.code==="permission-denied"
        ? "The database refused — publish the latest firestore.rules first." : "Couldn't switch. Try again.";
      b.disabled=false; b.textContent="Switch to admin";
    }
  };
}

function renderNotAdmin(user, wasAdmin=false){
  $("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
    ${BRAND}
    <div style="font-size:38px; margin:16px 0 6px">🛡️</div>
    <h3 class="auth-title">${wasAdmin ? "Admin access removed" : "Not an admin account"}</h3>
    <p class="auth-sub">PharmaFind has one admin. <b>${esc(user.email)}</b> ${wasAdmin ? "is no longer that admin" : "isn't the admin"}, so it can't open the admin portal.</p>
    <button class="btn primary big" id="na-out" style="width:100%">Sign out & try another account</button>
    <button class="btn ghost" id="na-pat" style="width:100%; margin-top:8px">Continue as a patient instead</button>
  </div></div>`;
  $("na-out").onclick=logout;
  $("na-pat").onclick=()=>{ setPortal("patient"); renderLoading("Loading…"); routeSignedIn(user); };
}

function renderLoadError(user, e){
  const rulesHint = e && e.code==="permission-denied"
    ? "The database refused access — make sure the latest firestore.rules are published."
    : "Check your internet connection and try again.";
  $("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
    <div class="brand" style="justify-content:center"><span class="mark"><span>✚</span></span> PharmaFind</div>
    <div style="font-size:36px; margin:14px 0 4px">⚠️</div>
    <h3>Couldn't load your account</h3>
    <p class="tag" style="margin-top:8px">${esc(e && e.message && !e.code ? e.message : rulesHint)}</p>
    <button class="btn primary" id="le-retry" style="width:100%">Try again</button>
    <button class="btn ghost" id="le-out" style="width:100%; margin-top:8px">Sign out</button>
  </div></div>`;
  $("le-retry").onclick=()=>{ renderLoading("Loading…"); routeSignedIn(user); };
  $("le-out").onclick=logout;
}

async function logout(){
  state.searchQuery=""; state.billDraft=[]; state.view=null;
  closeModal();
  await signOut(auth);
}

/* ============================================================
   AUTH SCREEN (email-link)
   ============================================================ */
function actionCodeSettings(){
  return { url: window.location.origin + window.location.pathname, handleCodeInApp:true };
}

function renderLoading(msg){
  $("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
    <div class="brand" style="justify-content:center"><span class="mark"><span>✚</span></span> PharmaFind</div>
    <p class="tag" style="margin-top:14px">${esc(msg||"Loading…")}</p></div></div>`;
}

const BRAND = `<div class="brand"><span class="mark"><span>✚</span></span> PharmaFind</div>`;

/* ---------- Portals: separate entry pages for each kind of user ---------- */
const PORTAL_KEY = "pf_portal";
const PORTALS = {
  patient:{ ic:"🧑", label:"Patient", who:"I need medicines",
    desc:"Find medicines in stock near you, reserve and pay online.",
    title:"Patient sign-in", sub:"Sign in or create your patient account with one tap." },
  pharmacy:{ ic:"🏥", label:"Medical shop", who:"I run a medical shop",
    desc:"List your stock, create bills and handle reservations.",
    title:"Medical shop sign-in", sub:"Sign in to your store, or register a new medical shop. New shops go live after the admin approves them." },
  admin:{ ic:"🛡️", label:"Admin", who:"I'm the admin",
    desc:"Approve shops, manage the medicine catalog and all accounts.",
    title:"Admin sign-in", sub:"Only approved admin accounts can sign in here." },
};
const ROLE_NAME = { patient:"Patient", pharmacy:"Medical shop", admin:"Admin" };

function hashPortal(){
  const h=(window.location.hash||"").replace(/^#\/?/,"").toLowerCase();
  return PORTALS[h] ? h : null;
}
function storedPortal(){
  try{ const v=localStorage.getItem(PORTAL_KEY); return PORTALS[v] ? v : null; }catch(_){ return null; }
}
function setPortal(p){
  try{ p ? localStorage.setItem(PORTAL_KEY, p) : localStorage.removeItem(PORTAL_KEY); }catch(_){}
  const url = window.location.pathname + window.location.search + (p ? "#/"+p : "");
  window.history.pushState({}, document.title, url);
}
window.addEventListener("hashchange", ()=>{
  if(!auth.currentUser && !completingLink) renderAuth();
});
window.addEventListener("popstate", ()=>{
  if(!auth.currentUser && !completingLink) renderAuth();
});

function renderPortalChooser(){
  $("root").innerHTML=`
  <div class="auth-wrap">
    <div class="auth-card">
      ${BRAND}
      <p class="tag">Find medicines in stock at pharmacies near you — and reserve them before you go.</p>
      <h3 class="auth-title" style="text-align:center">Welcome! Who are you?</h3>
      <p class="auth-sub" style="text-align:center">Pick one to continue.</p>
      <div class="portal-list">
        ${Object.entries(PORTALS).map(([k,p])=>`
          <button class="portal-card ${k==='admin'?'subtle':''}" data-portal="${k}">
            <span class="pc-ic">${p.ic}</span>
            <span class="pc-body"><b>${p.who}</b><small>${p.desc}</small></span>
            <span class="pc-go">›</span>
          </button>`).join("")}
      </div>
    </div>
  </div>`;
  $("root").querySelectorAll("[data-portal]").forEach(b=>b.onclick=()=>{ setPortal(b.dataset.portal); renderAuth(); });
}

function portalHeader(k){
  const p=PORTALS[k];
  return `<div class="portal-top">
    <button class="back-link" id="au-back">← Back</button>
    <span class="portal-chip">${p.ic} ${p.label}</span>
  </div>`;
}

function stepsHtml(active){
  const steps=["Enter your email","Open the link we email you","You're signed in"];
  return `<ol class="steps">${steps.map((t,i)=>`
    <li class="${i<active?'done':i===active?'now':''}"><span class="num">${i<active?'✓':i+1}</span><span>${t}</span></li>`).join("")}</ol>`;
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function renderAuth(prefill="", showEmail=false){
  const portal=hashPortal();
  if(!portal){ renderPortalChooser(); return; }
  const P=PORTALS[portal];
  $("root").innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      ${portalHeader(portal)}
      ${BRAND}
      <h3 class="auth-title" style="text-align:center; margin-top:14px">${P.title}</h3>
      <p class="auth-sub" style="text-align:center">${P.sub}</p>

      <button class="btn google big" id="au-google" style="width:100%">${GOOGLE_G}<span>Continue with Google</span></button>
      <div class="err" id="au-gerr" style="margin-top:10px"></div>

      <div class="or"><span>or</span></div>

      ${showEmail ? `
      <label class="fld"><span class="lab">Sign in with an email link instead</span>
        <input class="input" id="au-email" type="email" placeholder="you@example.com" autocomplete="email" value="${esc(prefill)}"></label>
      <div class="err" id="au-err"></div>
      <button class="btn" id="au-go" style="width:100%">Email me a sign-in link</button>
      <p class="fine">We'll email you a link — tap it on this device to sign in. No password needed.</p>
      ` : `
      <button class="btn ghost" id="au-showemail" style="width:100%">Use an email link instead</button>`}

      <p class="fine">${portal==="admin" ? "🔒 Admin access is limited to approved emails." : "🔒 We only use your name and email. No password to remember."}</p>
    </div>
  </div>`;
  $("au-back").onclick=()=>{ setPortal(null); renderAuth(); };
  $("au-google").onclick=googleSignIn;
  if(showEmail){
    const emailEl=$("au-email");
    const go=()=>sendLink(emailEl.value.trim());
    $("au-go").onclick=go;
    emailEl.onkeydown=e=>{ if(e.key==="Enter") go(); };
    emailEl.focus();
  } else {
    $("au-showemail").onclick=()=>renderAuth(prefill, true);
  }
}

/* ---------- Google sign-in ---------- */
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt:"select_account" });

async function googleSignIn(){
  const hp=hashPortal(); if(hp){ try{ localStorage.setItem(PORTAL_KEY, hp); }catch(_){} }
  const btn=$("au-google"), err=$("au-gerr");
  if(err) err.textContent="";
  if(btn){ btn.disabled=true; btn.querySelector("span").textContent="Opening Google…"; }
  try{
    if(IS_INSTALLED_APP){
      // inside the APK, a full-page Google sign-in is more reliable than a popup
      renderLoading("Opening Google sign-in…");
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    await signInWithPopup(auth, googleProvider);
    // onAuthStateChanged takes it from here
  }catch(e){
    if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment","auth/web-storage-unsupported"].includes(e.code)){
      try{ renderLoading("Opening Google sign-in…"); await signInWithRedirect(auth, googleProvider); return; }
      catch(e2){ e=e2; renderAuth(); }
    }
    if(!$("au-google")) renderAuth();
    const quiet = ["auth/popup-closed-by-user","auth/cancelled-popup-request","auth/user-cancelled"].includes(e.code);
    if(!quiet) console.error(e);
    const errEl=$("au-gerr"), b=$("au-google");
    if(errEl && !quiet) errEl.textContent=authErrorText(e, "google");
    if(b){ b.disabled=false; b.querySelector("span").textContent="Continue with Google"; }
  }
}

/* finish a redirect-based Google sign-in (used when popups are blocked) */
async function handleGoogleRedirectReturn(){
  try{ await getRedirectResult(auth); }
  catch(e){ console.error(e); toast(authErrorText(e, "google"), "bad"); }
}

function authErrorText(e, method="email"){
  switch(e && e.code){
    case "auth/unauthorized-continue-uri":
    case "auth/unauthorized-domain":
      return `This address (${window.location.hostname}) isn't in Firebase → Authentication → Settings → Authorized domains.`;
    case "auth/operation-not-allowed":
      return method==="google"
        ? "Google sign-in is off. Enable it in Firebase → Authentication → Sign-in method → Google."
        : "Email-link sign-in is off. Enable it in Firebase → Authentication → Sign-in method → Email/Password → Email link.";
    case "auth/account-exists-with-different-credential":
      return "This email already signed in another way. Use the email link option instead.";
    case "auth/internal-error":
      return "Google sign-in failed. Check your connection and try again.";
    case "auth/invalid-email": return "That email address looks invalid.";
    case "auth/quota-exceeded": return "Firebase's daily email limit was reached. Try again tomorrow.";
    case "auth/too-many-requests": return "Too many attempts. Wait a minute and try again.";
    case "auth/network-request-failed": return "No internet connection.";
    default: return method==="google" ? "Google sign-in didn't finish. Please try again." : "Could not send the link. Check the email and try again.";
  }
}

async function sendLink(email, fromResend=false){
  const err=$(fromResend?"ci-err":"au-err"); if(err) err.textContent="";
  if(!email || !/^\S+@\S+\.\S+$/.test(email)){ if(err) err.textContent="Please type a full email address, like name@gmail.com."; return; }
  const btn=$(fromResend?"ci-resend":"au-go"); const label=btn?btn.textContent:"";
  if(btn){ btn.disabled=true; btn.textContent="Sending…"; }
  try{
    await sendSignInLinkToEmail(auth, email, actionCodeSettings());
    try{ localStorage.setItem(EMAIL_KEY, email); const hp=hashPortal(); if(hp) localStorage.setItem(PORTAL_KEY, hp); }catch(_){}
    renderCheckInbox(email);
    if(fromResend) toast("New link sent.", "good");
  }catch(e){
    console.error(e);
    if(err) err.textContent = authErrorText(e);
    if(btn){ btn.disabled=false; btn.textContent=label; }
  }
}

function mailAppLink(email){
  const d=String(email).split("@")[1]?.toLowerCase()||"";
  if(d==="gmail.com"||d==="googlemail.com") return { name:"Gmail", url:"https://mail.google.com/mail/u/0/#search/PharmaFind" };
  if(/^(outlook|hotmail|live|msn)\./.test(d)) return { name:"Outlook", url:"https://outlook.live.com/mail/" };
  if(d.startsWith("yahoo.")) return { name:"Yahoo Mail", url:"https://mail.yahoo.com/" };
  return null;
}

let resendTimer=null;
function renderCheckInbox(email){
  const mail=mailAppLink(email);
  $("root").innerHTML=`
  <div class="auth-wrap">
    <div class="auth-card">
      ${BRAND}
      <div class="inbox-ic">📧</div>
      <h3 class="auth-title" style="text-align:center">Check your email</h3>
      <p class="auth-sub" style="text-align:center">We sent a sign-in link to<br><b class="email-pill">${esc(email)}</b></p>

      ${stepsHtml(1)}

      <div class="hint" style="margin-top:6px">
        <b>Open the email from PharmaFind and tap “Sign in”.</b><br>
        Use <b>this same phone or computer</b> — the link signs you in here.<br>
        Can't find it? Look in <b>Spam</b> or <b>Promotions</b>. It can take a minute.
      </div>

      ${mail?`<a class="btn primary big" style="width:100%; margin-top:16px; text-decoration:none" href="${mail.url}" target="_blank" rel="noopener">Open ${mail.name}</a>`:""}
      <div class="err" id="ci-err" style="margin-top:10px"></div>
      <div class="row" style="margin-top:${mail?'8':'16'}px">
        <button class="btn grow" id="ci-resend" disabled>Resend link</button>
        <button class="btn ghost grow" id="ci-back">Wrong email?</button>
      </div>
    </div>
  </div>`;
  $("ci-back").onclick=()=>{ clearInterval(resendTimer); renderAuth(email, true); };
  const rb=$("ci-resend"); let left=30;
  const tickTxt=()=>{ rb.textContent = left>0 ? `Resend in ${left}s` : "Resend link"; rb.disabled = left>0; };
  tickTxt(); clearInterval(resendTimer);
  resendTimer=setInterval(()=>{ left--; if(!$("ci-resend")){ clearInterval(resendTimer); return; } tickTxt(); if(left<=0) clearInterval(resendTimer); },1000);
  rb.onclick=()=>sendLink(email, true);
}

/* Called at boot: if the current URL is a sign-in link, finish signing in. */
async function handleEmailLinkReturn(){
  if(!isSignInWithEmailLink(auth, window.location.href)) return;
  completingLink=true;
  renderLoading("Signing you in…");
  let email = null;
  try{ email = localStorage.getItem(EMAIL_KEY); }catch(_){}
  if(!email){ email = (window.prompt("Please confirm your email to finish signing in:") || "").trim(); }
  if(!email){
    completingLink=false;
    const sp=storedPortal();
    window.history.replaceState({}, document.title, window.location.pathname + (sp ? "#/"+sp : ""));
    toast("Sign-in cancelled — enter your email to get a new link.", "bad");
    renderAuth(); return;
  }
  try{
    await signInWithEmailLink(auth, email, window.location.href);
    try{ localStorage.removeItem(EMAIL_KEY); }catch(_){}
  }catch(e){
    console.error(e);
    completingLink=false;
    toast(e.code==="auth/invalid-email"
      ? "That email doesn't match the one the link was sent to."
      : "That sign-in link is invalid or expired. Please request a new one.", "bad");
    if(!auth.currentUser) renderAuth();
  }finally{
    const p=storedPortal();
    window.history.replaceState({}, document.title, window.location.pathname + (p ? "#/"+p : ""));
  }
}

/* ---------- First-time profile setup ---------- */
function renderProfileSetup(user, fixedRole=null){
  const forcedAdmin = fixedRole==="admin" || (!fixedRole && isAdminEmail(user.email));
  const lockedRole = forcedAdmin ? "admin" : (fixedRole==="patient"||fixedRole==="pharmacy") ? fixedRole : null;
  let setupLoc = { ...DEFAULT_LOC, set:false };

  $("root").innerHTML=`
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="brand"><span class="mark"><span>✚</span></span> PharmaFind</div>
      <div class="signed-badge"><span>✓ Signed in</span></div>
      <h3 class="auth-title">You're in! One last step</h3>
      <p class="auth-sub">Signed in as <b>${esc(user.email)}</b>. Tell us a little about you — you only do this once.</p>

      <label class="fld"><span class="lab">Your full name</span>
        <input class="input" id="ps-name" placeholder="Your name" maxlength="80" value="${esc(user.displayName||"")}"></label>

      ${forcedAdmin ? `
        <div class="hint" style="margin:0 0 16px"><b>🛡️ Admin account.</b> Your email is on the admin list, so you'll manage the whole network.</div>
      ` : lockedRole ? `
      <div class="hint" style="margin:0 0 16px">Creating a <b>${PORTALS[lockedRole].ic} ${PORTALS[lockedRole].label}</b> account.
        <a href="#" id="ps-switch">Wrong type?</a></div>
      <input type="hidden" id="ps-role" value="${lockedRole}">
      <div id="ps-ph"></div>
      ` : `
      <div class="fld"><span class="lab">How will you use PharmaFind?</span>
        <input type="hidden" id="ps-role" value="patient">
        <div class="role-cards">
          <button type="button" class="role-card active" data-role="patient">
            <span class="rc-ic">🧑</span><b>I'm a patient</b><small>Search medicines, reserve &amp; pay</small></button>
          <button type="button" class="role-card" data-role="pharmacy">
            <span class="rc-ic">🏥</span><b>I run a pharmacy</b><small>List stock, billing, reservations</small></button>
        </div>
      </div>
      <div id="ps-ph"></div>`}

      <div class="err" id="ps-err"></div>
      <button class="btn primary big" id="ps-go" style="width:100%">${lockedRole==="pharmacy" ? "Register my shop" : "Finish & open PharmaFind"}</button>
      <button class="btn ghost" id="ps-cancel" style="width:100%; margin-top:8px">Not you? Sign out</button>
    </div>
  </div>`;

  if(!forcedAdmin){
    const roleSel=$("ps-role"), phBox=$("ps-ph");
    const drawPh=()=>{
      phBox.innerHTML = roleSel.value==="pharmacy" ? `
        <label class="fld"><span class="lab">Pharmacy name</span><input class="input" id="ps-phname" maxlength="100" placeholder="e.g. City Care Pharmacy"></label>
        <label class="fld"><span class="lab">Address / area</span><input class="input" id="ps-phaddr" maxlength="200" placeholder="e.g. Kukatpally, Hyderabad"></label>
        <label class="fld"><span class="lab">Opening hours</span><input class="input" id="ps-phhours" maxlength="60" placeholder="e.g. 9:00 AM – 9:00 PM"></label>
        <div class="fld">
          <span class="lab">Store location</span>
          <div class="row">
            <button class="btn sm" id="ps-loc" type="button">📍 Use my current location</button>
            <span id="ps-locinfo" style="font-size:13px; color:var(--muted)">${setupLoc.set
              ? `Set: ${setupLoc.lat.toFixed(4)}, ${setupLoc.lng.toFixed(4)}`
              : "Not set — Hyderabad centre will be used (change later in Store settings)."}</span>
          </div>
        </div>` : "";
      const lb=$("ps-loc");
      if(lb) lb.onclick=async ()=>{
        lb.disabled=true; lb.textContent="Locating…";
        try{ const p=await getPosition(); setupLoc={ ...p, set:true };
          $("ps-locinfo").textContent=`Set: ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`; }
        catch(e){ toast(e.message, "bad"); }
        lb.disabled=false; lb.textContent="📍 Use my current location";
      };
    };
    const sw=$("ps-switch");
    if(sw) sw.onclick=(e)=>{ e.preventDefault(); setPortal(null); renderProfileSetup(user, null); };
    document.querySelectorAll("[data-role]").forEach(card=>card.onclick=()=>{
      roleSel.value=card.dataset.role;
      document.querySelectorAll("[data-role]").forEach(c=>c.classList.toggle("active", c===card));
      drawPh();
    });
    roleSel.onchange=drawPh; drawPh();
  }

  $("ps-cancel").onclick=logout;
  $("ps-go").onclick=async ()=>{
    const name=$("ps-name").value.trim();
    const err=$("ps-err"); err.textContent="";
    if(!name){ err.textContent="Please enter your name."; return; }
    const role = forcedAdmin ? "admin" : $("ps-role").value;

    const btn=$("ps-go"); btn.disabled=true; btn.textContent="Creating…";
    try{
      const batch=writeBatch(db);
      batch.set(doc(db,"users",user.uid),
        { role, name, email:user.email, phone:"", address:"", createdAt:now() });
      if(role==="pharmacy"){
        const phname=$("ps-phname").value.trim()||name+"'s Pharmacy";
        const addr=$("ps-phaddr").value.trim()||"Hyderabad";
        const hours=$("ps-phhours").value.trim()||"9:00 AM – 9:00 PM";
        batch.set(doc(db,"pharmacies",user.uid),
          { ownerUserId:user.uid, name:phname, address:addr, hours,
            lat:setupLoc.lat, lng:setupLoc.lng, status:"pending", createdAt:now() });
      }
      await batch.commit();
      try{ localStorage.setItem(PORTAL_KEY, role); }catch(_){}
      window.history.replaceState({}, document.title, window.location.pathname + "#/" + role);
      await routeSignedIn(user);
      toast("Account created — welcome!", "good");
    }catch(e){
      console.error(e);
      err.textContent = (e.code==="permission-denied" && role==="admin")
        ? "Admin email mismatch — add this email to adminEmails() in firestore.rules too."
        : e.code==="permission-denied"
        ? "The database refused this — publish the latest firestore.rules."
        : "Could not create your account. Try again.";
      btn.disabled=false; btn.textContent="Finish & open PharmaFind";
    }
  };
}

/* ============================================================
   APP SHELL
   ============================================================ */
const NAV = {
  patient:[
    { v:"search", ic:"🔍", label:"Find medicine" },
    { v:"reservations", ic:"🏷️", label:"My reservations" },
    { v:"profile", ic:"👤", label:"My profile" },
  ],
  pharmacy:[
    { v:"ph-dash", ic:"📊", label:"Dashboard" },
    { v:"ph-inventory", ic:"📦", label:"Inventory" },
    { v:"ph-billing", ic:"🧾", label:"New bill" },
    { v:"ph-reservations", ic:"🏷️", label:"Reservations" },
    { v:"ph-sales", ic:"💰", label:"Sales history" },
    { v:"ph-settings", ic:"⚙️", label:"Store settings" },
  ],
  admin:[
    { v:"ad-dash", ic:"📊", label:"Overview" },
    { v:"ad-accounts", ic:"👥", label:"Accounts" },
    { v:"ad-approvals", ic:"✅", label:"Approvals" },
    { v:"ad-pharmacies", ic:"🏥", label:"Pharmacies" },
    { v:"ad-reservations", ic:"🏷️", label:"Reservations" },
    { v:"ad-medicines", ic:"💊", label:"Medicine catalog" },
  ],
};
const DEFAULT_VIEW = { patient:"search", pharmacy:"ph-dash", admin:"ad-dash" };

function renderApp(){
  const user=currentUser();
  if(!user){ renderAuth(); return; }
  if(!state.view || !NAV[user.role].some(n=>n.v===state.view)) state.view=DEFAULT_VIEW[user.role];

  const roleLabel={ patient:"Patient", pharmacy:"Pharmacy", admin:"Admin" }[user.role];
  const nav=NAV[user.role];

  const navItems=nav.map(n=>{
    let count="";
    if(user.role==="admin" && n.v==="ad-approvals"){
      const p=cache.pharmacies.filter(x=>x.status==="pending").length;
      if(p) count=`<span class="count">${p}</span>`;
    }
    if(n.v==="ph-reservations" || n.v==="ad-reservations"){
      const ph = user.role==="pharmacy" ? myPharmacy() : null;
      const c = cache.reservations.filter(r=>r.status==="pending" && (user.role==="admin" || (ph && r.pharmacyId===ph.id))).length;
      if(c) count=`<span class="count">${c}</span>`;
    }
    return `<button class="navitem ${state.view===n.v?'active':''}" data-view="${n.v}">
      <span class="ic">${n.ic}</span> ${n.label} ${count}</button>`;
  }).join("");

  const unread=unreadCount(user.uid);

  $("root").innerHTML=`
    <div class="topbar">
      <div class="brand"><span class="mark"><span>✚</span></span> PharmaFind</div>
      <span class="role-chip">${roleLabel}</span>
      <div class="spacer"></div>
      <button class="icon-btn" id="btn-notif" title="Notifications">🔔${unread?`<span class="badge-dot">${unread}</span>`:''}</button>
      <div class="who"><b>${esc(user.name)}</b><span class="sub">${esc(user.email)}</span></div>
      <button class="icon-btn" id="btn-logout" title="Sign out">⏻</button>
    </div>
    <div class="app">
      <aside class="side">
        <div class="navlabel">Menu</div>
        ${navItems}
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  $("root").querySelectorAll("[data-view]").forEach(b=>{
    b.onclick=()=>{ state.view=b.dataset.view; renderApp(); };
  });
  $("btn-logout").onclick=logout;
  $("btn-notif").onclick=openNotifications;

  renderView();
}

function renderView(){
  const map={
    search:viewSearch, reservations:viewPatientReservations, profile:viewPatientProfile,
    "ph-dash":viewPhDash, "ph-inventory":viewPhInventory, "ph-billing":viewPhBilling,
    "ph-reservations":viewPhReservations, "ph-sales":viewPhSales, "ph-settings":viewPhSettings,
    "ad-dash":viewAdDash, "ad-accounts":viewAdAccounts, "ad-approvals":viewAdApprovals,
    "ad-pharmacies":viewAdPharmacies, "ad-reservations":viewAdReservations, "ad-medicines":viewAdMedicines,
  };
  (map[state.view]||map[DEFAULT_VIEW[ME.role]])();
}

function loadingBlock(msg){
  return `<div class="empty"><div class="big">⏳</div><h3>${esc(msg||"Loading…")}</h3></div>`;
}

/* ---------- Notifications panel ---------- */
function openNotifications(){
  const u=currentUser();
  const mine=cache.notifications.filter(n=>n.userId===u.uid).sort((a,b)=>b.createdAt-a.createdAt);
  const body = mine.length ? mine.map(n=>`
    <div class="notif ${n.read?'read':''}">
      <div class="nd"></div>
      <div><div class="nt">${esc(n.text)}</div><div class="nm">${timeAgo(n.createdAt)}</div></div>
    </div>`).join("")
    : `<div class="empty"><div class="big">🔔</div><h3>No notifications</h3><p>Updates about your account show up here.</p></div>`;
  const anyUnread = mine.some(n=>!n.read);
  openModal(`
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <h3>Notifications</h3>
      ${anyUnread?`<button class="btn sm ghost" id="mark-read">Mark all read</button>`:""}
    </div>
    <div style="max-height:60vh; overflow:auto">${body}</div>
    <button class="btn" style="width:100%; margin-top:16px" onclick="closeModal()">Close</button>`);
  const mr=$("mark-read");
  if(mr) mr.onclick=async ()=>{
    const unread=mine.filter(n=>!n.read);
    closeModal();
    await Promise.all(unread.map(n=>updateDoc(doc(db,"notifications",n.id), { read:true }).catch(()=>{})));
  };
}

/* ---------- Shared reservation status helpers ---------- */
const RES_PILL = { pending:"pending", fulfilled:"approved", cancelled:"suspended" };
const RES_LABEL = { pending:"Waiting for pickup", fulfilled:"Completed", cancelled:"Cancelled" };
const resLabel = (st) => RES_LABEL[st] || st;

/* tabs: Pending / Completed / Cancelled / All */
function resTabs(list, key){
  const counts={ pending:0, fulfilled:0, cancelled:0 };
  list.forEach(r=>{ if(counts[r.status]!=null) counts[r.status]++; });
  const sel = state[key] || (counts.pending ? "pending" : "all");   // only a user's click is remembered
  const tabs=[["pending","⏳ Waiting"],["fulfilled","✅ Completed"],["cancelled","✖ Cancelled"],["all","All"]];
  const html=`<div class="tabs">${tabs.map(([k,l])=>`
    <button class="tab ${sel===k?'active':''}" data-restab="${k}">${l}
      <span class="tab-n">${k==="all"?list.length:counts[k]}</span></button>`).join("")}</div>`;
  const shown = sel==="all" ? list : list.filter(r=>r.status===sel);
  return { html, shown };
}
function bindResTabs(key, rerender){
  $("main").querySelectorAll("[data-restab]").forEach(b=>b.onclick=()=>{ state[key]=b.dataset.restab; rerender(); });
}

/* Cancel a pending reservation and put its stock back (pharmacy or admin). */
async function cancelReservation(resId){
  const resRef=doc(db,"reservations",resId);
  let info=null;
  await runTransaction(db, async (tx)=>{
    const rs=await tx.get(resRef);
    if(!rs.exists()) throw new Error("Reservation not found.");
    const r=rs.data();
    if(r.status!=="pending") throw new Error("This reservation is already "+r.status+".");
    let invRef=null, invSnap=null;
    if(r.inventoryId){ invRef=doc(db,"inventory",r.inventoryId); invSnap=await tx.get(invRef); }
    tx.update(resRef, { status:"cancelled", updatedAt:now() });
    const refunded = !!(invSnap && invSnap.exists());
    if(refunded) tx.update(invRef, { quantity: invSnap.data().quantity + r.qty });
    info={ ...r, id:resId, refunded };
  });
  return info;
}

async function fulfillReservation(r){
  await updateDoc(doc(db,"reservations",r.id), { status:"fulfilled", updatedAt:now() });
  notify(r.patientId, `Your order of ${r.qty} × ${getMed(r.medicineId)?.name||'a medicine'} is completed. Thank you!`, r.id);
}

function bindReservationActions(){
  $("main").querySelectorAll("[data-fulfill]").forEach(b=>b.onclick=async ()=>{
    const r=cache.reservations.find(x=>x.id===b.dataset.fulfill); if(!r) return;
    b.disabled=true;
    try{ await fulfillReservation(r); toast("Marked as completed — patient notified.", "good"); }
    catch(e){ console.error(e); toast("Could not update reservation.", "bad"); b.disabled=false; }
  });
  $("main").querySelectorAll("[data-cancel]").forEach(b=>b.onclick=async ()=>{
    const r=cache.reservations.find(x=>x.id===b.dataset.cancel); if(!r) return;
    if(!confirm(`Cancel this reservation? ${r.qty} unit(s) go back into stock.`)) return;
    b.disabled=true;
    try{
      const info=await cancelReservation(r.id);
      notify(r.patientId, `Your reservation for ${getMed(r.medicineId)?.name||'a medicine'} was cancelled. Your payment of ${money(r.amountPaid)} will be refunded.`, r.id);
      toast(info.refunded ? "Cancelled — stock returned." : "Cancelled (item no longer listed, no stock to return).");
    }catch(e){ console.error(e); toast(e.message||"Could not cancel.", "bad"); b.disabled=false; }
  });
}

function reservationRows(list, { showPharmacy=false, showActions=false }={}){
  return list.map(r=>{
    const m=getMed(r.medicineId), ph=getPh(r.pharmacyId);
    const paid = r.paid ? `<span class="pill ok">${money(r.amountPaid)}</span>` : `<span class="pill neutral">—</span>`;
    const actions = showActions && r.status==="pending" ? `
      <button class="btn sm primary" data-fulfill="${r.id}">✓ Mark as completed</button>
      <button class="btn sm danger" data-cancel="${r.id}">Cancel</button>`
      : r.status==="fulfilled" ? `<span class="done-note">✓ Handed over${r.updatedAt?` · ${timeAgo(r.updatedAt)}`:""}</span>`
      : r.status==="cancelled" ? `<span class="done-note muted">Stock returned${r.updatedAt?` · ${timeAgo(r.updatedAt)}`:""}</span>` : "—";
    return `<tr>
      <td><b>${esc(m?m.name:'—')}</b></td>
      ${showPharmacy?`<td>${esc(ph?ph.name:'—')}</td>`:""}
      <td>${esc(r.patientName||'Unknown')}</td>
      <td>${r.qty}</td>
      <td>${paid}</td>
      <td><span class="pill ${RES_PILL[r.status]||'neutral'}">${esc(resLabel(r.status))}</span></td>
      <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
      ${showActions?`<td style="text-align:right; white-space:nowrap">${actions}</td>`:""}</tr>`;
  }).join("");
}

/* ============================================================
   PATIENT VIEWS
   ============================================================ */
function viewSearch(){
  const q=state.searchQuery.trim().toLowerCase();
  const ready = loaded.has("medicines") && loaded.has("inventory") && loaded.has("pharmacies");
  let resultsHtml="";
  if(!q){
    resultsHtml=`<div class="empty"><div class="big">💊</div>
      <h3>Search for a medicine</h3>
      <p>Type a brand or generic name — e.g. <b>Dolo</b>, <b>Paracetamol</b>, <b>Azithromycin</b>.</p></div>`;
  } else if(!ready){
    resultsHtml=loadingBlock("Loading live stock…");
  } else {
    const matchMeds=cache.medicines.filter(m =>
      (m.name||"").toLowerCase().includes(q) || (m.generic||"").toLowerCase().includes(q));
    const rows=[];
    matchMeds.forEach(m=>{
      cache.inventory.filter(i=>i.medicineId===m.id).forEach(i=>{
        const ph=getPh(i.pharmacyId);
        if(!ph || ph.status!=="approved") return;
        rows.push({ med:m, inv:i, ph, dist:distanceKm(ph.lat, ph.lng) });
      });
    });
    rows.sort((a,b)=>{
      const ia=a.inv.quantity>0?0:1, ib=b.inv.quantity>0?0:1;
      if(ia!==ib) return ia-ib;
      return (a.dist??Infinity) - (b.dist??Infinity);
    });
    if(!rows.length){
      resultsHtml=`<div class="empty"><div class="big">😕</div>
        <h3>No pharmacy nearby has "${esc(state.searchQuery)}"</h3>
        <p>Try another name, or check back later — stock updates as pharmacies bill and restock.</p></div>`;
    } else {
      resultsHtml = rows.map(r=>{
        const ss=stockState(r.inv.quantity);
        const canReserve = r.inv.quantity>0;
        return `<div class="result">
          <div class="ph-ic">🏥</div>
          <div class="body">
            <div class="name">${esc(r.ph.name)}</div>
            <div style="font-size:14px; margin-top:2px"><b>${esc(r.med.name)}</b> · <span style="color:var(--muted)">${esc(r.med.generic)}</span></div>
            <div class="meta">
              <span>📍 ${r.dist!=null?r.dist.toFixed(1)+' km · ':''}${esc(r.ph.address)}</span>
              <span>🕒 ${esc(r.ph.hours)}</span>
            </div>
          </div>
          <div class="right">
            <div class="price">${money(r.inv.price)}</div>
            <span class="pill ${ss.key}">${ss.label}${r.inv.quantity>0?` · ${r.inv.quantity}`:''}</span>
            <button class="btn ${canReserve?'primary':''} sm" data-reserve="${r.inv.id}" ${canReserve?'':'disabled'}>
              ${canReserve?'Reserve & pay':'Unavailable'}</button>
          </div>
        </div>`;
      }).join("");
    }
  }

  const locText = state.loc.source==="gps"
    ? "Distances from your current location."
    : "Distances from Hyderabad city centre — share your location for accurate results.";

  $("main").innerHTML=`
    <div class="page-head"><h2>Find medicine</h2>
      <p>Live stock from approved pharmacies. ${locText}</p></div>
    <div class="card" style="padding:14px; margin-bottom:18px">
      <div class="row">
        <input class="input grow" id="search-in" placeholder="Search a medicine — name or salt…" value="${esc(state.searchQuery)}">
        <button class="btn primary" id="search-go">Search</button>
        <button class="btn" id="search-loc" title="Use my location">📍 ${state.loc.source==="gps"?"Update location":"Use my location"}</button>
      </div>
    </div>
    <div id="search-results">${resultsHtml}</div>`;

  const inEl=$("search-in");
  const run=()=>{ state.searchQuery=inEl.value; viewSearch(); };
  $("search-go").onclick=run;
  $("search-loc").onclick=useMyLocation;
  inEl.onkeydown=e=>{ if(e.key==="Enter") run(); };
  if(q){ inEl.focus(); try{ inEl.setSelectionRange(inEl.value.length, inEl.value.length); }catch(_){} }
  $("main").querySelectorAll("[data-reserve]").forEach(b=>{ b.onclick=()=>reserveMedicine(b.dataset.reserve); });
}

/* Step 1 of reserve: choose quantity */
function reserveMedicine(invId){
  const inv=cache.inventory.find(i=>i.id===invId);
  const med=inv && getMed(inv.medicineId), ph=inv && getPh(inv.pharmacyId);
  if(!inv || inv.quantity<=0 || !med || !ph || ph.status!=="approved"){
    toast("That item just became unavailable.", "bad"); viewSearch(); return;
  }

  openModal(`
    <h3>Reserve ${esc(med.name)}</h3>
    <p class="sub">at ${esc(ph.name)} · ${money(inv.price)} each</p>
    <label class="fld"><span class="lab">Quantity (max ${inv.quantity})</span>
      <input class="input" id="res-qty" type="number" min="1" max="${inv.quantity}" step="1" value="1"></label>
    <div class="cart-total"><span>To pay</span><span class="t" id="res-total">${money(inv.price)}</span></div>
    <div class="err" id="res-err" style="margin-top:8px"></div>
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="res-pay">Continue to payment</button>
    </div>`);

  const qtyEl=$("res-qty");
  const recalc=()=>{ const q=Math.max(1, parseInt(qtyEl.value,10)||1); $("res-total").textContent=money(round2(inv.price*q)); };
  qtyEl.oninput=recalc;

  $("res-pay").onclick=()=>{
    const raw=qtyEl.value.trim(), qty=Number(raw);
    if(!Number.isInteger(qty) || qty<1){ $("res-err").textContent="Enter a whole number of at least 1."; return; }
    if(qty>inv.quantity){ $("res-err").textContent=`Only ${inv.quantity} in stock.`; return; }
    openPayment(inv, med, ph, qty);
  };
}

/* The real work: hold the stock + create the reservation atomically. */
async function placeReservation(invId, qty, expectedPrice, paymentRef){
  const invRef=doc(db,"inventory",invId);
  const resRef=doc(collection(db,"reservations"));
  let out=null;
  await runTransaction(db, async (tx)=>{
    const s=await tx.get(invRef);
    if(!s.exists()) throw new Error("This item is no longer listed.");
    const d=s.data();
    if(d.price!==expectedPrice) throw new Error("The price just changed — please check and try again.");
    if(d.quantity<qty) throw new Error(d.quantity>0 ? `Only ${d.quantity} left now.` : "It just went out of stock.");
    const amountPaid=d.price*qty;
    tx.update(invRef, { quantity:d.quantity-qty, lastHoldId:resRef.id, lastHoldQty:qty });
    tx.set(resRef, {
      patientId:ME.uid, patientName:ME.name,
      pharmacyId:d.pharmacyId, pharmacyOwnerId:d.ownerUserId,
      inventoryId:invId, medicineId:d.medicineId,
      qty, status:"pending",
      paid:true, amountPaid, paymentRef, paymentMethod:"mock-card",
      createdAt:now(),
    });
    out={ id:resRef.id, amountPaid, ownerUserId:d.ownerUserId };
  });
  return out;
}

/* Step 2 of reserve: MOCK payment (no real money changes hands) */
function openPayment(inv, med, ph, qty){
  const total = round2(inv.price * qty);
  openModal(`
    <h3>Payment</h3>
    <p class="sub">${qty} × ${esc(med.name)} at ${esc(ph.name)}</p>
    <div class="hint" style="margin:0 0 16px">🧪 <b>Demo payment</b> — this is a mock screen. No real card is charged. Type any numbers.</div>

    <label class="fld"><span class="lab">Card number</span>
      <input class="input" id="pay-card" inputmode="numeric" placeholder="4111 1111 1111 1111" maxlength="19"></label>
    <div class="row">
      <label class="fld grow"><span class="lab">Expiry (MM/YY)</span>
        <input class="input" id="pay-exp" inputmode="numeric" placeholder="12/28" maxlength="5"></label>
      <label class="fld grow"><span class="lab">CVV</span>
        <input class="input" id="pay-cvv" inputmode="numeric" placeholder="123" maxlength="3"></label>
    </div>
    <label class="fld"><span class="lab">Name on card</span>
      <input class="input" id="pay-name" value="${esc(ME.name||'')}"></label>

    <div class="cart-total"><span>Amount</span><span class="t">${money(total)}</span></div>
    <div class="err" id="pay-err" style="margin-top:8px"></div>
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn money" id="pay-go">Pay ${money(total)}</button>
    </div>`);

  const cardEl=$("pay-card");
  cardEl.oninput=()=>{ const v=cardEl.value.replace(/\D/g,"").slice(0,16); cardEl.value=v.replace(/(.{4})/g,"$1 ").trim(); };
  const expEl=$("pay-exp");
  expEl.oninput=()=>{ let v=expEl.value.replace(/\D/g,"").slice(0,4); if(v.length>=3) v=v.slice(0,2)+"/"+v.slice(2); expEl.value=v; };
  const cvvEl=$("pay-cvv");
  cvvEl.oninput=()=>{ cvvEl.value=cvvEl.value.replace(/\D/g,"").slice(0,3); };

  $("pay-go").onclick=async ()=>{
    const card=cardEl.value.replace(/\s/g,""); const cvv=cvvEl.value.trim(); const exp=expEl.value.trim();
    const err=$("pay-err"); err.textContent="";
    if(card.length<12){ err.textContent="Enter a card number (any 12–16 digits)."; return; }
    const m=/^(\d{2})\/(\d{2})$/.exec(exp);
    if(!m || +m[1]<1 || +m[1]>12){ err.textContent="Enter expiry as MM/YY (month 01–12)."; return; }
    if(cvv.length<3){ err.textContent="Enter the 3-digit CVV."; return; }
    if(!$("pay-name").value.trim()){ err.textContent="Enter the name on the card."; return; }

    const btn=$("pay-go"); btn.disabled=true; btn.textContent="Processing…";
    await new Promise(r=>setTimeout(r,900));   // pretend to talk to a gateway

    const paymentRef = "PAY-" + Math.random().toString(36).slice(2,8).toUpperCase();
    try{
      const res=await placeReservation(inv.id, qty, inv.price, paymentRef);
      notify(res.ownerUserId, `New PAID reservation: ${qty} × ${med.name} — ${ME.name} (${money(res.amountPaid)})`, res.id);
      showPaymentReceipt({ paymentRef, total:res.amountPaid, med, ph, qty });
    }catch(e){
      console.error(e);
      err.innerHTML = e.code==="permission-denied"
        ? `<b>The database refused this reservation.</b> This usually means the latest <code>firestore.rules</code> haven't been published in the Firebase console yet (or the store was just suspended). You were not charged.`
        : esc(e.message||"Reservation failed.") + " You were not charged.";
      btn.disabled=false; btn.textContent="Pay "+money(total);
    }
  };
}

function showPaymentReceipt({ paymentRef, total, med, ph, qty }){
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:38px">✅</div>
      <h3>Payment successful</h3>
      <p class="sub">Ref ${esc(paymentRef)}</p>
    </div>
    <div class="card" style="box-shadow:none; background:var(--surface-2)">
      <div class="row" style="justify-content:space-between"><span style="color:var(--muted)">Medicine</span><b>${esc(med.name)} × ${qty}</b></div>
      <div class="row" style="justify-content:space-between; margin-top:8px"><span style="color:var(--muted)">Pharmacy</span><b>${esc(ph.name)}</b></div>
      <div class="row" style="justify-content:space-between; margin-top:8px"><span style="color:var(--muted)">Paid</span><b style="color:var(--money)">${money(total)}</b></div>
    </div>
    <p style="font-size:13px; color:var(--muted); margin:14px 0 0">The stock is held for you and the pharmacy has been notified. Collect it at the counter.</p>
    <button class="btn primary" style="width:100%; margin-top:14px" id="rc-done">Done</button>`);
  $("rc-done").onclick=()=>{ closeModal(); toast("Reservation placed & paid.", "good"); };
}

function viewPatientReservations(){
  const u=currentUser();
  const mine=cache.reservations.filter(r=>r.patientId===u.uid).sort((a,b)=>b.createdAt-a.createdAt);
  let body;
  if(!loaded.has("reservations")) body=loadingBlock();
  else if(mine.length){
    body=`<div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Qty</th><th>Paid</th><th>Status</th><th>When</th></tr></thead>
      <tbody>${mine.map(r=>{
        const med=getMed(r.medicineId), ph=getPh(r.pharmacyId);
        const paid = r.paid ? `<span class="pill ok">${money(r.amountPaid)}</span>` : `<span class="pill neutral">—</span>`;
        return `<tr>
          <td><b>${esc(med?med.name:'—')}</b></td>
          <td>${esc(ph?ph.name:'—')}</td>
          <td>${r.qty}</td>
          <td>${paid}${r.status==="cancelled"&&r.paid?' <span class="pill neutral">refund due</span>':''}</td>
          <td><span class="pill ${RES_PILL[r.status]||'neutral'}">${esc(r.status==="pending"?"Ready — collect at store":resLabel(r.status))}</span></td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`;
  } else {
    body=`<div class="empty"><div class="big">🏷️</div><h3>No reservations yet</h3>
      <p>Reserve a medicine from the search page to hold it for pickup.</p></div>`;
  }
  $("main").innerHTML=`<div class="page-head"><h2>My reservations</h2>
    <p>Medicines you've paid for and the pharmacy is holding for you.</p></div>${body}`;
}

/* ---------- Patient: edit own details ---------- */
function viewPatientProfile(){
  const u=currentUser();
  $("main").innerHTML=`
    <div class="page-head"><h2>My profile</h2><p>Update your personal details.</p></div>
    <div class="card" style="max-width:520px">
      <label class="fld"><span class="lab">Email (sign-in ID — can't change)</span>
        <input class="input" value="${esc(u.email)}" disabled></label>
      <label class="fld"><span class="lab">Full name</span>
        <input class="input" id="pf-name" maxlength="80" value="${esc(u.name||'')}"></label>
      <label class="fld"><span class="lab">Phone number</span>
        <input class="input" id="pf-phone" maxlength="30" value="${esc(u.phone||'')}" placeholder="e.g. +91 90000 00000"></label>
      <label class="fld"><span class="lab">Address</span>
        <input class="input" id="pf-addr" maxlength="200" value="${esc(u.address||'')}" placeholder="Your address / area"></label>
      <div class="err" id="pf-err"></div>
      <button class="btn primary" id="pf-save">Save changes</button>
    </div>`;
  $("pf-save").onclick=async ()=>{
    const name=$("pf-name").value.trim();
    $("pf-err").textContent="";
    if(!name){ $("pf-err").textContent="Name can't be empty."; return; }
    const phone=$("pf-phone").value.trim(), address=$("pf-addr").value.trim();
    if(phone && !/^[+\d][\d\s-]{5,}$/.test(phone)){ $("pf-err").textContent="Enter a valid phone number."; return; }
    const btn=$("pf-save"); btn.disabled=true;
    try{
      await updateDoc(doc(db,"users",u.uid), { name, phone, address });
      ME.name=name; ME.phone=phone; ME.address=address;
      toast("Profile updated.", "good");
      renderApp();
    }catch(e){ console.error(e); $("pf-err").textContent="Could not save. Try again."; btn.disabled=false; }
  };
}

/* ============================================================
   PHARMACY VIEWS
   ============================================================ */
function pendingGate(allowSuspended=false){
  if(!loaded.has("pharmacies")){ $("main").innerHTML=loadingBlock("Loading your store…"); return true; }
  const ph=myPharmacy();
  if(ph && ph.status==="approved") return false;
  if(ph && ph.status==="suspended" && allowSuspended) return false;
  if(!ph){
    $("main").innerHTML=`<div class="empty" style="margin-top:40px"><div class="big">🏥</div>
      <h3>No store found</h3><p style="max-width:420px; margin:0 auto">Your account has no pharmacy record. Ask the admin to check your account.</p></div>`;
    return true;
  }
  const suspended = ph.status==="suspended";
  const msg = suspended
    ? "Your store has been suspended by the admin. You can still handle existing reservations from the Reservations page."
    : "Your store is waiting for admin approval. You'll be able to manage inventory and billing once it's approved.";
  $("main").innerHTML=`<div class="empty" style="margin-top:40px">
    <div class="big">${suspended?"⛔":"⏳"}</div>
    <h3>${suspended?"Store suspended":"Awaiting approval"}</h3>
    <p style="max-width:420px; margin:0 auto">${msg}</p>
    <p style="margin-top:14px"><span class="pill ${suspended?'suspended':'pending'}">${esc(ph.status)}</span></p>
  </div>`;
  return true;
}

function viewPhDash(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id);
  const low=inv.filter(i=>i.quantity>0 && i.quantity<=LOW_STOCK).length;
  const outc=inv.filter(i=>i.quantity<=0).length;
  const myBills=cache.bills.filter(b=>b.pharmacyId===ph.id);
  const startToday=new Date(); startToday.setHours(0,0,0,0);
  const today=myBills.filter(b=>b.createdAt>=startToday.getTime());
  const myRes=cache.reservations.filter(r=>r.pharmacyId===ph.id);
  const revenue=myBills.reduce((s,b)=>s+(b.total||0),0) + onlineRevenue(myRes);
  const pendingRes=myRes.filter(r=>r.status==="pending").length;

  $("main").innerHTML=`
    <div class="page-head"><h2>${esc(ph.name)}</h2><p>${esc(ph.address)} · ${esc(ph.hours)}</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${inv.length}</div><div class="l">Medicines listed</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${low}</div><div class="l">Low stock (≤${LOW_STOCK})</div></div>
      <div class="stat"><div class="n" style="color:var(--out)">${outc}</div><div class="l">Out of stock</div></div>
      <div class="stat"><div class="n">${today.length}</div><div class="l">Bills today</div></div>
      <div class="stat money"><div class="n">${money(revenue)}</div><div class="l">Total revenue (bills + online)</div></div>
      <div class="stat"><div class="n">${pendingRes}</div><div class="l">Pending reservations</div></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between; margin-bottom:6px"><h3>Quick actions</h3></div>
      <div class="row">
        <button class="btn primary" data-go="ph-billing">🧾 Create a bill</button>
        <button class="btn" data-go="ph-inventory">📦 Update inventory</button>
        <button class="btn" data-go="ph-reservations">🏷️ View reservations</button>
      </div>
    </div>`;
  $("main").querySelectorAll("[data-go]").forEach(b=> b.onclick=()=>{ state.view=b.dataset.go; renderApp(); });
}

function viewPhInventory(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id)
    .sort((a,b)=>(getMed(a.medicineId)?.name||"").localeCompare(getMed(b.medicineId)?.name||""));
  const body = inv.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Salt / generic</th><th>Price</th><th>Quantity</th><th>Status</th><th></th></tr></thead>
      <tbody>${inv.map(i=>{
        const m=getMed(i.medicineId), ss=stockState(i.quantity);
        return `<tr>
          <td><b>${esc(m?m.name:'—')}</b></td>
          <td style="color:var(--muted)">${esc(m?m.generic:'')}</td>
          <td>${money(i.price)}</td>
          <td>${i.quantity}</td>
          <td><span class="pill ${ss.key}">${ss.label}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn sm ghost" data-edit-inv="${i.id}">Edit</button>
            <button class="btn sm danger" data-del-inv="${i.id}">Remove</button>
          </td></tr>`;
      }).join("")}</tbody>
    </table></div>` :
    `<div class="empty"><div class="big">📦</div><h3>No medicines listed yet</h3>
      <p>Add your first medicine so patients can find it.</p></div>`;
  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Inventory</h2><p>Stock patients see when they search. Reserved units are already deducted.</p></div>
      <div class="row">
        <button class="btn" id="import-inv">⬆ Import CSV / Excel</button>
        <button class="btn primary" id="add-inv">＋ Add medicine</button>
      </div>
    </div>${body}`;
  $("add-inv").onclick=()=>editInventory(null);
  $("import-inv").onclick=openStockImport;
  $("main").querySelectorAll("[data-edit-inv]").forEach(b=> b.onclick=()=>editInventory(b.dataset.editInv));
  $("main").querySelectorAll("[data-del-inv]").forEach(b=> b.onclick=async ()=>{
    const i=cache.inventory.find(x=>x.id===b.dataset.delInv); if(!i) return;
    const m=getMed(i.medicineId);
    const pend=cache.reservations.filter(r=>r.inventoryId===i.id && r.status==="pending").length;
    const warn = pend ? `\n\n⚠️ ${pend} pending reservation(s) are for this item. You can still fulfil them, but cancelling them won't return stock.` : "";
    if(confirm(`Remove ${m?m.name:'this medicine'} from your inventory?${warn}`)){
      try{ await deleteDoc(doc(db,"inventory",i.id)); toast("Removed from inventory"); }
      catch(e){ console.error(e); toast("Could not remove item.", "bad"); }
    }
  });
}

/* ============================================================
   BULK STOCK IMPORT  (CSV / Excel)
   ============================================================ */
const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const IMPORT_MAX_ROWS = 2000;
const COL_ALIASES = {
  name:     ["name","medicine","medicine name","medicinename","item","item name","product","product name","brand","drug","drug name"],
  quantity: ["quantity","qty","stock","units","count","available","quantity available","qty available"],
  price:    ["price","mrp","rate","unit price","price per unit","selling price","sp","cost","amount"],
  generic:  ["generic","salt","composition","generic name","salt name","molecule"],
  mfr:      ["manufacturer","mfr","company","brand owner","maker","mfg","manufactured by"],
};

const nameKey = (n) => String(n||"").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,100);

function parseCSV(text){
  text=String(text).replace(/^﻿/,"");
  const firstLine=text.split(/\r?\n/).find(l=>l.trim())||"";
  const counts={",":0,";":0,"\t":0};
  let q=false; for(const ch of firstLine){ if(ch==='"') q=!q; else if(!q && ch in counts) counts[ch]++; }
  const delim=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][1]>0 ? Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0] : ",";
  const rows=[]; let row=[], cell="", inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQ){
      if(c==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else inQ=false; }
      else cell+=c;
    } else if(c==='"') inQ=true;
    else if(c===delim){ row.push(cell); cell=""; }
    else if(c==="\n"||c==="\r"){ if(c==="\r"&&text[i+1]==="\n") i++; row.push(cell); rows.push(row); row=[]; cell=""; }
    else cell+=c;
  }
  if(cell!==""||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(c=>String(c).trim()!==""));
}

function readFileAs(file, kind){
  if(kind==="text" && typeof file.text==="function") return file.text();
  if(kind==="buffer" && typeof file.arrayBuffer==="function") return file.arrayBuffer();
  return new Promise((resolve, reject)=>{
    const fr=new FileReader();
    fr.onload=()=>resolve(fr.result);
    fr.onerror=()=>reject(new Error("Couldn't read that file."));
    kind==="text" ? fr.readAsText(file) : fr.readAsArrayBuffer(file);
  });
}

async function readSheetRows(file){
  const ext=(file.name.split(".").pop()||"").toLowerCase();
  if(ext==="csv"||ext==="txt"||file.type==="text/csv") return parseCSV(await readFileAs(file, "text"));
  if(ext==="xlsx"||ext==="xls"||ext==="ods"){
    let XLSX;
    try{ XLSX=await import(SHEETJS_URL); }
    catch(e){ throw new Error("Couldn't load the Excel reader (check your internet). You can also save the sheet as CSV and import that."); }
    const wb=XLSX.read(new Uint8Array(await readFileAs(file, "buffer")), { type:"array" });
    const ws=wb.Sheets[wb.SheetNames[0]];
    if(!ws) throw new Error("The workbook has no sheets.");
    return XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:"" })
      .filter(r=>r.some(c=>String(c).trim()!==""));
  }
  throw new Error("Please choose a .csv, .xlsx or .xls file.");
}

function mapColumns(rows){
  const norm=(h)=>String(h||"").toLowerCase().replace(/[_\-.()₹]/g," ").replace(/\s+/g," ").trim();
  for(let r=0; r<Math.min(rows.length,5); r++){
    const hdr=rows[r].map(norm); const map={};
    for(const [key,aliases] of Object.entries(COL_ALIASES)){
      const idx=hdr.findIndex(h=>aliases.includes(h));
      if(idx>=0) map[key]=idx;
    }
    if(map.name!=null && (map.quantity!=null || map.price!=null)) return { map, start:r+1, guessed:false };
  }
  // no header row: assume name, quantity, price, generic, manufacturer
  return { map:{ name:0, quantity:1, price:2, generic:3, mfr:4 }, start:0, guessed:true };
}

function toNumber(v){
  if(typeof v==="number") return v;
  const t=String(v??"").replace(/[₹,\s]/g,"").replace(/^rs\.?/i,"");
  if(t==="") return NaN;
  return Number(t);
}

function buildImportPlan(rows, ph){
  const { map, start, guessed } = mapColumns(rows);
  const catalogByKey={};
  cache.medicines.forEach(m=>{ catalogByKey[nameKey(m.name)]=m; });
  const invByMed={};
  cache.inventory.filter(i=>i.pharmacyId===ph.id).forEach(i=>{ invByMed[i.medicineId]=i; });
  const seen=new Set(); const plan=[];
  const body=rows.slice(start, start+IMPORT_MAX_ROWS);
  body.forEach((r, idx)=>{
    const line=start+idx+1;
    const name=String(r[map.name]??"").trim();
    const qRaw=map.quantity!=null ? r[map.quantity] : "";
    const pRaw=map.price!=null ? r[map.price] : "";
    const generic=map.generic!=null ? String(r[map.generic]??"").trim() : "";
    const mfr=map.mfr!=null ? String(r[map.mfr]??"").trim() : "";
    const item={ line, name, generic, mfr, status:"", note:"" };
    if(!name){ item.status="error"; item.note="Missing medicine name"; plan.push(item); return; }
    const key=nameKey(name);
    if(!key){ item.status="error"; item.note="Name has no letters or numbers"; plan.push(item); return; }
    if(seen.has(key)){ item.status="skip"; item.note="Duplicate row — first one is used"; plan.push(item); return; }
    seen.add(key);
    const qty=toNumber(qRaw), price=toNumber(pRaw);
    const qtyOk = qRaw==="" || (Number.isFinite(qty) && qty>=0 && Number.isInteger(qty));
    const priceOk = pRaw==="" || (Number.isFinite(price) && price>=0);
    if(!qtyOk){ item.status="error"; item.note=`Quantity "${qRaw}" must be a whole number`; plan.push(item); return; }
    if(!priceOk){ item.status="error"; item.note=`Price "${pRaw}" isn't a number`; plan.push(item); return; }
    item.qty = qRaw==="" ? null : qty;
    item.price = pRaw==="" ? null : round2(price);
    const med=catalogByKey[key];
    item.key=key;
    if(med){
      item.medicineId=med.id; item.displayName=med.name;
      const inv=invByMed[med.id];
      if(inv){ item.status="update"; item.inv=inv; }
      else {
        if(item.qty==null||item.price==null){ item.status="error"; item.note="New items need both quantity and price"; plan.push(item); return; }
        item.status="new";
      }
    } else {
      if(item.qty==null||item.price==null){ item.status="error"; item.note="New items need both quantity and price"; plan.push(item); return; }
      item.status="newmed"; item.displayName=name; item.medicineId=key;
    }
    plan.push(item);
  });
  return { plan, guessed, truncated: rows.length-start > IMPORT_MAX_ROWS };
}

function downloadTemplate(){
  const csv = "name,quantity,price,generic,manufacturer\n"
    + "Dolo 650,120,2.50,Paracetamol 650mg,Micro Labs\n"
    + "Azithromycin 500,30,14.00,Azithromycin 500mg,Cipla\n"
    + "Cetirizine 10,200,1.80,Cetirizine 10mg,Dr. Reddy's\n";
  const blob=new Blob(["﻿"+csv], { type:"text/csv;charset=utf-8" });
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download="pharmafind-stock-template.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}

function openStockImport(){
  openModal(`
    <h3>Import stock from a file</h3>
    <p class="sub">Upload a CSV or Excel sheet with your medicines. You'll see a preview before anything is saved.</p>

    <label class="dropzone" id="imp-drop">
      <input type="file" id="imp-file" accept=".csv,.xlsx,.xls,.ods,text/csv">
      <span class="dz-ic">📄</span>
      <b>Choose a file</b> <span>or drag it here</span>
      <small>.csv · .xlsx · .xls</small>
    </label>
    <div class="err" id="imp-err" style="margin-top:10px"></div>

    <div class="hint" style="margin-top:12px">
      <b>Columns needed:</b> <code>name</code>, <code>quantity</code>, <code>price</code>
      &nbsp;·&nbsp; optional: <code>generic</code>, <code>manufacturer</code><br>
      Headings like <i>Medicine, Qty, Stock, MRP, Rate, Salt, Company</i> also work.
      Medicines not in the catalog yet are added automatically.
    </div>
    <div class="row" style="justify-content:space-between; margin-top:16px">
      <button class="btn ghost" id="imp-tpl">⬇ Download template</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>`, { wide:true });

  $("imp-tpl").onclick=downloadTemplate;
  const input=$("imp-file"), drop=$("imp-drop");
  input.onchange=()=>{ if(input.files && input.files[0]) handleImportFile(input.files[0]); };
  drop.addEventListener("dragover", e=>{ e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", ()=>drop.classList.remove("over"));
  drop.addEventListener("drop", e=>{ e.preventDefault(); drop.classList.remove("over");
    const f=e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if(f) handleImportFile(f); });
}

async function handleImportFile(file){
  const err=$("imp-err"); if(err) err.textContent="";
  if(file.size > 5*1024*1024){ if(err) err.textContent="That file is over 5 MB. Split it into smaller files."; return; }
  const drop=$("imp-drop"); if(drop) drop.classList.add("busy");
  try{
    const rows=await readSheetRows(file);
    if(!rows.length) throw new Error("The file is empty.");
    const ph=myPharmacy();
    const result=buildImportPlan(rows, ph);
    if(!result.plan.length) throw new Error("No medicine rows found under the header.");
    showImportPreview(file.name, result);
  }catch(e){
    console.error(e);
    if($("imp-err")) $("imp-err").textContent=e.message||"Couldn't read that file.";
    if($("imp-drop")) $("imp-drop").classList.remove("busy");
  }
}

function showImportPreview(fileName, { plan, guessed, truncated }){
  const n=(st)=>plan.filter(x=>x.status===st).length;
  const STATUS={
    new:{ pill:"approved", label:"New stock" },
    update:{ pill:"pending", label:"Update" },
    newmed:{ pill:"neutral", label:"New medicine" },
    skip:{ pill:"neutral", label:"Skipped" },
    error:{ pill:"suspended", label:"Error" },
  };
  const draw=()=>{
    const mode=$("imp-mode")?.value||"set";
    const rows=plan.map(it=>{
      let detail="";
      if(it.status==="update"){
        const newQty = it.qty==null ? it.inv.quantity : mode==="add" ? it.inv.quantity+it.qty : it.qty;
        const newPrice = it.price==null ? it.inv.price : it.price;
        detail=`${it.inv.quantity} → <b>${newQty}</b>${newPrice!==it.inv.price?` · ${money(it.inv.price)} → <b>${money(newPrice)}</b>`:` · ${money(newPrice)}`}`;
      } else if(it.status==="new"||it.status==="newmed"){
        detail=`<b>${it.qty}</b> @ ${money(it.price)}`;
      } else detail=`<span style="color:var(--out)">${esc(it.note)}</span>`;
      return `<tr>
        <td style="color:var(--faint)">${it.line}</td>
        <td><b>${esc(it.displayName||it.name||"—")}</b>${it.status==="newmed"?`<br><small style="color:var(--muted)">${esc(it.generic||"")}</small>`:""}</td>
        <td><span class="pill ${STATUS[it.status].pill}">${STATUS[it.status].label}</span></td>
        <td>${detail}</td></tr>`;
    }).join("");
    $("imp-table").innerHTML=rows;
    const ok=plan.filter(x=>["new","update","newmed"].includes(x.status)).length;
    const go=$("imp-go"); go.disabled=!ok; go.textContent = ok ? `Import ${ok} item${ok!==1?'s':''}` : "Nothing to import";
  };

  openModal(`
    <h3>Check before importing</h3>
    <p class="sub">${esc(fileName)} · ${plan.length} row${plan.length!==1?'s':''}${truncated?` (only the first ${IMPORT_MAX_ROWS} are used)`:""}</p>
    ${guessed?`<div class="hint" style="margin:0 0 12px">⚠️ No header row found — reading columns as <b>name, quantity, price, generic, manufacturer</b>.</div>`:""}
    <div class="imp-summary">
      <span class="pill approved">${n("new")} new stock</span>
      <span class="pill pending">${n("update")} updates</span>
      <span class="pill neutral">${n("newmed")} new to catalog</span>
      ${n("error")?`<span class="pill suspended">${n("error")} errors (skipped)</span>`:""}
      ${n("skip")?`<span class="pill neutral">${n("skip")} duplicates</span>`:""}
    </div>
    ${n("update")?`
    <label class="fld" style="margin-top:12px"><span class="lab">For medicines you already stock</span>
      <select class="input" id="imp-mode">
        <option value="set">Replace quantity with the file's quantity</option>
        <option value="add">Add the file's quantity to current stock (restock)</option>
      </select></label>`:""}
    <div class="table-wrap imp-wrap"><table>
      <thead><tr><th>Row</th><th>Medicine</th><th>Action</th><th>Change</th></tr></thead>
      <tbody id="imp-table"></tbody>
    </table></div>
    <div class="err" id="imp-err2" style="margin-top:10px"></div>
    <div id="imp-progress" class="imp-progress" hidden><div class="bar"><span id="imp-bar"></span></div><small id="imp-ptext"></small></div>
    <div class="row" style="justify-content:space-between; margin-top:14px">
      <button class="btn ghost" id="imp-back">← Choose another file</button>
      <button class="btn primary" id="imp-go">Import</button>
    </div>`, { wide:true });

  draw();
  if($("imp-mode")) $("imp-mode").onchange=draw;
  $("imp-back").onclick=openStockImport;
  $("imp-go").onclick=()=>runImport(plan, $("imp-mode")?.value||"set");
}

async function runImport(plan, mode){
  const ph=myPharmacy();
  const todo=plan.filter(x=>["new","update","newmed"].includes(x.status));
  const go=$("imp-go"), back=$("imp-back"); go.disabled=true; back.disabled=true;
  const prog=$("imp-progress"); prog.hidden=false;
  let done=0, failed=[];
  const total=todo.length + todo.filter(x=>x.status==="newmed").length;
  const tick=()=>{ done++; $("imp-bar").style.width=Math.round(done/total*100)+"%"; $("imp-ptext").textContent=`Saving ${done} of ${total}…`; };
  const inChunks=async (items, fn)=>{ for(let i=0;i<items.length;i+=10){ await Promise.all(items.slice(i,i+10).map(fn)); } };

  // 1) add medicines that aren't in the catalog yet (id = name key, so no duplicates)
  const newMeds=todo.filter(x=>x.status==="newmed");
  await inChunks(newMeds, async (it)=>{
    const ref=doc(db,"medicines",it.key);
    try{
      const existing=await getDoc(ref);
      if(!existing.exists()){
        await setDoc(ref, { name:it.name.slice(0,100), generic:(it.generic||"—").slice(0,120),
          mfr:(it.mfr||"—").slice(0,100), nameKey:it.key, addedBy:ME.uid });
      }
      it.medicineId=it.key;
    }catch(e){ console.error(e); it.failed="Couldn't add to catalog"; failed.push(it); }
    tick();
  });

  // 2) write stock
  await inChunks(todo.filter(x=>!x.failed), async (it)=>{
    try{
      if(it.status==="update"){
        const patch={};
        if(it.qty!=null) patch.quantity = mode==="add" ? it.inv.quantity + it.qty : it.qty;
        if(it.price!=null) patch.price = it.price;
        if(Object.keys(patch).length) await updateDoc(doc(db,"inventory",it.inv.id), patch);
      } else {
        await setDoc(doc(db,"inventory",`${ph.id}_${it.medicineId}`),
          { pharmacyId:ph.id, ownerUserId:ME.uid, medicineId:it.medicineId, quantity:it.qty, price:it.price });
      }
    }catch(e){ console.error(e); it.failed = e.code==="permission-denied" ? "Refused by database rules" : "Save failed"; failed.push(it); }
    tick();
  });

  const ok=todo.length-failed.length;
  if(!failed.length){
    closeModal();
    toast(`Imported ${ok} item${ok!==1?'s':''} into your inventory.`, "good");
    return;
  }
  $("imp-ptext").textContent=`Imported ${ok}, ${failed.length} failed.`;
  $("imp-err2").innerHTML = `<b>${failed.length} row(s) didn't save:</b> ` +
    failed.slice(0,8).map(f=>`row ${f.line} (${esc(f.displayName||f.name)}: ${esc(f.failed)})`).join(", ") +
    (failed.length>8?"…":"") +
    (failed.some(f=>f.failed==="Refused by database rules") ? "<br>Make sure the latest <code>firestore.rules</code> are published." : "");
  back.disabled=false; go.textContent="Done"; go.disabled=false; go.onclick=closeModal;
}

function editInventory(invId){
  const ph=myPharmacy();
  const existing=invId?cache.inventory.find(i=>i.id===invId):null;
  const usedIds=new Set(cache.inventory.filter(i=>i.pharmacyId===ph.id).map(i=>i.medicineId));
  const options=cache.medicines
    .filter(m=> existing ? m.id===existing.medicineId : !usedIds.has(m.id))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""))
    .map(m=>`<option value="${m.id}" ${existing&&existing.medicineId===m.id?'selected':''}>${esc(m.name)} — ${esc(m.generic)}</option>`).join("");
  if(!existing && !options){ toast(cache.medicines.length ? "You've already listed every catalog medicine." : "The catalog is empty — ask the admin to add medicines.", "bad"); return; }

  openModal(`
    <h3>${existing?'Edit medicine':'Add medicine'}</h3>
    <p class="sub">${existing?'Update price and quantity.':'Pick from the shared catalog, then set your price and stock.'}</p>
    <label class="fld"><span class="lab">Medicine</span>
      <select class="input" id="iv-med" ${existing?'disabled':''}>${options}</select></label>
    <div class="row">
      <label class="fld grow"><span class="lab">Price (₹)</span>
        <input class="input" id="iv-price" type="number" min="0" step="0.01" value="${existing?existing.price:''}" placeholder="0.00"></label>
      <label class="fld grow"><span class="lab">Quantity</span>
        <input class="input" id="iv-qty" type="number" min="0" step="1" value="${existing?existing.quantity:''}" placeholder="0"></label>
    </div>
    <div class="err" id="iv-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="iv-save">${existing?'Save changes':'Add to inventory'}</button>
    </div>`);
  $("iv-save").onclick=async ()=>{
    const medId=$("iv-med").value;
    const price=round2(parseFloat($("iv-price").value));
    const qty=Number($("iv-qty").value.trim());
    if(isNaN(price)||price<0){ $("iv-err").textContent="Enter a valid price."; return; }
    if(!Number.isInteger(qty)||qty<0){ $("iv-err").textContent="Quantity must be a whole number (0 or more)."; return; }
    const btn=$("iv-save"); btn.disabled=true;
    try{
      if(existing){
        await updateDoc(doc(db,"inventory",existing.id), { price, quantity:qty });
      } else {
        await setDoc(doc(db,"inventory",`${ph.id}_${medId}`),
          { pharmacyId:ph.id, ownerUserId:ME.uid, medicineId:medId, quantity:qty, price });
      }
      closeModal();
      toast(existing?"Inventory updated":"Medicine added", "good");
    }catch(e){ console.error(e); $("iv-err").textContent="Could not save. Try again."; btn.disabled=false; }
  };
}

function viewPhBilling(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id && i.quantity>0)
    .sort((a,b)=>(getMed(a.medicineId)?.name||"").localeCompare(getMed(b.medicineId)?.name||""));
  const pickerOptions=inv.map(i=>{
    const m=getMed(i.medicineId);
    return `<option value="${i.id}">${esc(m?m.name:'—')} — ${money(i.price)} (${i.quantity} left)</option>`;
  }).join("");

  // drop lines whose item vanished; clamp to current stock
  state.billDraft = state.billDraft
    .filter(l => cache.inventory.some(i=>i.id===l.invId && i.quantity>0))
    .map(l => ({ ...l, qty: Math.min(l.qty, cache.inventory.find(i=>i.id===l.invId).quantity) }));

  const lines=state.billDraft.map(line=>{
    const i=cache.inventory.find(x=>x.id===line.invId);
    const m=getMed(i.medicineId);
    return `<div class="cart-line">
      <div class="cn"><b>${esc(m?m.name:'—')}</b><small>${money(i.price)} × ${line.qty} · ${i.quantity} in stock</small></div>
      <div class="qty-stepper">
        <button data-dec="${line.invId}">−</button><span>${line.qty}</span><button data-inc="${line.invId}">＋</button>
      </div>
      <button class="btn sm danger" data-rm="${line.invId}">✕</button>
    </div>`;
  }).join("");
  const total=state.billDraft.reduce((s,l)=>{ const i=cache.inventory.find(x=>x.id===l.invId); return s+(i?i.price*l.qty:0); },0);

  $("main").innerHTML=`
    <div class="page-head"><h2>New bill</h2>
      <p>Add items, then create the bill. Stock is reduced automatically the moment the bill is saved (max ${MAX_BILL_LINES} different medicines per bill).</p></div>
    <div class="bill-grid">
      <div class="card">
        <h3 style="margin-bottom:14px">Add an item</h3>
        ${inv.length? `
        <div class="row">
          <select class="input grow" id="bill-med">${pickerOptions}</select>
          <input class="input" id="bill-qty" type="number" min="1" step="1" value="1" style="width:90px">
          <button class="btn primary" id="bill-add">Add</button>
        </div>` : `<p style="color:var(--muted)">No in-stock medicines to bill. Add stock in Inventory first.</p>`}
      </div>
      <div class="card bill-cart">
        <h3 style="margin-bottom:12px">Bill items (${state.billDraft.length}/${MAX_BILL_LINES})</h3>
        ${state.billDraft.length? lines : `<p style="color:var(--muted); font-size:14px">No items added yet.</p>`}
        <div class="cart-total"><span>Total</span><span class="t">${money(total)}</span></div>
        <button class="btn money" id="bill-create" style="width:100%; margin-top:14px" ${state.billDraft.length?'':'disabled'}>
          Create bill · ${money(total)}</button>
        ${state.billDraft.length?`<button class="btn ghost" id="bill-clear" style="width:100%; margin-top:8px">Clear</button>`:''}
      </div>
    </div>`;

  const addBtn=$("bill-add");
  if(addBtn) addBtn.onclick=()=>{
    const invId=$("bill-med").value; const qty=Number($("bill-qty").value.trim());
    if(!invId||!Number.isInteger(qty)||qty<1){ toast("Pick a medicine and a whole-number quantity.", "bad"); return; }
    const item=cache.inventory.find(x=>x.id===invId); if(!item) return;
    const line=state.billDraft.find(l=>l.invId===invId); const have=line?line.qty:0;
    if(!line && state.billDraft.length>=MAX_BILL_LINES){ toast(`A bill can have up to ${MAX_BILL_LINES} different medicines. Create this bill, then start another.`, "bad"); return; }
    if(have+qty>item.quantity){ toast(`Only ${item.quantity} in stock (you already have ${have} in this bill).`, "bad"); return; }
    if(line) line.qty+=qty; else state.billDraft.push({ invId, qty });
    viewPhBilling();
  };
  $("main").querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>{
    const l=state.billDraft.find(x=>x.invId===b.dataset.inc);
    const stock=cache.inventory.find(x=>x.id===b.dataset.inc)?.quantity||0;
    if(!l) return;
    if(l.qty>=stock){ toast("That's all the stock there is.", "bad"); return; }
    l.qty++; viewPhBilling();
  });
  $("main").querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>{
    const l=state.billDraft.find(x=>x.invId===b.dataset.dec); if(!l) return;
    l.qty--; if(l.qty<=0) state.billDraft=state.billDraft.filter(x=>x.invId!==b.dataset.dec);
    viewPhBilling();
  });
  $("main").querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{
    state.billDraft=state.billDraft.filter(x=>x.invId!==b.dataset.rm); viewPhBilling();
  });
  const clr=$("bill-clear"); if(clr) clr.onclick=()=>{ state.billDraft=[]; viewPhBilling(); };
  const create=$("bill-create"); if(create) create.onclick=createBill;
}

async function createBill(){
  if(!state.billDraft.length) return;
  if(state.billDraft.length>MAX_BILL_LINES){ toast(`Max ${MAX_BILL_LINES} medicines per bill.`, "bad"); return; }
  const ph=myPharmacy();
  const draft=state.billDraft.map(l=>({ ...l }));
  const btn=$("bill-create"); if(btn){ btn.disabled=true; btn.textContent="Creating…"; }
  const billRef = doc(collection(db,"bills"));
  let receiptBill=null, lowList=[];
  try{
    await runTransaction(db, async (tx)=>{
      const refs  = draft.map(l => doc(db,"inventory",l.invId));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      const items=[]; let total=0; const low=[];
      snaps.forEach((s, idx)=>{
        const line=draft[idx];
        if(!s.exists()) throw new Error("An item is no longer available.");
        const data=s.data();
        const m=getMed(data.medicineId);
        if(data.pharmacyId!==ph.id) throw new Error("An item doesn't belong to your store.");
        if(data.quantity < line.qty) throw new Error(`Not enough stock for ${m?m.name:'an item'} (only ${data.quantity} left).`);
        const lineTotal=data.price*line.qty; total+=lineTotal;
        items.push({ inventoryId:s.id, medicineId:data.medicineId, name:m?m.name:"Item",
                     quantity:line.qty, unitPrice:data.price, lineTotal });
        const left=data.quantity-line.qty;
        if(left<=LOW_STOCK) low.push({ name:m?m.name:"Item", left });
      });
      snaps.forEach((s, idx)=> tx.update(refs[idx], {
        quantity: s.data().quantity - draft[idx].qty, lastBillId: billRef.id, lastBillQty: draft[idx].qty }));
      const createdAt=now();
      tx.set(billRef, { pharmacyId:ph.id, ownerUserId:ME.uid, patientId:null, items, total, createdAt });
      receiptBill={ id:billRef.id, pharmacyId:ph.id, items, total, createdAt };
      lowList=low;
    });
  }catch(e){
    console.warn("bill aborted:", e);
    toast((e.code==="permission-denied" ? "The database rejected this bill — publish the latest firestore.rules in the Firebase console." : (e.message||"Bill cancelled.")) + " Nothing was changed.", "bad");
    viewPhBilling(); return;
  }
  lowList.forEach(x=> notify(ME.uid, `Low stock: ${x.name} — ${x.left} left`));
  state.billDraft=[];
  showBillReceipt(receiptBill, ph);
}

function showBillReceipt(bill, ph){
  const rows=(bill.items||[]).map(it=>`<tr>
    <td>${esc(it.name)}</td><td style="text-align:center">${it.quantity}</td>
    <td style="text-align:right">${money(it.unitPrice)}</td>
    <td style="text-align:right">${money(it.lineTotal)}</td></tr>`).join("");
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:34px">✅</div>
      <h3>Bill #${String(bill.id).slice(0,8).toUpperCase()}</h3>
      <p class="sub">${esc(ph.name)} · ${new Date(bill.createdAt).toLocaleString()}</p>
    </div>
    <div class="table-wrap" style="box-shadow:none">
      <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div class="cart-total"><span>Amount charged</span><span class="t">${money(bill.total)}</span></div>
    <button class="btn primary" style="width:100%; margin-top:16px" id="rc-done">Done</button>`);
  $("rc-done").onclick=()=>{ closeModal(); };
}

function viewPhReservations(){
  if(pendingGate(true)) return;
  const ph=myPharmacy();
  const all=cache.reservations.filter(r=>r.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const { html:tabs, shown } = resTabs(all, "phResTab");
  const body = !loaded.has("reservations") ? loadingBlock() : !all.length ?
    `<div class="empty"><div class="big">🏷️</div><h3>No reservations</h3>
      <p>When a patient reserves one of your medicines, it appears here.</p></div>` :
    shown.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Patient</th><th>Qty</th><th>Paid</th><th>Status</th><th>Ordered</th><th style="text-align:right">Action</th></tr></thead>
      <tbody>${reservationRows(shown, { showActions:true })}</tbody>
    </table></div>` : `<div class="empty"><div class="big">✨</div><h3>Nothing here</h3><p>No reservations in this list.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>Reservations</h2>
    <p>Patients have already paid and the stock is set aside. When the patient collects the medicine, press
    <b>✓ Mark as completed</b>. If they don't come, press <b>Cancel</b> to put the stock back.</p></div>
    ${all.length?tabs:""}${body}`;
  bindResTabs("phResTab", viewPhReservations);
  bindReservationActions();
}

function viewPhSales(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const bills=cache.bills.filter(b=>b.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const online=cache.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="fulfilled").sort((a,b)=>b.createdAt-a.createdAt);
  const billRev=bills.reduce((s,b)=>s+(b.total||0),0), onlineRev=onlineRevenue(online);
  const billTable = bills.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Bill #</th><th>Items</th><th>When</th><th style="text-align:right">Amount</th><th></th></tr></thead>
      <tbody>${bills.map(b=>{
        const count=(b.items||[]).reduce((s,i)=>s+i.quantity,0);
        return `<tr>
          <td><b>#${String(b.id).slice(0,8).toUpperCase()}</b></td>
          <td>${count} item${count!==1?'s':''}</td>
          <td style="color:var(--muted)">${timeAgo(b.createdAt)}</td>
          <td style="text-align:right"><b>${money(b.total)}</b></td>
          <td style="text-align:right"><button class="btn sm ghost" data-view-bill="${b.id}">View</button></td></tr>`;
      }).join("")}</tbody>
    </table></div>` :
    `<div class="empty"><div class="big">💰</div><h3>No counter bills yet</h3><p>Create a bill and it'll show up here.</p></div>`;
  const onlineTable = online.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Patient</th><th>Qty</th><th>When</th><th style="text-align:right">Paid</th></tr></thead>
      <tbody>${online.map(r=>`<tr>
        <td><b>${esc(getMed(r.medicineId)?.name||'—')}</b></td><td>${esc(r.patientName||'')}</td><td>${r.qty}</td>
        <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
        <td style="text-align:right"><b>${money(r.amountPaid)}</b></td></tr>`).join("")}</tbody>
    </table></div>` : `<p style="color:var(--muted)">No fulfilled online reservations yet.</p>`;
  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Sales history</h2><p>Counter bills and fulfilled online reservations.</p></div>
      <div class="stat money" style="min-width:150px"><div class="n">${money(billRev+onlineRev)}</div><div class="l">Total revenue</div></div>
    </div>
    <h3 style="margin:0 0 10px">Counter bills · ${money(billRev)}</h3>
    ${billTable}
    <h3 style="margin:24px 0 10px">Online reservations · ${money(onlineRev)}</h3>
    ${onlineTable}`;
  $("main").querySelectorAll("[data-view-bill]").forEach(b=>b.onclick=()=>{
    const bill=cache.bills.find(x=>x.id===b.dataset.viewBill); if(bill) showBillReceipt(bill, ph);
  });
}

function viewPhSettings(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const lat=typeof ph.lat==="number"?ph.lat:DEFAULT_LOC.lat, lng=typeof ph.lng==="number"?ph.lng:DEFAULT_LOC.lng;
  $("main").innerHTML=`
    <div class="page-head"><h2>Store settings</h2><p>Details patients see about your pharmacy.</p></div>
    <div class="card" style="max-width:520px">
      <label class="fld"><span class="lab">Pharmacy name</span><input class="input" id="set-name" maxlength="100" value="${esc(ph.name)}"></label>
      <label class="fld"><span class="lab">Address / area</span><input class="input" id="set-addr" maxlength="200" value="${esc(ph.address)}"></label>
      <label class="fld"><span class="lab">Opening hours</span><input class="input" id="set-hours" maxlength="60" value="${esc(ph.hours)}"></label>
      <div class="row">
        <label class="fld grow"><span class="lab">Latitude</span><input class="input" id="set-lat" type="number" step="any" value="${lat}"></label>
        <label class="fld grow"><span class="lab">Longitude</span><input class="input" id="set-lng" type="number" step="any" value="${lng}"></label>
      </div>
      <p style="margin:-4px 0 14px"><button class="btn sm" id="set-loc" type="button">📍 Use my current location</button>
        <span style="font-size:12.5px; color:var(--muted); margin-left:6px">Stand inside the store when you tap this.</span></p>
      <div class="err" id="set-err"></div>
      <button class="btn primary" id="set-save">Save changes</button>
    </div>`;
  $("set-loc").onclick=async ()=>{
    const b=$("set-loc"); b.disabled=true; b.textContent="Locating…";
    try{ const p=await getPosition(); $("set-lat").value=p.lat.toFixed(6); $("set-lng").value=p.lng.toFixed(6); toast("Location filled — press Save.", "good"); }
    catch(e){ toast(e.message, "bad"); }
    b.disabled=false; b.textContent="📍 Use my current location";
  };
  $("set-save").onclick=async ()=>{
    const name=$("set-name").value.trim();
    const address=$("set-addr").value.trim();
    const hours=$("set-hours").value.trim();
    const la=parseFloat($("set-lat").value), ln=parseFloat($("set-lng").value);
    $("set-err").textContent="";
    if(!name){ $("set-err").textContent="Pharmacy name can't be empty."; return; }
    if(isNaN(la)||la<-90||la>90||isNaN(ln)||ln<-180||ln>180){ $("set-err").textContent="Enter a valid latitude (−90…90) and longitude (−180…180)."; return; }
    const btn=$("set-save"); btn.disabled=true;
    try{ await updateDoc(doc(db,"pharmacies",ph.id), { name, address, hours, lat:la, lng:ln }); toast("Store details saved.", "good"); }
    catch(e){ console.error(e); $("set-err").textContent="Could not save."; }
    btn.disabled=false;
  };
}

/* ============================================================
   ADMIN VIEWS
   ============================================================ */
function viewAdDash(){
  const phAll=cache.pharmacies;
  const pending=phAll.filter(p=>p.status==="pending").length;
  const active=phAll.filter(p=>p.status==="approved").length;
  const revenue=cache.bills.reduce((s,b)=>s+(b.total||0),0) + onlineRevenue(cache.reservations);
  const patients=cache.users.filter(u=>u.role==="patient").length;
  const openRes=cache.reservations.filter(r=>r.status==="pending").length;
  $("main").innerHTML=`
    <div class="page-head"><h2>Network overview</h2><p>Health of the whole PharmaFind network.</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${active}</div><div class="l">Active pharmacies</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${pending}</div><div class="l">Pending approval</div></div>
      <div class="stat"><div class="n">${patients}</div><div class="l">Registered patients</div></div>
      <div class="stat"><div class="n">${cache.medicines.length}</div><div class="l">Catalog medicines</div></div>
      <div class="stat"><div class="n">${cache.bills.length}</div><div class="l">Bills across network</div></div>
      <div class="stat"><div class="n">${openRes}</div><div class="l">Open reservations</div></div>
      <div class="stat money"><div class="n">${money(revenue)}</div><div class="l">Total network sales</div></div>
    </div>
    ${pending? `<div class="card"><div class="row" style="justify-content:space-between">
      <div><h3>${pending} pharmac${pending>1?'ies':'y'} waiting</h3>
      <p style="color:var(--muted); margin:4px 0 0">Approve them so their stock becomes searchable.</p></div>
      <button class="btn primary" data-go="ad-approvals">Review now</button></div></div>` : ""}
    ${!cache.medicines.length && loaded.has("medicines") ? `<div class="card"><div class="row" style="justify-content:space-between">
      <div><h3>The medicine catalog is empty</h3>
      <p style="color:var(--muted); margin:4px 0 0">Pharmacies can't list stock until it has medicines.</p></div>
      <button class="btn primary" data-go="ad-medicines">Open catalog</button></div></div>` : ""}`;
  $("main").querySelectorAll("[data-go]").forEach(g=> g.onclick=()=>{ state.view=g.dataset.go; renderApp(); });
}

function viewAdApprovals(){
  const pending=cache.pharmacies.filter(p=>p.status==="pending");
  const body = pending.length ? pending.map(p=>{
    const owner=getUser(p.ownerUserId);
    return `<div class="result">
      <div class="ph-ic">🏥</div>
      <div class="body">
        <div class="name">${esc(p.name)}</div>
        <div class="meta"><span>📍 ${esc(p.address)}</span><span>🕒 ${esc(p.hours)}</span>
          <span>👤 ${esc(owner?owner.name:'—')}${owner&&owner.email?` · ${esc(owner.email)}`:''}</span></div>
      </div>
      <div class="right">
        <button class="btn primary sm" data-approve="${p.id}">Approve</button>
        <button class="btn danger sm" data-reject="${p.id}">Reject</button>
      </div></div>`;
  }).join("") :
    `<div class="empty"><div class="big">✅</div><h3>All caught up</h3><p>No pharmacies are waiting for approval.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>Pharmacy approvals</h2>
    <p>Only approved pharmacies appear in patient search.</p></div>${body}`;
  $("main").querySelectorAll("[data-approve]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.approve); if(!p) return;
    b.disabled=true;
    try{ await updateDoc(doc(db,"pharmacies",p.id), { status:"approved" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was approved. You can now manage inventory and billing.`);
      toast(`${p.name} approved.`, "good"); }
    catch(e){ console.error(e); toast("Could not approve.", "bad"); b.disabled=false; }
  });
  $("main").querySelectorAll("[data-reject]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.reject); if(!p) return;
    if(!confirm(`Reject ${p.name}? This removes the store. The owner can sign in again and will be asked to set up their account.`)) return;
    b.disabled=true;
    try{
      await notify(p.ownerUserId, `Your pharmacy registration "${p.name}" was rejected.`);
      const invs=cache.inventory.filter(i=>i.pharmacyId===p.id);
      await Promise.all(invs.map(i=>deleteDoc(doc(db,"inventory",i.id)).catch(()=>{})));
      await deleteDoc(doc(db,"pharmacies",p.id));
      // remove the profile too, so the owner isn't stuck as a pharmacy with no store
      const owner=getUser(p.ownerUserId);
      if(owner && owner.role==="pharmacy") await deleteDoc(doc(db,"users",owner.id)).catch(()=>{});
      toast(`${p.name} rejected.`);
    }catch(e){ console.error(e); toast("Could not reject.", "bad"); b.disabled=false; }
  });
}

function viewAdPharmacies(){
  const all=[...cache.pharmacies].sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const body = all.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Pharmacy</th><th>Area</th><th>Items</th><th>Open res.</th><th>Status</th><th></th></tr></thead>
      <tbody>${all.map(p=>{
        const items=cache.inventory.filter(i=>i.pharmacyId===p.id).length;
        const open=cache.reservations.filter(r=>r.pharmacyId===p.id && r.status==="pending").length;
        const action = p.status==="approved"
          ? `<button class="btn sm danger" data-suspend="${p.id}">Suspend</button>`
          : p.status==="suspended"
          ? `<button class="btn sm primary" data-restore="${p.id}">Reactivate</button>`
          : `<button class="btn sm ghost" data-go2="ad-approvals">Review</button>`;
        return `<tr>
          <td><b>${esc(p.name)}</b></td>
          <td style="color:var(--muted)">${esc(p.address)}</td>
          <td>${items}</td>
          <td>${open}</td>
          <td><span class="pill ${esc(p.status)}">${esc(p.status)}</span></td>
          <td style="text-align:right">${action}</td></tr>`;
      }).join("")}</tbody></table></div>` :
    `<div class="empty"><div class="big">🏥</div><h3>No pharmacies</h3></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>All pharmacies</h2>
    <p>Every store on the network. Suspending hides it from search and blocks new reservations; existing ones can still be handled.</p></div>${body}`;
  $("main").querySelectorAll("[data-suspend]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.suspend); if(!p) return;
    if(!confirm(`Suspend ${p.name}?`)) return;
    try{ await updateDoc(doc(db,"pharmacies",p.id), { status:"suspended" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was suspended by admin.`); toast(`${p.name} suspended.`); }
    catch(e){ console.error(e); toast("Could not suspend.", "bad"); }
  });
  $("main").querySelectorAll("[data-restore]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.restore); if(!p) return;
    try{ await updateDoc(doc(db,"pharmacies",p.id), { status:"approved" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" is active again.`); toast(`${p.name} reactivated.`, "good"); }
    catch(e){ console.error(e); toast("Could not reactivate.", "bad"); }
  });
  $("main").querySelectorAll("[data-go2]").forEach(b=>b.onclick=()=>{ state.view=b.dataset.go2; renderApp(); });
}

function viewAdReservations(){
  const all=[...cache.reservations].sort((a,b)=>b.createdAt-a.createdAt);
  const { html:tabs, shown } = resTabs(all, "adResTab");
  const body = !loaded.has("reservations") ? loadingBlock() : !all.length ?
    `<div class="empty"><div class="big">🏷️</div><h3>No reservations yet</h3></div>` :
    shown.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Patient</th><th>Qty</th><th>Paid</th><th>Status</th><th>Ordered</th><th style="text-align:right">Action</th></tr></thead>
      <tbody>${reservationRows(shown, { showPharmacy:true, showActions:true })}</tbody>
    </table></div>` : `<div class="empty"><div class="big">✨</div><h3>Nothing here</h3><p>No reservations in this list.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>All reservations</h2>
    <p>Step in if a store can't handle one — completing or cancelling works the same as for the store.</p></div>
    ${all.length?tabs:""}${body}`;
  bindResTabs("adResTab", viewAdReservations);
  bindReservationActions();
}

function viewAdMedicines(){
  const meds=[...cache.medicines].sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const existingNames=new Set(meds.map(m=>(m.name||"").toLowerCase()));
  const missingSamples=SAMPLE_MEDS.filter(([n])=>!existingNames.has(n.toLowerCase()));
  const loader = (loaded.has("medicines") && missingSamples.length) ? `
    <div class="card" style="margin-bottom:16px; text-align:center">
      <p style="margin:0 0 10px">${meds.length ? `${missingSamples.length} sample medicine(s) aren't in the catalog yet.` : "The catalog is empty. Load the 10 sample medicines to get started."}</p>
      <button class="btn primary" id="load-sample">Load sample catalog</button>
    </div>` : "";
  const body = `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Salt / generic</th><th>Manufacturer</th><th>Listed by</th><th></th></tr></thead>
      <tbody>${meds.map(m=>{
        const listings=cache.inventory.filter(i=>i.medicineId===m.id).length;
        return `<tr>
          <td><b>${esc(m.name)}</b></td>
          <td style="color:var(--muted)">${esc(m.generic)}</td>
          <td>${esc(m.mfr)}${m.addedBy?` <span class="pill neutral" title="Added by a pharmacy during stock import">shop-added</span>`:""}</td>
          <td>${listings} pharmac${listings!==1?'ies':'y'}</td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn sm ghost" data-edit-med="${m.id}">Edit</button>
            <button class="btn sm danger" data-del-med="${m.id}">Delete</button></td></tr>`;
      }).join("")}</tbody></table></div>`;
  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Medicine catalog</h2>
      <p>The shared master list. Pharmacies pick from this — one clean name per medicine, no duplicates.</p></div>
      <button class="btn primary" id="add-med">＋ Add medicine</button>
    </div>${loader}${meds.length?body:""}`;

  const ls=$("load-sample");
  if(ls) ls.onclick=async ()=>{
    ls.disabled=true; ls.textContent="Loading…";
    try{
      await Promise.all(missingSamples.map(([name,generic,mfr]) =>
        addDoc(collection(db,"medicines"), { name, generic, mfr })));
      toast("Sample catalog loaded.", "good");
    }catch(e){ console.error(e); toast("Could not load catalog.", "bad"); ls.disabled=false; ls.textContent="Load sample catalog"; }
  };
  $("add-med").onclick=()=>editMedicine(null);
  $("main").querySelectorAll("[data-edit-med]").forEach(b=>b.onclick=()=>editMedicine(b.dataset.editMed));
  $("main").querySelectorAll("[data-del-med]").forEach(b=>b.onclick=async ()=>{
    const m=getMed(b.dataset.delMed); if(!m) return;
    const listings=cache.inventory.filter(i=>i.medicineId===m.id).length;
    if(listings){ toast(`Can't delete — ${m.name} is stocked by ${listings} pharmacy(ies).`, "bad"); return; }
    if(confirm(`Delete ${m.name} from the catalog?`)){
      try{ await deleteDoc(doc(db,"medicines",m.id)); toast("Deleted from catalog."); }
      catch(e){ console.error(e); toast("Could not delete.", "bad"); }
    }
  });
}

function editMedicine(medId){
  const m=medId?getMed(medId):null;
  openModal(`
    <h3>${m?'Edit medicine':'Add medicine'}</h3>
    <p class="sub">${m?'Update the catalog entry.':'Add a new medicine to the shared catalog.'}</p>
    <label class="fld"><span class="lab">Brand / name</span><input class="input" id="md-name" maxlength="100" value="${m?esc(m.name):''}" placeholder="e.g. Dolo 650"></label>
    <label class="fld"><span class="lab">Salt / generic</span><input class="input" id="md-gen" maxlength="120" value="${m?esc(m.generic):''}" placeholder="e.g. Paracetamol 650mg"></label>
    <label class="fld"><span class="lab">Manufacturer</span><input class="input" id="md-mfr" maxlength="100" value="${m?esc(m.mfr):''}" placeholder="e.g. Micro Labs"></label>
    <div class="err" id="md-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="md-save">${m?'Save':'Add'}</button>
    </div>`);
  $("md-save").onclick=async ()=>{
    const name=$("md-name").value.trim(), gen=$("md-gen").value.trim(), mfr=$("md-mfr").value.trim()||"—";
    if(!name||!gen){ $("md-err").textContent="Name and salt are required."; return; }
    const dupe=cache.medicines.some(x=>(x.name||"").toLowerCase()===name.toLowerCase() && (!m||x.id!==m.id));
    if(dupe){ $("md-err").textContent="A medicine with that name already exists."; return; }
    const btn=$("md-save"); btn.disabled=true;
    try{
      if(m){ await updateDoc(doc(db,"medicines",m.id), { name, generic:gen, mfr }); }
      else { await addDoc(collection(db,"medicines"), { name, generic:gen, mfr }); }
      closeModal(); toast(m?"Catalog updated":"Medicine added", "good");
    }catch(e){ console.error(e); $("md-err").textContent="Could not save."; btn.disabled=false; }
  };
}

const ROLE_LABEL = { admin:"Admin", pharmacy:"Medical (Pharmacy)", patient:"Patient" };
const ROLE_PILL  = { admin:"neutral", pharmacy:"approved", patient:"pending" };

function viewAdAccounts(){
  const me=currentUser();
  const order={ admin:0, pharmacy:1, patient:2 };
  const users=[...cache.users].sort((a,b)=> ((order[a.role]??9)-(order[b.role]??9)) || (a.name||'').localeCompare(b.name||''));
  const rows=users.map(u=>{
    const ph = u.role==="pharmacy" ? cache.pharmacies.find(p=>p.ownerUserId===u.id) : null;
    const store = ph ? `${esc(ph.name)} · <span class="pill ${esc(ph.status)}">${esc(ph.status)}</span>` : "—";
    const isMe = u.id===me.uid;
    return `<tr>
      <td><b>${esc(u.name||'—')}</b>${isMe?' <span class="pill neutral">you</span>':''}</td>
      <td><span class="pill ${ROLE_PILL[u.role]||'neutral'}">${esc(ROLE_LABEL[u.role]||u.role)}</span></td>
      <td><code>${esc(u.email||'—')}</code></td>
      <td>${store}</td>
      <td style="text-align:right">
        <button class="btn sm danger" data-delacc="${u.id}" ${isMe?'disabled':''}>Delete</button>
      </td></tr>`;
  }).join("");
  $("main").innerHTML=`
    <div class="page-head"><h2>Accounts</h2>
      <p>Everyone on the system. People sign themselves up with Google (or an email link).</p></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Store</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="hint" style="margin-top:16px">
      <b>How accounts are created:</b> a person taps “Continue with Google” (or uses an
      email link) and then picks patient or pharmacy.
      <b>PharmaFind has one admin</b> — <code>${esc(adminEmails[0]||"")}</code>. Nobody else can be made
      admin from the app; the database rules block it.
      Deleting removes their profile, store, stock and notifications and cancels
      their open reservations. Bills stay as a permanent record.
    </div>`;
  $("main").querySelectorAll("[data-delacc]").forEach(b=>b.onclick=()=>deleteAccount(b.dataset.delacc));
}

async function deleteAccount(userId){
  const u=getUser(userId); if(!u) return;
  if(u.id===ME.uid){ toast("You can't delete your own account.", "bad"); return; }
  if(u.role==="admin" && cache.users.filter(x=>x.role==="admin").length<=1){ toast("Can't delete the only admin.", "bad"); return; }
  const ph = u.role==="pharmacy" ? cache.pharmacies.find(p=>p.ownerUserId===u.id) : null;
  const warn = ph ? ` This also removes their store "${ph.name}" and its inventory, and cancels its open reservations.` : "";
  if(!confirm(`Delete ${u.name}'s account?${warn}\n\n(The email login itself stays in Firebase Auth; if they sign in again they'll be asked to set up a new profile.)`)) return;
  try{
    // 1) open reservations: patient's get cancelled WITH stock returned; store's just cancelled
    const asPatient=cache.reservations.filter(r=>r.patientId===userId && r.status==="pending");
    for(const r of asPatient){ await cancelReservation(r.id).catch(e=>console.warn(e)); }
    if(ph){
      const asStore=cache.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="pending");
      for(const r of asStore){
        await updateDoc(doc(db,"reservations",r.id), { status:"cancelled", updatedAt:now() }).catch(e=>console.warn(e));
        notify(r.patientId, `Your reservation at ${ph.name} was cancelled because the store closed. Your payment of ${money(r.amountPaid)} will be refunded.`);
      }
      const invs=cache.inventory.filter(i=>i.pharmacyId===ph.id);
      await Promise.all(invs.map(i=>deleteDoc(doc(db,"inventory",i.id)).catch(()=>{})));
      await deleteDoc(doc(db,"pharmacies",ph.id));
    }
    // 2) their notifications (admin doesn't cache other people's, so query them)
    const ns=await getDocs(query(collection(db,"notifications"), where("userId","==",userId)));
    await Promise.all(ns.docs.map(d=>deleteDoc(d.ref).catch(()=>{})));
    // 3) the profile
    await deleteDoc(doc(db,"users",userId));
    toast("Account deleted.");
  }catch(e){ console.error(e); toast("Could not delete account.", "bad"); }
}

/* ============================================================
   BOOT
   ============================================================ */
renderLoading("Loading…");
handleGoogleRedirectReturn();
handleEmailLinkReturn();   // if we arrived via an email link, finish sign-in;
                           // otherwise onAuthStateChanged shows sign-in or the app.
