import {ensureAppDirs,loadConfig,saveConfig} from '../packages/server/lib/app-config';
import {configuredManagedLimit,validManagedLimit} from '../packages/server/lib/managed-quota';
ensureAppDirs();
const config=loadConfig();
if(!validManagedLimit(config.storage_limit_bytes))saveConfig({storage_limit_bytes:configuredManagedLimit(config.storage_limit_bytes)});
