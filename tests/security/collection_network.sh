#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
lane=${COLLECTOR_CHECK_LANE:-collector}
[[ $lane =~ ^[a-z0-9][a-z0-9-]*$ ]]
scratch=$(mktemp -d)
project="collector-check-${scratch##*.}"
project=${project,,}
fixture=11.255.255.245
fixture_user="$(id -u):$(id -g)"
export COLLECTION_DNS_IPV4=192.0.2.53
export COLLECTION_SERVICE_TOKEN_FILE="$scratch/service-token"
openssl rand -hex 32 >"$COLLECTION_SERVICE_TOKEN_FILE"
chmod 0444 "$COLLECTION_SERVICE_TOKEN_FILE"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=data.austintexas.gov' \
  -addext 'subjectAltName=DNS:data.austintexas.gov,DNS:data.seattle.gov' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
cat >"$scratch/Corefile" <<DNS
.:53 {
    hosts {
        $fixture data.austintexas.gov
        169.254.169.254 data.seattle.gov
    }
}
DNS

collector_image=${COLLECTOR_CHECK_IMAGE:-$project-collector}
proxy_image=${COLLECTOR_CHECK_PROXY_IMAGE:-$project-egress}
cat >"$scratch/compose.yaml" <<YAML
services:
  collector:
    image: $collector_image
    labels: {lanes.lane: "$lane"}
    build:
      labels: {lanes.lane: "$lane"}
    environment:
      COLLECTION_CA_FILE: /fixture-ca.pem
    volumes:
      - "$scratch/cert.pem:/fixture-ca.pem:ro"
  collection-egress:
    labels: {lanes.lane: "$lane"}
    build:
      labels: {lanes.lane: "$lane"}
    image: $proxy_image
  origin:
    image: alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
    labels: {lanes.lane: "$lane"}
    networks: [collection_outbound]
    cap_add: [NET_ADMIN]
    command: [sh, -ec, "ip addr add $fixture/32 dev lo && ip addr add 169.254.169.254/32 dev lo && ip addr add $COLLECTION_DNS_IPV4/32 dev lo && exec sleep 180"]
  dns:
    image: coredns/coredns:1.13.1@sha256:9b9128672209474da07c91439bf15ed704ae05ad918dd6454e5b6ae14e35fee6
    labels: {lanes.lane: "$lane"}
    network_mode: service:origin
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    command: [-conf, /Corefile]
    volumes: ["$scratch/Corefile:/Corefile:ro"]
  publisher:
    image: $collector_image
    labels: {lanes.lane: "$lane"}
    network_mode: service:origin
    user: "$fixture_user"
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    entrypoint: [python, /origin.py]
    volumes:
      - "$root/tests/security/collection_network_origin.py:/origin.py:ro"
      - "$scratch:/fixture"
  checker:
    image: $collector_image
    labels: {lanes.lane: "$lane"}
    network_mode: none
    entrypoint: [/opt/collection/.venv/bin/python, /check.py]
    secrets: [collection_service_token]
    volumes:
      - collector_socket:/run/collection:ro
      - collector_artifacts:/var/staging/collection:ro
      - "$root/tests/security/collection_network_client.py:/check.py:ro"
networks:
  collection_private:
    labels: {lanes.lane: "$lane"}
  collection_outbound:
    labels: {lanes.lane: "$lane"}
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
volumes:
  collector_socket:
    labels: {lanes.lane: "$lane"}
  collector_artifacts:
    labels: {lanes.lane: "$lane"}
YAML

compose=(docker compose --env-file /dev/null --project-directory "$root" -p "$project"
  -f "$root/infra/compose/collection-network.yaml" -f "$root/infra/compose/collector.yaml" -f "$scratch/compose.yaml")
cleanup() {
  if (( $? != 0 )); then "${compose[@]}" logs collector publisher collection-egress >&2 || true; fi
  "${compose[@]}" down --volumes --timeout 2 >/dev/null
  if [[ -z ${COLLECTOR_CHECK_IMAGE:-} ]]; then docker image rm "$collector_image" >/dev/null 2>&1 || true; fi
  if [[ -z ${COLLECTOR_CHECK_PROXY_IMAGE:-} ]]; then docker image rm "$proxy_image" >/dev/null 2>&1 || true; fi
  rm -f "$scratch/service-token" "$scratch/key.pem" "$scratch/cert.pem" "$scratch/Corefile" \
    "$scratch/compose.yaml" "$scratch/canary-reached" "$scratch/retry-headers-sent"
  rmdir "$scratch"
}
trap cleanup EXIT
"${compose[@]}" pull --policy missing origin dns
if [[ -z ${COLLECTOR_CHECK_IMAGE:-} ]]; then "${compose[@]}" build collector; fi
if [[ -z ${COLLECTOR_CHECK_PROXY_IMAGE:-} ]]; then "${compose[@]}" build collection-egress; fi
"${compose[@]}" up -d --no-build --pull never collector collection-egress origin dns publisher
origin_ip=$("${compose[@]}" exec -T origin hostname -i | awk '{print $1}')
for address in "$fixture" 169.254.169.254 "$COLLECTION_DNS_IPV4"; do
  "${compose[@]}" exec -T collection-egress ip route add "$address/32" via "$origin_ip" dev uplink0
done
"${compose[@]}" run --rm --no-deps checker
[[ -f "$scratch/retry-headers-sent" ]]
"${compose[@]}" exec -T collector python -c '
import os
import socket
import sys
assert os.getuid() == 10001
for destination in sys.argv[1:]:
    with socket.socket() as connection:
        connection.settimeout(1)
        assert connection.connect_ex((destination, 443)) != 0
' "$fixture" "$origin_ip"
[[ ! -e "$scratch/canary-reached" ]]
echo "PASS isolated collector cannot connect directly to the publisher or its internal bridge address"
