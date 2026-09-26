-- Shared admission budgets; model credentials and conversation history stay on the host.
CREATE TABLE IF NOT EXISTS tress_demo_usage (
  bucket text NOT NULL,
  day date NOT NULL,
  used integer NOT NULL CHECK (used > 0),
  PRIMARY KEY (bucket, day)
);
CREATE INDEX IF NOT EXISTS tress_demo_usage_day_idx ON tress_demo_usage(day);
