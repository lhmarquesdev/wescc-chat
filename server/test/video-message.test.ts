import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { getSetting } from '../src/services/settings';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Mensagem de vídeo (spec B §12, video-message.test.ts).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

function videoForm(fields: Record<string, string>, type = 'video/webm', filename = 'Mensagem de vídeo.webm') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob(['vídeo de teste'], { type }), filename);
  return fd;
}
const lastMessage = async (rid: string) => (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [rid])).rows[0].last_message;

describe('mensagem de vídeo', () => {
  let rid: string;
  beforeAll(async () => {
    rid = (await api('POST', 'groups.create', { name: `video-${Date.now()}` }, A)).group._id;
  });

  it('video=1 com duração: anexo e arquivo marcados; prévia com a duração', async () => {
    const up = await api('POST', `rooms.upload/${rid}`, videoForm({ video: '1', duration: '42.3' }), A);
    expect(up.status).toBe(200);
    const att = up.message.attachments[0];
    expect(att).toMatchObject({ video_message: true, video_duration: 42.3 });
    expect(att.video_url).toBeTruthy();
    expect(up.message.files[0]).toMatchObject({ video: true, duration: 42.3 });
    expect((await lastMessage(rid)).msg).toBe('🎥 Mensagem de vídeo (0:42)');
  });

  it('duração absurda fica no teto', async () => {
    const up = await api('POST', `rooms.upload/${rid}`, videoForm({ video: '1', duration: '9999' }), A);
    expect(up.message.attachments[0].video_duration).toBe(125);
  });

  it('video=1 com imagem: arquivo comum', async () => {
    const up = await api('POST', `rooms.upload/${rid}`, videoForm({ video: '1', duration: '3' }, 'image/png', 'foto.png'), A);
    expect(up.status).toBe(200);
    expect(up.message.attachments[0].video_message).toBeUndefined();
    expect(up.message.files[0].video).toBeUndefined();
  });

  it('DM com arquivos desligados em mensagens diretas: o erro de sempre', async () => {
    const u = await newUser(A);
    const dm = (await api('POST', 'im.create', { username: u.username }, A)).room._id;
    const before = getSetting('FileUpload_Enabled_Direct');
    await api('POST', 'settings', { settings: { FileUpload_Enabled_Direct: false } }, A);
    try {
      const up = await api('POST', `rooms.upload/${dm}`, videoForm({ video: '1', duration: '5' }), A);
      expect(up.status).toBe(403);
      expect(up.success).toBe(false);
    } finally {
      await api('POST', 'settings', { settings: { FileUpload_Enabled_Direct: before } }, A);
    }
  });
});
