-- ============================================================
-- Tata Business Suite â€” Full Database Schema
-- Execute in Supabase SQL Editor (pastikan sudah hapus semua tabel)
-- ============================================================

-- 0. EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements; -- optional


-- 1. ADMINS (dashboard admin auth â€” bukan Supabase Auth)
-- ============================================================
CREATE TABLE IF NOT EXISTS admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_select_own ON admins
  FOR SELECT
  USING (email = current_setting('app.admin_email', true));
CREATE POLICY admin_update_own ON admins
  FOR UPDATE
  USING (email = current_setting('app.admin_email', true))
  WITH CHECK (email = current_setting('app.admin_email', true));

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);


-- 2. USERS (WA bot users)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                          text PRIMARY KEY,
  store_name                  text NOT NULL DEFAULT 'Toko Saya',
  store_slug                  varchar(100),
  status                      text NOT NULL DEFAULT 'demo' CHECK (status IN ('demo', 'pro', 'unlimited')),
  onboarding_status           text NOT NULL DEFAULT 'new_user',
  onboarding_completed_at     timestamptz,
  subscription_expires_at     timestamptz,
  upgrade_notified            boolean NOT NULL DEFAULT false,
  is_upgrading                boolean NOT NULL DEFAULT false,
  upgrade_package             text,
  dashboard_token             text,
  dashboard_token_created_at  timestamptz,
  bank_name                   text,
  bank_account                text,
  bank_holder                 text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_store_slug ON users(store_slug) WHERE store_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_dashboard_token ON users(dashboard_token) WHERE dashboard_token IS NOT NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_scope ON users
  FOR ALL
  USING (id = current_setting('app.user_id', true));


-- 3. PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku             text NOT NULL DEFAULT '',
  name            text NOT NULL,
  category        text NOT NULL DEFAULT 'Umum',
  unit            text NOT NULL DEFAULT 'pcs',
  price_buy       numeric NOT NULL DEFAULT 0,
  price_sell      numeric NOT NULL DEFAULT 0,
  stock_current   numeric NOT NULL DEFAULT 0,
  stock_min       numeric NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  supplier        text,
  location        text,
  notes           text,
  description     text,
  price_grosir    numeric DEFAULT 0,
  min_qty_grosir  numeric DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(user_id, name);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_user_scope ON products
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 4. TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              text NOT NULL,
  amount            numeric NOT NULL DEFAULT 0,
  description       text NOT NULL DEFAULT '',
  product_id        bigint REFERENCES products(id) ON DELETE SET NULL,
  quantity          numeric,
  price_sell        numeric,
  price_buy         numeric,
  profit            numeric,
  channel           text NOT NULL DEFAULT 'Offline',
  reference_type    text NOT NULL DEFAULT 'manual',
  hpp               numeric,
  beban_operasional numeric,
  customer_name     text,
  status_bayar      text NOT NULL DEFAULT 'tunai',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_ref ON transactions(reference_type, user_id);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_user_scope ON transactions
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 5. STOCK MOVEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_movements (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id      bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
  quantity        numeric NOT NULL,
  stock_before    numeric NOT NULL,
  stock_after     numeric NOT NULL,
  reference_type  text DEFAULT 'manual',
  reference_id    text,
  note            text,
  created_by      text NOT NULL DEFAULT 'system',
  created_via     text,
  unit_price      numeric,
  total_value     numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sm_user ON stock_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_sm_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_sm_created ON stock_movements(user_id, created_at DESC);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY sm_user_scope ON stock_movements
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 6. STOCK ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_alerts (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_type    text NOT NULL CHECK (alert_type IN ('low_stock', 'out_of_stock')),
  stock_level   numeric NOT NULL,
  alert_message text,
  resolved_at   timestamptz,
  alerted_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sa_user ON stock_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_sa_unresolved ON stock_alerts(user_id) WHERE resolved_at IS NULL;

ALTER TABLE stock_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sa_user_scope ON stock_alerts
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 7. DEBTS (Piutang)
-- ============================================================
CREATE TABLE IF NOT EXISTS debts (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  bigint REFERENCES transactions(id) ON DELETE SET NULL,
  nama_pelanggan  text NOT NULL,
  nominal_piutang numeric NOT NULL DEFAULT 0,
  status_lunas    boolean NOT NULL DEFAULT false,
  jatuh_tempo     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);

ALTER TABLE debts ENABLE ROW LEVEL SECURITY;
CREATE POLICY debts_user_scope ON debts
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 7b. ACCOUNTS PAYABLE (Hutang ke Supplier)
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts_payable (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nama_supplier   text NOT NULL,
  nominal_hutang  numeric NOT NULL DEFAULT 0,
  jumlah_dibayar  numeric NOT NULL DEFAULT 0,
  status_lunas    boolean NOT NULL DEFAULT false,
  jatuh_tempo     timestamptz,
  deskripsi       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_user ON accounts_payable(user_id);
CREATE INDEX IF NOT EXISTS idx_ap_jatuh_tempo ON accounts_payable(user_id, jatuh_tempo) WHERE status_lunas = false;

ALTER TABLE accounts_payable ENABLE ROW LEVEL SECURITY;
CREATE POLICY ap_user_scope ON accounts_payable
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));

CREATE OR REPLACE FUNCTION update_ap_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ap_updated_at ON accounts_payable;
CREATE TRIGGER trg_ap_updated_at
  BEFORE UPDATE ON accounts_payable
  FOR EACH ROW
  EXECUTE FUNCTION update_ap_updated_at();


-- 8. INVOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number  text NOT NULL,
  target_number   text NOT NULL,
  amount          numeric NOT NULL DEFAULT 0,
  description     text,
  status          text NOT NULL DEFAULT 'sent',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_user_scope ON invoices
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 9. MESSAGE PROCESSED (dedup)
-- ============================================================
CREATE TABLE IF NOT EXISTS message_processed (
  message_id    text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mp_processed ON message_processed(processed_at);

ALTER TABLE message_processed ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_processed_user_scope ON message_processed
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 10. SETTINGS (key-value store)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL DEFAULT ''
);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
-- Allow all authenticated access (settings is global, not per-user)
CREATE POLICY settings_all ON settings
  FOR ALL
  USING (true);


-- 11. WA SESSION BACKUP
-- ============================================================
CREATE TABLE IF NOT EXISTS wa_session_backup (
  user_id      text PRIMARY KEY,
  manifest     jsonb,
  session_data text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wa_session_backup ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_session_user_scope ON wa_session_backup
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 12. BOT STATUS
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_status (
  status      text NOT NULL DEFAULT 'offline',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bot_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_status_all ON bot_status
  FOR ALL
  USING (true);


-- 13. UPGRADES
-- ============================================================
CREATE TABLE IF NOT EXISTS upgrades (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upgrades_user ON upgrades(user_id);

ALTER TABLE upgrades ENABLE ROW LEVEL SECURITY;
CREATE POLICY upgrades_user_scope ON upgrades
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 14. USER BEHAVIOR LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_behavior_logs (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword         text NOT NULL,
  classified_as   text NOT NULL,
  confidence      numeric NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'user_confirm',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ubl_user ON user_behavior_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ubl_created ON user_behavior_logs(created_at);

ALTER TABLE user_behavior_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ubl_user_scope ON user_behavior_logs
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 15. USER PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id         text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bank_name       text,
  bank_account    text,
  bank_holder     text,
  admin_wa_number text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY up_user_scope ON user_profiles
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 16. CHART OF ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  balance         numeric NOT NULL DEFAULT 0,
  description     text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coa_user ON chart_of_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_coa_code ON chart_of_accounts(user_id, code);

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY coa_user_scope ON chart_of_accounts
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 17. JOURNAL ENTRIES
-- ============================================================
CREATE TABLE IF NOT EXISTS journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date      date NOT NULL DEFAULT CURRENT_DATE,
  reference_type  text NOT NULL,
  reference_id    text,
  description     text DEFAULT '',
  channel         text NOT NULL DEFAULT 'Offline',
  is_posted       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_je_user ON journal_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_je_reference ON journal_entries(reference_type, reference_id);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY je_user_scope ON journal_entries
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 18. JOURNAL LINES
-- ============================================================
CREATE TABLE IF NOT EXISTS journal_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code  text NOT NULL,
  debit         numeric NOT NULL DEFAULT 0,
  credit        numeric NOT NULL DEFAULT 0,
  description   text DEFAULT '',
  CONSTRAINT chk_debit_credit_positive CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT chk_at_least_one CHECK (debit > 0 OR credit > 0)
);

CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_jl_entry_account ON journal_lines(entry_id, account_code);

-- Journal lines inherit RLS via entry_id (no direct user_id column)
-- To enforce via parent journal:
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_via_entry ON journal_lines
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.id = entry_id
        AND je.user_id = current_setting('app.user_id', true)
    )
  );


-- 19. SCHEDULER LOCKS
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduler_locks (
  id          bigserial PRIMARY KEY,
  job_name    text NOT NULL UNIQUE,
  locked_at   timestamptz NOT NULL DEFAULT now(),
  locked_by   text NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_expires ON scheduler_locks(expires_at);

ALTER TABLE scheduler_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduler_locks_all ON scheduler_locks
  FOR ALL
  USING (true);


-- 20. BOM MATERIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS bom_materials (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  unit            text NOT NULL DEFAULT 'pcs',
  stock_current   numeric NOT NULL DEFAULT 0,
  stock_min       numeric NOT NULL DEFAULT 0,
  cost_per_unit   numeric NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bm_user ON bom_materials(user_id);

ALTER TABLE bom_materials ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_user_scope ON bom_materials
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 21. BOM RECIPES
-- ============================================================
CREATE TABLE IF NOT EXISTS bom_recipes (
  id                  bigserial PRIMARY KEY,
  user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id         bigint NOT NULL REFERENCES bom_materials(id) ON DELETE CASCADE,
  quantity_per_order  numeric NOT NULL DEFAULT 0,
  auto_deduct         boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_br_user ON bom_recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_br_material ON bom_recipes(material_id);

ALTER TABLE bom_recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY br_user_scope ON bom_recipes
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 22. BOM DEDUCTION LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS bom_deduction_logs (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id     bigint NOT NULL REFERENCES bom_materials(id) ON DELETE CASCADE,
  quantity        numeric NOT NULL,
  stock_before    numeric NOT NULL,
  stock_after     numeric NOT NULL,
  reference_type  text NOT NULL DEFAULT 'sale',
  reference_note  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bdl_user ON bom_deduction_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_bdl_material ON bom_deduction_logs(material_id);

ALTER TABLE bom_deduction_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY bdl_user_scope ON bom_deduction_logs
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 23. TRANSACTION TYPE â†’ COA MAPPING
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_type_coa (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipe        text NOT NULL,
  coa_debit   text NOT NULL,
  coa_credit  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tipe)
);

CREATE INDEX IF NOT EXISTS idx_ttcoa_user ON transaction_type_coa(user_id);
CREATE INDEX IF NOT EXISTS idx_ttcoa_tipe ON transaction_type_coa(user_id, tipe);

ALTER TABLE transaction_type_coa ENABLE ROW LEVEL SECURITY;
CREATE POLICY ttcoa_user_scope ON transaction_type_coa
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));


-- 24. USER SESSIONS (connect-pg-simple)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  sid     text PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_us_expire ON user_sessions(expire);

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_all ON user_sessions
  FOR ALL
  USING (true);


-- ============================================================
-- RPC: SEED DEFAULT COA
-- ============================================================
CREATE OR REPLACE FUNCTION seed_default_coa(p_user_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance) VALUES
    -- ASET (1xxx)
    (p_user_id, '1101', 'Kas / Bank',             'asset', 'debit'),
    (p_user_id, '1102', 'Piutang Dagang',          'asset', 'debit'),
    (p_user_id, '1201', 'Inventori',               'asset', 'debit'),
    (p_user_id, '1301', 'Aset Tetap',              'asset', 'debit'),
    (p_user_id, '1302', 'Akumulasi Penyusutan',    'asset', 'credit'),
    -- LIABILITAS (2xxx)
    (p_user_id, '2101', 'Hutang Dagang',           'liability', 'credit'),
    (p_user_id, '2102', 'Hutang Pajak',            'liability', 'credit'),
    -- EKUITAS (3xxx)
    (p_user_id, '3101', 'Modal Pemilik',           'equity', 'credit'),
    (p_user_id, '3102', 'Prive (Pribadi)',         'equity', 'debit'),
    (p_user_id, '3103', 'Laba Ditahan',            'equity', 'credit'),
    -- PENDAPATAN (4xxx)
    (p_user_id, '4101', 'Penjualan Offline',       'revenue', 'credit'),
    (p_user_id, '4102', 'Penjualan Tokopedia',     'revenue', 'credit'),
    (p_user_id, '4103', 'Penjualan TikTok Shop',   'revenue', 'credit'),
    (p_user_id, '4104', 'Penjualan Lazada',        'revenue', 'credit'),
    (p_user_id, '4105', 'Penjualan Shopee',        'revenue', 'credit'),
    -- HPP (5xxx)
    (p_user_id, '5101', 'Harga Pokok Penjualan',   'cogs', 'debit'),
    -- BEBAN (6xxx)
    (p_user_id, '6101', 'Beban Gaji',              'expense', 'debit'),
    (p_user_id, '6102', 'Beban Sewa',              'expense', 'debit'),
    (p_user_id, '6103', 'Beban Listrik & Air',     'expense', 'debit'),
    (p_user_id, '6104', 'Beban Transport',         'expense', 'debit'),
    (p_user_id, '6105', 'Beban Operasional Lainnya','expense', 'debit'),
    (p_user_id, '6106', 'Beban Penyusutan',        'expense', 'debit')
  ON CONFLICT (user_id, code) DO NOTHING;
END;
$$;


-- ============================================================
-- RPC: SEED DEFAULT COA MAPPING
-- ============================================================
CREATE OR REPLACE FUNCTION seed_default_coa_mapping(p_user_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO transaction_type_coa (user_id, tipe, coa_debit, coa_credit) VALUES
    (p_user_id, 'beban_gaji',             '6101', '1101'),
    (p_user_id, 'beban_sewa',             '6102', '1101'),
    (p_user_id, 'beban_listrik_air',      '6103', '1101'),
    (p_user_id, 'beban_transport',        '6104', '1101'),
    (p_user_id, 'beban_operasional',      '6105', '1101'),
    (p_user_id, 'modal',                  '1101', '3101'),
    (p_user_id, 'prive',                  '3102', '1101'),
    (p_user_id, 'piutang',                '1102', '4101'),
    (p_user_id, 'hutang_dagang',          '5101', '2101'),
    (p_user_id, 'hutang_lancar',          '6105', '2101')
  ON CONFLICT (user_id, tipe) DO NOTHING;
END;
$$;


-- ============================================================
-- RPC: ADJUST STOCK ATOMIC
-- ============================================================
CREATE OR REPLACE FUNCTION adjust_stock_atomic(
  p_user_id    text,
  p_product_id bigint,
  p_type       text,
  p_quantity   numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current numeric;
  v_new     numeric;
BEGIN
  SELECT stock_current INTO v_current
  FROM products
  WHERE id = p_product_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Product not found');
  END IF;

  IF p_type = 'in' THEN
    v_new := v_current + p_quantity;
  ELSIF p_type = 'out' THEN
    IF v_current < p_quantity THEN
      RETURN jsonb_build_object('error', 'Insufficient stock');
    END IF;
    v_new := v_current - p_quantity;
  ELSE
    RETURN jsonb_build_object('error', 'Invalid type, use "in" or "out"');
  END IF;

  UPDATE products SET stock_current = v_new
  WHERE id = p_product_id AND user_id = p_user_id;

  INSERT INTO stock_movements
    (user_id, product_id, type, quantity, stock_before, stock_after, created_via)
  VALUES
    (p_user_id, p_product_id, p_type, p_quantity, v_current, v_new, 'system');

  RETURN jsonb_build_object('success', true);
END;
$$;


-- ============================================================
-- RPC: POST JOURNAL
-- ============================================================
CREATE OR REPLACE FUNCTION post_journal(
  p_user_id         text,
  p_entry_date      date,
  p_reference_type  text,
  p_reference_id    text,
  p_description     text,
  p_lines           jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_journal_id     uuid;
  v_line           jsonb;
  v_total_debit    numeric := 0;
  v_total_credit   numeric := 0;
  v_account_name   text;
  v_account_type   text;
  v_normal_balance text;
  v_balance_change numeric;
BEGIN
  SELECT SUM((l->>'debit')::numeric), SUM((l->>'credit')::numeric)
  INTO v_total_debit, v_total_credit
  FROM jsonb_array_elements(p_lines) AS l;

  IF v_total_debit IS DISTINCT FROM v_total_credit THEN
    RAISE EXCEPTION 'Debit (%) tidak sama dengan Credit (%)', v_total_debit, v_total_credit;
  END IF;

  INSERT INTO journal_entries (user_id, entry_date, reference_type, reference_id, description, channel, is_posted)
  VALUES (p_user_id, p_entry_date, p_reference_type, p_reference_id, p_description, 'Offline', true)
  RETURNING id INTO v_journal_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT name, type, normal_balance
    INTO v_account_name, v_account_type, v_normal_balance
    FROM chart_of_accounts
    WHERE user_id = p_user_id AND code = (v_line->>'account_code');

    IF v_account_name IS NULL THEN
      RAISE EXCEPTION 'Akun % tidak ditemukan', (v_line->>'account_code');
    END IF;

    INSERT INTO journal_lines (entry_id, account_code, debit, credit, description)
    VALUES (
      v_journal_id,
      v_line->>'account_code',
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      COALESCE(v_line->>'description', '')
    );

    v_balance_change := COALESCE((v_line->>'debit')::numeric, 0) - COALESCE((v_line->>'credit')::numeric, 0);
    IF v_normal_balance = 'credit' THEN
      v_balance_change := -v_balance_change;
    END IF;

    UPDATE chart_of_accounts
    SET balance = balance + v_balance_change,
        updated_at = now()
    WHERE user_id = p_user_id AND code = (v_line->>'account_code');
  END LOOP;

  RETURN v_journal_id;
END;
$$;


-- ============================================================
-- TRIGGER: AUTO SEED COA MAPPING ON USER INSERT
-- ============================================================
CREATE OR REPLACE FUNCTION auto_seed_coa_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM seed_default_coa(NEW.id);
  PERFORM seed_default_coa_mapping(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_seed_coa_mapping ON users;
CREATE TRIGGER trg_auto_seed_coa_mapping
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION auto_seed_coa_mapping();


-- ============================================================
-- SEED DEFAULTS FOR EXISTING USERS (jika ada)
-- ============================================================
DO $$
DECLARE
  user_rec record;
BEGIN
  FOR user_rec IN SELECT id FROM users LOOP
    PERFORM seed_default_coa(user_rec.id);
    PERFORM seed_default_coa_mapping(user_rec.id);
  END LOOP;
END;
$$;


-- ============================================================
-- SEED ADMIN (JALANKAN BARIS INI MANUAL DI SQL EDITOR)
-- ============================================================
-- Ganti email & password sesuai keinginan, lalu uncomment & execute:
--
-- INSERT INTO admins (email, password_hash, role)
-- VALUES ('admin@email.com', crypt('password123', gen_salt('bf')), 'superadmin');
--
-- Verify:
-- SELECT * FROM admins;
-- ============================================================
-- Migration 006: Add accounts_payable (Hutang ke Supplier)
-- Execute di Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts_payable (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nama_supplier   text NOT NULL,
  nominal_hutang  numeric NOT NULL DEFAULT 0,
  jumlah_dibayar  numeric NOT NULL DEFAULT 0,
  status_lunas    boolean NOT NULL DEFAULT false,
  jatuh_tempo     timestamptz,
  deskripsi       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_user ON accounts_payable(user_id);
CREATE INDEX IF NOT EXISTS idx_ap_jatuh_tempo ON accounts_payable(user_id, jatuh_tempo) WHERE status_lunas = false;

ALTER TABLE accounts_payable ENABLE ROW LEVEL SECURITY;
CREATE POLICY ap_user_scope ON accounts_payable
  FOR ALL
  USING (user_id = current_setting('app.user_id', true));

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_ap_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ap_updated_at ON accounts_payable;
CREATE TRIGGER trg_ap_updated_at
  BEFORE UPDATE ON accounts_payable
  FOR EACH ROW
  EXECUTE FUNCTION update_ap_updated_at();

-- Sync to 000_full_schema.sql also
-- ============================================================
-- Fix admin RLS â€” bypass via SECURITY DEFINER function
-- RLS policy admin_select_own pada admins menggunakan
-- current_setting('app.admin_email', true) yang TIDAK PERNAH
-- diset dari Supabase anon key â†’ query selalu return 0 row.
-- Solusi: RPC function dengan SECURITY DEFINER (bypass RLS).
-- ============================================================

CREATE OR REPLACE FUNCTION get_admin_by_email(p_email text)
RETURNS TABLE (email text, password_hash text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT a.email, a.password_hash, a.role
  FROM admins a
  WHERE a.email = p_email;
END;
$$;
-- Inventory table for multi-warehouse stock tracking
CREATE TABLE IF NOT EXISTS inventory (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id      bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity        numeric NOT NULL DEFAULT 0,
  warehouse       text NOT NULL DEFAULT 'Utama',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_id, warehouse)
);

-- Backfill inventory from existing products.stock_current
INSERT INTO inventory (user_id, product_id, quantity, warehouse)
SELECT user_id, id, stock_current, 'Utama'
FROM products
WHERE stock_current != 0
ON CONFLICT (user_id, product_id, warehouse) DO NOTHING;
-- ============================================
-- Phase 1 & 4: Returns Support & Warehouses
-- ============================================

-- 1. Add discount & return fields to transactions
ALTER TABLE transactions 
  ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_type text,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS original_transaction_id bigint REFERENCES transactions(id) ON DELETE SET NULL;

-- 2. Add return reference types to stock_movements
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS from_warehouse text,
  ADD COLUMN IF NOT EXISTS to_warehouse text;

-- 3. Warehouses table
CREATE TABLE IF NOT EXISTS warehouses (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, code)
);

-- Seed default warehouse for existing users
INSERT INTO warehouses (user_id, name, code, is_default)
SELECT DISTINCT id, 'Utama', 'MAIN', true FROM users
ON CONFLICT DO NOTHING;

-- 4. Stock opname tables (Phase 2)
CREATE TABLE IF NOT EXISTS stock_opnames (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opname_date     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'draft',
  warehouse       text NOT NULL DEFAULT 'Utama',
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT valid_opname_status CHECK (status IN ('draft', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS opname_details (
  id              bigserial PRIMARY KEY,
  opname_id       bigint NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
  product_id      bigint NOT NULL REFERENCES products(id),
  system_qty      numeric NOT NULL,
  actual_qty      numeric NOT NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 5. COA accounts for returns & adjustments
INSERT INTO chart_of_accounts (code, name, type, description, is_system)
VALUES 
  ('4102', 'Retur Penjualan', 'revenue', 'Contra-revenue untuk retur penjualan (customer return)', true),
  ('4103', 'Diskon Penjualan', 'revenue', 'Contra-revenue untuk diskon penjualan', true),
  ('4104', 'Keuntungan Persediaan', 'revenue', 'Keuntungan dari inventory overage / selisih opname', true),
  ('6101', 'Kerugian Persediaan', 'expense', 'Kerugian inventory shortage / selisih opname', true)
ON CONFLICT (code) DO NOTHING;
-- ============================================
-- Migration 010: Rename accounting tables
-- Code references 'payables' and 'receivables'
-- but old migrations created 'accounts_payable' and 'debts'
-- ============================================

-- 1. Create payables (matching accounts_payable schema)
CREATE TABLE IF NOT EXISTS payables (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL,
  nama_supplier   text NOT NULL,
  nominal_hutang  numeric NOT NULL DEFAULT 0,
  jumlah_dibayar  numeric NOT NULL DEFAULT 0,
  status_lunas    boolean NOT NULL DEFAULT false,
  jatuh_tempo     timestamptz,
  deskripsi       text DEFAULT '',
  transaction_id  bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Copy data from accounts_payable if it exists
INSERT INTO payables (id, user_id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo, deskripsi, created_at)
SELECT id, user_id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo, deskripsi, created_at
FROM accounts_payable
WHERE NOT EXISTS (SELECT 1 FROM payables WHERE payables.id = accounts_payable.id);

-- 2. Create receivables (matching debts schema)
CREATE TABLE IF NOT EXISTS receivables (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL,
  transaction_id  bigint,
  nama_pelanggan  text NOT NULL,
  nominal_piutang numeric NOT NULL DEFAULT 0,
  status_lunas    boolean NOT NULL DEFAULT false,
  jatuh_tempo     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Copy data from debts if it exists
INSERT INTO receivables (id, user_id, transaction_id, nama_pelanggan, nominal_piutang, status_lunas, jatuh_tempo, created_at)
SELECT id, user_id, transaction_id, nama_pelanggan, nominal_piutang, status_lunas, jatuh_tempo, created_at
FROM debts
WHERE NOT EXISTS (SELECT 1 FROM receivables WHERE receivables.id = debts.id);
-- ============================================================
-- OPTIMASI DATABASE â€” UNIQUE CONSTRAINTS + INDEXES + BACKFILL
-- ============================================================
-- Run this in Supabase SQL Editor

-- 1. HAPUS DUPLIKAT sebelum ADD UNIQUE (biar tidak error)
DELETE FROM inventory a USING inventory b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.product_id = b.product_id
  AND a.warehouse = b.warehouse;

DELETE FROM warehouses a USING warehouses b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.code = b.code;

-- 2. UNIQUE CONSTRAINTS
ALTER TABLE inventory ADD UNIQUE (user_id, product_id, warehouse);
ALTER TABLE warehouses ADD UNIQUE (user_id, code);

-- 3. INDEXES (performa query)
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(user_id, type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_id ON stock_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_user ON journal_entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_coa_user ON chart_of_accounts(user_id, code);
CREATE INDEX IF NOT EXISTS idx_payables_user ON payables(user_id, status_lunas);
CREATE INDEX IF NOT EXISTS idx_receivables_user ON receivables(user_id, status_lunas);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id, status_lunas);
CREATE INDEX IF NOT EXISTS idx_product_categories_user ON product_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lookup ON inventory(user_id, product_id, warehouse);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_user ON stock_alerts(user_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_settings_lookup ON settings(key);

-- 4. BACKFILL â€” inventory dari products yg punya stok
INSERT INTO inventory (user_id, product_id, quantity, warehouse)
SELECT p.user_id, p.id, p.stock_current, 'Utama'
FROM products p
WHERE p.stock_current != 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.user_id = p.user_id AND i.product_id = p.id AND i.warehouse = 'Utama'
  );

-- 5. BACKFILL â€” payables dari accounts_payable (tabel lama)
INSERT INTO payables (id, user_id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo, deskripsi, transaction_id, created_at)
SELECT a.id, a.user_id, a.nama_supplier, a.nominal_hutang, a.jumlah_dibayar, a.status_lunas, a.jatuh_tempo, a.deskripsi, NULL, a.created_at
FROM accounts_payable a
WHERE NOT EXISTS (SELECT 1 FROM payables p WHERE p.id = a.id);

-- 6. BACKFILL â€” receivables dari debts (tabel lama)
INSERT INTO receivables (id, user_id, transaction_id, nama_pelanggan, nominal_piutang, status_lunas, jatuh_tempo, created_at)
SELECT d.id, d.user_id, d.transaction_id, d.nama_pelanggan, d.nominal_piutang, d.status_lunas, d.jatuh_tempo, d.created_at
FROM debts d
WHERE NOT EXISTS (SELECT 1 FROM receivables r WHERE r.id = d.id);
-- ============================================================
-- MIGRATION 012 â€” FULL OPTIMIZATION & CLEANUP
-- ============================================================
-- Run this ONCE in Supabase SQL Editor (idempoten â€” aman di-run ulang)

-- ============================================================
-- BAGIAN 1: HAPUS DUPLIKAT
-- ============================================================
DELETE FROM inventory a USING inventory b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.product_id = b.product_id
  AND a.warehouse = b.warehouse;

DELETE FROM warehouses a USING warehouses b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.code = b.code;

-- ============================================================
-- BAGIAN 2: UNIQUE CONSTRAINTS
-- ============================================================
ALTER TABLE inventory ADD UNIQUE (user_id, product_id, warehouse);
ALTER TABLE warehouses ADD UNIQUE (user_id, code);

-- ============================================================
-- BAGIAN 3: INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(user_id, type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_id ON stock_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_user ON journal_entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_coa_user ON chart_of_accounts(user_id, code);
CREATE INDEX IF NOT EXISTS idx_payables_user ON payables(user_id, status_lunas);
CREATE INDEX IF NOT EXISTS idx_receivables_user ON receivables(user_id, status_lunas);
CREATE INDEX IF NOT EXISTS idx_product_categories_user ON product_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lookup ON inventory(user_id, product_id, warehouse);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_user ON stock_alerts(user_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_settings_lookup ON settings(key);

-- ============================================================
-- BAGIAN 4: BACKFILL DATA KE TABEL BARU
-- ============================================================
INSERT INTO inventory (user_id, product_id, quantity, warehouse)
SELECT p.user_id, p.id, p.stock_current, 'Utama'
FROM products p
WHERE p.stock_current != 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.user_id = p.user_id AND i.product_id = p.id AND i.warehouse = 'Utama'
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'accounts_payable') THEN
    INSERT INTO payables (id, user_id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo, deskripsi, transaction_id, created_at)
    SELECT a.id, a.user_id, a.nama_supplier, a.nominal_hutang, a.jumlah_dibayar, a.status_lunas, a.jatuh_tempo, a.deskripsi, NULL, a.created_at
    FROM accounts_payable a
    WHERE NOT EXISTS (SELECT 1 FROM payables p WHERE p.id = a.id);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'debts') THEN
    INSERT INTO receivables (id, user_id, transaction_id, nama_pelanggan, nominal_piutang, status_lunas, jatuh_tempo, created_at)
    SELECT d.id, d.user_id, d.transaction_id, d.nama_pelanggan, d.nominal_piutang, d.status_lunas, d.jatuh_tempo, d.created_at
    FROM debts d
    WHERE NOT EXISTS (SELECT 1 FROM receivables r WHERE r.id = d.id);
  END IF;
END $$;

-- ============================================================
-- BAGIAN 5: DROP TABEL LAMA (hanya jika masih ada)
-- ============================================================
DROP TABLE IF EXISTS accounts_payable CASCADE;
DROP TABLE IF EXISTS debts CASCADE;

-- ============================================================
-- BAGIAN 6: DROP KOLOM MATI
-- ============================================================
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_amount;
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_type;

ALTER TABLE products DROP COLUMN IF EXISTS price_grosir;
ALTER TABLE products DROP COLUMN IF EXISTS min_qty_grosir;

-- ============================================================
-- BAGIAN 7: KONSOLIDASI BANK â€” pindah dari users ke user_profiles
-- ============================================================

DO $$ BEGIN
  -- 7a & 7b: Hanya jalan jika kolom bank masih ada di users
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'bank_name'
  ) THEN
    -- 7a. Backfill bank data dari users ke user_profiles
    INSERT INTO user_profiles (user_id, bank_name, bank_account, bank_holder)
    SELECT u.id, u.bank_name, u.bank_account, u.bank_holder
    FROM users u
    WHERE (u.bank_name IS NOT NULL OR u.bank_account IS NOT NULL OR u.bank_holder IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.user_id = u.id);

    -- 7b. Update user_profiles jika users punya data lebih baru
    UPDATE user_profiles up
    SET
      bank_name    = COALESCE(up.bank_name, u.bank_name),
      bank_account = COALESCE(up.bank_account, u.bank_account),
      bank_holder  = COALESCE(up.bank_holder, u.bank_holder)
    FROM users u
    WHERE up.user_id = u.id
      AND (u.bank_name IS NOT NULL OR u.bank_account IS NOT NULL OR u.bank_holder IS NOT NULL);

    -- 7c. Drop kolom bank dari users (sekarang cuma di user_profiles)
    ALTER TABLE users DROP COLUMN IF EXISTS bank_name;
    ALTER TABLE users DROP COLUMN IF EXISTS bank_account;
    ALTER TABLE users DROP COLUMN IF EXISTS bank_holder;
  END IF;
END $$;

-- 7d. Buat RPC upsert_user_profile agar code path primary bekerja
CREATE OR REPLACE FUNCTION upsert_user_profile(
  p_user_id TEXT,
  p_bank_name TEXT DEFAULT NULL,
  p_bank_account TEXT DEFAULT NULL,
  p_bank_holder TEXT DEFAULT NULL,
  p_admin_wa_number TEXT DEFAULT NULL
) RETURNS void AS $$
BEGIN
  INSERT INTO user_profiles (user_id, bank_name, bank_account, bank_holder, admin_wa_number)
  VALUES (p_user_id, p_bank_name, p_bank_account, p_bank_holder, p_admin_wa_number)
  ON CONFLICT (user_id) DO UPDATE SET
    bank_name        = COALESCE(EXCLUDED.bank_name, user_profiles.bank_name),
    bank_account     = COALESCE(EXCLUDED.bank_account, user_profiles.bank_account),
    bank_holder      = COALESCE(EXCLUDED.bank_holder, user_profiles.bank_holder),
    admin_wa_number  = COALESCE(EXCLUDED.admin_wa_number, user_profiles.admin_wa_number);
END;
$$ LANGUAGE plpgsql;
-- Add default_channel column to products table (missing from earlier migration)
ALTER TABLE products ADD COLUMN IF NOT EXISTS default_channel text NOT NULL DEFAULT '';
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- Migration 014: Hapus fitur Transfer Gudang
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- Dijalankan manual via SQL editor (Supabase Dashboard)
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- 1. Hapus data transfer yang sudah ada (opsional â€” kalau mau bersih)
-- DELETE FROM stock_movements WHERE reference_type = 'warehouse_transfer';

-- 2. Hapus kolom from_warehouse / to_warehouse dari stock_movements
ALTER TABLE stock_movements DROP COLUMN IF EXISTS from_warehouse;
ALTER TABLE stock_movements DROP COLUMN IF EXISTS to_warehouse;

-- 3. Hapus tabel warehouses
DROP TABLE IF EXISTS warehouses;

-- 4. Hapus semua baris di inventory yang bukan warehouse 'Utama'
--    (data transfer mungkin ada di warehouse lain)
-- DELETE FROM inventory WHERE warehouse != 'Utama';
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- Migration 015: Tambah product_id di bom_recipes
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- Kolom NULL = resep berlaku untuk SEMUA produk (backward compat)
-- Kolom terisi = resep spesifik untuk produk tertentu
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

ALTER TABLE bom_recipes ADD COLUMN IF NOT EXISTS product_id bigint REFERENCES products(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_br_product ON bom_recipes(product_id);
