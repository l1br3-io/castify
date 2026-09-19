-- Migration 0016: Drop the collection suggestion staging tables
-- (effort purge-collection-suggestions).
--
-- The suggestion pipeline is removed end to end: no code stages,
-- lists, accepts, or dismisses suggestions anymore. The three tables
-- below were derived staging data (regenerated per scan, per 0015's
-- own header), so dropping them loses nothing user-created — accepted
-- suggestions live on as rows in `collections` / `collection_items`
-- and are untouched. Migration 0015 is never edited; migrations are
-- append-only.
--
-- Drop order: `collection_suggestion_items` first (FK child of
-- `collection_suggestions`), then the groups, then the signature-keyed
-- dismissals.

DROP TABLE collection_suggestion_items;
DROP TABLE collection_suggestions;
DROP TABLE collection_suggestion_dismissals;
