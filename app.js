/* ============================================================
   PharmaFind — single-file demo
   Roles: Admin · Medical (Pharmacy) · User (Patient)
   Storage: localStorage (key below). No server.
   ============================================================ */

const DB_KEY = "pharmafind_db_v1";
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const now = () => Date.now();
const money = (n) => "₹" + Number(n).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* Patient's assumed location (Hyderabad city centre) for distance calc */
const USER_LOC = { lat: 17.3850, lng: 78.4867 };

/* ---------- Data layer ---------- */
let DB = null;

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){ console.warn("load failed", e); }
  return seed();
}

function saveDB(){
  try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
  catch(e){ toast("Could not save data (storage blocked)", "bad"); }
}

function seed(){
  const admin = { id:uid(), role:"admin", name:"System Admin", username:"admin", password:"admin123" };
  const owner1 = { id:uid(), role:"pharmacy", name:"Ravi (MedPlus)", username:"medplus", password:"123" };
  const owner2 = { id:uid(), role:"pharmacy", name:"Sana (Apollo)", username:"apollo", password:"123" };
  const patient = { id:uid(), role:"patient", name:"Sangeeth", username:"patient", password:"123" };

  const ph1 = { id:uid(), ownerUserId:owner1.id, name:"MedPlus Pharmacy", address:"Ameerpet, Hyderabad",
                lat:17.4374, lng:78.4487, hours:"9:00 AM – 10:00 PM", status:"approved" };
  const ph2 = { id:uid(), ownerUserId:owner2.id, name:"Apollo Pharmacy", address:"Banjara Hills, Hyderabad",
                lat:17.4126, lng:78.4482, hours:"8:00 AM – 11:00 PM", status:"pending" };

  const M = (name, generic, mfr) => ({ id:uid(), name, generic, mfr });
  const meds = [
    M("Dolo 650", "Paracetamol 650mg", "Micro Labs"),
    M("Azithromycin 500", "Azithromycin 500mg", "Cipla"),
    M("Cetirizine 10", "Cetirizine 10mg", "Dr. Reddy's"),
    M("Amoxicillin 500", "Amoxicillin 500mg", "Sun Pharma"),
    M("Pantoprazole 40", "Pantoprazole 40mg", "Alkem"),
    M("ORS Powder", "Oral Rehydration Salts", "FDC"),
    M("Vitamin C 500", "Ascorbic Acid 500mg", "HealthVit"),
    M("Metformin 500", "Metformin 500mg", "USV"),
    M("Amlodipine 5", "Amlodipine 5mg", "Torrent"),
    M("Ibuprofen 400", "Ibuprofen 400mg", "Abbott"),
  ];
  const byName = (n) => meds.find(m => m.name === n).id;

  const inv = [
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("Dolo 650"), quantity:120, price:2.5 },
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("Azithromycin 500"), quantity:8, price:14.0 },
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("Cetirizine 10"), quantity:0, price:1.8 },
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("Pantoprazole 40"), quantity:45, price:6.5 },
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("ORS Powder"), quantity:60, price:20.0 },
    { id:uid(), pharmacyId:ph1.id, medicineId:byName("Vitamin C 500"), quantity:5, price:4.2 },
  ];

  return {
    users:[admin, owner1, owner2, patient],
    pharmacies:[ph1, ph2],
    medicines:meds,
    inventory:inv,
    reservations:[],
    bills:[],
    billItems:[],
    notifications:[],
    session:null,
    _seeded:true,
  };
}

/* ---------- Lookups ---------- */
const getUser = (id) => DB.users.find(u => u.id === id);
const getMed = (id) => DB.medicines.find(m => m.id === id);
const getPh = (id) => DB.pharmacies.find(p => p.id === id);
const currentUser = () => DB.session ? getUser(DB.session) : null;
const myPharmacy = () => DB.pharmacies.find(p => p.ownerUserId === DB.session);

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

function notify(userId, text){
  DB.notifications.push({ id:uid(), userId, text, read:false, createdAt:now() });
}
function unreadCount(userId){ return DB.notifications.filter(n => n.userId===userId && !n.read).length; }

function timeAgo(ts){
  const s=Math.floor((now()-ts)/1000);
  if(s<60) return "just now";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
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
  modalCloser=()=>{ root.innerHTML=""; modalCloser=null; };
  root.querySelector("[data-modalbg]").addEventListener("mousedown", (e)=>{ if(e.target.dataset.modalbg!==undefined) modalCloser(); });
}
function closeModal(){ if(modalCloser) modalCloser(); }

/* Transient view state (not persisted) */
const state = { view:null, searchQuery:"", billDraft:[] /* [{medicineId, qty}] */, authTab:"login", authRole:"patient" };

/* ============================================================
   AUTH
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
        <b>Demo logins</b><br>
        Admin — <b>admin</b> / admin123<br>
        Pharmacy — <b>medplus</b> / 123<br>
        Patient — <b>patient</b> / 123
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
      <label class="fld"><span class="lab">Password</span><input class="input" id="rg-pass" type="password" placeholder="Create a password"></label>
      <div class="err" id="rg-err"></div>
      <button class="btn primary" id="rg-go" style="width:100%">Create account</button>`;
    const roleSel=$("rg-role");
    const phFields=$("rg-ph-fields");
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

function doLogin(){
  const u=$("lg-user").value.trim(), p=$("lg-pass").value;
  const user=DB.users.find(x=>x.username.toLowerCase()===u.toLowerCase() && x.password===p);
  if(!user){ $("lg-err").textContent="Wrong username or password. Try a demo login below."; return; }
  DB.session=user.id; saveDB();
  state.view=null;
  toast("Signed in as "+user.name, "good");
  renderApp();
}

function doRegister(){
  const role=$("rg-role").value;
  const name=$("rg-name").value.trim();
  const username=$("rg-user").value.trim();
  const password=$("rg-pass").value;
  const err=$("rg-err");
  if(!name||!username||!password){ err.textContent="Fill in name, username and password."; return; }
  if(DB.users.some(x=>x.username.toLowerCase()===username.toLowerCase())){ err.textContent="That username is taken."; return; }

  const user={ id:uid(), role, name, username, password };
  DB.users.push(user);

  if(role==="pharmacy"){
    const phname=$("rg-phname").value.trim()||name+"'s Pharmacy";
    const addr=$("rg-phaddr").value.trim()||"Hyderabad";
    const hours=$("rg-phhours").value.trim()||"9:00 AM – 9:00 PM";
    // scatter around Hyderabad for demo distance
    const lat=17.38+ (Math.random()-.5)*0.12, lng=78.48+ (Math.random()-.5)*0.12;
    DB.pharmacies.push({ id:uid(), ownerUserId:user.id, name:phname, address:addr, lat, lng, hours, status:"pending" });
    // tell every admin
    DB.users.filter(x=>x.role==="admin").forEach(a=>notify(a.id, `New pharmacy awaiting approval: ${phname}`));
  }

  DB.session=user.id; saveDB();
  state.view=null;
  toast("Account created — welcome!", "good");
  renderApp();
}

function logout(){
  DB.session=null; saveDB();
  state.searchQuery=""; state.billDraft=[]; state.view=null;
  renderAuth();
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
      const p=DB.pharmacies.filter(x=>x.status==="pending").length;
      if(p) count=`<span class="count">${p}</span>`;
    }
    if(user.role==="pharmacy" && n.v==="ph-reservations"){
      const ph=myPharmacy();
      const c = ph ? DB.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="pending").length : 0;
      if(c) count=`<span class="count">${c}</span>`;
    }
    return `<button class="navitem ${state.view===n.v?'active':''}" data-view="${n.v}">
      <span class="ic">${n.ic}</span> ${n.label} ${count}</button>`;
  }).join("");

  const unread=unreadCount(user.id);

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
  const mine=DB.notifications.filter(n=>n.userId===u.id).sort((a,b)=>b.createdAt-a.createdAt);
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
  if(mr) mr.onclick=()=>{ DB.notifications.forEach(n=>{ if(n.userId===u.id) n.read=true; }); saveDB(); closeModal(); renderApp(); };
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
    const matchMeds=DB.medicines.filter(m =>
      m.name.toLowerCase().includes(q) || m.generic.toLowerCase().includes(q));
    const rows=[];
    matchMeds.forEach(m=>{
      DB.inventory.filter(i=>i.medicineId===m.id).forEach(i=>{
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
      <p>Showing stock from approved pharmacies near you (Hyderabad).</p></div>
    <div class="card" style="padding:14px; margin-bottom:18px">
      <div class="row">
        <input class="input grow" id="search-in" placeholder="Search a medicine — name or salt…" value="${esc(state.searchQuery)}">
        <button class="btn primary" id="search-go">Search</button>
      </div>
    </div>
    <div id="search-results">${resultsHtml}</div>`;

  const inEl=$("search-in");
  const run=()=>{ state.searchQuery=inEl.value; viewSearch(); inEl2focus(); };
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
  const inv=DB.inventory.find(i=>i.id===invId);
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

  $("res-confirm").onclick=()=>{
    const qty=parseInt($("res-qty").value,10);
    if(!qty||qty<1){ $("res-err").textContent="Enter a valid quantity."; return; }
    if(qty>inv.quantity){ $("res-err").textContent="Not that many in stock."; return; }
    DB.reservations.push({ id:uid(), patientId:u.id, pharmacyId:ph.id, inventoryId:inv.id,
      medicineId:inv.medicineId, qty, status:"pending", createdAt:now() });
    notify(getPh(ph.id).ownerUserId, `New reservation: ${qty} × ${med.name} — ${u.name}`);
    saveDB(); closeModal();
    toast("Reserved — the pharmacy has been notified.", "good");
  };
}

function viewPatientReservations(){
  const u=currentUser();
  const mine=DB.reservations.filter(r=>r.patientId===u.id).sort((a,b)=>b.createdAt-a.createdAt);
  const body = mine.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Qty</th><th>Status</th><th>When</th></tr></thead>
      <tbody>${mine.map(r=>{
        const med=getMed(r.medicineId), ph=getPh(r.pharmacyId);
        const cls={pending:"pending",fulfilled:"approved",cancelled:"suspended"}[r.status];
        return `<tr>
          <td><b>${esc(med.name)}</b></td>
          <td>${esc(ph.name)}</td>
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
  const inv=DB.inventory.filter(i=>i.pharmacyId===ph.id);
  const low=inv.filter(i=>i.quantity>0 && i.quantity<=10).length;
  const outc=inv.filter(i=>i.quantity<=0).length;
  const myBills=DB.bills.filter(b=>b.pharmacyId===ph.id);
  const startToday=new Date(); startToday.setHours(0,0,0,0);
  const today=myBills.filter(b=>b.createdAt>=startToday.getTime());
  const revenue=myBills.reduce((s,b)=>s+b.total,0);
  const pendingRes=DB.reservations.filter(r=>r.pharmacyId===ph.id && r.status==="pending").length;

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
  const inv=DB.inventory.filter(i=>i.pharmacyId===ph.id);
  const body = inv.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Salt / generic</th><th>Price</th><th>Quantity</th><th>Status</th><th></th></tr></thead>
      <tbody>${inv.map(i=>{
        const m=getMed(i.medicineId), ss=stockState(i.quantity);
        return `<tr id="inv-row-${i.id}">
          <td><b>${esc(m.name)}</b></td>
          <td style="color:var(--muted)">${esc(m.generic)}</td>
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
  $("main").querySelectorAll("[data-del-inv]").forEach(b=> b.onclick=()=>{
    const i=DB.inventory.find(x=>x.id===b.dataset.delInv), m=getMed(i.medicineId);
    if(confirm(`Remove ${m.name} from your inventory?`)){
      DB.inventory=DB.inventory.filter(x=>x.id!==b.dataset.delInv); saveDB(); viewPhInventory();
      toast("Removed from inventory");
    }
  });
}

function editInventory(invId){
  const ph=myPharmacy();
  const existing=invId?DB.inventory.find(i=>i.id===invId):null;
  // medicines not yet in this pharmacy's inventory (for new rows)
  const usedIds=new Set(DB.inventory.filter(i=>i.pharmacyId===ph.id).map(i=>i.medicineId));
  const options=DB.medicines
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

  $("iv-save").onclick=()=>{
    const medId=$("iv-med").value;
    const price=parseFloat($("iv-price").value);
    const qty=parseInt($("iv-qty").value,10);
    if(isNaN(price)||price<0||isNaN(qty)||qty<0){ $("iv-err").textContent="Enter a valid price and quantity."; return; }
    if(existing){ existing.price=price; existing.quantity=qty; }
    else DB.inventory.push({ id:uid(), pharmacyId:ph.id, medicineId:medId, quantity:qty, price });
    saveDB(); closeModal(); viewPhInventory();
    toast(existing?"Inventory updated":"Medicine added", "good");
  };
}

/* ---------- Billing (the core: bill + atomic stock reduction) ---------- */
function viewPhBilling(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const inv=DB.inventory.filter(i=>i.pharmacyId===ph.id && i.quantity>0);

  const pickerOptions=inv.map(i=>{
    const m=getMed(i.medicineId);
    return `<option value="${i.id}">${esc(m.name)} — ${money(i.price)} (${i.quantity} left)</option>`;
  }).join("");

  // cart lines
  const lines=state.billDraft.map(line=>{
    const i=DB.inventory.find(x=>x.id===line.invId);
    const m=getMed(i.medicineId);
    return `<div class="cart-line">
      <div class="cn"><b>${esc(m.name)}</b><small>${money(i.price)} × ${line.qty} · ${i.quantity} in stock</small></div>
      <div class="qty-stepper">
        <button data-dec="${line.invId}">−</button><span>${line.qty}</span><button data-inc="${line.invId}">＋</button>
      </div>
      <button class="btn sm danger" data-rm="${line.invId}">✕</button>
    </div>`;
  }).join("");

  const total=state.billDraft.reduce((s,l)=>{
    const i=DB.inventory.find(x=>x.id===l.invId); return s + i.price*l.qty;
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
    const stock=DB.inventory.find(x=>x.id===invId).quantity;
    const line=state.billDraft.find(l=>l.invId===invId);
    const have=line?line.qty:0;
    if(have+qty>stock){ toast(`Only ${stock} in stock (you already have ${have} in this bill).`, "bad"); return; }
    if(line) line.qty+=qty; else state.billDraft.push({ invId, qty });
    viewPhBilling();
  };

  $("main").querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>{
    const l=state.billDraft.find(x=>x.invId===b.dataset.inc);
    const stock=DB.inventory.find(x=>x.id===b.dataset.inc).quantity;
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
  All lines succeed together or the whole bill is aborted.
  Oversell guard: re-check each line's stock at commit time; if any line
  no longer has enough, nothing is written. (localStorage + single-thread JS
  makes this check-then-write atomic in practice — mirrors an SQL
  `UPDATE ... WHERE quantity >= :qty` with a rows-affected check.)
*/
function createBill(){
  if(!state.billDraft.length) return;
  const ph=myPharmacy(), u=currentUser();

  // 1. Validate every line against current stock BEFORE writing anything
  for(const line of state.billDraft){
    const inv=DB.inventory.find(i=>i.id===line.invId);
    if(!inv || inv.quantity < line.qty){
      const m=inv?getMed(inv.medicineId).name:"an item";
      toast(`Not enough stock for ${m}. Bill cancelled — nothing was changed.`, "bad");
      viewPhBilling();
      return;                       // abort: no bill, no stock change (rollback)
    }
  }

  // 2. Commit: write bill, line items, and decrement stock together
  const bill={ id:uid(), pharmacyId:ph.id, patientId:null, total:0, createdAt:now() };
  let total=0;
  const changedRows=[];
  state.billDraft.forEach(line=>{
    const inv=DB.inventory.find(i=>i.id===line.invId);
    const m=getMed(inv.medicineId);
    const lineTotal=inv.price*line.qty;
    total+=lineTotal;
    DB.billItems.push({ id:uid(), billId:bill.id, medicineId:inv.medicineId,
      name:m.name, quantity:line.qty, unitPrice:inv.price, lineTotal });   // snapshot price
    inv.quantity-=line.qty;                                                // reduce stock
    changedRows.push({ invId:inv.id, medName:m.name, left:inv.quantity });
  });
  bill.total=total;
  DB.bills.push(bill);

  // 3. Low-stock alerts for the owner
  changedRows.forEach(r=>{ if(r.left<=10) notify(u.id, `Low stock: ${r.medName} — ${r.left} left`); });

  saveDB();
  const items=[...DB.billItems.filter(bi=>bi.billId===bill.id)];
  state.billDraft=[];
  showBillReceipt(bill, items, ph);
}

function showBillReceipt(bill, items, ph){
  const rows=items.map(it=>`<tr>
    <td>${esc(it.name)}</td><td style="text-align:center">${it.quantity}</td>
    <td style="text-align:right">${money(it.unitPrice)}</td>
    <td style="text-align:right">${money(it.lineTotal)}</td></tr>`).join("");
  openModal(`
    <div style="text-align:center; margin-bottom:14px">
      <div style="font-size:34px">✅</div>
      <h3>Bill created</h3>
      <p class="sub">${esc(ph.name)} · #${bill.id.toUpperCase()}</p>
    </div>
    <div class="table-wrap" style="box-shadow:none">
      <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div class="cart-total"><span>Amount charged</span><span class="t">${money(bill.total)}</span></div>
    <button class="btn primary" style="width:100%; margin-top:16px" id="rc-done">Done — stock updated</button>`);
  $("rc-done").onclick=()=>{ closeModal(); viewPhBilling(); toast("Stock reduced automatically.", "good"); };
}

function viewPhReservations(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const res=DB.reservations.filter(r=>r.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const body = res.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Medicine</th><th>Patient</th><th>Qty</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${res.map(r=>{
        const m=getMed(r.medicineId), pat=getUser(r.patientId);
        const cls={pending:"pending",fulfilled:"approved",cancelled:"suspended"}[r.status];
        const actions = r.status==="pending" ? `
          <button class="btn sm primary" data-fulfill="${r.id}">Mark fulfilled</button>
          <button class="btn sm danger" data-cancel="${r.id}">Cancel</button>` : "—";
        return `<tr>
          <td><b>${esc(m.name)}</b></td>
          <td>${esc(pat?pat.name:'Unknown')}</td>
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

  $("main").querySelectorAll("[data-fulfill]").forEach(b=>b.onclick=()=>{
    const r=DB.reservations.find(x=>x.id===b.dataset.fulfill);
    r.status="fulfilled"; notify(r.patientId, `Your reservation for ${getMed(r.medicineId).name} is ready for pickup.`);
    saveDB(); viewPhReservations(); toast("Marked fulfilled — patient notified.", "good");
  });
  $("main").querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>{
    const r=DB.reservations.find(x=>x.id===b.dataset.cancel);
    r.status="cancelled"; notify(r.patientId, `Your reservation for ${getMed(r.medicineId).name} was cancelled.`);
    saveDB(); viewPhReservations(); toast("Reservation cancelled.");
  });
}

function viewPhSales(){
  if(pendingGate()) return;
  const ph=myPharmacy();
  const bills=DB.bills.filter(b=>b.pharmacyId===ph.id).sort((a,b)=>b.createdAt-a.createdAt);
  const revenue=bills.reduce((s,b)=>s+b.total,0);
  const body = bills.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Bill #</th><th>Items</th><th>When</th><th style="text-align:right">Amount</th><th></th></tr></thead>
      <tbody>${bills.map(b=>{
        const items=DB.billItems.filter(bi=>bi.billId===b.id);
        const count=items.reduce((s,i)=>s+i.quantity,0);
        return `<tr>
          <td><b>#${b.id.toUpperCase()}</b></td>
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
    const bill=DB.bills.find(x=>x.id===b.dataset.viewBill);
    showBillReceipt(bill, DB.billItems.filter(bi=>bi.billId===bill.id), ph);
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
  $("set-save").onclick=()=>{
    ph.name=$("set-name").value.trim()||ph.name;
    ph.address=$("set-addr").value.trim()||ph.address;
    ph.hours=$("set-hours").value.trim()||ph.hours;
    saveDB(); toast("Store details saved.", "good"); renderApp();
  };
}

/* ============================================================
   ADMIN VIEWS
   ============================================================ */
function viewAdDash(){
  const phAll=DB.pharmacies;
  const pending=phAll.filter(p=>p.status==="pending").length;
  const active=phAll.filter(p=>p.status==="approved").length;
  const revenue=DB.bills.reduce((s,b)=>s+b.total,0);
  const patients=DB.users.filter(u=>u.role==="patient").length;

  $("main").innerHTML=`
    <div class="page-head"><h2>Network overview</h2><p>Health of the whole PharmaFind network.</p></div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${active}</div><div class="l">Active pharmacies</div></div>
      <div class="stat"><div class="n" style="color:var(--low)">${pending}</div><div class="l">Pending approval</div></div>
      <div class="stat"><div class="n">${patients}</div><div class="l">Registered patients</div></div>
      <div class="stat"><div class="n">${DB.medicines.length}</div><div class="l">Catalog medicines</div></div>
      <div class="stat"><div class="n">${DB.bills.length}</div><div class="l">Bills across network</div></div>
      <div class="stat money"><div class="n">${money(revenue)}</div><div class="l">Total network sales</div></div>
    </div>
    ${pending? `<div class="card"><div class="row" style="justify-content:space-between">
      <div><h3>${pending} pharmac${pending>1?'ies':'y'} waiting</h3>
      <p style="color:var(--muted); margin:4px 0 0">Approve them so their stock becomes searchable.</p></div>
      <button class="btn primary" data-go="ad-approvals">Review now</button></div></div>` : ""}`;
  const g=$("main").querySelector("[data-go]"); if(g) g.onclick=()=>{ state.view="ad-approvals"; renderApp(); };
}

function viewAdApprovals(){
  const pending=DB.pharmacies.filter(p=>p.status==="pending");
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

  $("main").querySelectorAll("[data-approve]").forEach(b=>b.onclick=()=>{
    const p=getPh(b.dataset.approve); p.status="approved";
    notify(p.ownerUserId, `Your pharmacy "${p.name}" was approved. You can now manage inventory and billing.`);
    saveDB(); renderApp(); toast(`${p.name} approved.`, "good");
  });
  $("main").querySelectorAll("[data-reject]").forEach(b=>b.onclick=()=>{
    const p=getPh(b.dataset.reject);
    if(!confirm(`Reject ${p.name}? This removes the pharmacy.`)) return;
    notify(p.ownerUserId, `Your pharmacy registration "${p.name}" was rejected.`);
    DB.pharmacies=DB.pharmacies.filter(x=>x.id!==p.id);
    DB.inventory=DB.inventory.filter(i=>i.pharmacyId!==p.id);
    saveDB(); renderApp(); toast(`${p.name} rejected.`);
  });
}

function viewAdPharmacies(){
  const all=DB.pharmacies;
  const body = all.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Pharmacy</th><th>Area</th><th>Items</th><th>Status</th><th></th></tr></thead>
      <tbody>${all.map(p=>{
        const items=DB.inventory.filter(i=>i.pharmacyId===p.id).length;
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

  $("main").querySelectorAll("[data-suspend]").forEach(b=>b.onclick=()=>{
    const p=getPh(b.dataset.suspend); p.status="suspended";
    notify(p.ownerUserId, `Your pharmacy "${p.name}" was suspended by admin.`);
    saveDB(); viewAdPharmacies(); toast(`${p.name} suspended.`);
  });
  $("main").querySelectorAll("[data-restore]").forEach(b=>b.onclick=()=>{
    const p=getPh(b.dataset.restore); p.status="approved";
    notify(p.ownerUserId, `Your pharmacy "${p.name}" is active again.`);
    saveDB(); viewAdPharmacies(); toast(`${p.name} reactivated.`, "good");
  });
  $("main").querySelectorAll("[data-go2]").forEach(b=>b.onclick=()=>{ state.view=b.dataset.go2; renderApp(); });
}

function viewAdMedicines(){
  const meds=DB.medicines;
  const body = `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Salt / generic</th><th>Manufacturer</th><th>Listed by</th><th></th></tr></thead>
      <tbody>${meds.map(m=>{
        const listings=DB.inventory.filter(i=>i.medicineId===m.id).length;
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
  $("main").querySelectorAll("[data-del-med]").forEach(b=>b.onclick=()=>{
    const m=getMed(b.dataset.delMed);
    const listings=DB.inventory.filter(i=>i.medicineId===m.id).length;
    if(listings){ toast(`Can't delete — ${m.name} is stocked by ${listings} pharmacy(ies).`, "bad"); return; }
    if(confirm(`Delete ${m.name} from the catalog?`)){
      DB.medicines=DB.medicines.filter(x=>x.id!==m.id); saveDB(); viewAdMedicines(); toast("Deleted from catalog.");
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
  $("md-save").onclick=()=>{
    const name=$("md-name").value.trim(), gen=$("md-gen").value.trim(), mfr=$("md-mfr").value.trim();
    if(!name||!gen){ $("md-err").textContent="Name and salt are required."; return; }
    const dupe=DB.medicines.some(x=>x.name.toLowerCase()===name.toLowerCase() && (!m||x.id!==m.id));
    if(dupe){ $("md-err").textContent="A medicine with that name already exists."; return; }
    if(m){ m.name=name; m.generic=gen; m.mfr=mfr; }
    else DB.medicines.push({ id:uid(), name, generic:gen, mfr:mfr||"—" });
    saveDB(); closeModal(); viewAdMedicines(); toast(m?"Catalog updated":"Medicine added", "good");
  };
}

/* ---------- Admin: accounts & logins ---------- */
const ROLE_LABEL = { admin:"Admin", pharmacy:"Medical (Pharmacy)", patient:"Patient" };
const ROLE_PILL  = { admin:"neutral", pharmacy:"approved", patient:"pending" };

function viewAdAccounts(){
  const me=currentUser();
  const order={ admin:0, pharmacy:1, patient:2 };
  const users=[...DB.users].sort((a,b)=> (order[a.role]-order[b.role]) || a.name.localeCompare(b.name));

  const rows=users.map(u=>{
    const ph = u.role==="pharmacy" ? DB.pharmacies.find(p=>p.ownerUserId===u.id) : null;
    const store = ph ? `${esc(ph.name)} · <span class="pill ${ph.status}">${ph.status}</span>` : "—";
    const isMe = u.id===me.id;
    return `<tr>
      <td><b>${esc(u.name)}</b>${isMe?' <span class="pill neutral">you</span>':''}</td>
      <td><span class="pill ${ROLE_PILL[u.role]}">${ROLE_LABEL[u.role]}</span></td>
      <td><code>${esc(u.username)}</code></td>
      <td>
        <span class="pw" data-pw="${esc(u.password)}" style="font-family:monospace">••••••</span>
        <button class="btn sm ghost" data-reveal="${u.id}" style="padding:2px 8px">show</button>
      </td>
      <td>${store}</td>
      <td style="text-align:right; white-space:nowrap">
        <button class="btn sm ghost" data-reset="${u.id}">Reset password</button>
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
      <thead><tr><th>Name</th><th>Role</th><th>User ID</th><th>Password</th><th>Store</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="hint" style="margin-top:16px">
      <b>Demo note:</b> passwords are shown in plain text here only so you can showcase logins easily.
      A real system stores them <b>hashed</b> — never readable, even by the admin.
    </div>`;

  $("acc-create").onclick=createAccount;

  $("main").querySelectorAll("[data-reveal]").forEach(b=>b.onclick=()=>{
    const cell=b.previousElementSibling;
    if(b.textContent==="show"){ cell.textContent=cell.dataset.pw; b.textContent="hide"; }
    else { cell.textContent="••••••"; b.textContent="show"; }
  });
  $("main").querySelectorAll("[data-reset]").forEach(b=>b.onclick=()=>resetPassword(b.dataset.reset));
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
      <label class="fld grow"><span class="lab">Password</span><input class="input" id="ac-pass" placeholder="e.g. 1234"></label>
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

  $("ac-save").onclick=()=>{
    const role=roleSel.value;
    const name=$("ac-name").value.trim();
    const username=$("ac-user").value.trim();
    const password=$("ac-pass").value.trim();
    const err=$("ac-err");
    if(!name||!username||!password){ err.textContent="Name, user ID and password are all required."; return; }
    if(DB.users.some(u=>u.username.toLowerCase()===username.toLowerCase())){ err.textContent="That user ID is already taken."; return; }

    const user={ id:uid(), role, name, username, password };
    DB.users.push(user);

    let phName="";
    if(role==="pharmacy"){
      phName=$("ac-phname").value.trim()||name+"'s Pharmacy";
      const addr=$("ac-phaddr").value.trim()||"Hyderabad";
      const hours=$("ac-phhours").value.trim()||"9:00 AM – 9:00 PM";
      const lat=17.38+(Math.random()-.5)*0.12, lng=78.48+(Math.random()-.5)*0.12;
      // admin-created stores are trusted → go live immediately
      DB.pharmacies.push({ id:uid(), ownerUserId:user.id, name:phName, address:addr, lat, lng, hours, status:"approved" });
      notify(user.id, `Your store "${phName}" is live. Sign in to manage inventory and billing.`);
    }
    saveDB(); closeModal();
    showCreatedCredentials(user, phName);
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
    <p style="font-size:13px; color:var(--muted); margin:14px 0 0">Share these with the account holder. They sign in from the same login screen.</p>
    <button class="btn primary" style="width:100%; margin-top:14px" id="cc-done">Done</button>`);
  $("cc-done").onclick=()=>{ closeModal(); viewAdAccounts(); toast("Login created.", "good"); };
}

function resetPassword(userId){
  const u=getUser(userId);
  openModal(`
    <h3>Reset password</h3>
    <p class="sub">for ${esc(u.name)} · <code>${esc(u.username)}</code></p>
    <label class="fld"><span class="lab">New password</span><input class="input" id="rp-pass" placeholder="New password"></label>
    <div class="err" id="rp-err"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="rp-save">Save password</button>
    </div>`);
  $("rp-save").onclick=()=>{
    const p=$("rp-pass").value.trim();
    if(!p){ $("rp-err").textContent="Enter a new password."; return; }
    u.password=p; notify(u.id, "Your password was reset by the admin.");
    saveDB(); closeModal(); viewAdAccounts(); toast("Password updated.", "good");
  };
}

function deleteAccount(userId){
  const u=getUser(userId);
  if(u.id===DB.session){ toast("You can't delete your own account.", "bad"); return; }
  if(u.role==="admin" && DB.users.filter(x=>x.role==="admin").length<=1){
    toast("Can't delete the only admin.", "bad"); return;
  }
  const ph = u.role==="pharmacy" ? DB.pharmacies.find(p=>p.ownerUserId===u.id) : null;
  const warn = ph ? ` This also removes their store "${ph.name}" and its inventory.` : "";
  if(!confirm(`Delete ${u.name}'s account?${warn}`)) return;

  if(ph){
    DB.inventory=DB.inventory.filter(i=>i.pharmacyId!==ph.id);
    DB.pharmacies=DB.pharmacies.filter(p=>p.id!==ph.id);
  }
  DB.users=DB.users.filter(x=>x.id!==userId);
  DB.notifications=DB.notifications.filter(n=>n.userId!==userId);
  saveDB(); viewAdAccounts(); toast("Account deleted.");
}

/* ============================================================
   BOOT
   ============================================================ */
DB=loadDB(); saveDB();
window.closeModal=closeModal;   // used by inline onclick in modals
renderApp();
