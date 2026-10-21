import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, startServer, stopServer, urlOf, type Auth } from './helpers';

let A: Auth;
let key = '';
let cert = '';
let otherCert = '';
const ISSUER = 'wescc-chat-test';

function makeCert(dir: string, name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=idp', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8') };
}

// Monta uma resposta do IdP com a asserção assinada.
function samlResponse(opts: { nameID: string; attrs: Record<string, string | string[]>; inResponseTo?: string; signWith?: string; acs: string }) {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';
  const attrs = Object.entries(opts.attrs)
    .map(([k, v]) => `<saml:Attribute Name="${k}">${[v].flat().map((x) => `<saml:AttributeValue>${x}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
    .join('');
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${Date.now()}${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>https://idp.example</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameID}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${opts.acs}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${ISSUER}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion>`;
  const sig = new SignedXml({ privateKey: opts.signWith ?? key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${Date.now()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${opts.acs}"${irt}>` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.example</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${sig.getSignedXml()}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

async function postAcs(SAMLResponse: string, RelayState = '/home') {
  return fetch(urlOf('/saml/acs'), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse, RelayState }) });
}

async function startLogin() {
  const r = await fetch(urlOf('/saml/login?redirect=/channel/geral'), { redirect: 'manual' });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location')!);
  const xml = zlib.inflateRawSync(Buffer.from(loc.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return { id: /ID="([^"]+)"/.exec(xml)![1], relay: loc.searchParams.get('RelayState'), xml };
}

let acs = '';
beforeAll(async () => {
  await startServer();
  A = await admin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-'));
  ({ key, cert } = makeCert(dir, 'idp'));
  otherCert = makeCert(dir, 'other').key;
  const base = urlOf('').replace(/\/$/, '');
  acs = `${base}/saml/acs`;
  const r = await api(
    'POST',
    'settings',
    {
      settings: {
        Site_Url: base,
        SAML_Enable: true,
        SAML_Entry_Point: 'https://idp.example/sso',
        SAML_Issuer: ISSUER,
        SAML_IdP_Cert: cert,
        SAML_Username_Attribute: 'uid',
        SAML_Email_Attribute: 'mail',
        SAML_Name_Attribute: 'displayName',
        SAML_Role_Attribute: 'groups',
        SAML_Role_Mapping: JSON.stringify({ 'chat-admins': ['admin'], suporte: ['livechat-agent'] }),
      },
    },
    A,
  );
  expect(r.success).toBe(true);
});
afterAll(() => stopServer());

describe('SAML', () => {
  it('publica os metadados do SP', async () => {
    const r = await fetch(urlOf('/saml/metadata'));
    const xml = await r.text();
    expect(xml).toContain(`entityID="${ISSUER}"`);
    expect(xml).toContain(acs);
  });

  it('login completo: pedido, resposta assinada, usuário criado com papéis e sessão', async () => {
    const req = await startLogin();
    expect(req.xml).toContain(acs);
    expect(req.relay).toBe('/channel/geral');
    const res = await postAcs(samlResponse({ nameID: 'ana@empresa.com', attrs: { uid: 'ana', mail: 'ana@empresa.com', displayName: 'Ana Souza', groups: ['suporte', 'outros'] }, inResponseTo: req.id, acs }), req.relay!);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'http://x');
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/channel/geral');
    const credentialToken = loc.searchParams.get('saml')!;

    const login = await api('POST', 'login', { saml: true, credentialToken });
    expect(login.status).toBe('success');
    expect(login.data.me.username).toBe('ana');
    expect(login.data.me.name).toBe('Ana Souza');
    expect(login.data.me.roles.sort()).toEqual(['livechat-agent', 'user']);
    const me = await api('GET', 'me', undefined, { userId: login.data.userId, authToken: login.data.authToken, username: 'ana' });
    expect(JSON.stringify(me)).toContain('ana@empresa.com');

    // A credencial é de uso único.
    const again = await api('POST', 'login', { saml: true, credentialToken });
    expect(again.success).toBe(false);
  });

  it('a mesma resposta não pode ser reutilizada (InResponseTo já consumido)', async () => {
    const req = await startLogin();
    const resp = samlResponse({ nameID: 'bia@empresa.com', attrs: { uid: 'bia', mail: 'bia@empresa.com' }, inResponseTo: req.id, acs });
    expect((await postAcs(resp)).status).toBe(302);
    expect((await postAcs(resp)).status).toBe(401);
  });

  it('recusa assinatura de outra chave e resposta adulterada', async () => {
    const bad = samlResponse({ nameID: 'eve@empresa.com', attrs: { uid: 'eve', groups: 'chat-admins' }, signWith: otherCert, acs });
    expect((await postAcs(bad)).status).toBe(401);

    const good = Buffer.from(samlResponse({ nameID: 'eve@empresa.com', attrs: { uid: 'eve', groups: 'outros' }, acs }), 'base64').toString();
    const tampered = Buffer.from(good.replace('<saml:AttributeValue>outros</saml:AttributeValue>', '<saml:AttributeValue>chat-admins</saml:AttributeValue>')).toString('base64');
    expect((await postAcs(tampered)).status).toBe(401);
    const eve = await pool.query(`SELECT 1 FROM users WHERE username = 'eve'`);
    expect(eve.rowCount).toBe(0);
  });

  it('não sobrescreve usuário local com o mesmo nome e só redireciona para caminhos internos', async () => {
    const res = await postAcs(samlResponse({ nameID: 'outro-admin@empresa.com', attrs: { uid: 'admin' }, acs }), 'https://evil.example/');
    expect(res.status).toBe(409);
    const ok = await postAcs(samlResponse({ nameID: 'caio@empresa.com', attrs: { uid: 'caio' }, acs }), '//evil.example');
    expect(new URL(ok.headers.get('location')!, 'http://x').searchParams.get('next')).toBe('/home');
  });

  it('desativado: rotas respondem 404 e credenciais não valem', async () => {
    await api('POST', 'settings', { settings: { SAML_Enable: false } }, A);
    expect((await fetch(urlOf('/saml/login'), { redirect: 'manual' })).status).toBe(404);
    const login = await api('POST', 'login', { saml: true, credentialToken: 'x' });
    expect(login.success).toBe(false);
  });
});
