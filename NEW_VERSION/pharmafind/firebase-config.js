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
   automatically on first sign-in. Use lowercase.

   ⚠️ The SAME email(s) must also be in adminEmails() inside
   firestore.rules — otherwise the rules refuse the admin account.
   ============================================================ */
export const ADMIN_EMAILS = [
  "chavanaboinasathvika@gmail.com",
];
