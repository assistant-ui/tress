-- Browser ownership is separate from the shareable per-thread attach ID.
CREATE TABLE IF NOT EXISTS tress_demo_owners (
  id uuid PRIMARY KEY,
  access_hash text NOT NULL UNIQUE CHECK (access_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE tress_demo_threads DROP CONSTRAINT IF EXISTS tress_demo_threads_owner_id_key;
ALTER TABLE tress_demo_threads ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE tress_demo_threads ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS tress_demo_threads_owner_idx ON tress_demo_threads(owner_id, updated_at DESC);
