/* ============================================================
   PharmaFind — app.js
   Medicine availability & pharmacy finder
   Roles: Admin · Pharmacy · Patient
   Backend: Firebase Auth (email + password) + Cloud Firestore
   ------------------------------------------------------------
   HOW THE CORE LOGIC WORKS

   • STOCK IS ALWAYS HONEST
     - Reserving a medicine HOLDS it: the reservation and the stock
       reduction happen in ONE Firestore transaction. What patients
       see as "available" is real, sellable stock.
     - Cancelling a reservation (patient or pharmacy) puts the
       quantity back, also in one transaction.
     - Counter billing reduces stock in a transaction, so two
       cashiers can never oversell the same item.

   • RESERVATION LIFECYCLE
       pending ──(pharmacy packs it)──▶ ready ──(patient picks up)──▶ collected
          │                               │
          └──────────── cancelled ◀───────┘   (stock returned)
     Patients can cancel only while it's still "pending".

   • LOCATION
     - Patients can share their location (browser GPS); otherwise
       distances are measured from DEFAULT_LOCATION.
     - Pharmacies set their real store location from Store settings.
       Stores without a location show "distance unknown".

   • LIMITS: a patient can hold at most MAX_ACTIVE_HOLDS reservations
     at once (tracked in holds/{uid}); unclaimed holds are released
     after HOLD_HOURS by the pharmacy's / admin's app.

   • ACCOUNTS: first admin is claimed once (meta/adminClaim); more
     admins via "Make admin". Admins can Block / Remove accounts —
     removed accounts stay blocked so they can't re-register.

   • PAYMENT is a MOCK screen (no real money). A real gateway needs
     a backend (e.g. Cloud Functions + Razorpay).

   Every rule the app relies on is enforced in firestore.rules —
   the JavaScript checks here are only for a friendly UI.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, runTransaction, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { firebaseConfig, ADMIN_EMAILS, DEFAULT_LOCATION } from "./firebase-config.js";


/* ============================================================
   FIREBASE INIT
   ============================================================ */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const adminEmails  = (ADMIN_EMAILS || []).map(e => String(e).trim().toLowerCase());
const isAdminEmail = (email) => adminEmails.includes(String(email || "").trim().toLowerCase());


/* ============================================================
   CONSTANTS
   ============================================================ */
const THEME_KEY = "pf_theme";
const LOC_KEY   = "pf_loc";
const LOW_STOCK = 10;
const MAX_RESERVE = 50;
const MAX_ACTIVE_HOLDS = 3;           // must match maxActiveHolds() in firestore.rules
const HOLD_HOURS = 24;                // unclaimed reservations are released after this
const HOLD_MS = HOLD_HOURS * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

const BASE_LOC = {
  lat: DEFAULT_LOCATION?.lat ?? 17.3850,
  lng: DEFAULT_LOCATION?.lng ?? 78.4867,
  label: DEFAULT_LOCATION?.label ?? "Hyderabad (city centre)",
};

const SAMPLE_MEDS = [
  ["Dolo 650",          "Paracetamol 650mg",      "Micro Labs"],
  ["Azithromycin 500",  "Azithromycin 500mg",     "Cipla"],
  ["Cetirizine 10",     "Cetirizine 10mg",        "Dr. Reddy's"],
  ["Amoxicillin 500",   "Amoxicillin 500mg",      "Sun Pharma"],
  ["Pantoprazole 40",   "Pantoprazole 40mg",      "Alkem"],
  ["ORS Powder",        "Oral Rehydration Salts", "FDC"],
  ["Vitamin C 500",     "Ascorbic Acid 500mg",    "HealthVit"],
  ["Metformin 500",     "Metformin 500mg",        "USV"],
  ["Amlodipine 5",      "Amlodipine 5mg",         "Torrent"],
  ["Ibuprofen 400",     "Ibuprofen 400mg",        "Abbott"],
];

const RES_STATUS = {
  pending:   { pill: "pending",   label: "Pending" },
  ready:     { pill: "ready",     label: "Ready for pickup" },
  collected: { pill: "collected", label: "Collected" },
  cancelled: { pill: "cancelled", label: "Cancelled" },
};
const ACTIVE_RES = ["pending", "ready"];

function statusInfo(r){
  if(r.status === "cancelled" && r.cancelledBy === "expired") return { pill: "cancelled", label: "Expired" };
  return RES_STATUS[r.status] || { pill: "neutral", label: esc(r.status) };
}

const ROLE_LABEL = { admin: "Admin", pharmacy: "Pharmacy", patient: "Patient" };
const ROLE_PILL  = { admin: "neutral", pharmacy: "approved", patient: "pending" };


/* ============================================================
   SMALL HELPERS
   ============================================================ */
const $     = (id) => document.getElementById(id);
const now   = () => Date.now();
const money = (n) => "₹" + Number(n || 0).toFixed(2);
const esc   = (s) => String(s ?? "").replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const shortId = (id) => "#" + String(id).slice(0, 8).toUpperCase();
const num     = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
const telHref = (p) => String(p || "").replace(/[^\d+]/g, "").slice(0, 16);

function lsGet(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } }
function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(_){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(_){} }

function stockState(q){
  if(q <= 0)         return { key: "out", label: "Out of stock" };
  if(q <= LOW_STOCK) return { key: "low", label: "Low stock" };
  return { key: "ok", label: "In stock" };
}

function haversineKm(a, b){
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function timeAgo(ts){
  if(!ts) return "—";
  const s = Math.floor((now() - ts) / 1000);
  if(s < 60)    return "just now";
  if(s < 3600)  return Math.floor(s / 60) + "m ago";
  if(s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function startOfToday(){ const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

function getBrowserLocation(){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation){ reject(new Error("Location isn't supported in this browser.")); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      e => reject(new Error(e.code === 1 ? "Location permission was denied." : "Couldn't get your location.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}


/* ============================================================
   THEME (light / dark / follow system)
   ============================================================ */
function applyTheme(t){
  if(t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}
function currentThemeIsDark(){
  const t = document.documentElement.getAttribute("data-theme");
  if(t) return t === "dark";
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function toggleTheme(){
  const next = currentThemeIsDark() ? "light" : "dark";
  applyTheme(next);
  lsSet(THEME_KEY, next);
  renderApp();
}
applyTheme(lsGet(THEME_KEY));


/* ============================================================
   LOCAL CACHE (kept live by onSnapshot listeners)
   ============================================================ */
let ME = null;   // { uid, role, name, email, phone, address }

const cache = {
  users: [], pharmacies: [], medicines: [], inventory: [],
  reservations: [], bills: [], notifications: [],
};

let listeners      = [];
let modalOpen      = false;
let pendingRefresh = false;
let signingUp      = false;   // true while a new account + profile is being created
let loaded         = {};      // collection key -> true once its first snapshot arrived
let expiring       = new Set();   // reservation ids being auto-released right now
let dirty          = new Set();   // input ids the user has typed in since the last navigation

const state = {
  view: null,
  authMode: "signin",     // "signin" | "signup"
  searchQuery: "",
  billDraft: [],          // [{ invId, qty }]
  loc: loadSavedLoc(),    // { lat, lng } from GPS (remembered), else BASE_LOC
  resTab: "active",       // pharmacy reservations tab
  salesTab: "bills",      // pharmacy sales tab
  orderTab: "active",     // admin orders tab
};


function loadSavedLoc(){
  try{
    const v = JSON.parse(localStorage.getItem(LOC_KEY) || "null");
    return v && num(v.lat) !== null && num(v.lng) !== null ? { lat: v.lat, lng: v.lng } : null;
  }catch(_){ return null; }
}
function saveLoc(loc){
  try{ loc ? localStorage.setItem(LOC_KEY, JSON.stringify(loc)) : localStorage.removeItem(LOC_KEY); }catch(_){}
}

/* ---------- Lookups ---------- */
const getUser    = (id) => cache.users.find(u => u.id === id);
const getMed     = (id) => cache.medicines.find(m => m.id === id);
const getPh      = (id) => cache.pharmacies.find(p => p.id === id);
const getInv     = (id) => cache.inventory.find(i => i.id === id);
const myPharmacy = () => ME ? cache.pharmacies.find(p => p.ownerUserId === ME.uid) : null;
const medName    = (id) => getMed(id)?.name || "a medicine";

function unreadCount(){
  return ME ? cache.notifications.filter(n => n.userId === ME.uid && !n.read).length : 0;
}

function patientLoc(){ return state.loc || BASE_LOC; }

function distanceTo(ph){
  if(!ph || !ph.locSet || num(ph.lat) === null || num(ph.lng) === null) return null;
  return haversineKm(patientLoc(), { lat: ph.lat, lng: ph.lng });
}

function myActiveHolds(){
  return ME ? cache.reservations.filter(r => r.patientId === ME.uid && ACTIVE_RES.includes(r.status)).length : 0;
}

function holdExpiresAt(r){ return (r.createdAt || 0) + HOLD_MS; }

function timeLeft(ms){
  if(ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

function heldQty(invId){
  return cache.reservations
    .filter(r => r.inventoryId === invId && ACTIVE_RES.includes(r.status))
    .reduce((s, r) => s + r.qty, 0);
}


/* ---------- Notifications (refId lets the rules verify who may notify whom) ---------- */
function notify(userId, text, refId = null){
  if(!userId) return;
  const data = { userId, text: String(text).slice(0, 280), read: false, createdAt: now(), fromUid: ME ? ME.uid : null };
  if(refId) data.refId = refId;
  addDoc(collection(db, "notifications"), data).catch(e => console.warn("notify failed", e));
}


/* ============================================================
   UI HELPERS — toast + modal
   ============================================================ */
function toast(msg, kind = ""){
  const box = $("toasts");
  while(box.children.length > 3) box.firstElementChild.remove();       // max 3 on screen
  if([...box.children].some(t => t.textContent === msg)) return;      // no duplicates
  while(box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.setAttribute("role", "status");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

let modalCloser = null;

function openModal(html){
  const root = $("modal-root");
  root.innerHTML = `<div class="modal-bg" data-modalbg><div class="modal">${html}</div></div>`;
  modalOpen = true;
  modalCloser = () => {
    root.innerHTML = "";
    modalCloser = null;
    modalOpen = false;
    if(pendingRefresh){ pendingRefresh = false; renderApp(); }
  };
  root.querySelector("[data-modalbg]").addEventListener("mousedown", (e) => {
    if(e.target.dataset.modalbg !== undefined) closeModal();
  });
  root.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
}

function closeModal(){ if(modalCloser) modalCloser(); }

document.addEventListener("keydown", (e) => { if(e.key === "Escape" && modalOpen) closeModal(); });

function confirmModal({ title, text, okLabel = "Confirm", danger = false }){
  return new Promise((resolve) => {
    let answered = false;
    openModal(`
      <h3>${esc(title)}</h3>
      <p class="sub">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" id="cf-no">Cancel</button>
        <button class="btn ${danger ? "danger" : "primary"}" id="cf-yes">${esc(okLabel)}</button>
      </div>`);
    const finish = (v) => { if(answered) return; answered = true; closeModal(); resolve(v); };
    $("cf-yes").onclick = () => finish(true);
    $("cf-no").onclick  = () => finish(false);
    const prev = modalCloser;
    modalCloser = () => { prev(); if(!answered){ answered = true; resolve(false); } };
  });
}

function refresh(){
  if(!ME) return;
  if(modalOpen){ pendingRefresh = true; return; }
  if(isTyping()){ pendingRefresh = true; return; }   // redraw when they leave the field
  renderApp();
  autoExpireHolds();
}

function isTyping(){
  const a = document.activeElement;
  return !!(a && $("main") && $("main").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.id !== "search-in");
}

// Track which inputs the user changed, so a live redraw can put their text back.
document.addEventListener("input", (e) => { if(e.target && e.target.id) dirty.add(e.target.id); });
document.addEventListener("focusout", () => {
  setTimeout(() => { if(pendingRefresh && !modalOpen && !isTyping()){ pendingRefresh = false; renderApp(); } }, 150);
});

function captureDirty(){
  const saved = {};
  dirty.forEach(id => { const el = $(id); if(el && "value" in el) saved[id] = el.value; });
  const a = document.activeElement;
  const focus = a && a.id && dirty.has(a.id) ? { id: a.id, pos: a.selectionStart } : null;
  return { saved, focus };
}

function restoreDirty({ saved, focus }){
  Object.entries(saved).forEach(([id, v]) => { const el = $(id); if(el && "value" in el) el.value = v; });
  if(focus){
    const el = $(focus.id);
    if(el){ el.focus(); try{ el.setSelectionRange(focus.pos, focus.pos); }catch(_){} }
  }
}


/* ============================================================
   REAL-TIME LISTENERS
   ============================================================ */
function teardownListeners(){
  listeners.forEach(unsub => { try{ unsub(); }catch(_){} });
  listeners = [];
  loaded = {};
  Object.keys(cache).forEach(k => cache[k] = []);
}

function allLoaded(){
  const keys = Object.keys(loaded);
  return keys.length > 0 && keys.every(k => loaded[k]);
}

function setupListeners(){
  teardownListeners();

  const sub = (q, key) => {
    loaded[key] = false;
    const unsub = onSnapshot(q,
      snap => { cache[key] = snap.docs.map(d => ({ id: d.id, ...d.data() })); loaded[key] = true; refresh(); },
      err  => { console.error("listener error [" + key + "]", err); loaded[key] = true; refresh(); });
    listeners.push(unsub);
  };

  // Watch my own profile: if an admin blocks or removes me, sign out right away.
  listeners.push(onSnapshot(doc(db, "users", ME.uid), snap => {
    if(!ME) return;
    if(!snap.exists() || snap.data().blocked){
      toast("Your account has been blocked by the admin.", "bad");
      logout();
      return;
    }
    const d = snap.data();
    if(d.role !== ME.role){ routeSignedIn(auth.currentUser); return; }   // admin changed my role
    Object.assign(ME, { name: d.name || "", phone: d.phone || "", address: d.address || "" });
  }, err => console.warn("profile watch", err)));

  const mine = (col, field) => query(collection(db, col), where(field, "==", ME.uid));

  sub(collection(db, "medicines"), "medicines");
  sub(collection(db, "inventory"), "inventory");
  sub(mine("notifications", "userId"), "notifications");

  if(ME.role === "patient"){
    sub(collection(db, "pharmacies"), "pharmacies");
    sub(mine("reservations", "patientId"), "reservations");
  }
  else if(ME.role === "pharmacy"){
    sub(mine("pharmacies", "ownerUserId"), "pharmacies");
    sub(mine("reservations", "pharmacyOwnerId"), "reservations");
    sub(mine("bills", "ownerUserId"), "bills");
  }
  else if(ME.role === "admin"){
    sub(collection(db, "users"), "users");
    sub(collection(db, "pharmacies"), "pharmacies");
    sub(collection(db, "reservations"), "reservations");
    sub(collection(db, "bills"), "bills");
  }
}


/* ============================================================
   SESSION LIFECYCLE
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
  if(user){
    if(signingUp) return;          // the sign-up handler routes once the profile is saved
    await routeSignedIn(user);
    return;
  }
  ME = null;
  teardownListeners();
  renderAuth(state.authMode);
});

async function routeSignedIn(user){
  let snap;
  try{ snap = await getDoc(doc(db, "users", user.uid)); }
  catch(e){
    console.error(e);
    renderLoading("Could not load your profile. Check your connection and refresh.");
    return;
  }

  if(!snap.exists()){ renderProfileSetup(user); return; }   // account exists but profile wasn't saved

  const d = snap.data();
  if(d.blocked){ renderBlocked(); return; }
  ME = {
    uid: user.uid, role: d.role, name: d.name || "",
    email: d.email || user.email, phone: d.phone || "", address: d.address || "",
  };
  state.view = null;
  state.searchQuery = "";
  state.billDraft = [];
  setupListeners();
  renderApp();
}

function renderBlocked(){
  ME = null;
  teardownListeners();
  $("root").innerHTML = `
    <div class="auth-wrap"><div class="auth-card" style="text-align:center">
      ${BRAND}
      <div style="font-size:40px; margin:16px 0 6px">⛔</div>
      <h3>Account blocked</h3>
      <p class="tag" style="margin-top:8px">This account has been blocked by the PharmaFind admin.
        If you think this is a mistake, contact the admin.</p>
      <button class="btn" id="bl-out" style="width:100%">Sign out</button>
    </div></div>`;
  $("bl-out").onclick = () => signOut(auth);
}

/* Saves a new profile. For the admin email this also records the one-time
   admin claim (meta/adminClaim) in the same batch, as the rules require. */
async function saveNewProfile(user, role, name){
  const email = String(user.email || "").toLowerCase();
  const profile = { role, name, email, phone: "", address: "", createdAt: now() };
  if(role !== "admin"){
    await setDoc(doc(db, "users", user.uid), profile);
    return;
  }
  const claim = await getDoc(doc(db, "meta", "adminClaim"));
  if(claim.exists()) throw Object.assign(new Error("admin-claimed"), { code: "admin-claimed" });
  const batch = writeBatch(db);
  batch.set(doc(db, "users", user.uid), profile);
  batch.set(doc(db, "meta", "adminClaim"), { uid: user.uid });
  await batch.commit();
}

function profileErrorText(e, role){
  if(e.code === "admin-claimed") return "The admin account has already been claimed. Ask the existing admin to give you access.";
  if(e.code === "permission-denied" && role === "admin") return "Admin email mismatch — this email must also be in adminEmails() in firestore.rules.";
  return "Saving your profile failed. Try again.";
}

function passwordProblem(pass){
  if(pass.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if(!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return "Password must include at least one letter and one number.";
  return "";
}

async function logout(){
  state.view = null;
  state.searchQuery = "";
  state.billDraft = [];
  state.loc = loadSavedLoc();      // location belongs to the device, keep it
  state.authMode = "signin";
  closeModal();
  await signOut(auth);
}


/* ============================================================
   AUTH SCREENS (email + password — no email verification)
   ============================================================ */
const BRAND = `<div class="brand"><span class="mark"><span>✚</span></span> PharmaFind</div>`;

function renderLoading(msg){
  $("root").innerHTML = `
    <div class="auth-wrap"><div class="auth-card" style="text-align:center">
      ${BRAND}
      <p class="tag" style="margin-top:14px">${esc(msg || "Loading…")}</p>
    </div></div>`;
}

function authErrorText(e){
  const map = {
    "auth/invalid-email":          "That email address doesn't look right.",
    "auth/missing-password":       "Enter your password.",
    "auth/invalid-credential":     "Wrong email or password.",
    "auth/wrong-password":         "Wrong email or password.",
    "auth/user-not-found":         "No account with that email — create one instead.",
    "auth/email-already-in-use":   "An account with this email already exists — sign in instead.",
    "auth/weak-password":          "That password is too weak — use at least 8 characters with a letter and a number.",
    "auth/requires-recent-login":  "For security, sign out and sign in again, then change your password.",
    "auth/missing-email":          "Enter your email.",
    "auth/password-does-not-meet-requirements": "That password doesn't meet the password policy. Try a longer one with a letter and a number.",
    "auth/too-many-requests":      "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed": "No internet connection.",
    "auth/operation-not-allowed":  "Email/Password sign-in isn't enabled in Firebase → Authentication → Sign-in method.",
  };
  return map[e && e.code] || "Something went wrong. Try again.";
}

function passwordField(id, label, autocomplete){
  return `
    <label class="fld"><span class="lab">${label}</span>
      <div class="row" style="flex-wrap:nowrap; gap:6px">
        <input class="input" id="${id}" type="password" autocomplete="${autocomplete}" placeholder="••••••••">
        <button class="btn sm ghost" type="button" data-eye="${id}" title="Show / hide">👁</button>
      </div></label>`;
}

function wireEyes(){
  $("root").querySelectorAll("[data-eye]").forEach(b => b.onclick = () => {
    const el = $(b.dataset.eye);
    el.type = el.type === "password" ? "text" : "password";
  });
}

function renderAuth(mode = "signin"){
  state.authMode = mode;
  const signup = mode === "signup";

  $("root").innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        ${BRAND}
        <div class="tag">Find medicines in stock near you.</div>

        <div class="seg">
          <button id="tab-in"  class="${signup ? "" : "active"}">Sign in</button>
          <button id="tab-up"  class="${signup ? "active" : ""}">Create account</button>
        </div>

        ${signup ? `
          <label class="fld"><span class="lab">Full name</span>
            <input class="input" id="au-name" placeholder="Your name" autocomplete="name"></label>` : ""}

        <label class="fld"><span class="lab">Email</span>
          <input class="input" id="au-email" type="email" placeholder="you@example.com" autocomplete="email"></label>

        ${passwordField("au-pass", "Password", signup ? "new-password" : "current-password")}
        ${signup ? `<p style="font-size:12px; color:var(--muted); margin:-8px 0 14px">At least ${MIN_PASSWORD} characters, with a letter and a number.</p>` : ""}

        ${signup ? `
          ${passwordField("au-pass2", "Confirm password", "new-password")}
          <div id="au-rolebox">
            <label class="fld"><span class="lab">I am a…</span>
              <select class="input" id="au-role">
                <option value="patient">Patient — I want to find medicines</option>
                <option value="pharmacy">Pharmacy — I want to list my store</option>
              </select></label>
            <div id="au-ph"></div>
          </div>
          <div class="hint" id="au-adminnote" style="display:none; margin:0 0 14px">
            <b>Admin account.</b> This email is on the admin list, so you'll manage the whole network.</div>` : ""}

        <div class="err" id="au-err"></div>
        <button class="btn primary" id="au-go" style="width:100%">${signup ? "Create account" : "Sign in"}</button>

        ${signup ? "" : `<p style="text-align:center; margin:14px 0 0">
          <a href="#" id="au-forgot" style="font-size:13px">Forgot password?</a></p>`}
      </div>
    </div>`;

  $("tab-in").onclick = () => renderAuth("signin");
  $("tab-up").onclick = () => renderAuth("signup");
  wireEyes();

  const holder = { loc: null };

  if(signup){
    const roleSel = $("au-role");
    const drawPh = () => {
      $("au-ph").innerHTML = roleSel.value === "pharmacy" ? storeFieldsHtml("au") : "";
      if(roleSel.value === "pharmacy") wireStoreLocation("au", holder);
    };
    roleSel.onchange = drawPh;
    drawPh();

    // If the typed email is an admin email, hide the role picker
    $("au-email").oninput = () => {
      const admin = isAdminEmail($("au-email").value);
      $("au-rolebox").style.display = admin ? "none" : "";
      $("au-adminnote").style.display = admin ? "" : "none";
    };
    $("au-name").focus();
  } else {
    $("au-email").focus();
    $("au-forgot").onclick = (e) => { e.preventDefault(); forgotPassword(); };
  }

  const submit = () => signup ? doSignUp(holder) : doSignIn();
  $("au-go").onclick = submit;
  $("root").querySelectorAll(".auth-card input").forEach(el => {
    el.onkeydown = e => { if(e.key === "Enter") submit(); };
  });
}

async function doSignIn(){
  const err = $("au-err");
  err.textContent = "";
  const email = $("au-email").value.trim();
  const pass  = $("au-pass").value;
  if(!email || !pass){ err.textContent = "Enter your email and password."; return; }

  const btn = $("au-go");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try{
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged takes it from here
  }catch(e){
    console.error(e);
    err.textContent = authErrorText(e);
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

async function doSignUp(holder){
  const err = $("au-err");
  err.textContent = "";

  const name  = $("au-name").value.trim().slice(0, 80);
  const email = $("au-email").value.trim().toLowerCase();
  const pass  = $("au-pass").value;
  const pass2 = $("au-pass2").value;
  const admin = isAdminEmail(email);
  const role  = admin ? "admin" : $("au-role").value;

  if(!name){ err.textContent = "Please enter your name."; return; }
  if(!/^\S+@\S+\.\S+$/.test(email)){ err.textContent = "Enter a valid email address."; return; }
  const weak = passwordProblem(pass);
  if(weak){ err.textContent = weak; return; }
  if(pass !== pass2){ err.textContent = "Passwords don't match."; return; }

  const store = role === "pharmacy" ? readStoreFields("au", name, holder) : null;

  const btn = $("au-go");
  btn.disabled = true;
  btn.textContent = "Creating account…";

  signingUp = true;
  let cred;
  try{
    cred = await createUserWithEmailAndPassword(auth, email, pass);
  }catch(e){
    signingUp = false;
    console.error(e);
    err.textContent = authErrorText(e);
    btn.disabled = false;
    btn.textContent = "Create account";
    return;
  }

  try{
    await saveNewProfile(cred.user, role, name);
    if(store) await createStore(cred.user.uid, store);
    toast("Account created — welcome!", "good");
  }catch(e){
    console.error(e);
    toast(profileErrorText(e, role) + (e.code === "admin-claimed" ? "" : " Finish it on the next screen."), "bad");
  }finally{
    signingUp = false;
  }
  await routeSignedIn(cred.user);
}

function forgotPassword(){
  const typed = $("au-email") ? $("au-email").value.trim() : "";
  openModal(`
    <h3>Forgot password?</h3>
    <p class="sub">Enter the email you signed up with. We'll email you a link to choose a new password.</p>
    <label class="fld"><span class="lab">Email</span>
      <input class="input" id="fp-email" type="email" autocomplete="email" value="${esc(typed)}" placeholder="you@example.com"></label>
    <div class="err" id="fp-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="fp-go">Send reset link</button>
    </div>`);
  const emailEl = $("fp-email");
  emailEl.focus();

  const send = async () => {
    const email = emailEl.value.trim();
    const err = $("fp-err");
    err.textContent = "";
    if(!/^\S+@\S+\.\S+$/.test(email)){ err.textContent = "Enter a valid email address."; return; }

    const btn = $("fp-go");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try{
      await sendPasswordResetEmail(auth, email);
      openModal(`
        <div style="text-align:center">
          <div style="font-size:40px; margin-bottom:6px">📧</div>
          <h3>Check your inbox</h3>
          <p class="sub" style="margin-top:6px">If an account exists for <b>${esc(email)}</b>, a password-reset link is on its way.</p>
        </div>
        <ol style="font-size:13.5px; color:var(--muted); line-height:1.8; padding-left:20px; margin:0 0 16px">
          <li>Open the email from PharmaFind (check <b>spam / promotions</b> too).</li>
          <li>Click the link and type your new password.</li>
          <li>Come back here and sign in with it.</li>
        </ol>
        <button class="btn primary" style="width:100%" data-close>Back to sign in</button>`);
    }catch(e){
      console.error(e);
      err.textContent = authErrorText(e);
      btn.disabled = false;
      btn.textContent = "Send reset link";
    }
  };
  $("fp-go").onclick = send;
  emailEl.onkeydown = e => { if(e.key === "Enter") send(); };
}


/* ============================================================
   FIRST-TIME PROFILE SETUP
   ============================================================ */
function storeFieldsHtml(prefix){
  return `
    <label class="fld"><span class="lab">Pharmacy name</span>
      <input class="input" id="${prefix}-phname" placeholder="e.g. City Care Pharmacy"></label>
    <label class="fld"><span class="lab">Address / area</span>
      <input class="input" id="${prefix}-phaddr" placeholder="e.g. Kukatpally, Hyderabad"></label>
    <label class="fld"><span class="lab">Opening hours</span>
      <input class="input" id="${prefix}-phhours" placeholder="e.g. 9:00 AM – 9:00 PM"></label>
    <label class="fld"><span class="lab">Store phone (shown to patients)</span>
      <input class="input" id="${prefix}-phphone" type="tel" placeholder="e.g. +91 40 1234 5678" maxlength="20"></label>
    <div class="row" style="margin-bottom:14px">
      <button class="btn sm" id="${prefix}-loc" type="button">📍 Use my current location for the store</button>
      <span id="${prefix}-locmsg" style="font-size:12.5px; color:var(--muted)">Optional — you can set it later.</span>
    </div>`;
}

function wireStoreLocation(prefix, holder){
  $(prefix + "-loc").onclick = async () => {
    const msg = $(prefix + "-locmsg");
    msg.textContent = "Getting location…";
    try{
      holder.loc = await getBrowserLocation();
      msg.textContent = `✓ Saved (${holder.loc.lat.toFixed(4)}, ${holder.loc.lng.toFixed(4)})`;
    }catch(e){ msg.textContent = e.message; }
  };
}

function readStoreFields(prefix, fallbackName, holder){
  return {
    name:    ($(prefix + "-phname").value.trim()  || fallbackName + "'s Pharmacy").slice(0, 80),
    address: ($(prefix + "-phaddr").value.trim()  || "Hyderabad").slice(0, 160),
    hours:   ($(prefix + "-phhours").value.trim() || "9:00 AM – 9:00 PM").slice(0, 60),
    phone:   $(prefix + "-phphone").value.trim().slice(0, 20),
    lat:     holder.loc ? holder.loc.lat : BASE_LOC.lat,
    lng:     holder.loc ? holder.loc.lng : BASE_LOC.lng,
    locSet:  !!holder.loc,
  };
}

// One store per pharmacy account: the store's document id IS the owner's uid.
async function createStore(uid, fields){
  return setDoc(doc(db, "pharmacies", uid), {
    ownerUserId: uid, ...fields, status: "pending", createdAt: now(),
  });
}

function renderProfileSetup(user){
  const forcedAdmin = isAdminEmail(user.email);
  const holder = { loc: null };

  $("root").innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        ${BRAND}
        <div class="tag">Welcome! Let's set up your account.</div>
        <p style="font-size:13px; color:var(--muted); margin:-6px 0 16px; text-align:center">
          Signed in as <b>${esc(user.email)}</b></p>

        <label class="fld"><span class="lab">Your full name</span>
          <input class="input" id="ps-name" placeholder="Your name"></label>

        ${forcedAdmin ? `
          <div class="hint" style="margin:0 0 16px"><b>Admin account.</b> Your email is on the admin list, so you'll manage the whole network.</div>
        ` : `
          <label class="fld"><span class="lab">I am a…</span>
            <select class="input" id="ps-role">
              <option value="patient">Patient — I want to find medicines</option>
              <option value="pharmacy">Pharmacy — I want to list my store</option>
            </select></label>
          <div id="ps-ph"></div>
        `}

        <div class="err" id="ps-err"></div>
        <button class="btn primary" id="ps-go" style="width:100%">Create my account</button>
        <button class="btn ghost" id="ps-cancel" style="width:100%; margin-top:8px">Sign out</button>
      </div>
    </div>`;

  if(!forcedAdmin){
    const roleSel = $("ps-role");
    const drawPh = () => {
      $("ps-ph").innerHTML = roleSel.value === "pharmacy" ? storeFieldsHtml("ps") : "";
      if(roleSel.value === "pharmacy") wireStoreLocation("ps", holder);
    };
    roleSel.onchange = drawPh;
    drawPh();
  }

  $("ps-cancel").onclick = logout;
  $("ps-name").focus();

  $("ps-go").onclick = async () => {
    const err = $("ps-err");
    err.textContent = "";
    const name = $("ps-name").value.trim();
    if(!name){ err.textContent = "Please enter your name."; return; }

    const role  = forcedAdmin ? "admin" : $("ps-role").value;
    const store = role === "pharmacy" ? readStoreFields("ps", name, holder) : null;

    const btn = $("ps-go");
    btn.disabled = true;
    btn.textContent = "Creating…";

    try{
      await saveNewProfile(user, role, name.slice(0, 80));
      if(store) await createStore(user.uid, store);
      await routeSignedIn(user);
      toast("Account created — welcome!", "good");
    }catch(e){
      console.error(e);
      err.textContent = profileErrorText(e, role);
      btn.disabled = false;
      btn.textContent = "Create my account";
    }
  };
}


/* ============================================================
   APP SHELL
   ============================================================ */
const NAV = {
  patient: [
    { v: "search",       ic: "🔍", label: "Find medicine" },
    { v: "reservations", ic: "🏷️", label: "My reservations" },
    { v: "profile",      ic: "👤", label: "My profile" },
  ],
  pharmacy: [
    { v: "ph-dash",         ic: "📊", label: "Dashboard" },
    { v: "ph-inventory",    ic: "📦", label: "Inventory" },
    { v: "ph-billing",      ic: "🧾", label: "New bill" },
    { v: "ph-reservations", ic: "🏷️", label: "Reservations" },
    { v: "ph-sales",        ic: "💰", label: "Sales history" },
    { v: "ph-settings",     ic: "⚙️", label: "Store settings" },
    { v: "profile",         ic: "👤", label: "My profile" },
  ],
  admin: [
    { v: "ad-dash",       ic: "📊", label: "Overview" },
    { v: "ad-approvals",  ic: "✅", label: "Approvals" },
    { v: "ad-pharmacies", ic: "🏥", label: "Pharmacies" },
    { v: "ad-orders",     ic: "🏷️", label: "Reservations" },
    { v: "ad-medicines",  ic: "💊", label: "Medicine catalog" },
    { v: "ad-accounts",   ic: "👥", label: "Accounts" },
    { v: "profile",       ic: "👤", label: "My profile" },
  ],
};

const DEFAULT_VIEW = { patient: "search", pharmacy: "ph-dash", admin: "ad-dash" };

function navCount(v){
  if(ME.role === "admin" && v === "ad-approvals"){
    return cache.pharmacies.filter(p => p.status === "pending").length;
  }
  if(ME.role === "pharmacy" && v === "ph-reservations"){
    const ph = myPharmacy();
    return ph ? cache.reservations.filter(r => r.pharmacyId === ph.id && r.status === "pending").length : 0;
  }
  if(ME.role === "patient" && v === "reservations"){
    return cache.reservations.filter(r => r.status === "ready").length;
  }
  return 0;
}

function go(view){ state.view = view; dirty.clear(); renderApp(); }

function renderApp(){
  if(!ME){ renderAuth(); return; }
  const nav = NAV[ME.role] || NAV.patient;
  if(!state.view || !nav.some(n => n.v === state.view)) state.view = DEFAULT_VIEW[ME.role] || "search";

  const navItems = nav.map(n => {
    const c = navCount(n.v);
    return `<button class="navitem ${state.view === n.v ? "active" : ""}" data-view="${n.v}">
      <span class="ic">${n.ic}</span> ${n.label} ${c ? `<span class="count">${c}</span>` : ""}</button>`;
  }).join("");

  const unread = unreadCount();
  const keep = captureDirty();

  $("root").innerHTML = `
    <div class="topbar">
      ${BRAND}
      <span class="role-chip">${ROLE_LABEL[ME.role] || ME.role}</span>
      <div class="spacer"></div>
      <button class="icon-btn" id="btn-theme" title="Toggle theme" aria-label="Toggle light or dark theme">${currentThemeIsDark() ? "☀️" : "🌙"}</button>
      <button class="icon-btn" id="btn-notif" title="Notifications" aria-label="Notifications${unread ? `, ${unread} unread` : ""}">🔔${unread ? `<span class="badge-dot" aria-hidden="true">${unread}</span>` : ""}</button>
      <div class="who"><b>${esc(ME.name)}</b><span class="sub">${esc(ME.email)}</span></div>
      <button class="icon-btn" id="btn-logout" title="Sign out" aria-label="Sign out">⏻</button>
    </div>
    <div class="app">
      <aside class="side">
        <div class="navlabel">Menu</div>
        ${navItems}
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  $("root").querySelectorAll("[data-view]").forEach(b => b.onclick = () => go(b.dataset.view));
  $("btn-logout").onclick = logout;
  $("btn-notif").onclick  = openNotifications;
  $("btn-theme").onclick  = toggleTheme;

  // Until every live collection has sent its first data, show a loader —
  // never a misleading "empty" screen (which could, e.g., offer "Register my store").
  if(!allLoaded()){
    $("main").innerHTML = `<div class="empty" style="margin-top:40px"><div class="big">⏳</div><h3>Loading your data…</h3></div>`;
    return;
  }

  renderView();
  restoreDirty(keep);
}

function renderView(){
  const map = {
    "search": viewSearch,
    "reservations": viewPatientReservations,
    "profile": viewProfile,
    "ph-dash": viewPhDash,
    "ph-inventory": viewPhInventory,
    "ph-billing": viewPhBilling,
    "ph-reservations": viewPhReservations,
    "ph-sales": viewPhSales,
    "ph-settings": viewPhSettings,
    "ad-dash": viewAdDash,
    "ad-approvals": viewAdApprovals,
    "ad-pharmacies": viewAdPharmacies,
    "ad-orders": viewAdOrders,
    "ad-medicines": viewAdMedicines,
    "ad-accounts": viewAdAccounts,
  };
  (map[state.view] || viewSearch)();
}

function bindGo(){
  $("main").querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
}


/* ---------- Notifications panel ---------- */
function openNotifications(){
  const mine = cache.notifications
    .filter(n => n.userId === ME.uid)
    .sort((a, b) => b.createdAt - a.createdAt);

  const body = mine.length
    ? mine.map(n => `
        <div class="notif ${n.read ? "read" : ""}">
          <div class="nd"></div>
          <div><div class="nt">${esc(n.text)}</div><div class="nm">${timeAgo(n.createdAt)}</div></div>
        </div>`).join("")
    : `<div class="empty"><div class="big">🔔</div><h3>No notifications</h3><p>Updates about your account show up here.</p></div>`;

  openModal(`
    <div class="row between" style="margin-bottom:12px">
      <h3>Notifications</h3>
      ${mine.some(n => !n.read) ? `<button class="btn sm ghost" id="mark-read">Mark all read</button>` : ""}
    </div>
    <div style="max-height:60vh; overflow:auto">${body}</div>
    ${mine.length ? `<button class="btn ghost sm" id="clear-notifs" style="margin-top:10px">Clear all</button>` : ""}
    <button class="btn" style="width:100%; margin-top:12px" data-close>Close</button>`);

  const mr = $("mark-read");
  if(mr) mr.onclick = async () => {
    const unread = mine.filter(n => !n.read);
    closeModal();
    await Promise.all(unread.map(n => updateDoc(doc(db, "notifications", n.id), { read: true }).catch(() => {})));
  };

  const cl = $("clear-notifs");
  if(cl) cl.onclick = async () => {
    closeModal();
    await Promise.all(mine.map(n => deleteDoc(doc(db, "notifications", n.id)).catch(() => {})));
    toast("Notifications cleared.");
  };
}


/* ============================================================
   SHARED: profile page (all roles)
   ============================================================ */
async function changePassword(){
  const err = $("cp-err");
  err.textContent = "";
  const oldPass = $("cp-old").value;
  const newPass = $("cp-new").value;
  const newPass2 = $("cp-new2").value;

  if(!oldPass){ err.textContent = "Enter your current password."; return; }
  const weak = passwordProblem(newPass);
  if(weak){ err.textContent = weak; return; }
  if(newPass !== newPass2){ err.textContent = "The new passwords don't match."; return; }
  if(newPass === oldPass){ err.textContent = "The new password must be different from the current one."; return; }

  const user = auth.currentUser;
  if(!user){ err.textContent = "You're signed out. Sign in again."; return; }

  const btn = $("cp-save");
  btn.disabled = true;
  btn.textContent = "Updating…";
  try{
    // Firebase requires proof you know the current password before changing it
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, oldPass));
    await updatePassword(user, newPass);
    ["cp-old", "cp-new", "cp-new2"].forEach(id => { $(id).value = ""; dirty.delete(id); });
    toast("Password updated. Use the new one next time you sign in.", "good");
  }catch(e){
    console.error(e);
    err.textContent = (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password")
      ? "Your current password is wrong."
      : authErrorText(e);
  }finally{
    btn.disabled = false;
    btn.textContent = "Update password";
  }
}

function viewProfile(){
  $("main").innerHTML = `
    <div class="page-head"><h2>My profile</h2><p>Your personal details.</p></div>
    <div class="card" style="max-width:520px">
      <label class="fld"><span class="lab">Email (sign-in ID — can't change)</span>
        <input class="input" value="${esc(ME.email)}" disabled></label>
      <label class="fld"><span class="lab">Full name</span>
        <input class="input" id="pf-name" value="${esc(ME.name)}"></label>
      <label class="fld"><span class="lab">Phone number</span>
        <input class="input" id="pf-phone" value="${esc(ME.phone)}" placeholder="e.g. +91 90000 00000"></label>
      <label class="fld"><span class="lab">Address</span>
        <input class="input" id="pf-addr" value="${esc(ME.address)}" placeholder="Your address / area"></label>
      <div class="err" id="pf-err"></div>
      <button class="btn primary" id="pf-save">Save changes</button>
    </div>

    <div class="card" style="max-width:520px">
      <h3 style="margin-bottom:4px">Change password</h3>
      <p style="color:var(--muted); font-size:13.5px; margin:0 0 16px">
        Enter your current password, then the new one twice. At least ${MIN_PASSWORD} characters, with a letter and a number.</p>
      ${passwordField("cp-old", "Current password", "current-password")}
      ${passwordField("cp-new", "New password", "new-password")}
      ${passwordField("cp-new2", "Confirm new password", "new-password")}
      <div class="err" id="cp-err"></div>
      <div class="row">
        <button class="btn primary" id="cp-save">Update password</button>
        <a href="#" id="cp-forgot" style="font-size:13px">Forgot your current password?</a>
      </div>
    </div>`;

  $("main").querySelectorAll("[data-eye]").forEach(b => b.onclick = () => {
    const el = $(b.dataset.eye);
    el.type = el.type === "password" ? "text" : "password";
  });
  $("cp-save").onclick = changePassword;
  $("cp-forgot").onclick = async (e) => {
    e.preventDefault();
    const ok = await confirmModal({
      title: "Send a reset link?",
      text: `We'll email a password-reset link to ${ME.email}. Open it, choose a new password, then sign in again.`,
      okLabel: "Send link",
    });
    if(!ok) return;
    try{
      await sendPasswordResetEmail(auth, ME.email);
      toast("Reset link sent — check your inbox (and spam).", "good");
    }catch(err){ console.error(err); toast(authErrorText(err), "bad"); }
  };

  $("pf-save").onclick = async () => {
    const name    = $("pf-name").value.trim();
    const phone   = $("pf-phone").value.trim();
    const address = $("pf-addr").value.trim();
    if(!name){ $("pf-err").textContent = "Name can't be empty."; return; }

    const btn = $("pf-save");
    btn.disabled = true;
    try{
      await updateDoc(doc(db, "users", ME.uid), { name, phone, address });
      Object.assign(ME, { name, phone, address });
      toast("Profile updated.", "good");
      renderApp();
    }catch(e){
      console.error(e);
      $("pf-err").textContent = "Could not save. Try again.";
      btn.disabled = false;
    }
  };
}


/* ============================================================
   PATIENT — search
   ============================================================ */
function searchRows(q){
  const matchMeds = cache.medicines.filter(m =>
    (m.name || "").toLowerCase().includes(q) || (m.generic || "").toLowerCase().includes(q));

  const rows = [];
  matchMeds.forEach(m => {
    cache.inventory.filter(i => i.medicineId === m.id).forEach(i => {
      const ph = getPh(i.pharmacyId);
      if(!ph || ph.status !== "approved") return;
      rows.push({ med: m, inv: i, ph, dist: distanceTo(ph) });
    });
  });

  rows.sort((a, b) => {
    const ia = a.inv.quantity > 0 ? 0 : 1, ib = b.inv.quantity > 0 ? 0 : 1;
    if(ia !== ib) return ia - ib;                                  // in stock first
    const da = a.dist ?? Infinity, dbb = b.dist ?? Infinity;
    if(da !== dbb) return da - dbb;                                // then nearest
    return a.inv.price - b.inv.price;                              // then cheapest
  });
  return rows;
}

function mapLink(ph){
  const lat = num(ph.lat), lng = num(ph.lng);
  const q = (ph.locSet && lat !== null && lng !== null)
    ? `${lat},${lng}`
    : encodeURIComponent(`${ph.name || ""} ${ph.address || ""}`);
  return "https://www.google.com/maps/search/?api=1&query=" + q;
}

function phoneLink(ph){
  const t = telHref(ph && ph.phone);
  return t ? `<a href="tel:${esc(t)}">📞 ${esc(ph.phone)}</a>` : "";
}

function resultCard(r){
  const ss = stockState(r.inv.quantity);
  const canReserve = r.inv.quantity > 0;
  const dist = r.dist === null ? "distance unknown" : `${r.dist.toFixed(1)} km`;

  return `
    <div class="result">
      <div class="ph-ic">🏥</div>
      <div class="body">
        <div class="name">${esc(r.ph.name)}</div>
        <div style="font-size:14px; margin-top:2px"><b>${esc(r.med.name)}</b> · <span style="color:var(--muted)">${esc(r.med.generic)}</span></div>
        <div class="meta">
          <span>📍 ${dist} · ${esc(r.ph.address)}</span>
          <span>🕒 ${esc(r.ph.hours)}</span>
          ${phoneLink(r.ph)}
          <a href="${esc(mapLink(r.ph))}" target="_blank" rel="noopener noreferrer">Directions ↗</a>
        </div>
      </div>
      <div class="right">
        <div class="price">${money(r.inv.price)}</div>
        <span class="pill ${ss.key}">${ss.label}${canReserve ? ` · ${r.inv.quantity}` : ""}</span>
        <button class="btn ${canReserve ? "primary" : ""} sm" data-reserve="${esc(r.inv.id)}" ${canReserve ? "" : "disabled"}>
          ${canReserve ? "Reserve & pay" : "Unavailable"}</button>
      </div>
    </div>`;
}

function searchResultsHtml(){
  const q = state.searchQuery.trim().toLowerCase();
  if(!q){
    return `
      <div class="empty"><div class="big">💊</div>
        <h3>Search for a medicine</h3>
        <p>Type a brand or generic name — e.g. <b>Dolo</b>, <b>Paracetamol</b>, <b>Azithromycin</b>.</p></div>`;
  }
  const rows = searchRows(q);
  return rows.length
    ? `<p style="color:var(--muted); font-size:13px; margin:0 0 10px">${rows.length} result${rows.length !== 1 ? "s" : ""} · in stock first, then nearest</p>`
      + rows.map(resultCard).join("")
    : `<div class="empty"><div class="big">😕</div>
        <h3>No pharmacy has "${esc(state.searchQuery)}" listed</h3>
        <p>Try another name or the generic salt — stock updates live as pharmacies bill and restock.</p></div>`;
}

function renderSearchResults(){
  const box = $("search-results");
  if(!box) return;
  box.innerHTML = searchResultsHtml();
  box.querySelectorAll("[data-reserve]").forEach(b => b.onclick = () => reserveMedicine(b.dataset.reserve));
}

let searchTimer = null;

function viewSearch(){
  const holds = myActiveHolds();
  const locText = state.loc
    ? `📍 Using your location (${state.loc.lat.toFixed(3)}, ${state.loc.lng.toFixed(3)})`
    : `📍 Distances from ${esc(BASE_LOC.label)}`;

  $("main").innerHTML = `
    <div class="page-head"><h2>Find medicine</h2>
      <p>Live stock from approved pharmacies. Reserving holds the medicine for you for ${HOLD_HOURS} hours.</p></div>
    <div class="card" style="padding:14px; margin-bottom:18px">
      <div class="row">
        <input class="input grow" id="search-in" type="search" aria-label="Search a medicine"
          placeholder="Search a medicine — name or salt…" value="${esc(state.searchQuery)}" autocomplete="off">
        <button class="btn primary" id="search-go">Search</button>
      </div>
      <div class="locbar">
        <span>${locText}</span>
        <button class="btn sm ghost" id="loc-btn">${state.loc ? "Refresh location" : "Use my location"}</button>
        ${state.loc ? `<button class="btn sm ghost" id="loc-reset">Reset</button>` : ""}
        <span style="margin-left:auto">🏷️ Active reservations: <b>${holds}/${MAX_ACTIVE_HOLDS}</b></span>
      </div>
    </div>
    <div id="search-results"></div>`;

  renderSearchResults();

  const inEl = $("search-in");
  const run = () => { clearTimeout(searchTimer); state.searchQuery = inEl.value; renderSearchResults(); };
  $("search-go").onclick = run;
  inEl.onkeydown = e => { if(e.key === "Enter") run(); };
  inEl.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 250); };   // live search

  $("loc-btn").onclick = async () => {
    const b = $("loc-btn");
    b.disabled = true;
    b.textContent = "Locating…";
    try{
      state.loc = await getBrowserLocation();
      saveLoc(state.loc);
      toast("Location saved — sorting by real distance.", "good");
    }catch(e){ toast(e.message, "bad"); }
    viewSearch();
  };
  const lr = $("loc-reset");
  if(lr) lr.onclick = () => { state.loc = null; saveLoc(null); viewSearch(); };
}


/* ============================================================
   PATIENT — reserve → mock payment → transaction (holds stock)
   ============================================================ */
function reserveMedicine(invId){
  const inv = getInv(invId);
  if(!inv || inv.quantity <= 0){ toast("That item just went out of stock.", "bad"); viewSearch(); return; }
  const med = getMed(inv.medicineId), ph = getPh(inv.pharmacyId);
  if(!med || !ph){ toast("That listing is no longer available.", "bad"); return; }
  if(myActiveHolds() >= MAX_ACTIVE_HOLDS){
    toast(`You can have at most ${MAX_ACTIVE_HOLDS} active reservations. Collect or cancel one first.`, "bad");
    return;
  }

  const max = Math.min(inv.quantity, MAX_RESERVE);

  openModal(`
    <h3>Reserve ${esc(med.name)}</h3>
    <p class="sub">at ${esc(ph.name)} · ${money(inv.price)} each</p>
    <label class="fld"><span class="lab">Quantity (max ${max})</span>
      <input class="input" id="res-qty" type="number" min="1" max="${max}" value="1"></label>
    <div class="cart-total"><span>To pay</span><span class="t" id="res-total">${money(inv.price)}</span></div>
    <p style="font-size:12.5px; color:var(--muted); margin:10px 0 0">
      The pharmacy holds this stock for you once you pay. Cancel any time before they mark it ready and it's returned to stock.</p>
    <div class="err" id="res-err" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="res-pay">Continue to payment</button>
    </div>`);

  const qtyEl = $("res-qty");
  qtyEl.oninput = () => {
    const q = Math.max(1, parseInt(qtyEl.value, 10) || 1);
    $("res-total").textContent = money(inv.price * q);
  };

  $("res-pay").onclick = () => {
    const qty = parseInt(qtyEl.value, 10);
    if(!qty || qty < 1){ $("res-err").textContent = "Enter a valid quantity."; return; }
    if(qty > max){ $("res-err").textContent = `You can reserve up to ${max}.`; return; }
    openPayment(inv.id, med, ph, qty);
  };
}

function openPayment(invId, med, ph, qty){
  const inv = getInv(invId);
  const total = inv.price * qty;

  openModal(`
    <h3>Payment</h3>
    <p class="sub">${qty} × ${esc(med.name)} at ${esc(ph.name)}</p>
    <div class="hint" style="margin:0 0 16px">🧪 <b>Demo payment</b> — mock screen, no real card is charged. Type any numbers.</div>

    <label class="fld"><span class="lab">Card number</span>
      <input class="input" id="pay-card" inputmode="numeric" placeholder="4111 1111 1111 1111" maxlength="19"></label>
    <div class="row">
      <label class="fld grow"><span class="lab">Expiry (MM/YY)</span>
        <input class="input" id="pay-exp" placeholder="12/28" maxlength="5"></label>
      <label class="fld grow"><span class="lab">CVV</span>
        <input class="input" id="pay-cvv" inputmode="numeric" placeholder="123" maxlength="3"></label>
    </div>
    <label class="fld"><span class="lab">Name on card</span>
      <input class="input" id="pay-name" value="${esc(ME.name)}"></label>

    <div class="cart-total"><span>Amount</span><span class="t">${money(total)}</span></div>
    <div class="err" id="pay-err" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn money" id="pay-go">Pay ${money(total)}</button>
    </div>`);

  const cardEl = $("pay-card");
  cardEl.oninput = () => {
    const v = cardEl.value.replace(/\D/g, "").slice(0, 16);
    cardEl.value = v.replace(/(.{4})/g, "$1 ").trim();
  };
  const expEl = $("pay-exp");
  expEl.oninput = () => {
    let v = expEl.value.replace(/\D/g, "").slice(0, 4);
    if(v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
    expEl.value = v;
  };

  $("pay-go").onclick = async () => {
    const err  = $("pay-err");
    const card = cardEl.value.replace(/\s/g, "");
    const exp  = expEl.value.trim();
    const cvv  = $("pay-cvv").value.trim();
    err.textContent = "";

    if(card.length < 12){ err.textContent = "Enter a card number (any 12–16 digits)."; return; }
    if(!/^(0[1-9]|1[0-2])\/\d{2}$/.test(exp)){ err.textContent = "Enter expiry as MM/YY."; return; }
    if(!/^\d{3}$/.test(cvv)){ err.textContent = "Enter the 3-digit CVV."; return; }

    const btn = $("pay-go");
    btn.disabled = true;
    btn.textContent = "Processing…";
    await new Promise(r => setTimeout(r, 1000));

    const paymentRef = "PAY-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const resRef = doc(collection(db, "reservations"));
    let paid = 0;

    try{
      await runTransaction(db, async (tx) => {
        const invRef   = doc(db, "inventory", invId);
        const holdsRef = doc(db, "holds", ME.uid);
        const s = await tx.get(invRef);
        const h = await tx.get(holdsRef);
        if(!s.exists()) throw new Error("This item is no longer listed.");
        const d = s.data();
        if(d.quantity < qty) throw new Error(d.quantity > 0 ? `Only ${d.quantity} left now.` : "It just went out of stock.");
        const activeNow = h.exists() ? (h.data().active || 0) : 0;
        if(activeNow >= MAX_ACTIVE_HOLDS) throw new Error(`You already have ${MAX_ACTIVE_HOLDS} active reservations.`);

        paid = d.price * qty;

        tx.update(invRef, { quantity: d.quantity - qty, lastHold: resRef.id });
        tx.set(holdsRef, { active: activeNow + 1, lastRes: resRef.id });
        tx.set(resRef, {
          patientId: ME.uid, patientName: ME.name, patientPhone: ME.phone || "",
          pharmacyId: d.pharmacyId, pharmacyOwnerId: ph.ownerUserId,
          inventoryId: invId, medicineId: d.medicineId,
          qty, unitPrice: d.price,
          status: "pending",
          paid: true, amountPaid: paid, paymentRef,
          createdAt: now(), updatedAt: now(),
        });
      });
    }catch(e){
      console.error(e);
      err.textContent = (e.message && !e.code)
        ? e.message + " You were not charged."
        : "Reservation failed — you were not charged. Try again.";
      btn.disabled = false;
      btn.textContent = "Pay " + money(total);
      return;
    }

    notify(ph.ownerUserId, `New paid reservation: ${qty} × ${med.name} — ${ME.name} (${money(paid)})`, resRef.id);
    showPaymentReceipt({ id: resRef.id, paymentRef, total: paid, med, ph, qty });
  };
}

function showPaymentReceipt({ id, paymentRef, total, med, ph, qty }){
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:38px">✅</div>
      <h3>Payment successful</h3>
      <p class="sub">Ref ${esc(paymentRef)} · Reservation ${shortId(id)}</p>
    </div>
    <div class="card" style="box-shadow:none; background:var(--surface-2)">
      <div class="kv"><span>Medicine</span><b>${esc(med.name)} × ${qty}</b></div>
      <div class="kv"><span>Pharmacy</span><b>${esc(ph.name)}</b></div>
      <div class="kv"><span>Paid</span><b style="color:var(--money)">${money(total)}</b></div>
    </div>
    <p style="font-size:13px; color:var(--muted); margin:14px 0 0">
      The stock is now held for you. You'll get a notification when the pharmacy marks it <b>ready for pickup</b>.</p>
    <button class="btn primary" style="width:100%; margin-top:14px" id="rc-done">Done</button>`);
  $("rc-done").onclick = () => { closeModal(); go("reservations"); };
}


/* ============================================================
   RESERVATION STATE CHANGES (shared by patient / pharmacy / admin)
   ============================================================ */

/* Cancel + return the held quantity to stock, atomically. */
/* Reads the patient's hold counter (inside a transaction) so we can give one back. */
async function readHolds(tx, patientId){
  const ref = doc(db, "holds", patientId);
  const snap = await tx.get(ref);
  return { ref, active: snap.exists() ? (snap.data().active || 0) : 0 };
}

/* Cancel + return the held quantity to stock + free the patient's hold — atomically. */
async function cancelReservation(resId, allowedFrom, byRole){
  let r;
  await runTransaction(db, async (tx) => {
    const rRef = doc(db, "reservations", resId);
    const rs = await tx.get(rRef);
    if(!rs.exists()) throw new Error("Reservation not found.");
    r = { id: rs.id, ...rs.data() };
    if(!allowedFrom.includes(r.status)) throw new Error("This reservation was already updated.");

    const invRef = doc(db, "inventory", r.inventoryId);
    const is = await tx.get(invRef);
    const holds = await readHolds(tx, r.patientId);

    tx.update(rRef, { status: "cancelled", cancelledBy: byRole, updatedAt: now() });
    if(is.exists()) tx.update(invRef, { quantity: is.data().quantity + r.qty, lastHold: resId });
    if(holds.active >= 1) tx.update(holds.ref, { active: holds.active - 1, lastRes: resId });
  });
  return r;
}

async function setReservationStatus(resId, from, to){
  let r;
  await runTransaction(db, async (tx) => {
    const rRef = doc(db, "reservations", resId);
    const rs = await tx.get(rRef);
    if(!rs.exists()) throw new Error("Reservation not found.");
    r = { id: rs.id, ...rs.data() };
    if(r.status !== from) throw new Error("This reservation was already updated.");
    const freesHold = ACTIVE_RES.includes(from) && !ACTIVE_RES.includes(to);
    const holds = freesHold ? await readHolds(tx, r.patientId) : null;

    tx.update(rRef, { status: to, updatedAt: now() });
    if(holds && holds.active >= 1) tx.update(holds.ref, { active: holds.active - 1, lastRes: resId });
  });
  return r;
}

/* Releases reservations nobody collected within HOLD_HOURS. Runs in the
   pharmacy's and admin's app whenever their data refreshes. (Fully automatic
   release while nobody is online needs a Cloud Function — see notes.) */
function autoExpireHolds(){
  if(!ME || (ME.role !== "pharmacy" && ME.role !== "admin")) return;
  const cutoff = now() - HOLD_MS;
  cache.reservations
    .filter(r => ACTIVE_RES.includes(r.status) && (r.createdAt || 0) < cutoff && !expiring.has(r.id))
    .filter(r => ME.role === "admin" || r.pharmacyOwnerId === ME.uid)
    .forEach(async r => {
      expiring.add(r.id);
      try{
        await cancelReservation(r.id, ACTIVE_RES, "expired");
        notify(r.patientId, `Your reservation for ${medName(r.medicineId)} expired after ${HOLD_HOURS} hours and was released. A refund has been initiated (demo).`, ME.role === "admin" ? null : r.id);
      }catch(e){ console.warn("auto-expire failed", r.id, e); }
      finally{ expiring.delete(r.id); }
    });
}


/* ============================================================
   PATIENT — my reservations
   ============================================================ */
function viewPatientReservations(){
  const mine = [...cache.reservations].sort((a, b) => b.createdAt - a.createdAt);

  const body = mine.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Qty</th><th>Paid</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${mine.map(r => {
        const ph = getPh(r.pharmacyId);
        const st = statusInfo(r);
        return `<tr>
          <td><b>${esc(getMed(r.medicineId)?.name || "—")}</b><br><small style="color:var(--faint)">${shortId(r.id)}</small></td>
          <td>${esc(ph ? ph.name : "—")}${ph ? `<br><small style="color:var(--muted)">${esc(ph.address)}</small>` : ""}
            ${ph && ph.phone ? `<br><small>${phoneLink(ph)}</small>` : ""}</td>
          <td>${r.qty}</td>
          <td><span class="pill ok">${money(r.amountPaid)}</span></td>
          <td><span class="pill ${st.pill}">${st.label}</span>
            ${ACTIVE_RES.includes(r.status) ? `<br><small style="color:var(--muted)">⏳ ${timeLeft(holdExpiresAt(r) - now())}</small>` : ""}</td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
          <td class="actions">${r.status === "pending" ? `<button class="btn sm danger" data-pcancel="${r.id}">Cancel</button>` : ""}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`
    : `<div class="empty"><div class="big">🏷️</div><h3>No reservations yet</h3>
        <p>Reserve a medicine from the search page to hold it for pickup.</p>
        <button class="btn primary" data-go="search" style="margin-top:10px">Find medicine</button></div>`;

  const ready = mine.filter(r => r.status === "ready").length;

  $("main").innerHTML = `
    <div class="page-head"><h2>My reservations</h2>
      <p>Medicines you've paid for and the pharmacy is holding. You can have ${MAX_ACTIVE_HOLDS} active at a time;
        each is held for ${HOLD_HOURS} hours, then released automatically.</p></div>
    ${ready ? `<div class="card" style="margin-bottom:16px; border-color:var(--info)">
      <b>🎉 ${ready} reservation${ready > 1 ? "s are" : " is"} ready for pickup.</b>
      <span style="color:var(--muted)"> Show the reservation ID at the counter.</span></div>` : ""}
    ${body}`;

  bindGo();

  $("main").querySelectorAll("[data-pcancel]").forEach(b => b.onclick = async () => {
    const ok = await confirmModal({
      title: "Cancel this reservation?",
      text: "The medicine goes back to the pharmacy's stock. (Demo: the refund is simulated.)",
      okLabel: "Yes, cancel", danger: true,
    });
    if(!ok) return;
    try{
      const r = await cancelReservation(b.dataset.pcancel, ["pending"], "patient");
      notify(r.pharmacyOwnerId, `${ME.name} cancelled their reservation for ${r.qty} × ${medName(r.medicineId)}. Stock returned.`, r.id);
      toast("Reservation cancelled — refund initiated (demo).", "good");
    }catch(e){ console.error(e); toast(e.message || "Could not cancel.", "bad"); }
  });
}


/* ============================================================
   PHARMACY — gate (pending / suspended / missing store)
   ============================================================ */
function pendingGate(){
  const ph = myPharmacy();
  if(ph && ph.status === "approved") return false;

  if(!ph){
    $("main").innerHTML = `
      <div class="empty" style="margin-top:40px">
        <div class="big">🏥</div>
        <h3>No store registered</h3>
        <p style="max-width:420px; margin:0 auto">Register your pharmacy so the admin can approve it.</p>
        <button class="btn primary" id="reg-store" style="margin-top:14px">Register my store</button>
      </div>`;
    $("reg-store").onclick = registerStoreModal;
    return true;
  }

  const suspended = ph.status === "suspended";
  $("main").innerHTML = `
    <div class="empty" style="margin-top:40px">
      <div class="big">${suspended ? "⛔" : "⏳"}</div>
      <h3>${suspended ? "Store suspended" : "Awaiting approval"}</h3>
      <p style="max-width:440px; margin:0 auto">${suspended
        ? "Your store has been suspended by the admin and is hidden from patients. Contact support to restore access."
        : "Your store is waiting for admin approval. Meanwhile you can fill in Store settings and set your location."}</p>
      <p style="margin-top:14px"><span class="pill ${suspended ? "suspended" : "pending"}">${ph.status}</span></p>
      ${suspended ? "" : `<button class="btn" data-go="ph-settings" style="margin-top:6px">⚙️ Store settings</button>`}
    </div>`;
  bindGo();
  return true;
}

function registerStoreModal(){
  const holder = { loc: null };
  openModal(`
    <h3>Register your store</h3>
    <p class="sub">It becomes visible to patients once the admin approves it.</p>
    ${storeFieldsHtml("rs")}
    <div class="err" id="rs-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="rs-go">Register</button>
    </div>`);
  wireStoreLocation("rs", holder);
  $("rs-go").onclick = async () => {
    const btn = $("rs-go");
    btn.disabled = true;
    try{
      await createStore(ME.uid, readStoreFields("rs", ME.name, holder));
      closeModal();
      toast("Store registered — waiting for approval.", "good");
    }catch(e){
      console.error(e);
      $("rs-err").textContent = "Could not register the store.";
      btn.disabled = false;
    }
  };
}


/* ============================================================
   PHARMACY — dashboard
   ============================================================ */
function pharmacyNumbers(ph){
  const inv       = cache.inventory.filter(i => i.pharmacyId === ph.id);
  const bills     = cache.bills.filter(b => b.pharmacyId === ph.id);
  const res       = cache.reservations.filter(r => r.pharmacyId === ph.id);
  const collected = res.filter(r => r.status === "collected");
  const today     = startOfToday();

  const counterRevenue = bills.reduce((s, b) => s + (b.total || 0), 0);
  const onlineRevenue  = collected.reduce((s, r) => s + (r.amountPaid || 0), 0);
  const todayRevenue   = bills.filter(b => b.createdAt >= today).reduce((s, b) => s + b.total, 0)
                       + collected.filter(r => (r.updatedAt || 0) >= today).reduce((s, r) => s + r.amountPaid, 0);

  return {
    inv, bills, res, collected,
    low: inv.filter(i => i.quantity > 0 && i.quantity <= LOW_STOCK).length,
    out: inv.filter(i => i.quantity <= 0).length,
    billsToday: bills.filter(b => b.createdAt >= today).length,
    pending: res.filter(r => r.status === "pending").length,
    ready: res.filter(r => r.status === "ready").length,
    counterRevenue, onlineRevenue, todayRevenue,
  };
}

function viewPhDash(){
  if(pendingGate()) return;
  const ph = myPharmacy();
  const n = pharmacyNumbers(ph);

  const lowList = n.inv
    .filter(i => i.quantity <= LOW_STOCK)
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 6);

  $("main").innerHTML = `
    <div class="page-head"><h2>${esc(ph.name)}</h2><p>${esc(ph.address)} · ${esc(ph.hours)}</p></div>

    ${ph.locSet ? "" : `<div class="card" style="margin-bottom:16px; border-color:var(--low)">
      <div class="row between"><div><b>📍 Your store location isn't set.</b>
      <div style="color:var(--muted); font-size:13px">Patients see "distance unknown" until you set it.</div></div>
      <button class="btn sm" data-go="ph-settings">Set location</button></div></div>`}

    <div class="stat-grid">
      <div class="stat"><div class="n">${n.inv.length}</div><div class="l">Medicines listed</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${n.low}</div><div class="l">Low stock (≤${LOW_STOCK})</div></div>
      <div class="stat"><div class="n" style="color:var(--out)">${n.out}</div><div class="l">Out of stock</div></div>
      <div class="stat"><div class="n">${n.pending}</div><div class="l">Reservations to pack</div></div>
      <div class="stat"><div class="n">${n.ready}</div><div class="l">Waiting for pickup</div></div>
      <div class="stat"><div class="n">${n.billsToday}</div><div class="l">Bills today</div></div>
      <div class="stat money"><div class="n">${money(n.todayRevenue)}</div><div class="l">Revenue today</div></div>
      <div class="stat money"><div class="n">${money(n.counterRevenue + n.onlineRevenue)}</div><div class="l">Total revenue</div></div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:10px">Quick actions</h3>
      <div class="row">
        <button class="btn primary" data-go="ph-billing">🧾 Create a bill</button>
        <button class="btn" data-go="ph-inventory">📦 Update inventory</button>
        <button class="btn" data-go="ph-reservations">🏷️ Reservations${n.pending ? ` (${n.pending})` : ""}</button>
      </div>
    </div>

    ${lowList.length ? `<div class="card">
      <div class="row between" style="margin-bottom:8px"><h3>Needs restocking</h3>
        <button class="btn sm ghost" data-go="ph-inventory">Open inventory</button></div>
      ${lowList.map(i => {
        const ss = stockState(i.quantity);
        return `<div class="kv" style="padding:6px 0; border-bottom:1px dashed var(--border)">
          <b>${esc(getMed(i.medicineId)?.name || "—")}</b>
          <span class="pill ${ss.key}">${i.quantity} left</span></div>`;
      }).join("")}
    </div>` : ""}`;

  bindGo();
}


/* ============================================================
   PHARMACY — inventory
   ============================================================ */
function viewPhInventory(){
  if(pendingGate()) return;
  const ph = myPharmacy();
  const inv = cache.inventory
    .filter(i => i.pharmacyId === ph.id)
    .sort((a, b) => (getMed(a.medicineId)?.name || "").localeCompare(getMed(b.medicineId)?.name || ""));

  const body = inv.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Salt / generic</th><th>Price</th><th>Available</th><th>Held</th><th>Status</th><th></th></tr></thead>
      <tbody>${inv.map(i => {
        const m = getMed(i.medicineId), ss = stockState(i.quantity), held = heldQty(i.id);
        return `<tr>
          <td><b>${esc(m ? m.name : "—")}</b></td>
          <td style="color:var(--muted)">${esc(m ? m.generic : "")}</td>
          <td>${money(i.price)}</td>
          <td>${i.quantity}</td>
          <td>${held ? `<span class="pill ready">${held}</span>` : `<span style="color:var(--faint)">0</span>`}</td>
          <td><span class="pill ${ss.key}">${ss.label}</span></td>
          <td class="actions">
            <button class="btn sm" data-restock="${i.id}">＋ Stock</button>
            <button class="btn sm ghost" data-edit-inv="${i.id}">Edit</button>
            <button class="btn sm danger" data-del-inv="${i.id}">Remove</button>
          </td></tr>`;
      }).join("")}</tbody>
    </table></div>
    <p style="font-size:12.5px; color:var(--muted); margin-top:10px">
      <b>Available</b> = what you can sell or patients can reserve. <b>Held</b> = already paid for by patients and set aside (not counted in Available).</p>`
    : `<div class="empty"><div class="big">📦</div><h3>No medicines listed yet</h3>
        <p>Add your first medicine so patients can find it.</p></div>`;

  $("main").innerHTML = `
    <div class="page-head row between" style="align-items:flex-end">
      <div><h2>Inventory</h2><p>Stock patients see when they search. Keep it current.</p></div>
      <button class="btn primary" id="add-inv">＋ Add medicine</button>
    </div>${body}`;

  $("add-inv").onclick = () => editInventory(null);
  $("main").querySelectorAll("[data-edit-inv]").forEach(b => b.onclick = () => editInventory(b.dataset.editInv));
  $("main").querySelectorAll("[data-restock]").forEach(b => b.onclick = () => restockModal(b.dataset.restock));
  $("main").querySelectorAll("[data-del-inv]").forEach(b => b.onclick = () => removeInventory(b.dataset.delInv));
}

async function removeInventory(invId){
  const i = getInv(invId);
  if(!i) return;
  const held = heldQty(invId);
  if(held){ toast(`Can't remove — ${held} unit(s) are held for patient reservations. Resolve those first.`, "bad"); return; }

  const ok = await confirmModal({
    title: "Remove from inventory?",
    text: `${medName(i.medicineId)} will no longer appear in patient search.`,
    okLabel: "Remove", danger: true,
  });
  if(!ok) return;
  try{ await deleteDoc(doc(db, "inventory", invId)); toast("Removed from inventory."); }
  catch(e){ console.error(e); toast("Could not remove item.", "bad"); }
}

function restockModal(invId){
  const i = getInv(invId);
  if(!i) return;
  openModal(`
    <h3>Add stock — ${esc(medName(i.medicineId))}</h3>
    <p class="sub">Currently ${i.quantity} available. New units are added on top.</p>
    <label class="fld"><span class="lab">Units received</span>
      <input class="input" id="rs-qty" type="number" min="1" value="10"></label>
    <div class="err" id="rs-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="rs-save">Add stock</button>
    </div>`);
  $("rs-qty").select();

  $("rs-save").onclick = async () => {
    const add = parseInt($("rs-qty").value, 10);
    if(!add || add < 1){ $("rs-err").textContent = "Enter how many units arrived."; return; }
    const btn = $("rs-save");
    btn.disabled = true;
    try{
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "inventory", invId);
        const s = await tx.get(ref);
        if(!s.exists()) throw new Error("Item not found.");
        tx.update(ref, { quantity: s.data().quantity + add });
      });
      closeModal();
      toast(`Added ${add} units.`, "good");
    }catch(e){
      console.error(e);
      $("rs-err").textContent = "Could not update stock.";
      btn.disabled = false;
    }
  };
}

function editInventory(invId){
  const ph = myPharmacy();
  const existing = invId ? getInv(invId) : null;
  const usedIds = new Set(cache.inventory.filter(i => i.pharmacyId === ph.id).map(i => i.medicineId));

  const options = cache.medicines
    .filter(m => existing ? m.id === existing.medicineId : !usedIds.has(m.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => `<option value="${m.id}" ${existing && existing.medicineId === m.id ? "selected" : ""}>${esc(m.name)} — ${esc(m.generic)}</option>`)
    .join("");

  if(!existing && !options){
    toast(cache.medicines.length ? "You already list every catalog medicine." : "The catalog is empty — ask the admin to add medicines.", "bad");
    return;
  }

  openModal(`
    <h3>${existing ? "Edit medicine" : "Add medicine"}</h3>
    <p class="sub">${existing ? "Update price or correct the available quantity." : "Pick from the shared catalog, then set your price and stock."}</p>
    <label class="fld"><span class="lab">Medicine</span>
      <select class="input" id="iv-med" ${existing ? "disabled" : ""}>${options}</select></label>
    <div class="row">
      <label class="fld grow"><span class="lab">Price (₹)</span>
        <input class="input" id="iv-price" type="number" min="0" step="0.5" value="${existing ? existing.price : ""}" placeholder="0.00"></label>
      <label class="fld grow"><span class="lab">Available quantity</span>
        <input class="input" id="iv-qty" type="number" min="0" value="${existing ? existing.quantity : ""}" placeholder="0"></label>
    </div>
    <div class="err" id="iv-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="iv-save">${existing ? "Save changes" : "Add to inventory"}</button>
    </div>`);

  $("iv-save").onclick = async () => {
    const medId = $("iv-med").value;
    const price = Math.round(parseFloat($("iv-price").value) * 100) / 100;
    const qty   = parseInt($("iv-qty").value, 10);
    if(isNaN(price) || price < 0 || isNaN(qty) || qty < 0){ $("iv-err").textContent = "Enter a valid price and quantity."; return; }

    const btn = $("iv-save");
    btn.disabled = true;
    try{
      if(existing){
        await updateDoc(doc(db, "inventory", existing.id), { price, quantity: qty });
      } else {
        await addDoc(collection(db, "inventory"), {
          pharmacyId: ph.id, ownerUserId: ME.uid, medicineId: medId, quantity: qty, price,
        });
      }
      closeModal();
      toast(existing ? "Inventory updated." : "Medicine added.", "good");
    }catch(e){
      console.error(e);
      $("iv-err").textContent = "Could not save. Try again.";
      btn.disabled = false;
    }
  };
}


/* ============================================================
   PHARMACY — counter billing (transaction)
   ============================================================ */
function viewPhBilling(){
  if(pendingGate()) return;
  const ph = myPharmacy();
  const inv = cache.inventory.filter(i => i.pharmacyId === ph.id && i.quantity > 0);

  state.billDraft = state.billDraft.filter(l => getInv(l.invId));

  const pickerOptions = inv
    .sort((a, b) => medName(a.medicineId).localeCompare(medName(b.medicineId)))
    .map(i => `<option value="${i.id}">${esc(medName(i.medicineId))} — ${money(i.price)} (${i.quantity} left)</option>`)
    .join("");

  const lines = state.billDraft.map(line => {
    const i = getInv(line.invId);
    return `<div class="cart-line">
      <div class="cn"><b>${esc(medName(i.medicineId))}</b><small>${money(i.price)} × ${line.qty} · ${i.quantity} in stock</small></div>
      <div class="qty-stepper">
        <button data-dec="${line.invId}">−</button><span>${line.qty}</span><button data-inc="${line.invId}">＋</button>
      </div>
      <button class="btn sm danger" data-rm="${line.invId}">✕</button>
    </div>`;
  }).join("");

  const total = state.billDraft.reduce((s, l) => s + getInv(l.invId).price * l.qty, 0);

  $("main").innerHTML = `
    <div class="page-head"><h2>New bill</h2>
      <p>Walk-in sale at the counter. Stock drops automatically when the bill is saved.</p></div>
    <div class="bill-grid">
      <div class="card">
        <h3 style="margin-bottom:14px">Add an item</h3>
        ${inv.length ? `
          <div class="row">
            <select class="input grow" id="bill-med">${pickerOptions}</select>
            <input class="input" id="bill-qty" type="number" min="1" value="1" style="width:90px">
            <button class="btn primary" id="bill-add">Add</button>
          </div>
          <label class="fld" style="margin:14px 0 0"><span class="lab">Customer name (optional)</span>
            <input class="input" id="bill-cust" value="${esc(state.billCustomer || "")}" placeholder="Walk-in customer"></label>`
          : `<p style="color:var(--muted)">No in-stock medicines to bill. Add stock in Inventory first.</p>`}
      </div>
      <div class="card bill-cart">
        <h3 style="margin-bottom:12px">Bill items</h3>
        ${state.billDraft.length ? lines : `<p style="color:var(--muted); font-size:14px">No items added yet.</p>`}
        <div class="cart-total"><span>Total</span><span class="t">${money(total)}</span></div>
        <button class="btn money" id="bill-create" style="width:100%; margin-top:14px" ${state.billDraft.length ? "" : "disabled"}>
          Create bill · ${money(total)}</button>
        ${state.billDraft.length ? `<button class="btn ghost" id="bill-clear" style="width:100%; margin-top:8px">Clear</button>` : ""}
      </div>
    </div>`;

  const custEl = $("bill-cust");
  if(custEl) custEl.oninput = () => { state.billCustomer = custEl.value; };

  const addBtn = $("bill-add");
  if(addBtn) addBtn.onclick = () => {
    const invId = $("bill-med").value;
    const qty = parseInt($("bill-qty").value, 10);
    if(!invId || !qty || qty < 1){ toast("Pick a medicine and quantity.", "bad"); return; }
    const stock = getInv(invId).quantity;
    const line = state.billDraft.find(l => l.invId === invId);
    const have = line ? line.qty : 0;
    if(have + qty > stock){ toast(`Only ${stock} in stock (${have} already in this bill).`, "bad"); return; }
    if(line) line.qty += qty; else state.billDraft.push({ invId, qty });
    viewPhBilling();
  };

  $("main").querySelectorAll("[data-inc]").forEach(b => b.onclick = () => {
    const l = state.billDraft.find(x => x.invId === b.dataset.inc);
    if(l.qty >= getInv(l.invId).quantity){ toast("That's all the stock there is.", "bad"); return; }
    l.qty++;
    viewPhBilling();
  });
  $("main").querySelectorAll("[data-dec]").forEach(b => b.onclick = () => {
    const l = state.billDraft.find(x => x.invId === b.dataset.dec);
    l.qty--;
    if(l.qty <= 0) state.billDraft = state.billDraft.filter(x => x.invId !== l.invId);
    viewPhBilling();
  });
  $("main").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
    state.billDraft = state.billDraft.filter(x => x.invId !== b.dataset.rm);
    viewPhBilling();
  });

  const clr = $("bill-clear");
  if(clr) clr.onclick = () => { state.billDraft = []; state.billCustomer = ""; viewPhBilling(); };
  const create = $("bill-create");
  if(create) create.onclick = createBill;
}

async function createBill(){
  if(!state.billDraft.length) return;
  const ph = myPharmacy();
  const draft = state.billDraft.map(l => ({ ...l }));
  const customer = (state.billCustomer || "").trim() || "Walk-in customer";

  const btn = $("bill-create");
  if(btn){ btn.disabled = true; btn.textContent = "Creating…"; }

  const billRef = doc(collection(db, "bills"));
  let bill = null;
  const lowAfter = [];

  try{
    await runTransaction(db, async (tx) => {
      const refs  = draft.map(l => doc(db, "inventory", l.invId));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      const items = [];
      let total = 0;

      snaps.forEach((s, idx) => {
        if(!s.exists()) throw new Error("An item is no longer available.");
        const d = s.data();
        const name = medName(d.medicineId);
        if(d.quantity < draft[idx].qty) throw new Error(`Not enough stock for ${name} (only ${d.quantity}).`);
        const lineTotal = d.price * draft[idx].qty;
        total += lineTotal;
        items.push({ medicineId: d.medicineId, name, quantity: draft[idx].qty, unitPrice: d.price, lineTotal });
      });

      lowAfter.length = 0;
      snaps.forEach((s, idx) => {
        const left = s.data().quantity - draft[idx].qty;
        tx.update(refs[idx], { quantity: left });
        if(left <= LOW_STOCK) lowAfter.push({ name: items[idx].name, left });
      });

      const created = now();
      tx.set(billRef, { pharmacyId: ph.id, ownerUserId: ME.uid, customer, items, total, createdAt: created });
      bill = { id: billRef.id, pharmacyId: ph.id, customer, items, total, createdAt: created };
    });
  }catch(e){
    console.warn("bill aborted:", e);
    toast((e.message && !e.code ? e.message : "Bill failed.") + " Nothing was changed.", "bad");
    viewPhBilling();
    return;
  }

  lowAfter.forEach(x => notify(ME.uid, x.left <= 0 ? `Out of stock: ${x.name}` : `Low stock: ${x.name} — ${x.left} left`));
  state.billDraft = [];
  state.billCustomer = "";
  showBillReceipt(bill, ph);
}

function showBillReceipt(bill, ph){
  const rows = bill.items.map(it => `<tr>
    <td>${esc(it.name)}</td><td style="text-align:center">${it.quantity}</td>
    <td style="text-align:right">${money(it.unitPrice)}</td>
    <td style="text-align:right">${money(it.lineTotal)}</td></tr>`).join("");

  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:34px">🧾</div>
      <h3>Bill ${shortId(bill.id)}</h3>
      <p class="sub">${esc(ph.name)} · ${esc(bill.customer || "Walk-in customer")} · ${new Date(bill.createdAt).toLocaleString()}</p>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div class="cart-total"><span>Amount</span><span class="t">${money(bill.total)}</span></div>
    <div class="row" style="margin-top:16px">
      <button class="btn grow" id="rc-print">🖨️ Print</button>
      <button class="btn primary grow" data-close>Done</button>
    </div>`);

  $("rc-print").onclick = () => printBill(bill, ph);
}

function printBill(bill, ph){
  const w = window.open("", "_blank", "width=420,height=600");
  if(!w){ toast("Allow pop-ups to print.", "bad"); return; }
  const rows = bill.items.map(it =>
    `<tr><td>${esc(it.name)}</td><td>${it.quantity}</td><td style="text-align:right">${money(it.lineTotal)}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Bill ${shortId(bill.id)}</title>
    <style>body{font-family:monospace;padding:16px}table{width:100%;border-collapse:collapse}
    td,th{padding:4px 0;border-bottom:1px dashed #999;text-align:left}h2{margin:0}</style></head><body>
    <h2>${esc(ph.name)}</h2><div>${esc(ph.address)}</div><hr>
    <div>Bill ${shortId(bill.id)} · ${new Date(bill.createdAt).toLocaleString()}</div>
    <div>Customer: ${esc(bill.customer || "Walk-in customer")}</div><br>
    <table><tr><th>Item</th><th>Qty</th><th style="text-align:right">Amount</th></tr>${rows}</table>
    <h3 style="text-align:right">Total ${money(bill.total)}</h3>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}


/* ============================================================
   PHARMACY — reservations
   ============================================================ */
function viewPhReservations(){
  if(pendingGate()) return;
  const ph = myPharmacy();
  const all = cache.reservations.filter(r => r.pharmacyId === ph.id).sort((a, b) => b.createdAt - a.createdAt);

  const tabs = {
    active:    all.filter(r => ACTIVE_RES.includes(r.status)),
    collected: all.filter(r => r.status === "collected"),
    cancelled: all.filter(r => r.status === "cancelled"),
  };
  const list = tabs[state.resTab] || tabs.active;

  const body = list.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Patient</th><th>Qty</th><th>Paid</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${list.map(r => {
        const st = statusInfo(r);
        let actions = "—";
        if(r.status === "pending"){
          actions = `<button class="btn sm primary" data-ready="${r.id}">Mark ready</button>
                     <button class="btn sm danger" data-cancel="${r.id}">Cancel</button>`;
        } else if(r.status === "ready"){
          actions = `<button class="btn sm primary" data-collect="${r.id}">Picked up</button>
                     <button class="btn sm danger" data-cancel="${r.id}">Cancel</button>`;
        }
        return `<tr>
          <td><b>${esc(medName(r.medicineId))}</b><br><small style="color:var(--faint)">${shortId(r.id)}</small></td>
          <td>${esc(r.patientName || "Unknown")}${r.patientPhone ? `<br><small style="color:var(--muted)">${esc(r.patientPhone)}</small>` : ""}</td>
          <td>${r.qty}</td>
          <td><span class="pill ok">${money(r.amountPaid)}</span></td>
          <td><span class="pill ${st.pill}">${st.label}</span></td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
          <td class="actions">${actions}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`
    : `<div class="empty"><div class="big">🏷️</div><h3>Nothing here</h3>
        <p>${state.resTab === "active" ? "When a patient reserves one of your medicines, it appears here." : "No reservations in this list yet."}</p></div>`;

  $("main").innerHTML = `
    <div class="page-head"><h2>Reservations</h2>
      <p>Paid online orders. Their stock is already set aside — pack them, then hand over at pickup.</p></div>
    <div class="tabs">
      <button data-tab="active" class="${state.resTab === "active" ? "active" : ""}">Active (${tabs.active.length})</button>
      <button data-tab="collected" class="${state.resTab === "collected" ? "active" : ""}">Collected (${tabs.collected.length})</button>
      <button data-tab="cancelled" class="${state.resTab === "cancelled" ? "active" : ""}">Cancelled (${tabs.cancelled.length})</button>
    </div>
    ${body}`;

  $("main").querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { state.resTab = b.dataset.tab; viewPhReservations(); });

  $("main").querySelectorAll("[data-ready]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try{
      const r = await setReservationStatus(b.dataset.ready, "pending", "ready");
      notify(r.patientId, `Your ${r.qty} × ${medName(r.medicineId)} is ready for pickup at ${ph.name}.`, r.id);
      toast("Marked ready — patient notified.", "good");
    }catch(e){ console.error(e); toast(e.message || "Could not update.", "bad"); b.disabled = false; }
  });

  $("main").querySelectorAll("[data-collect]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try{
      const r = await setReservationStatus(b.dataset.collect, "ready", "collected");
      notify(r.patientId, `You collected ${r.qty} × ${medName(r.medicineId)} from ${ph.name}. Thank you!`, r.id);
      toast("Marked as picked up.", "good");
    }catch(e){ console.error(e); toast(e.message || "Could not update.", "bad"); b.disabled = false; }
  });

  $("main").querySelectorAll("[data-cancel]").forEach(b => b.onclick = async () => {
    const ok = await confirmModal({
      title: "Cancel this reservation?",
      text: "The held quantity goes back into your available stock and the patient is notified (demo refund).",
      okLabel: "Cancel reservation", danger: true,
    });
    if(!ok) return;
    try{
      const r = await cancelReservation(b.dataset.cancel, ACTIVE_RES, "pharmacy");
      notify(r.patientId, `${ph.name} cancelled your reservation for ${medName(r.medicineId)}. A refund has been initiated (demo).`, r.id);
      toast("Reservation cancelled — stock returned.");
    }catch(e){ console.error(e); toast(e.message || "Could not cancel.", "bad"); }
  });
}


/* ============================================================
   PHARMACY — sales history
   ============================================================ */
function viewPhSales(){
  if(pendingGate()) return;
  const ph = myPharmacy();
  const n = pharmacyNumbers(ph);
  const bills = [...n.bills].sort((a, b) => b.createdAt - a.createdAt);
  const online = [...n.collected].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  let body;
  if(state.salesTab === "online"){
    body = online.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Reservation</th><th>Medicine</th><th>Patient</th><th>Collected</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${online.map(r => `<tr>
          <td><b>${shortId(r.id)}</b></td>
          <td>${r.qty} × ${esc(medName(r.medicineId))}</td>
          <td>${esc(r.patientName || "—")}</td>
          <td style="color:var(--muted)">${timeAgo(r.updatedAt)}</td>
          <td style="text-align:right"><b>${money(r.amountPaid)}</b></td></tr>`).join("")}</tbody>
      </table></div>`
      : `<div class="empty"><div class="big">🏷️</div><h3>No collected online orders yet</h3></div>`;
  } else {
    body = bills.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Bill #</th><th>Customer</th><th>Items</th><th>When</th><th style="text-align:right">Amount</th><th></th></tr></thead>
        <tbody>${bills.map(b => {
          const count = (b.items || []).reduce((s, i) => s + i.quantity, 0);
          return `<tr>
            <td><b>${shortId(b.id)}</b></td>
            <td>${esc(b.customer || "Walk-in customer")}</td>
            <td>${count} item${count !== 1 ? "s" : ""}</td>
            <td style="color:var(--muted)">${timeAgo(b.createdAt)}</td>
            <td style="text-align:right"><b>${money(b.total)}</b></td>
            <td class="actions"><button class="btn sm ghost" data-view-bill="${b.id}">View</button></td></tr>`;
        }).join("")}</tbody>
      </table></div>`
      : `<div class="empty"><div class="big">💰</div><h3>No counter sales yet</h3><p>Create a bill and it'll show up here.</p></div>`;
  }

  $("main").innerHTML = `
    <div class="page-head"><h2>Sales history</h2><p>Counter bills and collected online reservations.</p></div>
    <div class="stat-grid">
      <div class="stat money"><div class="n">${money(n.counterRevenue)}</div><div class="l">Counter sales (${bills.length} bills)</div></div>
      <div class="stat money"><div class="n">${money(n.onlineRevenue)}</div><div class="l">Online orders (${online.length} collected)</div></div>
      <div class="stat money"><div class="n">${money(n.counterRevenue + n.onlineRevenue)}</div><div class="l">Total revenue</div></div>
    </div>
    <div class="tabs">
      <button data-stab="bills" class="${state.salesTab === "bills" ? "active" : ""}">Counter bills</button>
      <button data-stab="online" class="${state.salesTab === "online" ? "active" : ""}">Online orders</button>
    </div>
    ${body}`;

  $("main").querySelectorAll("[data-stab]").forEach(b => b.onclick = () => { state.salesTab = b.dataset.stab; viewPhSales(); });
  $("main").querySelectorAll("[data-view-bill]").forEach(b => b.onclick = () => {
    const bill = cache.bills.find(x => x.id === b.dataset.viewBill);
    if(bill) showBillReceipt(bill, ph);
  });
}


/* ============================================================
   PHARMACY — store settings (allowed while pending too)
   ============================================================ */
function viewPhSettings(){
  const ph = myPharmacy();
  if(!ph || ph.status === "suspended"){ pendingGate(); return; }

  $("main").innerHTML = `
    <div class="page-head"><h2>Store settings</h2><p>Details patients see about your pharmacy.</p></div>
    <div class="card" style="max-width:560px">
      <p style="margin:0 0 14px">Status: <span class="pill ${ph.status}">${ph.status}</span></p>
      <label class="fld"><span class="lab">Pharmacy name</span><input class="input" id="set-name" value="${esc(ph.name)}"></label>
      <label class="fld"><span class="lab">Address / area</span><input class="input" id="set-addr" value="${esc(ph.address)}"></label>
      <label class="fld"><span class="lab">Opening hours</span><input class="input" id="set-hours" value="${esc(ph.hours)}"></label>
      <label class="fld"><span class="lab">Store phone (shown to patients)</span>
        <input class="input" id="set-phone" type="tel" maxlength="20" value="${esc(ph.phone || "")}" placeholder="e.g. +91 40 1234 5678"></label>

      <div class="fld" style="margin-bottom:16px">
        <span class="lab" style="font-size:13px; font-weight:600; display:block; margin-bottom:6px">Store location</span>
        <div class="row">
          <span id="set-locmsg" style="font-size:13px; color:var(--muted)">${ph.locSet && num(ph.lat) !== null && num(ph.lng) !== null
            ? `📍 ${ph.lat.toFixed(5)}, ${ph.lng.toFixed(5)}`
            : "📍 Not set — patients see “distance unknown”."}</span>
          <button class="btn sm" id="set-loc" type="button">Use my current location</button>
        </div>
        <p style="font-size:12px; color:var(--faint); margin:6px 0 0">Do this while standing in the store for the most accurate distance.</p>
      </div>

      <button class="btn primary" id="set-save">Save changes</button>
    </div>`;

  let newLoc = null;

  $("set-loc").onclick = async () => {
    const msg = $("set-locmsg");
    msg.textContent = "Getting location…";
    try{
      newLoc = await getBrowserLocation();
      msg.textContent = `📍 ${newLoc.lat.toFixed(5)}, ${newLoc.lng.toFixed(5)} (click Save)`;
    }catch(e){ msg.textContent = e.message; }
  };

  $("set-save").onclick = async () => {
    const data = {
      name:    ($("set-name").value.trim()  || ph.name).slice(0, 80),
      address: ($("set-addr").value.trim()  || ph.address).slice(0, 160),
      hours:   ($("set-hours").value.trim() || ph.hours).slice(0, 60),
      phone:   $("set-phone").value.trim().slice(0, 20),
    };
    if(newLoc) Object.assign(data, { lat: newLoc.lat, lng: newLoc.lng, locSet: true });

    const btn = $("set-save");
    btn.disabled = true;
    try{
      await updateDoc(doc(db, "pharmacies", ph.id), data);
      toast("Store details saved.", "good");
    }catch(e){
      console.error(e);
      toast("Could not save.", "bad");
      btn.disabled = false;
    }
  };
}


/* ============================================================
   ADMIN — overview
   ============================================================ */
function viewAdDash(){
  const ph = cache.pharmacies;
  const pending = ph.filter(p => p.status === "pending").length;
  const active  = ph.filter(p => p.status === "approved").length;
  const counter = cache.bills.reduce((s, b) => s + (b.total || 0), 0);
  const online  = cache.reservations.filter(r => r.status === "collected").reduce((s, r) => s + (r.amountPaid || 0), 0);
  const openRes = cache.reservations.filter(r => ACTIVE_RES.includes(r.status)).length;
  const patients = cache.users.filter(u => u.role === "patient").length;
  const outListings = cache.inventory.filter(i => i.quantity <= 0).length;

  $("main").innerHTML = `
    <div class="page-head"><h2>Network overview</h2><p>Health of the whole PharmaFind network.</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${active}</div><div class="l">Active pharmacies</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${pending}</div><div class="l">Pending approval</div></div>
      <div class="stat"><div class="n">${patients}</div><div class="l">Registered patients</div></div>
      <div class="stat"><div class="n">${cache.medicines.length}</div><div class="l">Catalog medicines</div></div>
      <div class="stat"><div class="n">${openRes}</div><div class="l">Open reservations</div></div>
      <div class="stat"><div class="n" style="color:var(--out)">${outListings}</div><div class="l">Out-of-stock listings</div></div>
      <div class="stat money"><div class="n">${money(counter)}</div><div class="l">Counter sales</div></div>
      <div class="stat money"><div class="n">${money(online)}</div><div class="l">Online orders collected</div></div>
    </div>
    ${pending ? `<div class="card"><div class="row between">
      <div><h3>${pending} pharmac${pending > 1 ? "ies" : "y"} waiting</h3>
        <p style="color:var(--muted); margin:4px 0 0">Approve them so their stock becomes searchable.</p></div>
      <button class="btn primary" data-go="ad-approvals">Review now</button></div></div>` : ""}
    ${cache.medicines.length ? "" : `<div class="card"><div class="row between">
      <div><h3>The medicine catalog is empty</h3>
        <p style="color:var(--muted); margin:4px 0 0">Pharmacies can't list stock until the catalog has medicines.</p></div>
      <button class="btn primary" data-go="ad-medicines">Open catalog</button></div></div>`}`;

  bindGo();
}


/* ============================================================
   ADMIN — approvals / pharmacies
   ============================================================ */

/* Removes a store, its stock, and cancels its open reservations. */
async function removePharmacy(p, reasonText){
  const openRes = cache.reservations.filter(r => r.pharmacyId === p.id && ACTIVE_RES.includes(r.status));
  for(const r of openRes){
    try{
      await cancelReservation(r.id, ACTIVE_RES, "admin");
      notify(r.patientId, `Your reservation at ${p.name} was cancelled (store removed). A refund has been initiated (demo).`);
    }catch(e){ console.warn(e); }
  }
  const invs = cache.inventory.filter(i => i.pharmacyId === p.id);
  await Promise.all(invs.map(i => deleteDoc(doc(db, "inventory", i.id)).catch(() => {})));
  await deleteDoc(doc(db, "pharmacies", p.id));
  if(reasonText) notify(p.ownerUserId, reasonText);
}

function viewAdApprovals(){
  const pending = cache.pharmacies.filter(p => p.status === "pending").sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const body = pending.length ? pending.map(p => {
    const owner = getUser(p.ownerUserId);
    return `<div class="result">
      <div class="ph-ic">🏥</div>
      <div class="body">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">
          <span>📍 ${esc(p.address)}${p.locSet ? "" : " (no map location)"}</span>
          <span>🕒 ${esc(p.hours)}</span>
          <span>👤 ${esc(owner ? owner.name : "—")} · ${esc(owner ? owner.email : "")}</span>
          <span>Registered ${timeAgo(p.createdAt)}</span>
        </div>
      </div>
      <div class="right">
        <button class="btn primary sm" data-approve="${p.id}">Approve</button>
        <button class="btn danger sm" data-reject="${p.id}">Reject</button>
      </div></div>`;
  }).join("")
  : `<div class="empty"><div class="big">✅</div><h3>All caught up</h3><p>No pharmacies are waiting for approval.</p></div>`;

  $("main").innerHTML = `
    <div class="page-head"><h2>Pharmacy approvals</h2><p>Only approved pharmacies appear in patient search.</p></div>
    ${body}`;

  $("main").querySelectorAll("[data-approve]").forEach(b => b.onclick = async () => {
    const p = getPh(b.dataset.approve);
    b.disabled = true;
    try{
      await updateDoc(doc(db, "pharmacies", p.id), { status: "approved", approvedAt: now() });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was approved. You can now manage inventory and billing.`);
      toast(`${p.name} approved.`, "good");
    }catch(e){ console.error(e); toast("Could not approve.", "bad"); b.disabled = false; }
  });

  $("main").querySelectorAll("[data-reject]").forEach(b => b.onclick = async () => {
    const p = getPh(b.dataset.reject);
    const ok = await confirmModal({
      title: `Reject ${p.name}?`, text: "This removes the store registration. The owner can register again.",
      okLabel: "Reject", danger: true,
    });
    if(!ok) return;
    try{
      await removePharmacy(p, `Your pharmacy registration "${p.name}" was rejected. You can register again from your dashboard.`);
      toast(`${p.name} rejected.`);
    }catch(e){ console.error(e); toast("Could not reject.", "bad"); }
  });
}

function viewAdPharmacies(){
  const all = [...cache.pharmacies].sort((a, b) => a.name.localeCompare(b.name));

  const body = all.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Pharmacy</th><th>Area</th><th>Listings</th><th>Open orders</th><th>Status</th><th></th></tr></thead>
      <tbody>${all.map(p => {
        const items = cache.inventory.filter(i => i.pharmacyId === p.id).length;
        const open = cache.reservations.filter(r => r.pharmacyId === p.id && ACTIVE_RES.includes(r.status)).length;
        const action =
          p.status === "approved"  ? `<button class="btn sm danger" data-suspend="${p.id}">Suspend</button>` :
          p.status === "suspended" ? `<button class="btn sm primary" data-restore="${p.id}">Reactivate</button>` :
                                     `<button class="btn sm ghost" data-go="ad-approvals">Review</button>`;
        return `<tr>
          <td><b>${esc(p.name)}</b>${p.locSet ? "" : `<br><small style="color:var(--faint)">no map location</small>`}</td>
          <td style="color:var(--muted)">${esc(p.address)}</td>
          <td>${items}</td>
          <td>${open}</td>
          <td><span class="pill ${p.status}">${p.status}</span></td>
          <td class="actions">${action}
            <button class="btn sm danger" data-delph="${p.id}">Delete</button></td></tr>`;
      }).join("")}</tbody>
    </table></div>`
    : `<div class="empty"><div class="big">🏥</div><h3>No pharmacies yet</h3></div>`;

  $("main").innerHTML = `
    <div class="page-head"><h2>All pharmacies</h2><p>Suspend to hide a store from patient search.</p></div>
    ${body}`;

  bindGo();

  $("main").querySelectorAll("[data-suspend]").forEach(b => b.onclick = async () => {
    const p = getPh(b.dataset.suspend);
    try{
      await updateDoc(doc(db, "pharmacies", p.id), { status: "suspended" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was suspended by the admin.`);
      toast(`${p.name} suspended.`);
    }catch(e){ console.error(e); toast("Could not suspend.", "bad"); }
  });

  $("main").querySelectorAll("[data-restore]").forEach(b => b.onclick = async () => {
    const p = getPh(b.dataset.restore);
    try{
      await updateDoc(doc(db, "pharmacies", p.id), { status: "approved" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" is active again.`);
      toast(`${p.name} reactivated.`, "good");
    }catch(e){ console.error(e); toast("Could not reactivate.", "bad"); }
  });

  $("main").querySelectorAll("[data-delph]").forEach(b => b.onclick = async () => {
    const p = getPh(b.dataset.delph);
    const ok = await confirmModal({
      title: `Delete ${p.name}?`,
      text: "Removes the store and its inventory, and cancels its open reservations. Bills are kept as records.",
      okLabel: "Delete store", danger: true,
    });
    if(!ok) return;
    try{
      await removePharmacy(p, `Your pharmacy "${p.name}" was removed by the admin.`);
      toast(`${p.name} deleted.`);
    }catch(e){ console.error(e); toast("Could not delete.", "bad"); }
  });
}


/* ============================================================
   ADMIN — all reservations
   ============================================================ */
function viewAdOrders(){
  const all = [...cache.reservations].sort((a, b) => b.createdAt - a.createdAt);
  const tabs = {
    active:    all.filter(r => ACTIVE_RES.includes(r.status)),
    collected: all.filter(r => r.status === "collected"),
    cancelled: all.filter(r => r.status === "cancelled"),
  };
  const list = tabs[state.orderTab] || tabs.active;

  const body = list.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Medicine</th><th>Patient</th><th>Pharmacy</th><th>Paid</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${list.map(r => {
        const st = statusInfo(r);
        return `<tr>
          <td><b>${shortId(r.id)}</b></td>
          <td>${r.qty} × ${esc(medName(r.medicineId))}</td>
          <td>${esc(r.patientName || "—")}</td>
          <td>${esc(getPh(r.pharmacyId)?.name || "—")}</td>
          <td>${money(r.amountPaid)}</td>
          <td><span class="pill ${st.pill}">${st.label}</span></td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
          <td class="actions">${ACTIVE_RES.includes(r.status) ? `<button class="btn sm danger" data-acancel="${r.id}">Cancel</button>` : ""}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`
    : `<div class="empty"><div class="big">🏷️</div><h3>No reservations in this list</h3></div>`;

  $("main").innerHTML = `
    <div class="page-head"><h2>Reservations</h2><p>Every online order on the network.</p></div>
    <div class="tabs">
      <button data-otab="active" class="${state.orderTab === "active" ? "active" : ""}">Active (${tabs.active.length})</button>
      <button data-otab="collected" class="${state.orderTab === "collected" ? "active" : ""}">Collected (${tabs.collected.length})</button>
      <button data-otab="cancelled" class="${state.orderTab === "cancelled" ? "active" : ""}">Cancelled (${tabs.cancelled.length})</button>
    </div>
    ${body}`;

  $("main").querySelectorAll("[data-otab]").forEach(b => b.onclick = () => { state.orderTab = b.dataset.otab; viewAdOrders(); });

  $("main").querySelectorAll("[data-acancel]").forEach(b => b.onclick = async () => {
    const ok = await confirmModal({
      title: "Cancel this reservation?", text: "Stock is returned to the pharmacy and both sides are notified.",
      okLabel: "Cancel reservation", danger: true,
    });
    if(!ok) return;
    try{
      const r = await cancelReservation(b.dataset.acancel, ACTIVE_RES, "admin");
      notify(r.patientId, `Your reservation for ${medName(r.medicineId)} was cancelled by the admin. A refund has been initiated (demo).`);
      notify(r.pharmacyOwnerId, `Admin cancelled reservation ${shortId(r.id)} (${r.qty} × ${medName(r.medicineId)}). Stock returned.`);
      toast("Reservation cancelled.");
    }catch(e){ console.error(e); toast(e.message || "Could not cancel.", "bad"); }
  });
}


/* ============================================================
   ADMIN — medicine catalog
   ============================================================ */
function viewAdMedicines(){
  const meds = [...cache.medicines].sort((a, b) => a.name.localeCompare(b.name));

  const loader = meds.length ? "" : `
    <div class="card" style="margin-bottom:16px; text-align:center">
      <p style="margin:0 0 10px">The catalog is empty. Load ${SAMPLE_MEDS.length} common medicines to get started.</p>
      <button class="btn primary" id="load-sample">Load sample catalog</button>
    </div>`;

  const body = meds.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Salt / generic</th><th>Manufacturer</th><th>Listed by</th><th></th></tr></thead>
      <tbody>${meds.map(m => {
        const listings = cache.inventory.filter(i => i.medicineId === m.id).length;
        return `<tr>
          <td><b>${esc(m.name)}</b></td>
          <td style="color:var(--muted)">${esc(m.generic)}</td>
          <td>${esc(m.mfr)}</td>
          <td>${listings} pharmac${listings !== 1 ? "ies" : "y"}</td>
          <td class="actions">
            <button class="btn sm ghost" data-edit-med="${m.id}">Edit</button>
            <button class="btn sm danger" data-del-med="${m.id}">Delete</button></td></tr>`;
      }).join("")}</tbody>
    </table></div>` : "";

  $("main").innerHTML = `
    <div class="page-head row between" style="align-items:flex-end">
      <div><h2>Medicine catalog</h2>
        <p>The shared master list. Pharmacies pick from this — one clean name per medicine.</p></div>
      <button class="btn primary" id="add-med">＋ Add medicine</button>
    </div>${loader}${body}`;

  const ls = $("load-sample");
  if(ls) ls.onclick = async () => {
    ls.disabled = true;
    ls.textContent = "Loading…";
    try{
      await Promise.all(SAMPLE_MEDS.map(([name, generic, mfr]) => addDoc(collection(db, "medicines"), { name, generic, mfr })));
      toast("Sample catalog loaded.", "good");
    }catch(e){
      console.error(e);
      toast("Could not load catalog.", "bad");
      ls.disabled = false;
      ls.textContent = "Load sample catalog";
    }
  };

  $("add-med").onclick = () => editMedicine(null);
  $("main").querySelectorAll("[data-edit-med]").forEach(b => b.onclick = () => editMedicine(b.dataset.editMed));
  $("main").querySelectorAll("[data-del-med]").forEach(b => b.onclick = async () => {
    const m = getMed(b.dataset.delMed);
    const listings = cache.inventory.filter(i => i.medicineId === m.id).length;
    if(listings){ toast(`Can't delete — ${m.name} is stocked by ${listings} pharmacy(ies).`, "bad"); return; }
    const ok = await confirmModal({ title: `Delete ${m.name}?`, text: "It will be removed from the shared catalog.", okLabel: "Delete", danger: true });
    if(!ok) return;
    try{ await deleteDoc(doc(db, "medicines", m.id)); toast("Deleted from catalog."); }
    catch(e){ console.error(e); toast("Could not delete.", "bad"); }
  });
}

function editMedicine(medId){
  const m = medId ? getMed(medId) : null;
  openModal(`
    <h3>${m ? "Edit medicine" : "Add medicine"}</h3>
    <p class="sub">${m ? "Update the catalog entry." : "Add a new medicine to the shared catalog."}</p>
    <label class="fld"><span class="lab">Brand / name</span>
      <input class="input" id="md-name" value="${m ? esc(m.name) : ""}" placeholder="e.g. Dolo 650"></label>
    <label class="fld"><span class="lab">Salt / generic</span>
      <input class="input" id="md-gen" value="${m ? esc(m.generic) : ""}" placeholder="e.g. Paracetamol 650mg"></label>
    <label class="fld"><span class="lab">Manufacturer</span>
      <input class="input" id="md-mfr" value="${m ? esc(m.mfr) : ""}" placeholder="e.g. Micro Labs"></label>
    <div class="err" id="md-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="md-save">${m ? "Save" : "Add"}</button>
    </div>`);
  $("md-name").focus();

  $("md-save").onclick = async () => {
    const name = $("md-name").value.trim();
    const generic = $("md-gen").value.trim();
    const mfr = $("md-mfr").value.trim() || "—";
    if(!name || !generic){ $("md-err").textContent = "Name and salt are required."; return; }
    const dupe = cache.medicines.some(x => x.name.toLowerCase() === name.toLowerCase() && (!m || x.id !== m.id));
    if(dupe){ $("md-err").textContent = "A medicine with that name already exists."; return; }

    const btn = $("md-save");
    btn.disabled = true;
    try{
      if(m) await updateDoc(doc(db, "medicines", m.id), { name, generic, mfr });
      else  await addDoc(collection(db, "medicines"), { name, generic, mfr });
      closeModal();
      toast(m ? "Catalog updated." : "Medicine added.", "good");
    }catch(e){
      console.error(e);
      $("md-err").textContent = "Could not save.";
      btn.disabled = false;
    }
  };
}


/* ============================================================
   ADMIN — accounts
   ============================================================ */
function viewAdAccounts(){
  const order = { admin: 0, pharmacy: 1, patient: 2 };
  const users = [...cache.users].sort((a, b) =>
    ((a.blocked ? 1 : 0) - (b.blocked ? 1 : 0)) || (order[a.role] - order[b.role]) || (a.name || "").localeCompare(b.name || ""));

  const rows = users.map(u => {
    const ph = u.role === "pharmacy" ? cache.pharmacies.find(p => p.ownerUserId === u.id) : null;
    const store = ph ? `${esc(ph.name)} · <span class="pill ${esc(ph.status)}">${esc(ph.status)}</span>` : "—";
    const isMe = u.id === ME.uid;
    const actions = isMe ? `<span style="color:var(--faint)">—</span>` : u.blocked
      ? `<button class="btn sm primary" data-unblock="${esc(u.id)}">Unblock</button>`
      : `${u.role !== "admin" ? `<button class="btn sm ghost" data-mkadmin="${esc(u.id)}">Make admin</button>` : ""}
         <button class="btn sm danger" data-block="${esc(u.id)}">Block</button>
         <button class="btn sm danger" data-delacc="${esc(u.id)}">Remove</button>`;
    return `<tr style="${u.blocked ? "opacity:.6" : ""}">
      <td><b>${esc(u.name || "—")}</b>${isMe ? ' <span class="pill neutral">you</span>' : ""}${u.blocked ? ' <span class="pill cancelled">blocked</span>' : ""}</td>
      <td><span class="pill ${ROLE_PILL[u.role] || "neutral"}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td><code>${esc(u.email || "—")}</code></td>
      <td>${esc(u.phone || "—")}</td>
      <td>${store}</td>
      <td class="actions">${actions}</td></tr>`;
  }).join("");

  $("main").innerHTML = `
    <div class="page-head"><h2>Accounts</h2><p>Everyone on the system. People create their own accounts from the sign-in screen.</p></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Store</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="hint">
      <b>Block</b> — the person is signed out immediately and can't sign back in to use the app. Reversible.<br>
      <b>Remove</b> — cancels their open reservations, deletes their store and notifications, and blocks the account
      (so they can't just sign up again with the same login). The login itself can only be deleted in the
      Firebase console → Authentication → Users.<br>
      <b>Make admin</b> — gives full admin rights. The first admin is claimed once by the admin email; every other admin is added here.
    </div>`;

  $("main").querySelectorAll("[data-block]").forEach(b => b.onclick = () => setBlocked(b.dataset.block, true));
  $("main").querySelectorAll("[data-unblock]").forEach(b => b.onclick = () => setBlocked(b.dataset.unblock, false));
  $("main").querySelectorAll("[data-mkadmin]").forEach(b => b.onclick = () => makeAdmin(b.dataset.mkadmin));
  $("main").querySelectorAll("[data-delacc]").forEach(b => b.onclick = () => deleteAccount(b.dataset.delacc));
}

async function setBlocked(userId, blocked){
  const u = getUser(userId);
  if(!u || u.id === ME.uid) return;
  if(blocked){
    const ok = await confirmModal({
      title: `Block ${u.name || "this user"}?`,
      text: "They are signed out right away and can't use the app until you unblock them.",
      okLabel: "Block", danger: true,
    });
    if(!ok) return;
  }
  try{
    await updateDoc(doc(db, "users", userId), { blocked });
    if(!blocked) notify(userId, "Your account has been unblocked by the admin.");
    toast(blocked ? `${u.name} blocked.` : `${u.name} unblocked.`, blocked ? "" : "good");
  }catch(e){ console.error(e); toast("Could not update the account.", "bad"); }
}

async function makeAdmin(userId){
  const u = getUser(userId);
  if(!u) return;
  const ok = await confirmModal({
    title: `Make ${u.name || "this user"} an admin?`,
    text: "They get full control: approvals, accounts, catalog and all reservations.",
    okLabel: "Make admin", danger: true,
  });
  if(!ok) return;
  try{
    await updateDoc(doc(db, "users", userId), { role: "admin" });
    notify(userId, "You are now a PharmaFind admin. Sign in again to see the admin tools.");
    toast(`${u.name} is now an admin.`, "good");
  }catch(e){ console.error(e); toast("Could not change the role.", "bad"); }
}

async function deleteAccount(userId){
  const u = getUser(userId);
  if(!u) return;
  if(u.id === ME.uid){ toast("You can't remove your own account.", "bad"); return; }

  const ph = u.role === "pharmacy" ? cache.pharmacies.find(p => p.ownerUserId === u.id) : null;
  const ok = await confirmModal({
    title: `Remove ${u.name || "this user"}'s account?`,
    text: ph
      ? `Removes their store "${ph.name}" and its inventory, cancels its open reservations, and blocks the account.`
      : "Cancels their open reservations (stock goes back), deletes their notifications, and blocks the account.",
    okLabel: "Remove account", danger: true,
  });
  if(!ok) return;

  try{
    if(ph) await removePharmacy(ph, null);

    const open = cache.reservations.filter(r => r.patientId === u.id && ACTIVE_RES.includes(r.status));
    for(const r of open){
      try{
        await cancelReservation(r.id, ACTIVE_RES, "admin");
        notify(r.pharmacyOwnerId, `Reservation ${shortId(r.id)} was cancelled (patient account removed). Stock returned.`);
      }catch(e){ console.warn(e); }
    }

    const notifSnap = await getDocs(query(collection(db, "notifications"), where("userId", "==", userId)));
    await Promise.all(notifSnap.docs.map(d => deleteDoc(d.ref).catch(() => {})));

    // Keep a blocked stub instead of deleting — otherwise they could sign in and re-register.
    await updateDoc(doc(db, "users", userId), { blocked: true, deleted: true, phone: "", address: "" });
    toast("Account removed and blocked.");
  }catch(e){
    console.error(e);
    toast("Could not remove the account completely.", "bad");
  }
}


/* ============================================================
   BOOT
   ============================================================ */
renderLoading("Loading…");