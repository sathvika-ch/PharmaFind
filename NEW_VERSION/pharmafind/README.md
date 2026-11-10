# PharmaFind — setup guide

Medicine availability & pharmacy finder. Roles: **Admin · Pharmacy · Patient**.
Firebase Auth (passwordless email link) + Cloud Firestore (live data).

## Files

| File | What it is |
|---|---|
| `index.html` | App shell — loads `styles.css` and `app.js` |
| `app.js` | The whole app (auth, live cache, all screens) |
| `styles.css` | Styling, dark mode, mobile layout |
| `firebase-config.js` | Firebase keys + `ADMIN_EMAILS` |
| `firestore.rules` | Security rules — **paste into the Firebase console** |
| `seed.html` | Admin-only demo data loader (catalog + sample stock) |

## One-time Firebase console setup

1. **Authentication → Sign-in method → Email/Password** → enable it **and** enable **Email link (passwordless sign-in)**.
2. **Authentication → Settings → Authorized domains** → make sure the address you open the app from is listed
   (`localhost` is there by default; add your GitHub Pages / hosting domain when you deploy).
3. **Firestore Database → Rules** → paste all of `firestore.rules` → **Publish**.
4. Admin email: it must be the same in **both** `firebase-config.js` (`ADMIN_EMAILS`) and `firestore.rules` (`adminEmails()`), in lowercase.

## Run locally

The app uses ES modules, so it must be served over http (not opened as `file://`):

```
cd pharmafind
npx serve .            # or:  python -m http.server 8000
```

Open the printed address (e.g. `http://localhost:3000`).

## Demo walkthrough

1. Sign in with the **admin email** → name → you're admin.
2. Sign in with a **second email** → choose *Pharmacy* → fill store details (tap 📍 to set its location).
3. Back as admin, open **`seed.html`** on the same address → *Load sample catalog* → pick the pharmacy →
   *Add sample stock* (tick "approve"). Or do it by hand: Medicine catalog → Load sample; Approvals → Approve.
4. Sign in with a **third email** as *Patient* → search "Dolo" → Reserve & pay (mock card, any numbers).
5. As the pharmacy: Reservations → Mark fulfilled / Cancel; New bill → add items → Create bill.

## How stock stays correct

- **Reserve & pay** runs one transaction: stock goes down by the reserved quantity and the reservation is created
  together. The rules only let a patient lower stock when a matching new reservation is created in the same write,
  and the amount paid must equal price × quantity.
- **Cancel** (pharmacy or admin) puts the reserved quantity back into stock.
- **Billing** runs one transaction: checks stock, lowers it and writes the bill. The rules re-check that every bill
  line lowered the matching inventory by exactly that quantity, at that price, and that the total adds up.
  Limit: **8 different medicines per bill** (a rules limit — start a second bill for more).
- Bills can never be edited or deleted.

## Known limits (by design for a demo)

- Payment is a **mock** card screen. The rules check the amount, but nothing checks that money really moved —
  a real gateway (Razorpay etc.) needs a server / Cloud Function to verify payments.
- Deleting an account removes its Firestore data; the email login itself stays in Firebase Auth
  (removing that needs the Admin SDK). If that person signs in again, they set up a fresh profile.
- Patient location comes from the browser (📍 button). Without permission, distances are from Hyderabad centre.
  Geolocation only works on `https://` or `localhost`.

## Upgrading from the older version

- New pharmacy stores use the owner's uid as the document id and new inventory uses `<pharmacyId>_<medicineId>`.
  Existing data from the old version keeps working.
- Accounts created by the **old** `seed.html` (fake usernames like `admin/admin123`) can't sign in with email links.
  Delete them in the Firebase console (Authentication + `users` collection) and sign up with real emails.
