#!/usr/bin/env bash
# The fixture address exists only inside two container network namespaces.
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
  rm -f "$scratch/check.yaml"
  rmdir "$scratch"
}
fixture=11.255.255.246
cat >"$scratch/check.yaml" <<YAML
services:
  collection-egress:
    labels: {lanes.lane: egress}
    build:
      labels: {lanes.lane: egress}
    image: ${EGRESS_CHECK_IMAGE:-$project-proxy}
    extra_hosts:
      data.austintexas.gov: "$fixture"
      data.seattle.gov: "169.254.169.254"
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
    command: [sh, -ec, "ip addr add $fixture/32 dev lo && ip addr add 169.254.169.254/32 dev lo && exec nc -lk -p 443 -e /bin/cat"]
    networks:
      collection_outbound:
        aliases: [www2.census.gov]
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
  "${compose[@]}" build collection-egress
  built=1
fi
"${compose[@]}" up -d --no-build --pull never
client() { "${compose[@]}" exec -T client "$@"; }
proxy() { "${compose[@]}" exec -T collection-egress "$@"; }
origin_ip=$("${compose[@]}" exec -T origin hostname -i | awk '{print $1}')
for address in "$fixture" 169.254.169.254; do
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
[[ $response == *"200 Connection established"* && $response == *fixture-marker* ]]
echo "PASS approved authority reached the fixture through CONNECT"
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
