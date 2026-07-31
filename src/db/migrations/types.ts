export interface Migration {
  /** Monotonic, starts at 1. Never renumber a shipped migration. */
  readonly version: number;
  /** Short slug, recorded in schema_migrations for readability. */
  readonly name: string;
  /** SQL executed inside a transaction. */
  readonly up: string;
}
