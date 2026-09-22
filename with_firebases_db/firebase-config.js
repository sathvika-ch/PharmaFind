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
   automatically. Put YOUR real email here (the one you'll sign in
   with). You can add more than one.

   ⚠️ IMPORTANT: the SAME email(s) must also be written into
   firestore.rules (there's a matching list there) — otherwise the
   rules won't let you become an admin. Keep the two in sync.
   ============================================================ */
export const ADMIN_EMAILS = [
  "put-your-chavanaboinasathvika@gmail.com",   // <-- CHANGE THIS to your real email
];
