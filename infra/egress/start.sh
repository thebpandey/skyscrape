#!/bin/sh
set -eu
nft -f /etc/collection-egress/firewall.nft
client_ip=$(ip -4 -o addr show dev clients0 | awk '{split($4, a, "/"); print a[1]}')
test -n "$client_ip"
printf 'http_port %s:3128\ninclude /etc/collection-egress/squid.conf\n' "$client_ip" >/tmp/squid.conf
exec setpriv --reuid=squid --regid=squid --clear-groups --bounding-set=-all \
  --inh-caps=-all --ambient-caps=-all --no-new-privs squid -N -f /tmp/squid.conf
