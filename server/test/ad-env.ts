import fs from 'node:fs';
import { Client } from 'ldapts';

// AD de teste (Samba, domínio EXPLORER.TEST). As senhas vêm só das variáveis de ambiente, para nenhuma
// credencial ficar no repositório; sem elas, os testes de AD são ignorados.

const env = process.env;
const AD_DIR = env.WESCC_TEST_AD_DIR ?? '';

export const AD_START_HINT = AD_DIR
  ? `${AD_DIR}/adctl.sh start`
  : 'suba o AD de teste e defina WESCC_TEST_AD_DIR, WESCC_TEST_AD_SYNC_PASSWORD, WESCC_TEST_AD_PROVISION_PASSWORD e WESCC_TEST_AD_USER_PASSWORD';

export const AD = {
  url: env.WESCC_TEST_AD_URL ?? 'ldap://127.0.0.1:389',
  ldapsUrl: env.WESCC_TEST_AD_LDAPS_URL ?? 'ldaps://127.0.0.1:636',
  caFile: env.WESCC_TEST_AD_CA ?? (AD_DIR ? `${AD_DIR}/tls/ca.pem` : ''),
  domainDn: 'DC=explorer,DC=test',
  baseDn: 'OU=Explorer,DC=explorer,DC=test',
  sync: {
    dn: env.WESCC_TEST_AD_SYNC_DN ?? 'CN=svc-wescc-ldap,CN=Users,DC=explorer,DC=test',
    password: env.WESCC_TEST_AD_SYNC_PASSWORD ?? '',
  },
  provision: {
    dn: env.WESCC_TEST_AD_PROVISION_DN ?? 'CN=svc-wescc-provision,CN=Users,DC=explorer,DC=test',
    password: env.WESCC_TEST_AD_PROVISION_PASSWORD ?? '',
  },
  userPassword: env.WESCC_TEST_AD_USER_PASSWORD ?? '',
};

export function adCa(): string | null {
  if (!AD.caFile) return null;
  try {
    return fs.readFileSync(AD.caFile, 'utf8');
  } catch {
    return null;
  }
}

// null quando o AD responde ao bind do usuário de serviço; senão, o motivo.
export async function adUnavailableReason(): Promise<string | null> {
  if (!AD.sync.password || !AD.userPassword) return 'senhas do AD de teste não definidas nas variáveis WESCC_TEST_AD_*';
  const c = new Client({ url: AD.url, timeout: 3_000, connectTimeout: 3_000 });
  try {
    await c.bind(AD.sync.dn, AD.sync.password);
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e) || 'erro desconhecido';
  } finally {
    await c.unbind().catch(() => {});
  }
}
