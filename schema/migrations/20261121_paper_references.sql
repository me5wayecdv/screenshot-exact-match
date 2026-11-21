-- Additive and repeatable. Existing grades and student publication are unchanged.
CREATE TABLE IF NOT EXISTS handwritten_references (
  id TEXT PRIMARY KEY NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('written', 'bubble')),
  image_path TEXT NOT NULL,
  confirmed_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_handwritten_references_teacher ON handwritten_references(teacher_id, created_at DESC);
