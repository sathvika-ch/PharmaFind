-- ============================================================
-- PharmaFind — Supabase (Postgres) schema + seed data
-- Run this ONCE in Supabase → SQL Editor → New query → Run.
-- It creates every table, disables row-level security for the
-- demo, and inserts the same starting data your app used to seed.
-- ============================================================

-- Clean slate (safe to re-run this whole file)
drop table if exists bill_items    cascade;
drop table if exists bills          cascade;
drop table if exists reservations   cascade;
drop table if exists inventory      cascade;
drop table if exists notifications  cascade;
drop table if exists pharmacies     cascade;
drop table if exists medicines      cascade;
drop table if exists users          cascade;

-- ---------- USERS ----------
create table users (
  id         uuid primary key default gen_random_uuid(),
  role       text not null check (role in ('admin','pharmacy','patient')),
  name       text not null,
  username   text not null unique,
  password   text not null,
  created_at timestamptz default now()
);

-- ---------- MEDICINES (shared catalog) ----------
create table medicines (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  generic    text not null,
  mfr        text default '—',
  created_at timestamptz default now()
);

-- ---------- PHARMACIES ----------
create table pharmacies (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  name          text not null,
  address       text default 'Hyderabad',
  lat           double precision,
  lng           double precision,
  hours         text default '9:00 AM – 9:00 PM',
  status        text not null default 'pending' check (status in ('pending','approved','suspended')),
  created_at    timestamptz default now()
);

-- ---------- INVENTORY ----------
create table inventory (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid references pharmacies(id) on delete cascade,
  medicine_id  uuid references medicines(id) on delete cascade,
  quantity     integer not null default 0 check (quantity >= 0),
  price        numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);

-- ---------- RESERVATIONS ----------
create table reservations (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid references users(id) on delete cascade,
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  inventory_id  uuid references inventory(id) on delete set null,
  medicine_id   uuid references medicines(id) on delete cascade,
  qty           integer not null,
  status        text not null default 'pending' check (status in ('pending','fulfilled','cancelled')),
  created_at    timestamptz default now()
);

-- ---------- BILLS ----------
create table bills (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid references pharmacies(id) on delete cascade,
  patient_id  uuid references users(id) on delete set null,
  total       numeric(10,2) not null default 0,
  created_at  timestamptz default now()
);

-- ---------- BILL ITEMS ----------
create table bill_items (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid references bills(id) on delete cascade,
  medicine_id uuid references medicines(id) on delete set null,
  name        text not null,
  quantity    integer not null,
  unit_price  numeric(10,2) not null,
  line_total  numeric(10,2) not null
);

-- ---------- NOTIFICATIONS ----------
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references users(id) on delete cascade,
  text       text not null,
  read       boolean not null default false,
  created_at timestamptz default now()
);

-- ============================================================
-- DEMO SECURITY NOTE:
-- Supabase turns on Row Level Security (RLS) by default, which
-- would block the anon key from reading/writing. For a class
-- demo we DISABLE it so the app just works. This is NOT safe for
-- production — anyone with the key could read every row. Fine for
-- a college project; call it out in your report.
-- ============================================================
alter table users         disable row level security;
alter table medicines     disable row level security;
alter table pharmacies    disable row level security;
alter table inventory     disable row level security;
alter table reservations  disable row level security;
alter table bills         disable row level security;
alter table bill_items    disable row level security;
alter table notifications disable row level security;

-- ============================================================
-- SEED DATA — mirrors the old seed() in app.js
-- We use a DO block with variables so foreign keys line up.
-- ============================================================
do $$
declare
  admin_id   uuid;
  owner1_id  uuid;
  owner2_id  uuid;
  patient_id uuid;
  ph1_id     uuid;
  ph2_id     uuid;
  m_dolo   uuid; m_azi   uuid; m_cet uuid; m_amox uuid; m_pan uuid;
  m_ors    uuid; m_vitc  uuid; m_met uuid; m_amlo uuid; m_ibu uuid;
begin
  -- Users
  insert into users (role, name, username, password) values
    ('admin',    'System Admin',   'admin',   'admin123') returning id into admin_id;
  insert into users (role, name, username, password) values
    ('pharmacy', 'Ravi (MedPlus)', 'medplus', '123') returning id into owner1_id;
  insert into users (role, name, username, password) values
    ('pharmacy', 'Sana (Apollo)',  'apollo',  '123') returning id into owner2_id;
  insert into users (role, name, username, password) values
    ('patient',  'Sangeeth',       'patient', '123') returning id into patient_id;

  -- Pharmacies
  insert into pharmacies (owner_user_id, name, address, lat, lng, hours, status) values
    (owner1_id, 'MedPlus Pharmacy', 'Ameerpet, Hyderabad',     17.4374, 78.4487, '9:00 AM – 10:00 PM', 'approved') returning id into ph1_id;
  insert into pharmacies (owner_user_id, name, address, lat, lng, hours, status) values
    (owner2_id, 'Apollo Pharmacy',  'Banjara Hills, Hyderabad', 17.4126, 78.4482, '8:00 AM – 11:00 PM', 'pending')  returning id into ph2_id;

  -- Medicines
  insert into medicines (name, generic, mfr) values ('Dolo 650','Paracetamol 650mg','Micro Labs')        returning id into m_dolo;
  insert into medicines (name, generic, mfr) values ('Azithromycin 500','Azithromycin 500mg','Cipla')    returning id into m_azi;
  insert into medicines (name, generic, mfr) values ('Cetirizine 10','Cetirizine 10mg','Dr. Reddy''s')   returning id into m_cet;
  insert into medicines (name, generic, mfr) values ('Amoxicillin 500','Amoxicillin 500mg','Sun Pharma') returning id into m_amox;
  insert into medicines (name, generic, mfr) values ('Pantoprazole 40','Pantoprazole 40mg','Alkem')      returning id into m_pan;
  insert into medicines (name, generic, mfr) values ('ORS Powder','Oral Rehydration Salts','FDC')        returning id into m_ors;
  insert into medicines (name, generic, mfr) values ('Vitamin C 500','Ascorbic Acid 500mg','HealthVit')  returning id into m_vitc;
  insert into medicines (name, generic, mfr) values ('Metformin 500','Metformin 500mg','USV')            returning id into m_met;
  insert into medicines (name, generic, mfr) values ('Amlodipine 5','Amlodipine 5mg','Torrent')          returning id into m_amlo;
  insert into medicines (name, generic, mfr) values ('Ibuprofen 400','Ibuprofen 400mg','Abbott')         returning id into m_ibu;

  -- Inventory (MedPlus / ph1 only, same as old seed)
  insert into inventory (pharmacy_id, medicine_id, quantity, price) values
    (ph1_id, m_dolo, 120, 2.5),
    (ph1_id, m_azi,    8, 14.0),
    (ph1_id, m_cet,    0, 1.8),
    (ph1_id, m_pan,   45, 6.5),
    (ph1_id, m_ors,   60, 20.0),
    (ph1_id, m_vitc,   5, 4.2);
end $$;
