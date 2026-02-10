-- Session table creation script for KM Finny local setup
-- This table is required for Express session storage and authentication

-- Drop table if it exists (for clean reinstall)
DROP TABLE IF EXISTS session;

-- Create session table with proper structure for connect-pg-simple
CREATE TABLE session (
  sid TEXT PRIMARY KEY NOT NULL,
  sess TEXT NOT NULL,
  expire TIMESTAMP NOT NULL
);

-- Add index on expire for cleanup efficiency
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- Verify table creation
SELECT 'Session table created successfully!' as status;
SELECT COUNT(*) as initial_session_count FROM session;