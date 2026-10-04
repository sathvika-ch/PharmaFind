# PharmaFind as an app — set-up with GitHub

The app is the same website, made installable. Nothing was removed.

## New files (keep them all in the same folder as index.html)

| File | What it does |
|---|---|
| `manifest.webmanifest` | App name, colours and icons for the phone |
| `icons/` (6 images) | The app icon in the sizes phones ask for |
| `sw.js` | Lets the phone install the app; shows a clear message when offline |
| `pwa.js` | The "Install app" button (set `PWA_ENABLED = false` to switch it off) |
| `.nojekyll` | Tells GitHub Pages to publish the files exactly as they are |

Changed files: `index.html` (app tags + offline message) and `app.js` (loads `pwa.js`, phone Back button).

## 1. Put the site on GitHub Pages

1. Create a new **public** repository on GitHub (for example `pharmafind`).
2. Upload everything from this folder, including the `icons` folder.
   Leave out `seed.html` — it lists the demo accounts' passwords and the repository is public.
3. Repository → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
4. Wait a few minutes. The site opens at `https://<your-username>.github.io/<repository>/`.
5. Firebase console → Authentication → Settings → **Authorized domains** → add `<your-username>.github.io`.

## 2. Install it on a phone (no APK needed)

- Android (Chrome): open the address above → tap **Install app** in the bar at the bottom
  (or Chrome menu ⋮ → "Add to Home screen" / "Install app").
- iPhone (Safari): Share → "Add to Home Screen".

## 3. Get an APK file

1. Open https://www.pwabuilder.com and paste your GitHub Pages address.
2. Choose **Package for stores → Android** and download the package.
3. The zip contains an APK you can copy to a phone and install, and an `assetlinks.json` file.

About `assetlinks.json`: Android hides the browser address bar inside the APK only if this file is
reachable at `https://<your-username>.github.io/.well-known/assetlinks.json` — at the very top of the
domain, not inside the repository folder. That needs a second repository named exactly
`<your-username>.github.io` containing `.well-known/assetlinks.json` and a `.nojekyll` file.
Without it the APK still works; it just shows a thin address bar at the top.

## Updating later

Upload the changed files to the repository. Installed apps and the APK load the new version the next
time they are opened with internet — no new APK is needed.
