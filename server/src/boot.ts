import { config } from './config';
import { migrate } from './db/migrate';
import { query } from './db/pool';
import { bus } from './realtime/bus';
import { loadPermissions, seedPermissions } from './services/permissions';
import { ensureDefaultChannel } from './services/rooms';
import { loadSettings, setSettingCache } from './services/settings';
import { ensureAdmin } from './services/users';

export async function boot(log: (m: string) => void = console.log) {
  await migrate(log);
  await loadSettings();
  await seedPermissions();
  await loadPermissions();
  bus.onSettings((s) => s.forEach((x) => setSettingCache(x._id, x.value)));
  await bus.start();
  await query(`INSERT INTO instances (id, info) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET last_seen = now()`, [
    bus.origin,
    JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), port: config.port }),
  ]);
  await ensureAdmin(config.adminUsername, config.adminPassword, config.adminEmail, log);
  await ensureDefaultChannel();
}
