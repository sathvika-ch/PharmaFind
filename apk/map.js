/* ============================================================
   PharmaFind — map.js   (ADD-ON, step 1)
   ------------------------------------------------------------
   Map view for patients + "pick on map" for store location.
   Uses Leaflet + OpenStreetMap: free, no API key, no account.

   This file is self-contained. app.js only calls the three
   functions exported here. To switch the whole feature OFF,
   set MAP_ENABLED to false — the app then behaves exactly as
   it did before this file existed.
   ============================================================ */

export const MAP_ENABLED = true;

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_JS  = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const TILE_URL    = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

let leafletPromise = null;
let activeMap = null;        // the patient map currently on screen (only one at a time)
let popupOpen = false;


/* Loads Leaflet once, the first time a map is needed. */
export function loadLeaflet(){
  if(window.L) return Promise.resolve(window.L);
  if(leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);

    const js = document.createElement("script");
    js.src = LEAFLET_JS;
    js.onload = () => window.L ? resolve(window.L) : reject(new Error("Map library failed to start."));
    js.onerror = () => { leafletPromise = null; reject(new Error("Couldn't load the map. Check your internet connection.")); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}


function pin(L, emoji, cls){
  return L.divIcon({
    className: "",
    html: `<div class="map-pin ${cls}"><span>${emoji}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 32], popupAnchor: [0, -30],
  });
}


/* True while a marker popup is open — app.js waits with live redraws
   so the popup (and its Reserve button) doesn't vanish under the user. */
export function mapIsBusy(){ return popupOpen; }


export function destroyPharmacyMap(){
  if(activeMap){ try{ activeMap.remove(); }catch(_){} }
  activeMap = null;
  popupOpen = false;
}


/* Patient map.
   el      : the container element
   me      : { lat, lng, label }            — the patient's position
   points  : [{ lat, lng, html, dim }]      — one per pharmacy (html = popup content, already escaped)
   view    : { lat, lng, zoom } | null      — restore a previous view
   onView  : (view) => void                 — called when the user pans/zooms
   onPopup : (popupElement) => void         — wire buttons inside a popup
   onIdle  : () => void                     — called when a popup closes */
export async function showPharmacyMap(el, { me, points, view, onView, onPopup, onIdle }){
  const L = await loadLeaflet();
  if(!el.isConnected) return;            // the page changed while Leaflet was loading
  destroyPharmacyMap();
  el.innerHTML = "";                     // remove the "Loading map…" placeholder

  const map = L.map(el, { scrollWheelZoom: true });
  activeMap = map;
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);

  L.marker([me.lat, me.lng], { icon: pin(L, "🧍", "me"), zIndexOffset: 1000, keyboard: false })
    .addTo(map)
    .bindPopup(`<b>You are here</b><br><small>${me.label}</small>`);

  const latlngs = [[me.lat, me.lng]];
  points.forEach(p => {
    L.marker([p.lat, p.lng], { icon: pin(L, "🏥", p.dim ? "dim" : "ph"), title: p.title || "" })
      .addTo(map)
      .bindPopup(p.html, { maxWidth: 290, minWidth: 220 });
    latlngs.push([p.lat, p.lng]);
  });

  if(view) map.setView([view.lat, view.lng], view.zoom);
  else if(latlngs.length > 1) map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
  else map.setView([me.lat, me.lng], 13);

  map.on("moveend", () => {
    const c = map.getCenter();
    if(onView) onView({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  });
  map.on("popupopen", (e) => {
    popupOpen = true;
    if(onPopup) onPopup(e.popup.getElement());
  });
  map.on("popupclose", () => {
    popupOpen = false;
    if(onIdle) setTimeout(onIdle, 50);
  });
}


/* Store-location picker (used in a dialog).
   Click the map or drag the pin; onPick gets { lat, lng } each time. */
export async function showLocationPicker(el, { start, onPick }){
  const L = await loadLeaflet();
  if(!el.isConnected) return null;

  el.innerHTML = "";
  const map = L.map(el).setView([start.lat, start.lng], 15);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);

  const marker = L.marker([start.lat, start.lng], { icon: pin(L, "🏥", "ph"), draggable: true }).addTo(map);
  const report = () => { const p = marker.getLatLng(); onPick({ lat: p.lat, lng: p.lng }); };

  marker.on("dragend", report);
  map.on("click", (e) => { marker.setLatLng(e.latlng); report(); });

  setTimeout(() => map.invalidateSize(), 100);   // the dialog animates in
  return {
    moveTo(lat, lng){ marker.setLatLng([lat, lng]); map.setView([lat, lng], 16); report(); },
    destroy(){ try{ map.remove(); }catch(_){} },
  };
}
