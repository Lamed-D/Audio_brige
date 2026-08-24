import { SUPPORTED_SCHEMA_VERSION } from '../contracts/manifest';

// kwon2/backend binds to the IPv4 loopback interface by default. Keep this
// value in sync with extension/manifest.json host_permissions.
export const API_BASE_URL = 'http://127.0.0.1:5000' as const;
export const CONTRACT_VERSION = SUPPORTED_SCHEMA_VERSION;
