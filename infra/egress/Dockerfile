FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache squid=7.6-r0 nftables=1.1.6-r1 setpriv=2.42.3-r1
COPY squid.conf firewall.nft /etc/collection-egress/
COPY --chmod=755 start.sh /usr/local/bin/start-egress
ENTRYPOINT ["/usr/local/bin/start-egress"]
