#!/bin/sh
set -eu
resolver=${COLLECTION_DNS_IPV4:?Set the trusted IPv4 resolver for collection egress}
if ! awk 'BEGIN {
    if (split(ENVIRON["COLLECTION_DNS_IPV4"], octets, "[.]") != 4) exit 1
    for (i = 1; i <= 4; i++)
        if (octets[i] !~ /^(0|[1-9][0-9]?[0-9]?)$/ || octets[i] > 255) exit 1
    if (octets[1] == 0 || octets[1] == 127 || octets[1] >= 224) exit 1
}'; then
    echo 'COLLECTION_DNS_IPV4 must be a non-loopback unicast IPv4 address' >&2
    exit 1
fi
printf 'define trusted_resolver = %s\ninclude "/etc/collection-egress/firewall.nft"\n' "$resolver" |
  nft -f -
client_ip=$(ip -4 -o addr show dev clients0 | awk '{split($4, a, "/"); print a[1]}')
test -n "$client_ip"
printf 'http_port %s:3128\ndns_nameservers %s\ninclude /etc/collection-egress/squid.conf\n' \
  "$client_ip" "$resolver" >/tmp/squid.conf
exec setpriv --reuid=squid --regid=squid --clear-groups --bounding-set=-all \
  --inh-caps=-all --ambient-caps=-all --no-new-privs squid -N -f /tmp/squid.conf
