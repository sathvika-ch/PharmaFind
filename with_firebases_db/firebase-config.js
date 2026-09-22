/* ============================================================
   firebase-config.js  —  filled in with YOUR project's values.
   (The apiKey here is safe to keep in your code — Firebase web
   keys are public by design. Real security comes from
   firestore.rules, applied in the setup steps.)
   ============================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyAdo5MJE8Hjxp9l2lSoXdh23dx_8tb7OjI",
  authDomain: "pharmafind-3529c.firebaseapp.com",
  projectId: "pharmafind-3529c",
  storageBucket: "pharmafind-3529c.firebasestorage.app",
  messagingSenderId: "938918577503",
  appId: "1:938918577503:web:102f7d65c188b059ce62ea",
};

/* PharmaFind logs users in by a username (e.g. "patient"), but Firebase
   Auth needs an email. We map one to the other with a fake domain.
   The domain is never emailed — it just makes a valid, unique email. */
export const emailFor = (username) =>
  String(username).trim().toLowerCase() + "@pharmafind.local";
