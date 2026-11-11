# PharmaFind → Android APK

How it works: the website goes online on **Firebase Hosting** (free), then **PWABuilder** wraps it
into an Android app (a *Trusted Web Activity*). The app runs on the phone's Chrome engine, so Google sign-in,
location, file upload and live data all work exactly like the website. When you update the website,
the app updates too — no new APK needed.

---

## Part 1 — Put the website online (Firebase Hosting)

You need **Node.js** installed (https://nodejs.org → LTS).

Open a terminal **inside the `pharmafind` folder** (VS Code → Terminal → New Terminal) and run:

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

- `firebase login` opens the browser — sign in with the Google account that owns the Firebase project.
- `firebase deploy` uploads the website **and publishes `firestore.rules`** for you
  (so you don't have to paste rules in the console any more).
- The project is already set in `.firebaserc` (`pharmafind-3529c`) and `firebase.json`.

When it finishes, your site is live at:

**https://pharmafind-3529c.firebaseapp.com**

(It's also on `pharmafind-3529c.web.app`, but the app automatically switches to the `firebaseapp.com`
address because that's where Google sign-in lives.)

Open it on your phone and test sign-in before making the APK.

> Already authorized: `pharmafind-3529c.firebaseapp.com` is in *Authentication → Settings → Authorized domains*
> by default. Nothing to add.

---

## Part 2 — Make the APK (PWABuilder)

1. Go to **https://www.pwabuilder.com**
2. Paste `https://pharmafind-3529c.firebaseapp.com` → **Start**.
   It should show the manifest, service worker and icons as found.
3. Click **Package for stores** → **Android** → **Generate package**.
4. In the options:
   - **Package ID:** `com.pharmafind.app`  (must match `.well-known/assetlinks.json`)
   - **App name:** PharmaFind
   - **Launcher name:** PharmaFind
   - **Signing key:** *Create new* (default) — fill in your name/organisation.
   - Leave the rest as default.
5. **Download** → you get a `.zip` containing:
   - `PharmaFind.apk` — install this on phones ✅
   - `PharmaFind.aab` — only for the Google Play Store
   - `signing.keystore` + `signing-key-info.txt` — ⚠️ **keep these safe and private.**
     You need the same key for every future update. Never upload them to GitHub.
   - `assetlinks.json` — used in Part 3.

---

## Part 3 — Remove the browser address bar (Digital Asset Links)

Without this step the app works, but shows a thin Chrome address bar at the top.

1. Open the `assetlinks.json` from the PWABuilder zip.
2. Copy its contents into **`.well-known/assetlinks.json`** in this project
   (replace the placeholder file completely).
3. Run `firebase deploy` again.
4. Check it opens: `https://pharmafind-3529c.firebaseapp.com/.well-known/assetlinks.json`
5. Uninstall and reinstall the APK on your phone — the address bar is gone.

---

## Part 4 — Install / share the APK

**On your own phone:** send the `.apk` to the phone (WhatsApp to yourself, Drive, USB), open it,
allow *"Install unknown apps"* when Android asks, then **Install**.

**Share it from GitHub (Releases):**
1. Create a GitHub repository (e.g. `pharmafind`) and push the project code.
   Do **not** add the keystore, `signing-key-info.txt`, `.apk` or `.aab` files to the repo.
2. On the repo page → **Releases** → **Draft a new release**.
3. Tag `v1.0.0`, title "PharmaFind v1.0.0", then **attach `PharmaFind.apk`** in the files box → **Publish release**.
4. Share the release link — people tap the `.apk` to download and install.

---

## Updating later

- Changed the code? Just run `firebase deploy`. The app picks up the new version the next time it opens
  (the service worker always fetches the latest files first).
- You only need a new APK if you change the app name, icon, package ID or splash settings —
  generate it in PWABuilder **using the same signing key** (`signing.keystore`) and bump the version number.

---

## Notes & troubleshooting

| Problem | Fix |
|---|---|
| `firebase: command not found` | Install Node.js, then `npm install -g firebase-tools`, reopen the terminal. |
| Google sign-in loops back to the login screen in the app | Make sure you used the `firebaseapp.com` URL in PWABuilder, and that Google is enabled in *Authentication → Sign-in method*. |
| "Email link" sign-in | The email opens in the phone's browser, not the app. Use **Continue with Google** inside the app. |
| Address bar still visible | Part 3 — the fingerprint in `assetlinks.json` must exactly match the key the APK was signed with. Reinstall the app after deploying. |
| Phone says "App not installed" | An older build signed with a different key is installed — uninstall it first. |
| Location doesn't work | Allow the location permission when the app asks (Android Settings → Apps → PharmaFind → Permissions). |
