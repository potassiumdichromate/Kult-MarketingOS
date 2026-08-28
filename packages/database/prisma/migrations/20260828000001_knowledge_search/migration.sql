-- Cosine similarity over float vectors stored as double precision[].
--
-- The brand knowledge base retrieves chunks by ranking on this function inside
-- Postgres, so a similarity search never loads an organization's whole corpus
-- into the application process.
--
-- STRICT: a NULL argument yields NULL rather than an error.
-- IMMUTABLE + PARALLEL SAFE: lets the planner parallelise the ranking scan.
CREATE OR REPLACE FUNCTION kult_cosine_similarity(a double precision[], b double precision[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT CASE
    WHEN array_length(a, 1) IS DISTINCT FROM array_length(b, 1) THEN 0::double precision
    WHEN s.norm_a = 0 OR s.norm_b = 0 THEN 0::double precision
    ELSE s.dot / (s.norm_a * s.norm_b)
  END
  FROM (
    SELECT
      sum(x * y)        AS dot,
      sqrt(sum(x * x))  AS norm_a,
      sqrt(sum(y * y))  AS norm_b
    FROM unnest(a, b) AS t(x, y)
  ) AS s;
$$;

-- Supports the org-scoped ranking scan used by knowledge retrieval.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_organizationId_createdAt_idx"
  ON "KnowledgeChunk" ("organizationId", "createdAt");
