# Gerado por scripts/livekit/render-config.mjs. Não edite à mão: rode o instalador de novo.
port: 7880
bind_addresses:
  - "127.0.0.1"
rtc:
  tcp_port: 7881
  udp_port: "7882-7885"
  use_external_ip: false
  node_ip: "{{NODE_IP}}"
  ips:
    includes:
{{LAN_CIDRS}}
  enable_loopback_candidate: false
  allow_tcp_fallback: true
keys:
  "{{API_KEY}}": "{{API_SECRET}}"
room:
  auto_create: false
  empty_timeout: 120
  departure_timeout: 40
  enable_remote_unmute: false
webhook:
  api_key: "{{API_KEY}}"
  urls:
    - "{{WEBHOOK_URL}}"
turn:
  enabled: false
limit:
  num_tracks: {{NUM_TRACKS}}
  bytes_per_sec: {{BYTES_PER_SEC}}
logging:
  level: info
