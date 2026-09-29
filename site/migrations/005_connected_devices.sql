-- A public visitor can attach one native workspace to a thread without
-- receiving the Harness project key. Pairing and device tokens are stored hashed.
CREATE TABLE IF NOT EXISTS tress_demo_devices (
  id uuid PRIMARY KEY,
  thread_id uuid REFERENCES tress_demo_threads(id) ON DELETE CASCADE,
  code_hash text UNIQUE CHECK (code_hash IS NULL OR code_hash ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  label text NOT NULL,
  root_label text NOT NULL,
  writable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  code_expires_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tress_demo_devices_thread_idx
  ON tress_demo_devices(thread_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tress_demo_device_jobs (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES tress_demo_devices(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('read', 'list', 'write')),
  path text NOT NULL,
  content text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  leased_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tress_demo_device_jobs_pending_idx
  ON tress_demo_device_jobs(device_id, created_at)
  WHERE status = 'pending';
