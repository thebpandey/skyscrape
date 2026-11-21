# Collector egress

Only `collection-egress` joins both networks. The client bridge `collection_private` is internal and has no host gateway address. Squid listens on its client-side IPv4 address on port 3128. The `collection_outbound` bridge supplies its internet route. The proxy publishes no host port. Network names are scoped to the Compose project.

From the repository root, start the proxy with Docker Engine 28 or later and Compose 2.36 or later.

```sh
docker compose --project-directory . -f infra/compose/collection-network.yaml up --build -d collection-egress
```

For a combined deployment, pass `-f compose.yaml` before the network fragment and the collector service file after it. Use the same project name for all three. Keep the database, API and LLM gateway off both collection networks.

## Attach a collector

Apply these settings to the collector service. Leave its Docker socket, host mounts, DB and gateway credentials out of the container.

```yaml
networks: [collection_private]
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
dns: [127.0.0.1]
dns_search: ["."]
environment:
  HTTP_PROXY: http://collection-egress:3128
  HTTPS_PROXY: http://collection-egress:3128
  http_proxy: http://collection-egress:3128
  https_proxy: http://collection-egress:3128
  NO_PROXY: ""
  no_proxy: ""
```

Docker DNS resolves the proxy service name on the private network. The loopback DNS setting prevents forwarding collector queries to an external resolver. Set the browser's proxy server explicitly to `http://collection-egress:3128`, use `--proxy-bypass-list=<-loopback>` and `--disable-quic`, and disable alternate proxies and direct retries. Use authenticated local IPC for control-plane integration if it would otherwise require a second collector network.

## Destination policy

Squid checks each CONNECT authority against the allowlist and accepts only TCP port 443. The kernel checks the actual IPv4 destination on outbound packets, including packets sent after a DNS change. It rejects special-use, private and metadata addresses. The firewall allows outbound IPv4 connections to TCP 443 and queries to Docker's embedded DNS. Squid runs without capabilities after startup installs the namespace-local firewall. [Source assessment](../../docs/source-assessment.md)

If the deployment routes any globally assigned IP addresses to host services or internal networks, deny access to those addresses from `collection_outbound` in the host firewall.

The tunnel passes bytes through. The collector must verify TLS certificates, reject URL credentials, check each redirect against the task policy, and apply source, path and budget rules to browser subrequests. WP03 must exercise those settings with its browser and an internal canary.

## Check the boundary

Run `bash infra/egress/check.sh` from the repository root. It creates two isolated bridges, a client and a fixture origin. A forwarding address exists only in the test containers. The check exercises the real proxy and firewall. It contacts no publisher. To run offline with warm images, set `EGRESS_CHECK_IMAGE` to a previously built proxy image and retain the pinned Alpine base locally.

For an opt-in publisher check, run this single HEAD from a collector attached to the production-shaped network.

```sh
curl -q --noproxy '' --proxy http://collection-egress:3128 --head --max-time 15 \
  https://www2.census.gov/econ/bps/County/co2025a.txt
```
