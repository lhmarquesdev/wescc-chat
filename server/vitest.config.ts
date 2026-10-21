import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared/src') } },
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://chat:chat@127.0.0.1:5432/chat_test',
      UPLOAD_DIR: path.resolve(import.meta.dirname, '.test-uploads'),
      ADMIN_PASSWORD: 'admin-pass-123',
      LOG_LEVEL: 'silent',
    },
  },
});
