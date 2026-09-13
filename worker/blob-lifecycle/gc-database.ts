/** Structural access to the existing lifecycle SQL authority. batch must commit
 * all statements atomically, or roll back every statement on failure. This does
 * not make the SQLite queries portable to other database engines. */
export interface BlobLifecycleStatement {
  bind(...values: unknown[]): BlobLifecycleStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface BlobLifecycleDatabase {
  prepare(query: string): BlobLifecycleStatement;
  batch(statements: BlobLifecycleStatement[]): Promise<Array<{ meta: { changes?: number } }>>;
}
