CREATE TABLE IF NOT EXISTS qr_records (
  code CHAR(3) PRIMARY KEY,
  type VARCHAR(10) NOT NULL CHECK (type IN ('CABLE', 'DEVICE')),
  status VARCHAR(14) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'ACTIVE', 'DEACTIVATED')),
  name TEXT NOT NULL DEFAULT '',
  description_tags TEXT[] NOT NULL DEFAULT '{}',
  operation_voltage TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  bypass_protection VARCHAR(7) NOT NULL DEFAULT 'IGNORE' CHECK (bypass_protection IN ('CUT', 'CONNECT', 'IGNORE')),
  emergency VARCHAR(7) NOT NULL DEFAULT 'IGNORE' CHECK (emergency IN ('CUT', 'CONNECT', 'IGNORE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_pins (
  id BIGSERIAL PRIMARY KEY,
  device_code CHAR(3) NOT NULL REFERENCES qr_records(code) ON DELETE CASCADE,
  pin_name TEXT NOT NULL,
  pin_description TEXT NOT NULL DEFAULT '',
  UNIQUE(device_code, pin_name)
);

CREATE TABLE IF NOT EXISTS connections (
  id BIGSERIAL PRIMARY KEY,
  cable_code CHAR(3) NOT NULL REFERENCES qr_records(code) ON DELETE CASCADE,
  slot SMALLINT NOT NULL CHECK (slot IN (1, 2)),
  endpoint_type VARCHAR(10) NOT NULL CHECK (endpoint_type IN ('TEXT', 'CABLE', 'DEVICE')),
  endpoint_code CHAR(3),
  endpoint_pin TEXT,
  descriptive_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cable_code, slot)
);

CREATE TABLE IF NOT EXISTS link_operations (
  id UUID PRIMARY KEY,
  action VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inserted_connection_ids BIGINT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_connections_endpoint_code ON connections(endpoint_code);
CREATE INDEX IF NOT EXISTS idx_qr_records_type_status ON qr_records(type, status);
