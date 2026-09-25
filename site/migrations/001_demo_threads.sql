-- Thread ownership/selection metadata. Harness remains the conversation store.
CREATE TABLE IF NOT EXISTS tress_demo_threads (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE,
  access_hash text NOT NULL UNIQUE CHECK (access_hash ~ '^[a-f0-9]{64}$'),
  harness_thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Multiple access IDs can join the same session without moving its history/files.
CREATE TABLE IF NOT EXISTS tress_demo_access (
  access_hash text PRIMARY KEY CHECK (access_hash ~ '^[a-f0-9]{64}$'),
  thread_id uuid NOT NULL REFERENCES tress_demo_threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tress_demo_access_thread_id_idx ON tress_demo_access(thread_id);
INSERT INTO tress_demo_access (access_hash, thread_id)
SELECT access_hash, id FROM tress_demo_threads
ON CONFLICT (access_hash) DO NOTHING;
