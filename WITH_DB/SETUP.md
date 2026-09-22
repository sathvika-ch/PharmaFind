# PharmaFind — Setup Guide (Supabase database)

This turns PharmaFind from a single-laptop demo into a **shared app**: the data
lives in a free cloud database (Supabase), so you and your friend can open the
app on **any laptop** and see the **same** pharmacies, stock, reservations and bills.

You do this setup **once**. After that, anyone just needs the `config.js` values.

---

## What you have now

```
index.html      ← page shell, loads Supabase + config + app
styles.css      ← unchanged design
config.js       ← YOU paste your database keys here
app.js          ← app logic, now talks to Supabase
schema.sql      ← run this once to build the database tables + demo data
SETUP.md        ← this file
```

---

## Step 1 — Create a free Supabase project

1. Go to **https://supabase.com** and click **Start your project** (sign in with GitHub or email — free).
2. Click **New project**.
   - **Name:** `pharmafind`
   - **Database password:** pick anything and save it somewhere (you rarely need it again).
   - **Region:** choose the closest one (e.g. *South Asia (Mumbai)*).
3. Click **Create new project** and wait ~2 minutes while it provisions.

---

## Step 2 — Create the tables (run the SQL)

1. In your project, open the left sidebar → **SQL Editor**.
2. Click **New query**.
3. Open `schema.sql` from this folder, copy **everything**, and paste it into the editor.
4. Click **Run** (bottom right).
5. You should see *Success. No rows returned.*

Check it worked: sidebar → **Table Editor**. You should see the tables
`users`, `pharmacies`, `medicines`, `inventory`, etc., and the `users` table
should already have 4 rows (admin, medplus, apollo, patient).

---

## Step 3 — Get your two keys

1. Sidebar → **Project Settings** (gear icon) → **API**.
2. Copy two things:
   - **Project URL** — looks like `https://abcdxyz.supabase.co`
   - **anon public** key — a long string under *Project API keys*
     (use the one labelled **anon / public**, NOT `service_role`).

---

## Step 4 — Paste the keys into config.js

Open `config.js` and replace the placeholders:

```js
window.SUPABASE_URL = "https://abcdxyz.supabase.co";      // your Project URL
window.SUPABASE_KEY = "eyJhbGciOiJ...your-anon-key...";   // your anon public key
```

Save the file.

> The anon key is **designed** to sit in browser code — it's safe to share with
> your teammate. Just never paste the `service_role` key anywhere public.

---

## Step 5 — Run it

Open `index.html` in your browser.

- **Best way:** use a tiny local server so nothing is blocked. In this folder run:
  ```bash
  # Python (already on most laptops)
  python -m http.server 5500
  ```
  Then open **http://localhost:5500** in your browser.

- Or with Node:
  ```bash
  npx serve .
  ```

Sign in with a demo login:

| Role     | Username  | Password  |
|----------|-----------|-----------|
| Admin    | `admin`   | `admin123`|
| Pharmacy | `medplus` | `123`     |
| Patient  | `patient` | `123`     |

---

## Step 6 — Run on a DIFFERENT laptop

This is the whole point. On the second laptop:

1. Copy the same folder (all files) over — USB, GitHub, Google Drive, whatever.
2. `config.js` already has the keys, so **don't change anything**.
3. Open `index.html` (ideally via the local server as in Step 5).

Both laptops now read and write the **same** database. Add a medicine on one,
hit the **⟳ refresh** button (top bar) on the other, and it's there.

> Tip: the app loads data when you sign in and after every change *you* make.
> To pull in changes *someone else* made, click the **⟳** button in the top bar.

---

## How it works (for your report / viva)

- **Old version:** all data lived in the browser's `localStorage` — one copy per
  laptop, never shared. That's why a second laptop started empty.
- **New version:** data lives in **Supabase**, which is a hosted **PostgreSQL**
  database with an auto-generated REST API. The browser talks to it over HTTPS
  using the `@supabase/supabase-js` client.
- **Tables** (see `schema.sql`) map one-to-one to the old in-memory objects:
  `users`, `pharmacies`, `medicines`, `inventory`, `reservations`, `bills`,
  `bill_items`, `notifications`. **Foreign keys** enforce relationships (e.g. an
  inventory row must point to a real pharmacy and a real medicine). Deleting a
  pharmacy **cascades** to its inventory automatically.
- **Billing transaction:** when a bill is created, `app.js` re-reads each item's
  live quantity from the database, then decrements stock with a guarded update
  (`.gte("quantity", qty)`) so two laptops can't sell the same last unit. This
  mirrors the SQL pattern `UPDATE inventory SET quantity = quantity - :qty
  WHERE id = :id AND quantity >= :qty`.

### Two honest limitations to mention (shows you understand it)

1. **Auth is demo-grade.** Passwords are stored in plain text in the `users`
   table and checked directly. A production app would use **Supabase Auth** with
   **hashed** passwords. Good talking point for your Cybersecurity specialization.
2. **Row Level Security is off.** `schema.sql` disables RLS so the anon key can
   read/write everything, which is fine for a class demo but means anyone with
   the key sees all rows. Real apps write **RLS policies** so each user only
   touches their own data.

---

## Troubleshooting

- **"config.js is not set up"** → you didn't paste real keys in Step 4.
- **"Could not reach the database"** → wrong URL/key, no internet, or you pasted
  the `service_role` key instead of `anon public`.
- **Login says wrong password but you're sure it's right** → check the `users`
  table in Supabase → Table Editor; the seed may not have run (re-run `schema.sql`).
- **Nothing shows / blank page** → open the browser **Console** (F12) and read
  the red error; it usually names the exact problem.
