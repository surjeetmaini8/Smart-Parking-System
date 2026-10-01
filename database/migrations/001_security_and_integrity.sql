-- Migration for existing Smart Parking System databases.
-- Run this against an existing database before deploying the improved server.
-- Review/fix any overlapping active bookings before adding the exclusion constraint.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_vehicle_per_user
  ON vehicles(user_id) WHERE is_primary = true;

CREATE TABLE IF NOT EXISTS wallet_transactions (
    wallet_transaction_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'refunded')),
    payment_method VARCHAR(30) NOT NULL,
    gateway_response JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user
  ON wallet_transactions(user_id);

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS booking_time_valid;
ALTER TABLE bookings
  ADD CONSTRAINT booking_time_valid CHECK (end_time > start_time);

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS no_overlapping_active_bookings;
ALTER TABLE bookings
  ADD CONSTRAINT no_overlapping_active_bookings
  EXCLUDE USING gist (
    slot_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (status IN ('pending', 'confirmed', 'active'));

COMMIT;
