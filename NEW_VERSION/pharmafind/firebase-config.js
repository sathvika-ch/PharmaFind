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
   THE ADMIN  (PharmaFind has exactly ONE admin)
   ------------------------------------------------------------
   This email is the only account that can manage PharmaFind.
   It becomes admin automatically when it signs in. Use lowercase.

   ⚠️ The SAME email must also be in adminEmails() inside
   firestore.rules — the rules are what actually enforce it.
   ============================================================ */
export const ADMIN_EMAILS = [
  "chavanaboinasathvika@gmail.com",
];
