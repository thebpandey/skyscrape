#!/usr/bin/env bash
# The fixture addresses exist only inside the disposable container networks.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
project="egress-check-${scratch##*.}"
project=${project,,}
compose=(docker compose --env-file /dev/null --project-directory "$root" -p "$project"
  -f "$root/infra/compose/collection-network.yaml" -f "$scratch/check.yaml")
cleanup() {
  if (( $? != 0 )); then "${compose[@]}" logs collection-egress >&2; fi
  "${compose[@]}" down --timeout 2 >/dev/null
  if [[ ${built:-0} == 1 ]]; then docker image rm "$project-proxy" >/dev/null; fi
  rm -f "$scratch/check.yaml" "$scratch/Corefile"
  rmdir "$scratch"
}
fixture=11.255.255.246
resolver=192.0.2.53
export COLLECTION_DNS_IPV4=$resolver
cat >"$scratch/Corefile" <<DNS
.:53 {
    hosts {
        $fixture data.austintexas.gov
        169.254.169.254 data.seattle.gov
        $resolver www2.census.gov
    }
}
DNS
cat >"$scratch/check.yaml" <<YAML
services:
  collection-egress:
    labels: {lanes.lane: egress}
    build:
      labels: {lanes.lane: egress}
    image: ${EGRESS_CHECK_IMAGE:-$project-proxy}
  client:
    image: alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
    labels: {lanes.lane: egress}
    command: [sleep, "300"]
    cap_drop: [ALL]
    dns: [127.0.0.1]
    networks: [collection_private]
  origin:
    image: alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
    labels: {lanes.lane: egress}
    cap_add: [NET_ADMIN]
    command: [sh, -ec, "ip addr add $fixture/32 dev lo && ip addr add 169.254.169.254/32 dev lo && ip addr add $resolver/32 dev lo && exec nc -lk -p 443 -e /bin/cat"]
    networks: [collection_outbound]
  dns:
    image: coredns/coredns:1.13.1@sha256:9b9128672209474da07c91439bf15ed704ae05ad918dd6454e5b6ae14e35fee6
    labels: {lanes.lane: egress}
    network_mode: service:origin
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    command: [-conf, /Corefile]
    volumes:
      - "$scratch/Corefile:/Corefile:ro"
networks:
  collection_private:
    labels: {lanes.lane: egress}
  collection_outbound:
    labels: {lanes.lane: egress}
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
YAML
trap cleanup EXIT
if [[ -z ${EGRESS_CHECK_IMAGE:-} ]]; then
  "${compose[@]}" pull --policy missing client dns
  "${compose[@]}" build collection-egress
  built=1
fi
"${compose[@]}" up -d --no-build --pull never
client() { "${compose[@]}" exec -T client "$@"; }
proxy() { "${compose[@]}" exec -T collection-egress "$@"; }
origin_ip=$("${compose[@]}" exec -T origin hostname -i | awk '{print $1}')
for address in "$fixture" 169.254.169.254 "$resolver"; do
  proxy ip route add "$address/32" via "$origin_ip" dev uplink0
done
for ((i=0; i<30; i++)); do
  if client nc -zw1 collection-egress 3128; then break; fi
  sleep 0.2
done
if ! client nc -zw1 collection-egress 3128; then
  "${compose[@]}" logs collection-egress >&2
  exit 1
fi
probe() {
  local expected=$1 request=$2 response
  response=$(client sh -c 'printf "%s\r\n\r\n" "$1" | nc -w2 collection-egress 3128' sh "$request")
  if [[ ${response%%$'\r'*} != HTTP/*" $expected "* ]]; then
    echo "Unexpected response for $request: ${response%%$'\r'*}" >&2
    exit 1
  fi
  if [[ $expected == 503 && $response != *"X-Squid-Error: ERR_CONNECT_FAIL"* ]]; then
    echo "Expected resolved destination refusal for $request" >&2; exit 1
  fi
  echo "$expected $request"
}
response=$(client sh -c '{
  printf "CONNECT data.austintexas.gov:443 HTTP/1.1\r\nHost: data.austintexas.gov:443\r\n\r\n"
  sleep 0.2
  printf "fixture-marker\n"
  sleep 0.3
} | nc -w2 collection-egress 3128')
if [[ $response != *"200 Connection established"* || $response != *fixture-marker* ]]; then
  echo "Expected DNS-resolved CONNECT with fixture marker. Received ${response%%$'\r'*}" >&2
  exit 1
fi
echo "PASS approved authority resolved through the upstream DNS fixture and reached the origin"
proxy nc -zw1 "$resolver" 53
if proxy nc -zw1 "$fixture" 53; then
  echo "Proxy reached port 53 at an address other than its configured resolver" >&2
  exit 1
fi
echo "PASS proxy TCP 53 is restricted to the configured resolver"
probe 400 'CONNECT fixture@data.austintexas.gov:443 HTTP/1.0'
probe 403 'CONNECT unapproved.invalid:443 HTTP/1.0'
probe 403 'GET http://data.austintexas.gov/ HTTP/1.0'
probe 403 'CONNECT data.austintexas.gov:80 HTTP/1.0'
probe 403 'CONNECT 127.0.0.1:443 HTTP/1.0'
probe 403 'CONNECT [fd00::1]:443 HTTP/1.0'
probe 403 'CONNECT [::1]:443 HTTP/1.0'
probe 403 'CONNECT 169.254.169.254:443 HTTP/1.0'
probe 503 'CONNECT data.seattle.gov:443 HTTP/1.0'
probe 503 'CONNECT www2.census.gov:443 HTTP/1.0'
if client ip route get "$fixture" >/dev/null 2>&1 ||
   client ip -6 route get 2001:db8::1 >/dev/null 2>&1 ||
   client nc -zw1 "$origin_ip" 443; then
  echo "Collector has a direct route to the origin" >&2; exit 1
fi
if "${compose[@]}" exec -T origin nc -zw1 collection-egress 3128; then
  echo "Proxy accepts outbound-side clients" >&2; exit 1
fi
proxy sh -ec 'grep -Eq "^Uid:[[:space:]]+[1-9]" /proc/1/status; grep -Eq "^CapBnd:[[:space:]]+0+$" /proc/1/status'
echo "PASS private listener, isolated IPv4/IPv6 client routes, and unprivileged Squid"
