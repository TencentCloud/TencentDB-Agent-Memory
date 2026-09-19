import { SqliteMetadataStore } from '../store/sqlite-adapter.js';
import { runMetadataStoreContract } from '../store/metadata-store.contract.js';
runMetadataStoreContract('sqlite', async () => new SqliteMetadataStore(':memory:'), async (s) => { await s.close(); });
