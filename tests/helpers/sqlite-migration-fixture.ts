import type Database from "better-sqlite3";

/**
 * Remove migrations added after the v16 connection schema when a test needs
 * to reconstruct an older database from a freshly migrated fixture.
 *
 * Production migrations remain forward-only. This helper is test-only and
 * drops dependent objects in reverse migration order before trimming ledger.
 */
export function removePostV16MigrationFixture(db: Database.Database): void {
  const hasCryptoOwner = (db.prepare("PRAGMA table_info(connections)").all() as Array<{ name: string }>)
    .some((column) => column.name === "crypto_owner_id");
  if (hasCryptoOwner) {
    db.exec(`
      DROP TRIGGER IF EXISTS connections_crypto_owner_update;
      DROP TRIGGER IF EXISTS connections_crypto_owner_insert;
      ALTER TABLE connections DROP COLUMN crypto_owner_id;
    `);
  }
  db.exec(`
    DROP TRIGGER IF EXISTS connector_operation_list_no_delete;
    DROP TRIGGER IF EXISTS connector_operation_list_no_update;
    DROP TRIGGER IF EXISTS connector_operation_list_insert;
    DROP TABLE IF EXISTS connector_operation_list_entries;
    DROP INDEX IF EXISTS idx_connector_definition_owner_projection_hash;

    DROP TRIGGER IF EXISTS connector_import_rate_insert_conflict;
    DROP TRIGGER IF EXISTS connector_import_rate_no_delete;
    DROP TRIGGER IF EXISTS connector_import_rate_no_update;
    DROP TRIGGER IF EXISTS connector_operation_versions_insert_conflict;
    DROP TRIGGER IF EXISTS connector_operation_versions_no_delete;
    DROP TRIGGER IF EXISTS connector_operation_versions_no_update;
    DROP TRIGGER IF EXISTS connector_definition_versions_insert_conflict;
    DROP TRIGGER IF EXISTS connector_definition_versions_no_delete;
    DROP TRIGGER IF EXISTS connector_definition_versions_no_update;
    DROP TRIGGER IF EXISTS connector_identities_insert_conflict;
    DROP TRIGGER IF EXISTS connector_identities_revision_update;
    DROP TRIGGER IF EXISTS connector_identities_identity_no_update;
    DROP TABLE IF EXISTS connector_import_rate_reservations;
    DROP TABLE IF EXISTS connector_operation_versions;
    DROP TABLE IF EXISTS connector_definition_versions;
    DROP TABLE IF EXISTS connector_identities;

    DROP TRIGGER IF EXISTS control_audit_events_no_update;
    DROP TRIGGER IF EXISTS control_audit_events_no_delete;
    DROP TABLE IF EXISTS control_audit_events;
    DELETE FROM schema_migrations WHERE version >= 17;
  `);
}
