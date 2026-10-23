import crypto from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { joinToken, parseJoinClaims, resetSfuState, sfu, sfuConfig, sfuHealth, signJwt, verifyJwt, verifyWebhook } from '../src/calls/livekit';
import { config } from '../src/config';
import { setSettingCache } from '../src/services/settings';
import { startFakeSfu, type FakeSfu } from './sfu-fake';

// Recebe os webhooks do LiveKit falso como chegam: corpo cru e cabeçalhos.
const hooks: { body: string; auth: string; type: string }[] = [];
let hookServer: http.Server;
let fake: FakeSfu;

function useSfu(url: string, key: string, secret: string) {
  setSettingCache('Calls_SFU_Url', url);
  setSettingCache('Calls_SFU_Api_Key', key);
  setSettingCache('Calls_SFU_Api_Secret', secret);
}

const decode = (token: string) => {
  const [h, p] = token.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(p, 'base64url').toString()) };
};
const now = () => Math.floor(Date.now() / 1000);

// Servidor Twirp de mentira com respostas escolhidas pelo teste (para formatos e erros que o falso não produz).
async function stubTwirp(handler: (method: string, body: any) => [number, unknown]) {
  const seen: { method: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ method, body });
      const [status, out] = handler(method, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

beforeAll(async () => {
  hookServer = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      hooks.push({ body: b, auth: String(req.headers.authorization ?? ''), type: String(req.headers['content-type'] ?? '') });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  fake = await startFakeSfu({ webhookUrl: `http://127.0.0.1:${(hookServer.address() as net.AddressInfo).port}/sfu-webhook` });
  useSfu(fake.url, fake.key, fake.secret);
});
afterAll(async () => {
  await fake.stop();
  await new Promise<void>((r) => hookServer.close(() => r()));
});
afterEach(() => {
  vi.useRealTimers();
  resetSfuState();
  useSfu(fake.url, fake.key, fake.secret);
});

describe('tokens', () => {
  it('token de entrada: HS256, iss, sub, nbf e exp de 60 s, uma sala, permissões e fontes; sem nome, metadados ou atributos; canUpdateOwnMetadata e canPublishData falsos', () => {
    const t0 = now();
    const { token, expiresAt } = joinToken({ room: 'wc_abc123', identity: 'user1', canPublish: true, sources: ['microphone', 'camera'], hidden: false });
    const { header, claims } = decode(token);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(verifyJwt(token, fake.secret, { issuer: fake.key })).not.toBeNull();
    expect(claims.iss).toBe(fake.key);
    expect(claims.sub).toBe('user1');
    expect(claims.exp - claims.nbf).toBe(65); // nbf 5 s antes, para relógios um pouco adiantados
    expect(claims.exp).toBeGreaterThanOrEqual(t0 + 60);
    expect(claims.exp).toBeLessThanOrEqual(now() + 60);
    expect(new Date(expiresAt).getTime()).toBe(claims.exp * 1000);
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'wc_abc123',
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      hidden: false,
      canPublishSources: ['microphone', 'camera'],
    });
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iss', 'nbf', 'sub', 'video']);
    for (const k of ['name', 'metadata', 'attributes']) expect(claims).not.toHaveProperty(k);

    // Ouvinte: não publica e fica oculto.
    const l = decode(joinToken({ room: 'wc_abc123', identity: 'user2', canPublish: false, sources: [], hidden: true }).token).claims;
    expect(l.video).toMatchObject({ canPublish: false, canPublishSources: [], hidden: true, canPublishData: false, canUpdateOwnMetadata: false });
  });

  it('token do autoteste: sem lista de fontes e 5 min', () => {
    const { token } = joinToken({ room: 'wc_test_abc', identity: 'user1', canPublish: true, sources: null, hidden: false, ttlSeconds: 300 });
    const { claims } = decode(token);
    expect(claims.video).not.toHaveProperty('canPublishSources');
    expect(claims.video).toMatchObject({ roomJoin: true, room: 'wc_test_abc', canPublish: true, canPublishData: false, canUpdateOwnMetadata: false });
    expect(claims.exp - claims.nbf).toBe(305);
    expect(claims.exp - now()).toBeGreaterThan(295);
    const parsed = parseJoinClaims(claims);
    expect(parsed).toMatchObject({ identity: 'user1', room: 'wc_test_abc', forbidden: null, hidden: false });
    expect(parsed.exp - parsed.nbf).toBeLessThanOrEqual(310);
  });

  it('parseJoinClaims marca roomAdmin, roomCreate, roomList, roomRecord, recorder, agent, canUpdateOwnMetadata, canPublishData e sala fora do padrão', () => {
    const base = { iss: 'k', sub: 'u1', nbf: 1, exp: 2, video: { roomJoin: true, room: 'wc_abc', canPublish: true, canPublishData: false, hidden: true, canPublishSources: ['microphone', 'camera'] } };
    expect(parseJoinClaims(base)).toEqual({ identity: 'u1', room: 'wc_abc', hidden: true, nbf: 1, exp: 2, canPublish: true, sources: ['microphone', 'camera'], forbidden: null });
    // Como o LiveKit lê: canPublish ausente vale true, lista vazia ou ausente libera todas as fontes, e
    // canPublishData ausente segue o canPublish (então é proibido quando publica).
    expect(parseJoinClaims({ ...base, video: { ...base.video, canPublishSources: [] } })).toMatchObject({ canPublish: true, sources: null });
    expect(parseJoinClaims({ ...base, video: { roomJoin: true, room: 'wc_abc', canPublishData: false } })).toMatchObject({ canPublish: true, sources: null, forbidden: null });
    expect(parseJoinClaims({ ...base, video: { ...base.video, canPublish: false } })).toMatchObject({ canPublish: false });
    expect(parseJoinClaims({ ...base, video: { roomJoin: true, room: 'wc_abc' } }).forbidden).toBe('canPublishData');
    expect(parseJoinClaims({ ...base, video: { roomJoin: true, room: 'wc_abc', canPublish: false } }).forbidden).toBeNull();
    for (const g of ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin', 'recorder', 'agent', 'canUpdateOwnMetadata', 'canPublishData']) {
      expect(parseJoinClaims({ ...base, video: { ...base.video, [g]: true } }).forbidden).toBe(g);
      // Falso explícito não é privilégio.
      expect(parseJoinClaims({ ...base, video: { ...base.video, [g]: false } }).forbidden).toBeNull();
    }
    for (const room of ['outra', 'wc_', 'wc_abc-1', 'wc_abc/../x', 'loadtest1', '']) {
      expect(parseJoinClaims({ ...base, video: { ...base.video, room } }).forbidden).toBe('room');
    }
    expect(parseJoinClaims({ ...base, video: { ...base.video, room: 'wc_test_xyz9' } }).forbidden).toBeNull();
    expect(parseJoinClaims({ ...base, video: { ...base.video, roomJoin: false } }).forbidden).toBe('roomJoin');
    expect(parseJoinClaims({ ...base, video: undefined }).forbidden).toBe('roomJoin');
    expect(parseJoinClaims({ ...base, sub: '' }).forbidden).toBe('sub');
    expect(parseJoinClaims({ ...base, video: { ...base.video, hidden: 'true' } }).hidden).toBe(false);
  });

  it('verifyJwt recusa assinatura errada, alg diferente, token vencido e iss estranho', () => {
    const s = 'segredo-de-teste-com-tamanho-bom-123456';
    const good = signJwt({ iss: 'APIk', exp: now() + 60, nbf: now() }, s);
    expect(verifyJwt(good, s, { issuer: 'APIk' })).toMatchObject({ iss: 'APIk' });
    expect(verifyJwt(good, s + 'x')).toBeNull();
    expect(verifyJwt(good, s, { issuer: 'outro' })).toBeNull();
    expect(verifyJwt(signJwt({ iss: 'APIk', exp: now() - 1 }, s), s)).toBeNull();
    expect(verifyJwt(signJwt({ iss: 'APIk' }, s), s)).toBeNull(); // sem exp
    expect(verifyJwt(signJwt({ iss: 'APIk', exp: now() + 60, nbf: now() + 60 }, s), s)).toBeNull();
    expect(verifyJwt(signJwt({ iss: 'APIk', exp: now() + 60, nbf: now() + 5 }, s), s)).not.toBeNull(); // folga de 10 s
    // alg trocado (mesma assinatura HMAC, cabeçalho HS512 ou none)
    const [, p, sig] = good.split('.');
    for (const alg of ['HS512', 'none', 'RS256']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
      const resigned = crypto.createHmac('sha256', s).update(`${h}.${p}`).digest('base64url');
      expect(verifyJwt(`${h}.${p}.${resigned}`, s)).toBeNull();
      expect(verifyJwt(`${h}.${p}.`, s)).toBeNull();
    }
    // corpo trocado com a assinatura antiga
    const forged = Buffer.from(JSON.stringify({ iss: 'APIk', exp: now() + 9999 })).toString('base64url');
    expect(verifyJwt(`${good.split('.')[0]}.${forged}.${sig}`, s)).toBeNull();
    expect(verifyJwt('lixo', s)).toBeNull();
    expect(verifyJwt(good, '')).toBeNull();
  });

  it('verifyWebhook confere o sha256 do corpo cru; corpo alterado é recusado', async () => {
    hooks.length = 0;
    await sfu.createRoom('wc_hook1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    const sid = await fake.join('wc_hook1', 'u1');
    await fake.publish('wc_hook1', 'u1', { source: 'camera', name: 'camera', type: 'video' });
    await fake.leave('wc_hook1', 'u1', { reason: 'CLIENT_INITIATED' });
    await vi.waitFor(() => expect(hooks.length).toBeGreaterThanOrEqual(4));
    for (const h of hooks) expect(h.type).toBe('application/webhook+json');
    const evs = hooks.map((h) => verifyWebhook(h.body, h.auth));
    expect(evs.map((e) => e?.event)).toEqual(['room_started', 'participant_joined', 'track_published', 'participant_left']);
    const [started, joined, track, left] = evs;
    expect(started).toMatchObject({ room: { name: 'wc_hook1' }, participant: null, track: null });
    expect(joined).toMatchObject({ participant: { sid, identity: 'u1', disconnectReason: null } });
    expect(track?.track).toMatchObject({ name: 'camera', source: 'camera' });
    expect(left?.participant).toEqual({ sid, identity: 'u1', disconnectReason: 'CLIENT_INITIATED' });
    for (const e of evs) {
      expect(e?.id).toMatch(/^EV_/);
      expect(typeof e?.createdAt).toBe('number');
      expect(Math.abs((e?.createdAt ?? 0) - now())).toBeLessThan(5);
    }
    // Também com "Bearer ".
    expect(verifyWebhook(hooks[0].body, `Bearer ${hooks[0].auth}`)?.event).toBe('room_started');
    // Corpo alterado (um espaço a mais), assinatura de outro corpo, sem cabeçalho, segredo errado.
    expect(verifyWebhook(hooks[0].body + ' ', hooks[0].auth)).toBeNull();
    expect(verifyWebhook(hooks[0].body.replace('wc_hook1', 'wc_hook2'), hooks[0].auth)).toBeNull();
    expect(verifyWebhook(hooks[1].body, hooks[0].auth)).toBeNull();
    expect(verifyWebhook(hooks[0].body, undefined)).toBeNull();
    const sha = crypto.createHash('sha256').update(hooks[0].body).digest('base64');
    expect(verifyWebhook(hooks[0].body, signJwt({ iss: fake.key, exp: now() + 60, sha256: sha }, 'outro-segredo'))).toBeNull();
    expect(verifyWebhook(hooks[0].body, signJwt({ iss: 'APIoutro', exp: now() + 60, sha256: sha }, fake.secret))).toBeNull();
    expect(verifyWebhook(hooks[0].body, signJwt({ iss: fake.key, exp: now() + 60, sha256: sha }, fake.secret))?.event).toBe('room_started');
    await sfu.deleteRoom('wc_hook1');
  });
});

describe('API do servidor de chamadas (Twirp)', () => {
  it('Twirp: cada método usa o grant certo e os campos certos; respostas protojson são normalizadas (int64 em texto, campos omitidos)', async () => {
    fake.calls.length = 0;
    const t0 = now();
    await sfu.createRoom('wc_twirp1', { emptyTimeout: 120, departureTimeout: 40, maxParticipants: 35 });
    await fake.join('wc_twirp1', 'u1', { sid: 'PA_um', hidden: true });
    await fake.publish('wc_twirp1', 'u1', { source: 'microphone', name: 'microphone', type: 'audio' });
    const rooms = await sfu.listRooms(['wc_twirp1']);
    expect(rooms).toEqual([{ name: 'wc_twirp1', numParticipants: 1, creationTime: expect.any(Number) }]);
    expect(rooms[0].creationTime).toBeGreaterThanOrEqual(t0);
    const people = await sfu.listParticipants('wc_twirp1');
    expect(people).toEqual([
      {
        sid: 'PA_um',
        identity: 'u1',
        state: 'ACTIVE',
        joinedAt: expect.any(Number),
        tracks: [{ sid: expect.stringMatching(/^TR_/), source: 'microphone', type: 'audio', name: 'microphone', muted: false }],
        permission: { canPublish: true, canPublishSources: [], canPublishData: false, canUpdateMetadata: false, hidden: true },
      },
    ]);
    await sfu.muteTrack('wc_twirp1', 'u1', people[0].tracks[0].sid);
    await sfu.updatePermission('wc_twirp1', 'u1', { canPublish: true, sources: ['microphone'], hidden: true });
    await sfu.removeParticipant('wc_twirp1', 'u1');
    await sfu.deleteRoom('wc_twirp1');

    const byMethod = (m: string) => fake.calls.filter((c) => c.method === m);
    expect(byMethod('CreateRoom')[0]).toMatchObject({ body: { name: 'wc_twirp1', emptyTimeout: 120, departureTimeout: 40, maxParticipants: 35 }, grant: { roomCreate: true } });
    expect(byMethod('DeleteRoom')[0]).toMatchObject({ body: { room: 'wc_twirp1' }, grant: { roomCreate: true } });
    expect(byMethod('ListRooms')[0]).toMatchObject({ body: { names: ['wc_twirp1'] }, grant: { roomList: true } });
    for (const m of ['ListParticipants', 'RemoveParticipant', 'UpdateParticipant', 'MutePublishedTrack']) {
      expect(byMethod(m)[0].grant).toEqual({ roomAdmin: true, room: 'wc_twirp1' });
    }
    expect(byMethod('MutePublishedTrack')[0].body).toEqual({ room: 'wc_twirp1', identity: 'u1', trackSid: people[0].tracks[0].sid, muted: true });
    // Nenhum token de API dá mais do que o método precisa.
    for (const c of fake.calls) expect(Object.keys(c.grant).length).toBeLessThanOrEqual(2);

    // Formato do webhook e do protojson sem campos padrão: int64 em texto, enums omitidos, camelCase.
    const stub = await stubTwirp((method) => {
      if (method === 'ListRooms') return [200, { rooms: [{ name: 'wc_x', creationTime: '1792700000' }, { name: 'wc_y', numParticipants: 3, creationTime: '1792700001' }] }];
      return [200, { participants: [{ sid: 'PA_a', identity: 'a', joinedAt: '1792700002', tracks: [{ sid: 'TR_a', name: 'microphone' }, { sid: 'TR_b', type: 'VIDEO', source: 'SCREEN_SHARE' }, { sid: 'TR_c', type: 'DATA', source: 'FOO' }], permission: { canSubscribe: true } }] }];
    });
    useSfu(stub.url, fake.key, fake.secret);
    expect(await sfu.listRooms()).toEqual([{ name: 'wc_x', numParticipants: 0, creationTime: 1792700000 }, { name: 'wc_y', numParticipants: 3, creationTime: 1792700001 }]);
    expect(await sfu.listParticipants('wc_x')).toEqual([
      {
        sid: 'PA_a',
        identity: 'a',
        state: 'JOINING',
        joinedAt: 1792700002,
        tracks: [
          { sid: 'TR_a', source: 'unknown', type: 'audio', name: 'microphone', muted: false },
          { sid: 'TR_b', source: 'screen_share', type: 'video', name: '', muted: false },
          { sid: 'TR_c', source: 'unknown', type: 'data', name: '', muted: false },
        ],
        permission: { canPublish: false, canPublishSources: [], canPublishData: false, canUpdateMetadata: false, hidden: false },
      },
    ]);
    await stub.close();
  });

  it('updatePermission manda a permissão completa; pausa vai com fontes vazias; publicar sem fontes falha antes de chamar', async () => {
    await sfu.createRoom('wc_perm1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    await fake.join('wc_perm1', 'u1');
    const tr = await fake.publish('wc_perm1', 'u1', { source: 'camera', name: 'camera', type: 'video' });
    await fake.publish('wc_perm1', 'u1', { source: 'microphone', name: 'microphone', type: 'audio' });
    fake.calls.length = 0;
    await sfu.updatePermission('wc_perm1', 'u1', { canPublish: true, sources: ['microphone', 'screen_share', 'screen_share_audio'], hidden: false });
    expect(fake.calls[0].body).toEqual({
      room: 'wc_perm1',
      identity: 'u1',
      permission: { canSubscribe: true, canPublish: true, canPublishData: false, canUpdateMetadata: false, hidden: false, canPublishSources: ['MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] },
    });
    // A câmera deixou de valer: o LiveKit tira a faixa.
    let p = (await sfu.listParticipants('wc_perm1'))[0];
    expect(p.tracks.map((t) => t.source)).toEqual(['microphone']);
    expect(p.tracks.some((t) => t.sid === tr)).toBe(false);
    expect(p.permission.canPublishSources).toEqual(['microphone', 'screen_share', 'screen_share_audio']);

    // Pausa: canPublish false e nenhuma fonte, mesmo que o chamador passe uma lista.
    fake.calls.length = 0;
    await sfu.updatePermission('wc_perm1', 'u1', { canPublish: false, sources: ['microphone'], hidden: false });
    expect(fake.calls[0].body.permission).toEqual({ canSubscribe: true, canPublish: false, canPublishData: false, canUpdateMetadata: false, hidden: false, canPublishSources: [] });
    p = (await sfu.listParticipants('wc_perm1'))[0];
    expect(p.tracks).toEqual([]);
    expect(p.permission.canPublish).toBe(false);

    fake.calls.length = 0;
    await expect(sfu.updatePermission('wc_perm1', 'u1', { canPublish: true, sources: [], hidden: false })).rejects.toThrow('fontes vazias');
    expect(fake.calls).toEqual([]);
    await sfu.deleteRoom('wc_perm1');
  });

  it('removeParticipant manda revokeTokenTs e tenta de novo sem ele quando o servidor não conhece o campo', async () => {
    await sfu.createRoom('wc_rm1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    await fake.join('wc_rm1', 'u1');
    fake.calls.length = 0;
    const t0 = now();
    await sfu.removeParticipant('wc_rm1', 'u1');
    const body = fake.calls[0].body;
    expect(body).toMatchObject({ room: 'wc_rm1', identity: 'u1' });
    expect(typeof body.revokeTokenTs).toBe('string'); // int64 em protojson
    expect(Number(body.revokeTokenTs)).toBeGreaterThanOrEqual(t0);
    expect(Number(body.revokeTokenTs)).toBeLessThanOrEqual(now());
    expect(fake.rooms.get('wc_rm1')?.participants.size).toBe(0);
    await sfu.deleteRoom('wc_rm1');

    // Servidor Twirp que recusa o corpo com o campo: responde malformed com o texto fixo do Twirp, que não cita o
    // campo. Uma nova tentativa sem ele, e o processo lembra.
    const stub = await stubTwirp((_m, b) => ('revokeTokenTs' in b ? [400, { code: 'malformed', msg: 'the json request could not be decoded' }] : [200, {}]));
    useSfu(stub.url, fake.key, fake.secret);
    await sfu.removeParticipant('wc_rm2', 'u1');
    expect(stub.seen.map((s) => 'revokeTokenTs' in s.body)).toEqual([true, false]);
    await sfu.removeParticipant('wc_rm2', 'u2');
    expect(stub.seen.map((s) => 'revokeTokenTs' in s.body)).toEqual([true, false, false]);
    await stub.close();

    // malformed também sem o campo: o problema não era ele. O erro chega a quem chamou e nada fica lembrado.
    resetSfuState();
    const stub3 = await stubTwirp(() => [400, { code: 'malformed', msg: 'the json request could not be decoded' }]);
    useSfu(stub3.url, fake.key, fake.secret);
    await expect(sfu.removeParticipant('wc_rm4', 'u1')).rejects.toMatchObject({ code: 'malformed', status: 400 });
    await expect(sfu.removeParticipant('wc_rm4', 'u1')).rejects.toMatchObject({ code: 'malformed' });
    expect(stub3.seen.map((s) => 'revokeTokenTs' in s.body)).toEqual([true, false, true, false]);
    await stub3.close();

    // Outro erro 400 não vira nova tentativa.
    resetSfuState();
    const stub2 = await stubTwirp(() => [400, { code: 'invalid_argument', msg: 'identity inválida' }]);
    useSfu(stub2.url, fake.key, fake.secret);
    await expect(sfu.removeParticipant('wc_rm3', 'u1')).rejects.toMatchObject({ code: 'invalid_argument', status: 400 });
    expect(stub2.seen.length).toBe(1);
    await stub2.close();
  });

  it('sala inexistente: deleteRoom e removeParticipant não falham; listParticipants dá not_found', async () => {
    await expect(sfu.deleteRoom('wc_naoexiste')).resolves.toBeUndefined();
    await expect(sfu.removeParticipant('wc_naoexiste', 'u1')).resolves.toBeUndefined();
    await expect(sfu.listParticipants('wc_naoexiste')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    // Sala que existe, vazia: lista vazia, sem erro. Pessoa ausente numa sala que existe: não é erro.
    await sfu.createRoom('wc_vazia1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    await expect(sfu.listParticipants('wc_vazia1')).resolves.toEqual([]);
    await expect(sfu.removeParticipant('wc_vazia1', 'ninguem')).resolves.toBeUndefined();
    // CreateRoom de sala que já existe devolve a mesma sala.
    const before = fake.rooms.get('wc_vazia1')?.creationTime;
    await sfu.createRoom('wc_vazia1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    expect(fake.rooms.get('wc_vazia1')?.creationTime).toBe(before);
    await sfu.deleteRoom('wc_vazia1');
    // Outros erros chegam com código e status.
    useSfu(fake.url, fake.key, 'segredo-errado');
    await expect(sfu.listRooms()).rejects.toMatchObject({ code: 'http_401', status: 401 });
    fake.down();
    useSfu(fake.url, fake.key, fake.secret);
    await expect(sfu.listRooms()).rejects.toMatchObject({ code: 'unreachable' });
    fake.up();
    // Tempo esgotado também é "sem resposta".
    fake.delay(400);
    await expect(sfu.listRooms([], { timeoutMs: 100 })).rejects.toMatchObject({ code: 'unreachable', message: `Sem resposta de ${fake.url}.` });
    fake.delay(0);
  });

  it('sfuHealth guarda o resultado por 15 s e explica a falha em português', async () => {
    await sfu.createRoom('wc_saude1', { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 5 });
    await fake.join('wc_saude1', 'u1');
    await fake.join('wc_saude1', 'u2');
    vi.useFakeTimers({ toFake: ['Date'] });
    fake.calls.length = 0;
    const h = await sfuHealth();
    expect(h).toEqual({ ok: true, latencyMs: expect.any(Number), rooms: expect.any(Number), participants: expect.any(Number) });
    expect(h.participants).toBeGreaterThanOrEqual(2);
    const listCalls = () => fake.calls.filter((c) => c.method === 'ListRooms').length;
    expect(listCalls()).toBe(1);
    // Chamadas ao mesmo tempo usam a mesma consulta.
    await Promise.all([sfuHealth(), sfuHealth(), sfuHealth()]);
    expect(listCalls()).toBe(1);
    fake.down();
    vi.setSystemTime(Date.now() + 14_000);
    expect((await sfuHealth()).ok).toBe(true);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await sfuHealth()).toEqual({ ok: false, latencyMs: null, error: `Sem resposta de ${fake.url}.` });
    fake.up();
    expect((await sfuHealth()).ok).toBe(false); // ainda no cache
    expect((await sfuHealth(true)).ok).toBe(true); // force ignora o cache
    // Segredo errado: outra chave do cache, mensagem própria.
    useSfu(fake.url, fake.key, 'segredo-errado');
    expect((await sfuHealth()).error).toBe('A chave ou o segredo da API do LiveKit não conferem.');
    useSfu('', '', '');
    expect(await sfuHealth()).toEqual({ ok: false, latencyMs: null, error: 'Servidor de chamadas não configurado.' });
    vi.useRealTimers();
    useSfu(fake.url, fake.key, fake.secret);
    await sfu.deleteRoom('wc_saude1');
  });

  it('variáveis LIVEKIT_* têm precedência sobre as configurações', async () => {
    const saved = { ...config.livekit };
    try {
      useSfu('http://127.0.0.1:1', 'APIdasconfig', 'segredo-das-config');
      expect(sfuConfig()).toEqual({ url: 'http://127.0.0.1:1', apiKey: 'APIdasconfig', apiSecret: 'segredo-das-config', configured: true });
      config.livekit.url = `${fake.url}/`;
      config.livekit.apiKey = fake.key;
      config.livekit.apiSecret = fake.secret;
      expect(sfuConfig()).toEqual({ url: fake.url, apiKey: fake.key, apiSecret: fake.secret, configured: true });
      expect((await sfuHealth(true)).ok).toBe(true);
      expect(decode(joinToken({ room: 'wc_a', identity: 'u', canPublish: false, sources: [], hidden: false }).token).claims.iss).toBe(fake.key);
      // Cada variável vale sozinha; o resto vem das configurações.
      config.livekit.url = null;
      config.livekit.apiSecret = null;
      expect(sfuConfig()).toEqual({ url: 'http://127.0.0.1:1', apiKey: fake.key, apiSecret: 'segredo-das-config', configured: true });
      useSfu('http://127.0.0.1:1', '', '');
      config.livekit.apiKey = null;
      expect(sfuConfig().configured).toBe(false);
      expect(() => joinToken({ room: 'wc_a', identity: 'u', canPublish: false, sources: [], hidden: false })).toThrow('Servidor de chamadas não configurado.');
    } finally {
      Object.assign(config.livekit, saved);
    }
  });
});
