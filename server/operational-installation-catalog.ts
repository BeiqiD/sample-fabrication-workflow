import { V26_NODE_INSTALLATION_CATALOG } from './installation-catalog-v26';

/** Fixed code-owned catalog for live Node development and offline installation
 * operations. The separate V25 catalog/readers remain frozen for recovery.
 * Selecting metadata schema never opens a provider or grants File authority. */
export const OPERATIONAL_NODE_INSTALLATION_CATALOG = V26_NODE_INSTALLATION_CATALOG;
