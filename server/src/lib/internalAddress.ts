import net from 'node:net';

// Endereços que não são da internet: loopback, redes privadas, link-local, multicast... Sem outras importações: as
// configurações (services/settings.ts) usam esta regra sem puxar o login.

const INTERNAL = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  INTERNAL.addSubnet(a, n, 'ipv4');
}
// Formas de IPv6 que levam um IPv4 dentro (compatível ::/96, traduzido ::ffff:0:0:0/96, NAT64 64:ff9b::/96 e o de uso
// local 64:ff9b:1::/48, 6to4 2002::/16) são recusadas inteiras: por elas se chega a qualquer endereço IPv4 interno.
for (const [a, n] of [
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2002::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  INTERNAL.addSubnet(a, n, 'ipv6');
}

// Loopback, redes privadas, link-local, multicast... (IPv4 mapeado em IPv6 também conta).
export function internalAddress(ip: string) {
  const family = net.isIP(ip);
  return !family || INTERNAL.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// IP literal da internet (um nome não conta: quem chama resolve e confere cada endereço).
export const externalIp = (host: string) => net.isIP(host) > 0 && !internalAddress(host);
