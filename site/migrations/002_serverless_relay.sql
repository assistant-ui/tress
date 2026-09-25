-- Short-lived routing records; conversation history still lives in Harness.
ALTER TABLE tress_demo_threads ADD COLUMN IF NOT EXISTS files jsonb;
ALTER TABLE tress_demo_threads ADD COLUMN IF NOT EXISTS previews jsonb;
CREATE TABLE IF NOT EXISTS tress_demo_relay_clients (
  thread_id uuid NOT NULL REFERENCES tress_demo_threads(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  owner text NOT NULL,
  record jsonb,
  PRIMARY KEY (thread_id, client_id)
);
CREATE TABLE IF NOT EXISTS tress_demo_relay_connections (
  lease text PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES tress_demo_threads(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  details jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '45 seconds'
);
CREATE INDEX IF NOT EXISTS tress_demo_relay_connections_thread_idx
  ON tress_demo_relay_connections(thread_id);
CREATE TABLE IF NOT EXISTS tress_demo_relay_frames (
  id uuid PRIMARY KEY,
  lease text NOT NULL REFERENCES tress_demo_relay_connections(lease) ON DELETE CASCADE,
  body text NOT NULL,
  status integer,
  response text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tress_demo_relay_frames_pending_idx
  ON tress_demo_relay_frames(lease) WHERE status IS NULL;
