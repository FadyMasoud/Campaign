-- ===========================================================================
-- Phase 4 — searching 81,842 customers without reading 81,842 rows
-- ===========================================================================
--
-- The contacts view has to be searchable and stay quick for the brand with
-- ninety times the data of the smallest. A plain `ilike '%term%'` cannot use a
-- btree index at all — the leading wildcard defeats it — so every keystroke
-- would read the whole table.
--
-- pg_trgm indexes the three-letter sequences inside each value, which makes a
-- contains-match indexable. It is the difference between a search box that
-- feels instant for Marrakech and unusable for Kilele, and one that behaves
-- the same for both.
-- ===========================================================================

create extension if not exists pg_trgm with schema extensions;

-- One index per searchable field rather than one over a concatenation: the
-- planner can then use whichever field the term actually matches, and combine
-- them with a bitmap OR when the term could match either.
create index if not exists contacts_full_name_trgm_idx
  on public.contacts using gin (full_name extensions.gin_trgm_ops);

create index if not exists contacts_email_trgm_idx
  on public.contacts using gin (email extensions.gin_trgm_ops);

-- The customer reference is searched by prefix far more often than by
-- fragment — people paste "CT-0057" — so a plain btree earns its keep here.
create index if not exists contacts_brand_external_id_idx
  on public.contacts (brand_id, external_id text_pattern_ops);
