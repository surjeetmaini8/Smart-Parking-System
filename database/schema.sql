-- Smart Parking System database schema
-- PostgreSQL 12+
-- IMPORTANT: use environment variables for credentials; never store secrets here.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) >= 2),
    email VARCHAR(254) UNIQUE NOT NULL,
    phone VARCHAR(15) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
    wallet_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (wallet_balance >= 0),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    password_changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parking_locations (
    location_id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DECIMAL(11, 8) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    total_slots INTEGER NOT NULL CHECK (total_slots >= 0),
    available_slots INTEGER NOT NULL CHECK (available_slots >= 0 AND available_slots <= total_slots),
    owner_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    hourly_rate NUMERIC(10, 2) NOT NULL CHECK (hourly_rate >= 0),
    daily_rate NUMERIC(10, 2) CHECK (daily_rate IS NULL OR daily_rate >= 0),
    is_active BOOLEAN DEFAULT true,
    has_camera BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parking_slots (
    slot_id SERIAL PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES parking_locations(location_id) ON DELETE CASCADE,
    slot_number VARCHAR(10) NOT NULL,
    slot_type VARCHAR(20) DEFAULT 'standard' CHECK (slot_type IN ('standard', 'compact', 'large', 'handicap', 'ev')),
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance')),
    floor VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(location_id, slot_number)
);

CREATE TABLE IF NOT EXISTS vehicles (
    vehicle_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    license_plate VARCHAR(20) UNIQUE NOT NULL,
    make VARCHAR(50),
    model VARCHAR(50),
    color VARCHAR(30),
    vehicle_type VARCHAR(20) DEFAULT 'car' CHECK (vehicle_type IN ('car', 'bike', 'suv', 'truck')),
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_vehicle_per_user
ON vehicles(user_id) WHERE is_primary = true;

CREATE TABLE IF NOT EXISTS bookings (
    booking_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES parking_locations(location_id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES parking_slots(slot_id) ON DELETE RESTRICT,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
    booking_reference VARCHAR(50) UNIQUE NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    actual_entry_time TIMESTAMPTZ,
    actual_exit_time TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'cancelled')),
    total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
    paid_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (paid_amount >= 0 AND paid_amount <= total_amount),
    payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'refunded', 'partial')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT booking_time_valid CHECK (end_time > start_time)
);

-- Prevent double-booking the same slot, including concurrent requests.
ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS no_overlapping_active_bookings;
ALTER TABLE bookings
    ADD CONSTRAINT no_overlapping_active_bookings
    EXCLUDE USING gist (
        slot_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    )
    WHERE (status IN ('pending', 'confirmed', 'active'));

CREATE TABLE IF NOT EXISTS entry_exit_logs (
    log_id SERIAL PRIMARY KEY,
    booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE SET NULL,
    location_id INTEGER NOT NULL REFERENCES parking_locations(location_id) ON DELETE CASCADE,
    license_plate VARCHAR(20) NOT NULL,
    event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('entry', 'exit')),
    image_path TEXT,
    confidence_score NUMERIC(5, 4) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
    detected_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    camera_id VARCHAR(50),
    is_verified BOOLEAN DEFAULT false
);

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

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);

CREATE TABLE IF NOT EXISTS payments (
    payment_id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) CHECK (payment_method IN ('wallet', 'card', 'upi', 'cash', 'razorpay', 'online')),
    transaction_id VARCHAR(100) UNIQUE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
    payment_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    gateway_response JSONB
);

CREATE TABLE IF NOT EXISTS occupancy_events (
    event_id SERIAL PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES parking_locations(location_id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES parking_slots(slot_id) ON DELETE CASCADE,
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    changed_by VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_location ON bookings(location_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_slot_time ON bookings(slot_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_slots_location ON parking_slots(location_id);
CREATE INDEX IF NOT EXISTS idx_slots_status ON parking_slots(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(license_plate);
CREATE INDEX IF NOT EXISTS idx_entry_exit_plate ON entry_exit_logs(license_plate);
CREATE INDEX IF NOT EXISTS idx_entry_exit_time ON entry_exit_logs(detected_time);
CREATE INDEX IF NOT EXISTS idx_locations_coords ON parking_locations(latitude, longitude);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_parking_locations_updated_at ON parking_locations;
CREATE TRIGGER update_parking_locations_updated_at BEFORE UPDATE ON parking_locations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_parking_slots_updated_at ON parking_slots;
CREATE TRIGGER update_parking_slots_updated_at BEFORE UPDATE ON parking_slots
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bookings_updated_at ON bookings;
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Development seed. Change/remove before production.
INSERT INTO users (name, email, phone, password_hash, role, wallet_balance)
VALUES (
    'Admin User',
    'admin@smartparking.com',
    '1234567890',
    '$2a$12$ZQdQWL37903RbEw5WRKhJuc3MqmMYD5XJsQYwKtnGDw8Pc65jA/yS',
    'admin',
    0.00
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO parking_locations
(name, address, latitude, longitude, total_slots, available_slots, hourly_rate, daily_rate, has_camera)
VALUES
('Demo Parking', 'New Delhi, India', 28.61390000, 77.20900000, 50, 50, 50.00, 400.00, false)
ON CONFLICT DO NOTHING;

INSERT INTO parking_slots (location_id, slot_number, slot_type, floor)
SELECT l.location_id, 'A' || gs, 'standard', 'Ground'
FROM (SELECT location_id FROM parking_locations ORDER BY location_id LIMIT 1) l
CROSS JOIN generate_series(1, 30) gs
ON CONFLICT (location_id, slot_number) DO NOTHING;

INSERT INTO parking_slots (location_id, slot_number, slot_type, floor)
SELECT l.location_id, 'B' || gs, 'compact', 'First'
FROM (SELECT location_id FROM parking_locations ORDER BY location_id LIMIT 1) l
CROSS JOIN generate_series(1, 20) gs
ON CONFLICT (location_id, slot_number) DO NOTHING;
