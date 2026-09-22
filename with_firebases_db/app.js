/* ============================================================
   PharmaFind — Firebase edition
   Roles: Admin · Medical (Pharmacy) · User (Patient)
   Backend: Firebase Authentication + Cloud Firestore (real-time)
   ------------------------------------------------------------
   HOW IT WORKS (read this once, it explains the whole file):

   • Auth is real now. Firebase Auth stores hashed passwords and
     manages sessions. We log in by username, which we turn into a
     fake email (username@pharmafind.local) so Firebase accepts it.

   • Firestore is the single source of truth. We do NOT read it on
     every render. Instead, when you sign in we attach real-time
     LISTENERS (onSnapshot) to the collections your role can see.
     Each listener keeps a local `cache` in sync, and any change —
     from you OR from another device — re-renders the current view.
     That's what makes stock update live when a pharmacy bills.

   • Because the cache mirrors Firestore, most view functions stay
     synchronous (they read the cache). Only writes are async.

   • Billing uses a Firestore TRANSACTION. It re-reads stock at
     commit time and aborts the whole bill if any line is short —
     real oversell protection across every device, not just one tab.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { firebaseConfig, emailFor } from "./firebase-config.js";

/* ---------- Firebase init ---------- */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* A SECOND app instance, used only when the admin creates a login.
   createUserWithEmailAndPassword signs you in as the new user — on the
   PRIMARY app that would kick the admin out. Doing it on a secondary
   app keeps the admin's own session untouched. */
let secondaryApp = null;
function getSecondaryAuth(){
  if(!secondaryApp) secondaryApp = initializeApp(firebaseConfig, "pf-secondary");
  return getAuth(secondaryApp);
}

/* ---------- Small helpers ---------- */
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const money = (n) => "₹" + Number(n).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* Patient's assumed location (Hyderabad city centre) for distance calc */
const USER_LOC = { lat: 17.3850, lng: 78.4867 };

/* ============================================================
   LOCAL CACHE  (kept in sync by onSnapshot listeners)
   ============================================================ */
let ME = null;   // { uid, role, name, username }
const cache = {
  users:[], pharmacies:[], medicines:[], inventory:[],
  reservations:[], bills:[], notifications:[],
};
let listeners = [];              // unsubscribe functions
let authBusy = false;            // true while WE drive an auth change
let modalOpen = false;
let pendingRefresh = false;

/* Transient view state (never persisted) */
const state = { view:null, searchQuery:"", billDraft:[] /* [{invId, qty}] */,
                authTab:"login", authRole:"patient" };

/* ---------- Lookups (read the cache, like the old DB) ---------- */
const getUser = (id) => cache.users.find(u => u.id === id);
const getMed  = (id) => cache.medicines.find(m => m.id === id);
const getPh   = (id) => cache.pharmacies.find(p => p.id === id);
const currentUser = () => ME;
const myPharmacy = () => cache.pharmacies.find(p => p.ownerUserId === (ME && ME.uid));

function stockState(q){
  if(q <= 0) return { key:"out", label:"Out of stock" };
  if(q <= 10) return { key:"low", label:"Low stock" };
  return { key:"ok", label:"In stock" };
}

function distanceKm(lat, lng){
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat-USER_LOC.lat), dLng=toRad(lng-USER_LOC.lng);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(USER_LOC.lat))*Math.cos(toRad(lat))*Math.sin(dLng/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(1);
}

function unreadCount(userId){ return cache.notifications.filter(n => n.userId===userId && !n.read).length; }

function timeAgo(ts){
  const s=Math.floor((now()-ts)/1000);
  if(s<60) return "just now";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}

/* Create a notification for any user (fire-and-forget) */
function notify(userId, text){
  addDoc(collection(db,"notifications"), { userId, text, read:false, createdAt:now() })
    .catch(e => console.warn("notify failed", e));
}

/* ---------- UI helpers ---------- */
function toast(msg, kind=""){
  const el=document.createElement("div");
  el.className="toast "+kind;
  el.textContent=msg;
  $("toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),300); }, 2600);
}

let modalCloser=null;
function openModal(html){
  const root=$("modal-root");
  root.innerHTML=`<div class="modal-bg" data-modalbg><div class="modal">${html}</div></div>`;
  modalOpen=true;
  modalCloser=()=>{ root.innerHTML=""; modalCloser=null; modalOpen=false;
    if(pendingRefresh){ pendingRefresh=false; renderApp(); } };
  root.querySelector("[data-modalbg]").addEventListener("mousedown", (e)=>{ if(e.target.dataset.modalbg!==undefined) modalCloser(); });
}
function closeModal(){ if(modalCloser) modalCloser(); }
window.closeModal = closeModal;   // referenced by inline onclick in modals

/* Called by every listener when data changes. Skips re-render while a
   modal is open (so a background update can't wipe a half-filled form) —
   the refresh is flushed when the modal closes. */
function refresh(){
  if(!ME){ return; }
  if(modalOpen){ pendingRefresh=true; return; }
  renderApp();
}

/* ============================================================
   REAL-TIME LISTENERS
   ============================================================ */
function teardownListeners(){
  listeners.forEach(unsub => { try{ unsub(); }catch(_){} });
  listeners = [];
  Object.keys(cache).forEach(k => cache[k] = []);
}

function setupListeners(){
  teardownListeners();
  const sub = (q, key) => {
    const unsub = onSnapshot(q,
      snap => { cache[key] = snap.docs.map(d => ({ id:d.id, ...d.data() })); refresh(); },
      err  => console.error("listener error ["+key+"]", err));
    listeners.push(unsub);
  };

  /* Everyone sees the shared catalog and (public) stock. */
  sub(collection(db,"medicines"), "medicines");
  sub(collection(db,"inventory"), "inventory");

  if(ME.role === "patient"){
    sub(collection(db,"pharmacies"), "pharmacies");                                 // public; filtered to approved in view
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
   SESSION lifecycle
   ============================================================ */
onAuthStateChanged(auth, async (fbUser) => {
  if(authBusy) return;                 // our own login/register flow handles it
  if(fbUser){ await initSession(fbUser.uid); }
  else { ME=null; teardownListeners(); renderAuth(); }
});

async function initSession(uid){
  let snap;
  try{ snap = await getDoc(doc(db,"users",uid)); }
  catch(e){ console.error(e); toast("Could not load your profile.", "bad"); await signOut(auth); return; }

  if(!snap.exists()){
    /* Auth account exists but the profile was removed (e.g. admin deleted it). */
    toast("This account is no longer active.", "bad");
    await signOut(auth); ME=null; renderAuth(); return;
  }
  const d = snap.data();
  ME = { uid, role:d.role, name:d.name, username:d.username };
  state.view = null; state.searchQuery=""; state.billDraft=[];
  setupListeners();
  renderApp();
}

/* ============================================================
   AUTH SCREEN
   ============================================================ */
function renderAuth(){
  const isLogin = state.authTab==="login";
  $("root").innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="brand"><span class="mark"><span>✚</span></span> PharmaFind</div>
      <div class="tag">Find medicines. Manage stock. All in one place.</div>

      <div class="seg">
        <button data-authtab="login" class="${isLogin?'active':''}">Sign in</button>
        <button data-authtab="register" class="${!isLogin?'active':''}">Register</button>
      </div>

      <div id="auth-body"></div>

      <div class="hint">
        <b>Demo logins</b> (run seed.html once to create these)<br>
        Admin — <b>admin</b> / admin123<br>
        Pharmacy — <b>medplus</b> / medplus123<br>
        Patient — <b>patient</b> / patient123
      </div>
    </div>
  </div>`;

  renderAuthBody();
  $("root").querySelectorAll("[data-authtab]").forEach(b=>{
    b.onclick=()=>{ state.authTab=b.dataset.authtab; renderAuth(); };
  });
}

function renderAuthBody(){
  const box=$("auth-body");
  if(state.authTab==="login"){
    box.innerHTML=`
      <label class="fld"><span class="lab">Username</span><input class="input" id="lg-user" placeholder="e.g. patient" autocomplete="off"></label>
      <label class="fld"><span class="lab">Password</span><input class="input" id="lg-pass" type="password" placeholder="••••••"></label>
      <div class="err" id="lg-err"></div>
      <button class="btn primary" id="lg-go" style="width:100%">Sign in</button>`;
    $("lg-go").onclick=doLogin;
    $("lg-pass").onkeydown=e=>{ if(e.key==="Enter") doLogin(); };
  } else {
    box.innerHTML=`
      <label class="fld"><span class="lab">I am a…</span>
        <select class="input" id="rg-role">
          <option value="patient">Patient — I want to find medicines</option>
          <option value="pharmacy">Pharmacy — I want to list my store</option>
        </select></label>
      <label class="fld"><span class="lab">Full name</span><input class="input" id="rg-name" placeholder="Your name"></label>
      <div id="rg-ph-fields"></div>
      <label class="fld"><span class="lab">Username</span><input class="input" id="rg-user" placeholder="Pick a username" autocomplete="off"></label>
      <label class="fld"><span class="lab">Password</span><input class="input" id="rg-pass" type="password" placeholder="At least 6 characters"></label>
      <div class="err" id="rg-err"></div>
      <button class="btn primary" id="rg-go" style="width:100%">Create account</button>`;
    const roleSel=$("rg-role"), phFields=$("rg-ph-fields");
    const drawPh=()=>{
      phFields.innerHTML = roleSel.value==="pharmacy" ? `
        <label class="fld"><span class="lab">Pharmacy name</span><input class="input" id="rg-phname" placeholder="e.g. City Care Pharmacy"></label>
        <label class="fld"><span class="lab">Address / area</span><input class="input" id="rg-phaddr" placeholder="e.g. Kukatpally, Hyderabad"></label>
        <label class="fld"><span class="lab">Opening hours</span><input class="input" id="rg-phhours" placeholder="e.g. 9:00 AM – 9:00 PM"></label>` : "";
    };
    roleSel.onchange=drawPh; drawPh();
    $("rg-go").onclick=doRegister;
  }
}

async function doLogin(){
  const u=$("lg-user").value.trim(), p=$("lg-pass").value;
  const errEl=$("lg-err"); errEl.textContent="";
  if(!u||!p){ errEl.textContent="Enter your username and password."; return; }
  const btn=$("lg-go"); btn.disabled=true; btn.textContent="Signing in…";
  authBusy=true;
  try{
    const cred = await signInWithEmailAndPassword(auth, emailFor(u), p);
    await initSession(cred.user.uid);
    toast("Signed in as "+(ME?ME.name:u), "good");
  }catch(e){
    errEl.textContent = "Wrong username or password. Try a demo login below.";
    console.warn("login failed", e.code || e);
  }finally{
    authBusy=false; if($("lg-go")){ btn.disabled=false; btn.textContent="Sign in"; }
  }
}

async function doRegister(){
  const role=$("rg-role").value;
  const name=$("rg-name").value.trim();
  const username=$("rg-user").value.trim();
  const password=$("rg-pass").value;
  const err=$("rg-err"); err.textContent="";
  if(!name||!username||!password){ err.textContent="Fill in name, username and password."; return; }
  if(password.length<6){ err.textContent="Password must be at least 6 characters."; return; }

  const btn=$("rg-go"); btn.disabled=true; btn.textContent="Creating…";
  authBusy=true;
  try{
    const cred = await createUserWithEmailAndPassword(auth, emailFor(username), password);
    const uid = cred.user.uid;
    await setDoc(doc(db,"users",uid), { role, name, username, createdAt:now() });

    if(role==="pharmacy"){
      const phname=$("rg-phname").value.trim()||name+"'s Pharmacy";
      const addr=$("rg-phaddr").value.trim()||"Hyderabad";
      const hours=$("rg-phhours").value.trim()||"9:00 AM – 9:00 PM";
      const lat=17.38+(Math.random()-.5)*0.12, lng=78.48+(Math.random()-.5)*0.12;
      await addDoc(collection(db,"pharmacies"),
        { ownerUserId:uid, name:phname, address:addr, lat, lng, hours, status:"pending", createdAt:now() });
      /* Admins see pending stores in their Approvals tab (the pharmacies
         listener drives that count) — no per-admin notification needed. */
    }

    await initSession(uid);
    toast("Account created — welcome!", "good");
  }catch(e){
    err.textContent = (e.code==="auth/email-already-in-use")
      ? "That username is taken." : "Could not create the account.";
    console.warn("register failed", e.code || e);
  }finally{
    authBusy=false; if($("rg-go")){ btn.disabled=false; btn.textContent="Create account"; }
  }
}

async function logout(){
  state.searchQuery=""; state.billDraft=[]; state.view=null;
  await signOut(auth);   // onAuthStateChanged tears down listeners + shows auth
}

/* ============================================================
   APP SHELL
   ============================================================ */
const NAV = {
  patient:[
    { v:"search", ic:"🔍", label:"Find medicine" },
    { v:"reservations", ic:"🏷️", label:"My reservations" },
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
    { v:"ad-accounts", ic:"👥", label:"Accounts & logins" },
    { v:"ad-approvals", ic:"✅", label:"Approvals" },
    { v:"ad-pharmacies", ic:"🏥", label:"Pharmacies" },
    { v:"ad-medicines", ic:"💊", label:"Medicine catalog" },
  ],
};
const DEFAULT_VIEW = { patient:"search", pharmacy:"ph-dash", admin:"ad-dash" };

function renderApp(){
  const user=currentUser();
  if(!user){ renderAuth(); return; }
  if(!state.view) state.view=DEFAULT_VIEW[user.role];

  const roleLabel={ patient:"Patient", pharmacy:"Pharmacy", admin:"Admin" }[user.role];
  const nav=NAV[user.role];

  const navItems=nav.map(n=>{
    let count="";
    if(user.role==="admin" && n.v==="ad-approvals"){
      const p=cache.pharmacies.filter(x=>x.status==="pending").length;
      if(p) count=`<span class="count">${p}</span>`;
    }
    if(user.role==="pharmacy" && n.v==="ph-reservations"){
      const ph=myPharmacy();
      const c = ph ? cache.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="pending").length : 0;
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
      <div class="who"><b>${esc(user.name)}</b><span class="sub">@${esc(user.username)}</span></div>
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
  const v=state.view;
  const map={
    search:viewSearch, reservations:viewPatientReservations,
    "ph-dash":viewPhDash, "ph-inventory":viewPhInventory, "ph-billing":viewPhBilling,
    "ph-reservations":viewPhReservations, "ph-sales":viewPhSales, "ph-settings":viewPhSettings,
    "ad-dash":viewAdDash, "ad-accounts":viewAdAccounts, "ad-approvals":viewAdApprovals,
    "ad-pharmacies":viewAdPharmacies, "ad-medicines":viewAdMedicines,
  };
  (map[v]||viewSearch)();
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
  openModal(`
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <h3>Notifications</h3>
      ${mine.length?`<button class="btn sm ghost" id="mark-read">Mark all read</button>`:""}
    </div>
    <div style="max-height:60vh; overflow:auto">${body}</div>
    <button class="btn" style="width:100%; margin-top:16px" onclick="closeModal()">Close</button>`);
  const mr=$("mark-read");
  if(mr) mr.onclick=async ()=>{
    const unread=cache.notifications.filter(n=>n.userId===u.uid && !n.read);
    closeModal();
    await Promise.all(unread.map(n=>updateDoc(doc(db,"notifications",n.id), { read:true }).catch(()=>{})));
  };
}

/* ============================================================
   PATIENT VIEWS
   ============================================================ */
function viewSearch(){
  const q=state.searchQuery.trim().toLowerCase();
  let resultsHtml="";

  if(!q){
    resultsHtml=`<div class="empty"><div class="big">💊</div>
      <h3>Search for a medicine</h3>
      <p>Type a brand or generic name — e.g. <b>Dolo</b>, <b>Paracetamol</b>, <b>Azithromycin</b>.</p></div>`;
  } else {
    const matchMeds=cache.medicines.filter(m =>
      m.name.toLowerCase().includes(q) || m.generic.toLowerCase().includes(q));
    const rows=[];
    matchMeds.forEach(m=>{
      cache.inventory.filter(i=>i.medicineId===m.id).forEach(i=>{
        const ph=getPh(i.pharmacyId);
        if(!ph || ph.status!=="approved") return;      // only approved, listed pharmacies
        rows.push({ med:m, inv:i, ph, dist:parseFloat(distanceKm(ph.lat, ph.lng)) });
      });
    });
    rows.sort((a,b)=> a.dist - b.dist);

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
              <span>📍 ${r.dist} km · ${esc(r.ph.address)}</span>
              <span>🕒 ${esc(r.ph.hours)}</span>
            </div>
          </div>
          <div class="right">
            <div class="price">${money(r.inv.price)}</div>
            <span class="pill ${ss.key}">${ss.label}${r.inv.quantity>0?` · ${r.inv.quantity}`:''}</span>
            <button class="btn ${canReserve?'primary':''} sm" data-reserve="${r.inv.id}" ${canReserve?'':'disabled'}>
              ${canReserve?'Reserve':'Unavailable'}</button>
          </div>
        </div>`;
      }).join("");
    }
  }

  $("main").innerHTML=`
    <div class="page-head"><h2>Find medicine</h2>
      <p>Showing live stock from approved pharmacies near you (Hyderabad).</p></div>
    <div class="card" style="padding:14px; margin-bottom:18px">
      <div class="row">
        <input class="input grow" id="search-in" placeholder="Search a medicine — name or salt…" value="${esc(state.searchQuery)}">
        <button class="btn primary" id="search-go">Search</button>
      </div>
    </div>
    <div id="search-results">${resultsHtml}</div>`;

  const inEl=$("search-in");
  const run=()=>{ state.searchQuery=inEl.value; viewSearch(); };
  $("search-go").onclick=run;
  inEl.onkeydown=e=>{ if(e.key==="Enter") run(); };
  // keep caret at end after re-render
  function inEl2focus(){ const el=$("search-in"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  if(q) inEl2focus();

  $("main").querySelectorAll("[data-reserve]").forEach(b=>{
    b.onclick=()=>reserveMedicine(b.dataset.reserve);
  });
}

function reserveMedicine(invId){
  const inv=cache.inventory.find(i=>i.id===invId);
  if(!inv || inv.quantity<=0){ toast("That item just went out of stock.", "bad"); viewSearch(); return; }
  const med=getMed(inv.medicineId), ph=getPh(inv.pharmacyId), u=currentUser();

  openModal(`
    <h3>Reserve ${esc(med.name)}</h3>
    <p class="sub">at ${esc(ph.name)} · ${money(inv.price)} each</p>
    <label class="fld"><span class="lab">Quantity (max ${inv.quantity})</span>
      <input class="input" id="res-qty" type="number" min="1" max="${inv.quantity}" value="1"></label>
    <div class="err" id="res-err"></div>
    <div class="row" style="justify-content:flex-end; margin-top:6px">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="res-confirm">Confirm reservation</button>
    </div>`);

  $("res-confirm").onclick=async ()=>{
    const qty=parseInt($("res-qty").value,10);
    if(!qty||qty<1){ $("res-err").textContent="Enter a valid quantity."; return; }
    if(qty>inv.quantity){ $("res-err").textContent="Not that many in stock."; return; }
    const btn=$("res-confirm"); btn.disabled=true;
    try{
      await addDoc(collection(db,"reservations"), {
        patientId:u.uid, patientName:u.name,
        pharmacyId:ph.id, pharmacyOwnerId:ph.ownerUserId,
        inventoryId:inv.id, medicineId:inv.medicineId,
        qty, status:"pending", createdAt:now(),
      });
      notify(ph.ownerUserId, `New reservation: ${qty} × ${med.name} — ${u.name}`);
      closeModal();
      toast("Reserved — the pharmacy has been notified.", "good");
    }catch(e){ console.error(e); $("res-err").textContent="Could not reserve. Try again."; btn.disabled=false; }
  };
}

function viewPatientReservations(){
  const u=currentUser();
  const mine=cache.reservations.filter(r=>r.patientId===u.uid).sort((a,b)=>b.createdAt-a.createdAt);
  const body = mine.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Qty</th><th>Status</th><th>When</th></tr></thead>
      <tbody>${mine.map(r=>{
        const med=getMed(r.medicineId), ph=getPh(r.pharmacyId);
        const cls={pending:"pending",fulfilled:"approved",cancelled:"suspended"}[r.status];
        return `<tr>
          <td><b>${esc(med?med.name:'—')}</b></td>
          <td>${esc(ph?ph.name:'—')}</td>
          <td>${r.qty}</td>
          <td><span class="pill ${cls}">${r.status}</span></td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>` :
    `<div class="empty"><div class="big">🏷️</div><h3>No reservations yet</h3>
      <p>Reserve a medicine from the search page to hold it for pickup.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>My reservations</h2>
    <p>Medicines you've asked a pharmacy to hold.</p></div>${body}`;
}

/* ============================================================
   PHARMACY VIEWS
   ============================================================ */
function pendingGate(){
  const ph=myPharmacy();
  if(ph && ph.status==="approved") return null;
  const status = ph ? ph.status : "pending";
  const msg = status==="suspended"
    ? "Your store has been suspended by the admin. Contact support to restore access."
    : "Your store is waiting for admin approval. You'll be able to manage inventory and billing once it's approved.";
  $("main").innerHTML=`<div class="empty" style="margin-top:40px">
    <div class="big">${status==="suspended"?"⛔":"⏳"}</div>
    <h3>${status==="suspended"?"Store suspended":"Awaiting approval"}</h3>
    <p style="max-width:420px; margin:0 auto">${msg}</p>
    <p style="margin-top:14px"><span class="pill ${status==='suspended'?'suspended':'pending'}">${status}</span></p>
  </div>`;
  return true;
}

function viewPhDash(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id);
  const low=inv.filter(i=>i.quantity>0 && i.quantity<=10).length;
  const outc=inv.filter(i=>i.quantity<=0).length;
  const myBills=cache.bills.filter(b=>b.pharmacyId===ph.id);
  const startToday=new Date(); startToday.setHours(0,0,0,0);
  const today=myBills.filter(b=>b.createdAt>=startToday.getTime());
  const revenue=myBills.reduce((s,b)=>s+b.total,0);
  const pendingRes=cache.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="pending").length;

  $("main").innerHTML=`
    <div class="page-head"><h2>${esc(ph.name)}</h2><p>${esc(ph.address)} · ${esc(ph.hours)}</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${inv.length}</div><div class="l">Medicines listed</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${low}</div><div class="l">Low stock (≤10)</div></div>
      <div class="stat"><div class="n" style="color:var(--out)">${outc}</div><div class="l">Out of stock</div></div>
      <div class="stat"><div class="n">${today.length}</div><div class="l">Bills today</div></div>
      <div class="stat money"><div class="n">${money(revenue)}</div><div class="l">Total revenue</div></div>
      <div class="stat"><div class="n">${pendingRes}</div><div class="l">Pending reservations</div></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between; margin-bottom:6px">
        <h3>Quick actions</h3></div>
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
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id);
  const body = inv.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Salt / generic</th><th>Price</th><th>Quantity</th><th>Status</th><th></th></tr></thead>
      <tbody>${inv.map(i=>{
        const m=getMed(i.medicineId), ss=stockState(i.quantity);
        return `<tr id="inv-row-${i.id}">
          <td><b>${esc(m?m.name:'—')}</b></td>
          <td style="color:var(--muted)">${esc(m?m.generic:'')}</td>
          <td>${money(i.price)}</td>
          <td><span id="qty-${i.id}">${i.quantity}</span></td>
          <td><span class="pill ${ss.key}">${ss.label}</span></td>
          <td style="text-align:right">
            <button class="btn sm ghost" data-edit-inv="${i.id}">Edit</button>
            <button class="btn sm danger" data-del-inv="${i.id}">Remove</button>
          </td></tr>`;
      }).join("")}</tbody>
    </table></div>` :
    `<div class="empty"><div class="big">📦</div><h3>No medicines listed yet</h3>
      <p>Add your first medicine so patients can find it.</p></div>`;

  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Inventory</h2><p>Stock patients see when they search. Keep it current.</p></div>
      <button class="btn primary" id="add-inv">＋ Add medicine</button>
    </div>${body}`;

  $("add-inv").onclick=()=>editInventory(null);
  $("main").querySelectorAll("[data-edit-inv]").forEach(b=> b.onclick=()=>editInventory(b.dataset.editInv));
  $("main").querySelectorAll("[data-del-inv]").forEach(b=> b.onclick=async ()=>{
    const i=cache.inventory.find(x=>x.id===b.dataset.delInv), m=getMed(i.medicineId);
    if(confirm(`Remove ${m?m.name:'this medicine'} from your inventory?`)){
      try{ await deleteDoc(doc(db,"inventory",i.id)); toast("Removed from inventory"); }
      catch(e){ console.error(e); toast("Could not remove item.", "bad"); }
    }
  });
}

function editInventory(invId){
  const ph=myPharmacy();
  const existing=invId?cache.inventory.find(i=>i.id===invId):null;
  // medicines not yet in this pharmacy's inventory (for new rows)
  const usedIds=new Set(cache.inventory.filter(i=>i.pharmacyId===ph.id).map(i=>i.medicineId));
  const options=cache.medicines
    .filter(m=> existing ? m.id===existing.medicineId : !usedIds.has(m.id))
    .map(m=>`<option value="${m.id}" ${existing&&existing.medicineId===m.id?'selected':''}>${esc(m.name)} — ${esc(m.generic)}</option>`).join("");

  if(!existing && !options){ toast("All catalog medicines are already listed.", "bad"); return; }

  openModal(`
    <h3>${existing?'Edit medicine':'Add medicine'}</h3>
    <p class="sub">${existing?'Update price and quantity.':'Pick from the shared catalog, then set your price and stock.'}</p>
    <label class="fld"><span class="lab">Medicine</span>
      <select class="input" id="iv-med" ${existing?'disabled':''}>${options}</select></label>
    <div class="row">
      <label class="fld grow"><span class="lab">Price (₹)</span>
        <input class="input" id="iv-price" type="number" min="0" step="0.5" value="${existing?existing.price:''}" placeholder="0.00"></label>
      <label class="fld grow"><span class="lab">Quantity</span>
        <input class="input" id="iv-qty" type="number" min="0" value="${existing?existing.quantity:''}" placeholder="0"></label>
    </div>
    <div class="err" id="iv-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="iv-save">${existing?'Save changes':'Add to inventory'}</button>
    </div>`);

  $("iv-save").onclick=async ()=>{
    const medId=$("iv-med").value;
    const price=parseFloat($("iv-price").value);
    const qty=parseInt($("iv-qty").value,10);
    if(isNaN(price)||price<0||isNaN(qty)||qty<0){ $("iv-err").textContent="Enter a valid price and quantity."; return; }
    const btn=$("iv-save"); btn.disabled=true;
    try{
      if(existing){ await updateDoc(doc(db,"inventory",existing.id), { price, quantity:qty }); }
      else { await addDoc(collection(db,"inventory"),
        { pharmacyId:ph.id, ownerUserId:ME.uid, medicineId:medId, quantity:qty, price }); }
      closeModal();
      toast(existing?"Inventory updated":"Medicine added", "good");
    }catch(e){ console.error(e); $("iv-err").textContent="Could not save. Try again."; btn.disabled=false; }
  };
}

/* ---------- Billing: bill + atomic stock reduction via transaction ---------- */
function viewPhBilling(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=cache.inventory.filter(i=>i.pharmacyId===ph.id && i.quantity>0);

  const pickerOptions=inv.map(i=>{
    const m=getMed(i.medicineId);
    return `<option value="${i.id}">${esc(m?m.name:'—')} — ${money(i.price)} (${i.quantity} left)</option>`;
  }).join("");

  // cart lines — drop any draft line whose stock/item disappeared
  state.billDraft = state.billDraft.filter(l => cache.inventory.some(i=>i.id===l.invId));
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

  const total=state.billDraft.reduce((s,l)=>{
    const i=cache.inventory.find(x=>x.id===l.invId); return s + (i?i.price*l.qty:0);
  },0);

  $("main").innerHTML=`
    <div class="page-head"><h2>New bill</h2>
      <p>Add items, then create the bill. Stock is reduced automatically the moment the bill is saved.</p></div>
    <div class="bill-grid">
      <div class="card">
        <h3 style="margin-bottom:14px">Add an item</h3>
        ${inv.length? `
        <div class="row">
          <select class="input grow" id="bill-med">${pickerOptions}</select>
          <input class="input" id="bill-qty" type="number" min="1" value="1" style="width:90px">
          <button class="btn primary" id="bill-add">Add</button>
        </div>` : `<p style="color:var(--muted)">No in-stock medicines to bill. Add stock in Inventory first.</p>`}
      </div>

      <div class="card bill-cart">
        <h3 style="margin-bottom:12px">Bill items</h3>
        ${state.billDraft.length? lines : `<p style="color:var(--muted); font-size:14px">No items added yet.</p>`}
        <div class="cart-total"><span>Total</span><span class="t">${money(total)}</span></div>
        <button class="btn money" id="bill-create" style="width:100%; margin-top:14px" ${state.billDraft.length?'':'disabled'}>
          Create bill · ${money(total)}</button>
        ${state.billDraft.length?`<button class="btn ghost" id="bill-clear" style="width:100%; margin-top:8px">Clear</button>`:''}
      </div>
    </div>`;

  const addBtn=$("bill-add");
  if(addBtn) addBtn.onclick=()=>{
    const invId=$("bill-med").value;
    const qty=parseInt($("bill-qty").value,10);
    if(!invId||!qty||qty<1){ toast("Pick a medicine and quantity.", "bad"); return; }
    const stock=cache.inventory.find(x=>x.id===invId).quantity;
    const line=state.billDraft.find(l=>l.invId===invId);
    const have=line?line.qty:0;
    if(have+qty>stock){ toast(`Only ${stock} in stock (you already have ${have} in this bill).`, "bad"); return; }
    if(line) line.qty+=qty; else state.billDraft.push({ invId, qty });
    viewPhBilling();
  };

  $("main").querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>{
    const l=state.billDraft.find(x=>x.invId===b.dataset.inc);
    const stock=cache.inventory.find(x=>x.id===b.dataset.inc).quantity;
    if(l.qty>=stock){ toast("That's all the stock there is.", "bad"); return; }
    l.qty++; viewPhBilling();
  });
  $("main").querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>{
    const l=state.billDraft.find(x=>x.invId===b.dataset.dec);
    l.qty--; if(l.qty<=0) state.billDraft=state.billDraft.filter(x=>x.invId!==b.dataset.dec);
    viewPhBilling();
  });
  $("main").querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{
    state.billDraft=state.billDraft.filter(x=>x.invId!==b.dataset.rm); viewPhBilling();
  });
  const clr=$("bill-clear"); if(clr) clr.onclick=()=>{ state.billDraft=[]; viewPhBilling(); };
  const create=$("bill-create"); if(create) create.onclick=createBill;
}

/*
  createBill — the transaction.
  runTransaction re-reads every line's inventory doc at commit time and,
  if ANY line no longer has enough stock, throws — which aborts the whole
  transaction: no bill is written and no stock is touched. This is a real
  `UPDATE ... WHERE quantity >= :qty` guard that holds across every device,
  not just one browser tab. Firestore also auto-retries the transaction if
  another write lands on the same docs mid-flight.
*/
async function createBill(){
  if(!state.billDraft.length) return;
  const ph=myPharmacy();
  const draft=[...state.billDraft];
  const btn=$("bill-create"); if(btn){ btn.disabled=true; btn.textContent="Creating…"; }

  const billRef = doc(collection(db,"bills"));   // pre-generate the bill id
  let receiptBill=null;

  try{
    await runTransaction(db, async (tx)=>{
      // 1. READ every line first (Firestore requires all reads before writes)
      const refs  = draft.map(l => doc(db,"inventory",l.invId));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));

      // 2. VALIDATE against live stock
      const items=[]; let total=0;
      snaps.forEach((s, idx)=>{
        const line=draft[idx];
        if(!s.exists()) throw new Error("An item is no longer available.");
        const data=s.data();
        if(data.quantity < line.qty){
          const m=getMed(data.medicineId);
          throw new Error(`Not enough stock for ${m?m.name:'an item'}.`);
        }
        const m=getMed(data.medicineId);
        const lineTotal=data.price*line.qty;
        total+=lineTotal;
        items.push({ medicineId:data.medicineId, name:m?m.name:"Item",
                     quantity:line.qty, unitPrice:data.price, lineTotal });   // snapshot price
      });

      // 3. WRITE: decrement each line, then create the bill — all atomic
      snaps.forEach((s, idx)=> tx.update(refs[idx], { quantity: s.data().quantity - draft[idx].qty }));
      tx.set(billRef, {
        pharmacyId:ph.id, ownerUserId:ME.uid, patientId:null,
        items, total, createdAt:now(),
      });
      receiptBill={ id:billRef.id, pharmacyId:ph.id, items, total, createdAt:now() };
    });
  }catch(e){
    console.warn("bill aborted:", e.message);
    toast((e.message||"Bill cancelled.")+" Nothing was changed.", "bad");
    viewPhBilling();
    return;
  }

  // 4. Low-stock alerts (outside the transaction) — quantities are now updated in cache soon,
  //    but compute from what we billed to alert immediately.
  receiptBill.items.forEach(it=>{
    const invNow=cache.inventory.find(i=>i.pharmacyId===ph.id && i.medicineId===it.medicineId);
    const left = invNow ? (invNow.quantity - it.quantity) : null;   // approx until snapshot lands
    if(left!==null && left<=10) notify(ME.uid, `Low stock: ${it.name} — ${left} left`);
  });

  state.billDraft=[];
  showBillReceipt(receiptBill, ph);
}

function showBillReceipt(bill, ph){
  const rows=bill.items.map(it=>`<tr>
    <td>${esc(it.name)}</td><td style="text-align:center">${it.quantity}</td>
    <td style="text-align:right">${money(it.unitPrice)}</td>
    <td style="text-align:right">${money(it.lineTotal)}</td></tr>`).join("");
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:34px">✅</div>
      <h3>Bill created</h3>
      <p class="sub">${esc(ph.name)} · #${String(bill.id).slice(0,8).toUpperCase()}</p>
    </div>
    <div class="table-wrap" style="box-shadow:none">
      <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div class="cart-total"><span>Amount charged</span><span class="t">${money(bill.total)}</span></div>
    <button class="btn primary" style="width:100%; margin-top:16px" id="rc-done">Done — stock updated</button>`);
  $("rc-done").onclick=()=>{ closeModal(); toast("Stock reduced automatically.", "good"); };
}

function viewPhReservations(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const res=cache.reservations.filter(r=>r.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const body = res.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Patient</th><th>Qty</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${res.map(r=>{
        const m=getMed(r.medicineId);
        const cls={pending:"pending",fulfilled:"approved",cancelled:"suspended"}[r.status];
        const actions = r.status==="pending" ? `
          <button class="btn sm primary" data-fulfill="${r.id}">Mark fulfilled</button>
          <button class="btn sm danger" data-cancel="${r.id}">Cancel</button>` : "—";
        return `<tr>
          <td><b>${esc(m?m.name:'—')}</b></td>
          <td>${esc(r.patientName||'Unknown')}</td>
          <td>${r.qty}</td>
          <td><span class="pill ${cls}">${r.status}</span></td>
          <td style="color:var(--muted)">${timeAgo(r.createdAt)}</td>
          <td style="text-align:right">${actions}</td></tr>`;
      }).join("")}</tbody>
    </table></div>` :
    `<div class="empty"><div class="big">🏷️</div><h3>No reservations</h3>
      <p>When a patient reserves one of your medicines, it appears here.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>Reservations</h2>
    <p>Requests from patients to hold a medicine.</p></div>${body}`;

  $("main").querySelectorAll("[data-fulfill]").forEach(b=>b.onclick=async ()=>{
    const r=cache.reservations.find(x=>x.id===b.dataset.fulfill);
    try{
      await updateDoc(doc(db,"reservations",r.id), { status:"fulfilled" });
      notify(r.patientId, `Your reservation for ${getMed(r.medicineId)?.name||'a medicine'} is ready for pickup.`);
      toast("Marked fulfilled — patient notified.", "good");
    }catch(e){ console.error(e); toast("Could not update reservation.", "bad"); }
  });
  $("main").querySelectorAll("[data-cancel]").forEach(b=>b.onclick=async ()=>{
    const r=cache.reservations.find(x=>x.id===b.dataset.cancel);
    try{
      await updateDoc(doc(db,"reservations",r.id), { status:"cancelled" });
      notify(r.patientId, `Your reservation for ${getMed(r.medicineId)?.name||'a medicine'} was cancelled.`);
      toast("Reservation cancelled.");
    }catch(e){ console.error(e); toast("Could not update reservation.", "bad"); }
  });
}

function viewPhSales(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const bills=cache.bills.filter(b=>b.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const revenue=bills.reduce((s,b)=>s+b.total,0);
  const body = bills.length ? `
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
    `<div class="empty"><div class="big">💰</div><h3>No sales yet</h3>
      <p>Create a bill and it'll show up here.</p></div>`;
  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Sales history</h2><p>Every bill you've created.</p></div>
      <div class="stat money" style="min-width:150px"><div class="n">${money(revenue)}</div><div class="l">Total revenue</div></div>
    </div>${body}`;
  $("main").querySelectorAll("[data-view-bill]").forEach(b=>b.onclick=()=>{
    const bill=cache.bills.find(x=>x.id===b.dataset.viewBill);
    showBillReceipt(bill, ph);
  });
}

function viewPhSettings(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  $("main").innerHTML=`
    <div class="page-head"><h2>Store settings</h2><p>Details patients see about your pharmacy.</p></div>
    <div class="card" style="max-width:520px">
      <label class="fld"><span class="lab">Pharmacy name</span><input class="input" id="set-name" value="${esc(ph.name)}"></label>
      <label class="fld"><span class="lab">Address / area</span><input class="input" id="set-addr" value="${esc(ph.address)}"></label>
      <label class="fld"><span class="lab">Opening hours</span><input class="input" id="set-hours" value="${esc(ph.hours)}"></label>
      <button class="btn primary" id="set-save">Save changes</button>
    </div>`;
  $("set-save").onclick=async ()=>{
    const name=$("set-name").value.trim()||ph.name;
    const address=$("set-addr").value.trim()||ph.address;
    const hours=$("set-hours").value.trim()||ph.hours;
    const btn=$("set-save"); btn.disabled=true;
    try{ await updateDoc(doc(db,"pharmacies",ph.id), { name, address, hours }); toast("Store details saved.", "good"); }
    catch(e){ console.error(e); toast("Could not save.", "bad"); btn.disabled=false; }
  };
}

/* ============================================================
   ADMIN VIEWS
   ============================================================ */
function viewAdDash(){
  const phAll=cache.pharmacies;
  const pending=phAll.filter(p=>p.status==="pending").length;
  const active=phAll.filter(p=>p.status==="approved").length;
  const revenue=cache.bills.reduce((s,b)=>s+b.total,0);
  const patients=cache.users.filter(u=>u.role==="patient").length;

  $("main").innerHTML=`
    <div class="page-head"><h2>Network overview</h2><p>Health of the whole PharmaFind network.</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${active}</div><div class="l">Active pharmacies</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${pending}</div><div class="l">Pending approval</div></div>
      <div class="stat"><div class="n">${patients}</div><div class="l">Registered patients</div></div>
      <div class="stat"><div class="n">${cache.medicines.length}</div><div class="l">Catalog medicines</div></div>
      <div class="stat"><div class="n">${cache.bills.length}</div><div class="l">Bills across network</div></div>
      <div class="stat money"><div class="n">${money(revenue)}</div><div class="l">Total network sales</div></div>
    </div>
    ${pending? `<div class="card"><div class="row" style="justify-content:space-between">
      <div><h3>${pending} pharmac${pending>1?'ies':'y'} waiting</h3>
      <p style="color:var(--muted); margin:4px 0 0">Approve them so their stock becomes searchable.</p></div>
      <button class="btn primary" data-go="ad-approvals">Review now</button></div></div>` : ""}`;
  const g=$("main").querySelector("[data-go]"); if(g) g.onclick=()=>{ state.view="ad-approvals"; renderApp(); };
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
          <span>👤 ${esc(owner?owner.name:'—')}</span></div>
      </div>
      <div class="right">
        <button class="btn primary sm" data-approve="${p.id}">Approve</button>
        <button class="btn danger sm" data-reject="${p.id}">Reject</button>
      </div></div>`;
  }).join("") :
    `<div class="empty"><div class="big">✅</div><h3>All caught up</h3>
      <p>No pharmacies are waiting for approval.</p></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>Pharmacy approvals</h2>
    <p>Only approved pharmacies appear in patient search.</p></div>${body}`;

  $("main").querySelectorAll("[data-approve]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.approve);
    try{
      await updateDoc(doc(db,"pharmacies",p.id), { status:"approved" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was approved. You can now manage inventory and billing.`);
      toast(`${p.name} approved.`, "good");
    }catch(e){ console.error(e); toast("Could not approve.", "bad"); }
  });
  $("main").querySelectorAll("[data-reject]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.reject);
    if(!confirm(`Reject ${p.name}? This removes the pharmacy.`)) return;
    try{
      notify(p.ownerUserId, `Your pharmacy registration "${p.name}" was rejected.`);
      // remove its inventory, then the store
      const invs=cache.inventory.filter(i=>i.pharmacyId===p.id);
      await Promise.all(invs.map(i=>deleteDoc(doc(db,"inventory",i.id)).catch(()=>{})));
      await deleteDoc(doc(db,"pharmacies",p.id));
      toast(`${p.name} rejected.`);
    }catch(e){ console.error(e); toast("Could not reject.", "bad"); }
  });
}

function viewAdPharmacies(){
  const all=cache.pharmacies;
  const body = all.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Pharmacy</th><th>Area</th><th>Items</th><th>Status</th><th></th></tr></thead>
      <tbody>${all.map(p=>{
        const items=cache.inventory.filter(i=>i.pharmacyId===p.id).length;
        const action = p.status==="approved"
          ? `<button class="btn sm danger" data-suspend="${p.id}">Suspend</button>`
          : p.status==="suspended"
          ? `<button class="btn sm primary" data-restore="${p.id}">Reactivate</button>`
          : `<button class="btn sm ghost" data-go2="ad-approvals">Review</button>`;
        return `<tr>
          <td><b>${esc(p.name)}</b></td>
          <td style="color:var(--muted)">${esc(p.address)}</td>
          <td>${items}</td>
          <td><span class="pill ${p.status}">${p.status}</span></td>
          <td style="text-align:right">${action}</td></tr>`;
      }).join("")}</tbody></table></div>` :
    `<div class="empty"><div class="big">🏥</div><h3>No pharmacies</h3></div>`;
  $("main").innerHTML=`<div class="page-head"><h2>All pharmacies</h2>
    <p>Every store on the network. Suspend to hide from patient search.</p></div>${body}`;

  $("main").querySelectorAll("[data-suspend]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.suspend);
    try{ await updateDoc(doc(db,"pharmacies",p.id), { status:"suspended" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" was suspended by admin.`); toast(`${p.name} suspended.`); }
    catch(e){ console.error(e); toast("Could not suspend.", "bad"); }
  });
  $("main").querySelectorAll("[data-restore]").forEach(b=>b.onclick=async ()=>{
    const p=getPh(b.dataset.restore);
    try{ await updateDoc(doc(db,"pharmacies",p.id), { status:"approved" });
      notify(p.ownerUserId, `Your pharmacy "${p.name}" is active again.`); toast(`${p.name} reactivated.`, "good"); }
    catch(e){ console.error(e); toast("Could not reactivate.", "bad"); }
  });
  $("main").querySelectorAll("[data-go2]").forEach(b=>b.onclick=()=>{ state.view=b.dataset.go2; renderApp(); });
}

function viewAdMedicines(){
  const meds=cache.medicines;
  const body = `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Salt / generic</th><th>Manufacturer</th><th>Listed by</th><th></th></tr></thead>
      <tbody>${meds.map(m=>{
        const listings=cache.inventory.filter(i=>i.medicineId===m.id).length;
        return `<tr>
          <td><b>${esc(m.name)}</b></td>
          <td style="color:var(--muted)">${esc(m.generic)}</td>
          <td>${esc(m.mfr)}</td>
          <td>${listings} pharmac${listings!==1?'ies':'y'}</td>
          <td style="text-align:right">
            <button class="btn sm ghost" data-edit-med="${m.id}">Edit</button>
            <button class="btn sm danger" data-del-med="${m.id}">Delete</button></td></tr>`;
      }).join("")}</tbody></table></div>`;
  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Medicine catalog</h2>
      <p>The shared master list. Pharmacies pick from this — one clean name per medicine, no duplicates.</p></div>
      <button class="btn primary" id="add-med">＋ Add medicine</button>
    </div>${body}`;

  $("add-med").onclick=()=>editMedicine(null);
  $("main").querySelectorAll("[data-edit-med]").forEach(b=>b.onclick=()=>editMedicine(b.dataset.editMed));
  $("main").querySelectorAll("[data-del-med]").forEach(b=>b.onclick=async ()=>{
    const m=getMed(b.dataset.delMed);
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
    <label class="fld"><span class="lab">Brand / name</span><input class="input" id="md-name" value="${m?esc(m.name):''}" placeholder="e.g. Dolo 650"></label>
    <label class="fld"><span class="lab">Salt / generic</span><input class="input" id="md-gen" value="${m?esc(m.generic):''}" placeholder="e.g. Paracetamol 650mg"></label>
    <label class="fld"><span class="lab">Manufacturer</span><input class="input" id="md-mfr" value="${m?esc(m.mfr):''}" placeholder="e.g. Micro Labs"></label>
    <div class="err" id="md-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="md-save">${m?'Save':'Add'}</button>
    </div>`);
  $("md-save").onclick=async ()=>{
    const name=$("md-name").value.trim(), gen=$("md-gen").value.trim(), mfr=$("md-mfr").value.trim();
    if(!name||!gen){ $("md-err").textContent="Name and salt are required."; return; }
    const dupe=cache.medicines.some(x=>x.name.toLowerCase()===name.toLowerCase() && (!m||x.id!==m.id));
    if(dupe){ $("md-err").textContent="A medicine with that name already exists."; return; }
    const btn=$("md-save"); btn.disabled=true;
    try{
      if(m){ await updateDoc(doc(db,"medicines",m.id), { name, generic:gen, mfr }); }
      else { await addDoc(collection(db,"medicines"), { name, generic:gen, mfr:mfr||"—" }); }
      closeModal(); toast(m?"Catalog updated":"Medicine added", "good");
    }catch(e){ console.error(e); $("md-err").textContent="Could not save."; btn.disabled=false; }
  };
}

/* ---------- Admin: accounts & logins ---------- */
const ROLE_LABEL = { admin:"Admin", pharmacy:"Medical (Pharmacy)", patient:"Patient" };
const ROLE_PILL  = { admin:"neutral", pharmacy:"approved", patient:"pending" };

function viewAdAccounts(){
  const me=currentUser();
  const order={ admin:0, pharmacy:1, patient:2 };
  const users=[...cache.users].sort((a,b)=> (order[a.role]-order[b.role]) || a.name.localeCompare(b.name));

  const rows=users.map(u=>{
    const ph = u.role==="pharmacy" ? cache.pharmacies.find(p=>p.ownerUserId===u.id) : null;
    const store = ph ? `${esc(ph.name)} · <span class="pill ${ph.status}">${ph.status}</span>` : "—";
    const isMe = u.id===me.uid;
    return `<tr>
      <td><b>${esc(u.name)}</b>${isMe?' <span class="pill neutral">you</span>':''}</td>
      <td><span class="pill ${ROLE_PILL[u.role]}">${ROLE_LABEL[u.role]}</span></td>
      <td><code>${esc(u.username)}</code></td>
      <td>
        <button class="btn sm danger" data-delacc="${u.id}" ${isMe?'disabled':''}>Delete</button>
      </td></tr>`;
  }).join("");

  $("main").innerHTML=`
    <div class="page-head row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Accounts &amp; logins</h2>
        <p>Create logins and share the user ID + password. Every account on the system is listed here.</p></div>
      <button class="btn primary" id="acc-create">＋ Create login</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Role</th><th>User ID</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="hint" style="margin-top:16px">
      <b>Passwords are handled by Firebase Auth</b> — they're hashed and never
      readable, not even by an admin (which is exactly how it should be). That's
      why there's no "show password" or admin reset here: resetting another
      user's password needs the Firebase <b>Admin SDK</b> (a Cloud Function).
      Deleting removes the account from the directory, which revokes app access.
    </div>`;

  $("acc-create").onclick=createAccount;
  $("main").querySelectorAll("[data-delacc]").forEach(b=>b.onclick=()=>deleteAccount(b.dataset.delacc));
}

function createAccount(){
  openModal(`
    <h3>Create login</h3>
    <p class="sub">Set a user ID and password, then share them with the account holder.</p>
    <label class="fld"><span class="lab">Account type</span>
      <select class="input" id="ac-role">
        <option value="pharmacy">Medical (Pharmacy) — runs an online store</option>
        <option value="patient">Patient — searches for medicine</option>
        <option value="admin">Admin — manages the system</option>
      </select></label>
    <label class="fld"><span class="lab">Full name</span><input class="input" id="ac-name" placeholder="Account holder's name"></label>
    <div id="ac-ph"></div>
    <div class="row">
      <label class="fld grow"><span class="lab">User ID</span><input class="input" id="ac-user" placeholder="e.g. citycare" autocomplete="off"></label>
      <label class="fld grow"><span class="lab">Password</span><input class="input" id="ac-pass" placeholder="Min 6 characters"></label>
    </div>
    <div class="err" id="ac-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="ac-save">Create login</button>
    </div>`);

  const roleSel=$("ac-role"), phBox=$("ac-ph");
  const drawPh=()=>{
    phBox.innerHTML = roleSel.value==="pharmacy" ? `
      <label class="fld"><span class="lab">Store name</span><input class="input" id="ac-phname" placeholder="e.g. City Care Pharmacy"></label>
      <div class="row">
        <label class="fld grow"><span class="lab">Area</span><input class="input" id="ac-phaddr" placeholder="e.g. Kukatpally, Hyderabad"></label>
        <label class="fld grow"><span class="lab">Hours</span><input class="input" id="ac-phhours" placeholder="9 AM – 9 PM"></label>
      </div>` : "";
  };
  roleSel.onchange=drawPh; drawPh();

  $("ac-save").onclick=async ()=>{
    const role=roleSel.value;
    const name=$("ac-name").value.trim();
    const username=$("ac-user").value.trim();
    const password=$("ac-pass").value.trim();
    const err=$("ac-err"); err.textContent="";
    if(!name||!username||!password){ err.textContent="Name, user ID and password are all required."; return; }
    if(password.length<6){ err.textContent="Password must be at least 6 characters."; return; }

    const btn=$("ac-save"); btn.disabled=true; btn.textContent="Creating…";
    let phName="";
    try{
      // Create the Auth user on the SECONDARY app so the admin stays signed in.
      const secAuth=getSecondaryAuth();
      const cred=await createUserWithEmailAndPassword(secAuth, emailFor(username), password);
      const newUid=cred.user.uid;
      await signOut(secAuth);

      await setDoc(doc(db,"users",newUid), { role, name, username, createdAt:now() });

      if(role==="pharmacy"){
        phName=$("ac-phname").value.trim()||name+"'s Pharmacy";
        const addr=$("ac-phaddr").value.trim()||"Hyderabad";
        const hours=$("ac-phhours").value.trim()||"9:00 AM – 9:00 PM";
        const lat=17.38+(Math.random()-.5)*0.12, lng=78.48+(Math.random()-.5)*0.12;
        // admin-created stores are trusted → go live immediately
        await addDoc(collection(db,"pharmacies"),
          { ownerUserId:newUid, name:phName, address:addr, lat, lng, hours, status:"approved", createdAt:now() });
        notify(newUid, `Your store "${phName}" is live. Sign in to manage inventory and billing.`);
      }
      closeModal();
      showCreatedCredentials({ role, name, username, password }, phName);
    }catch(e){
      console.error(e);
      err.textContent = (e.code==="auth/email-already-in-use")
        ? "That user ID is already taken." : "Could not create the login.";
      btn.disabled=false; btn.textContent="Create login";
    }
  };
}

function showCreatedCredentials(user, phName){
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:34px">✅</div>
      <h3>Login created</h3>
      <p class="sub">${ROLE_LABEL[user.role]}${phName?` · ${esc(phName)}`:''}</p>
    </div>
    <div class="card" style="box-shadow:none; background:var(--surface-2)">
      <div class="row" style="justify-content:space-between"><span style="color:var(--muted)">Name</span><b>${esc(user.name)}</b></div>
      <div class="row" style="justify-content:space-between; margin-top:8px"><span style="color:var(--muted)">User ID</span><code>${esc(user.username)}</code></div>
      <div class="row" style="justify-content:space-between; margin-top:8px"><span style="color:var(--muted)">Password</span><code>${esc(user.password)}</code></div>
    </div>
    <p style="font-size:13px; color:var(--muted); margin:14px 0 0">Share these now — the password is hashed in Firebase and can't be shown again later.</p>
    <button class="btn primary" style="width:100%; margin-top:14px" id="cc-done">Done</button>`);
  $("cc-done").onclick=()=>{ closeModal(); toast("Login created.", "good"); };
}

async function deleteAccount(userId){
  const u=getUser(userId);
  if(u.id===ME.uid){ toast("You can't delete your own account.", "bad"); return; }
  if(u.role==="admin" && cache.users.filter(x=>x.role==="admin").length<=1){
    toast("Can't delete the only admin.", "bad"); return;
  }
  const ph = u.role==="pharmacy" ? cache.pharmacies.find(p=>p.ownerUserId===u.id) : null;
  const warn = ph ? ` This also removes their store "${ph.name}" and its inventory.` : "";
  if(!confirm(`Delete ${u.name}'s account?${warn}\n\n(Note: this removes their profile and data. The underlying Auth login can only be fully deleted with the Admin SDK.)`)) return;

  try{
    if(ph){
      const invs=cache.inventory.filter(i=>i.pharmacyId===ph.id);
      await Promise.all(invs.map(i=>deleteDoc(doc(db,"inventory",i.id)).catch(()=>{})));
      await deleteDoc(doc(db,"pharmacies",ph.id));
    }
    const notifs=cache.notifications.filter(n=>n.userId===userId);
    await Promise.all(notifs.map(n=>deleteDoc(doc(db,"notifications",n.id)).catch(()=>{})));
    await deleteDoc(doc(db,"users",userId));
    toast("Account deleted.");
  }catch(e){ console.error(e); toast("Could not delete account.", "bad"); }
}

/* ============================================================
   BOOT
   ============================================================ */
$("root").innerHTML=`<div class="auth-wrap"><div class="auth-card" style="text-align:center">
  <div class="brand" style="justify-content:center"><span class="mark"><span>✚</span></span> PharmaFind</div>
  <p class="tag" style="margin-top:14px">Loading…</p></div></div>`;
/* onAuthStateChanged (registered above) takes over from here:
   if a session is remembered it restores it, otherwise it shows sign-in. */
