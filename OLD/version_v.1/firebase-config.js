/* ============================================================
   firebase-config.js  —  your project's values.
   (The apiKey is safe in client code — real security is in
   firestore.rules.)
   ============================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyAdo5MJE8Hjxp9l2lSoXdh23dx_8tb7OjI",
  authDomain: "pharmafind-3529c.firebaseapp.com",
  projectId: "pharmafind-3529c",
  storageBucket: "pharmafind-3529c.firebasestorage.app",
  messagingSenderId: "938918577503",
  appId: "1:938918577503:web:102f7d65c188b059ce62ea",
};

/* ============================================================
   ADMIN EMAILS
   ------------------------------------------------------------
   Anyone who signs in with an email in this list becomes an ADMIN
   automatically.

   ⚠️ The SAME email(s) must also be in adminEmails() inside
   firestore.rules — keep the two lists identical (lowercase).
   ============================================================ */
export const ADMIN_EMAILS = [
  "chavanaboinasathvika@gmail.com",
];

/* Default map point used for distances until the patient shares
   their location (Hyderabad city centre). */
export const DEFAULT_LOCATION = { lat: 17.3850, lng: 78.4867, label: "Hyderabad (city centre)" };
