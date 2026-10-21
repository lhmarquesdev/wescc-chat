import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@127.0.0.1:5432/chat',
  uploadDir: path.resolve(env.UPLOAD_DIR ?? './uploads'),
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : null,
  siteUrl: env.SITE_URL ?? 'http://localhost:3000',
  sessionDays: Number(env.SESSION_DAYS ?? 90),
  // Usuário administrador criado na primeira execução, se não houver nenhum.
  adminUsername: env.ADMIN_USERNAME ?? 'admin',
  adminPassword: env.ADMIN_PASSWORD ?? null,
  adminEmail: env.ADMIN_EMAIL ?? 'admin@localhost',
  logLevel: env.LOG_LEVEL ?? 'info',
  disableCron: env.DISABLE_CRON === '1',
};
