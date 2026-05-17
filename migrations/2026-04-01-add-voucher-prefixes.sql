-- Migration: add voucher_prefixes table
CREATE TABLE IF NOT EXISTS voucher_prefixes (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  updated_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Insert default prefixes if not present
INSERT INTO voucher_prefixes (type, prefix)
VALUES
  ('expense', 'KM2526-EV-')
ON CONFLICT (type) DO NOTHING;

INSERT INTO voucher_prefixes (type, prefix)
VALUES
  ('toll', 'KM2526-TV-')
ON CONFLICT (type) DO NOTHING;
