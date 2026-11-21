# Collection engine qualification

The collector supports structured retrieval and HTML extraction with Scrapling on assessed sources. A disposable local deployment verified these modes with synthetic permit records and markup. Live qualification, browser isolation, and production quality measurements remain open. [Source assessments](source-assessment.md)

## Pinned runtime

| Component | Pin and role |
| --- | --- |
| CPython | `3.13.18`. Debian slim container base pinned by image digest. |
| uv | `0.13.9`. The service lock pins the resolved Python dependencies and distribution hashes. |
| Scrapling | `0.5.1`, BSD-3-Clause. Upstream publishing commit `3a4bb5b0a008233c85269a0a38a6d08edd4ce329`. Wheel SHA-256 `c9eb0ef22a05e00e19827a179544fea2bc91b663585f637d428453d3b00ceb17`. [Upstream wheel and provenance](https://pypi.org/project/scrapling/0.5.1/#files) |
| curl-cffi | `0.16.3`. The ordinary HTTP transport for HTML mode. The Linux x86-64 wheel SHA-256 is `a875a661e2f9a949be29454880bbb9553307a487c4c08819738298cf5c1622e2`. [Upstream release](https://pypi.org/project/curl-cffi/0.16.3/#files) |
| HTTPX | `0.28.1`. Streams native structured responses with the same proxy, redirect, and budget policy. |
| Service | FastAPI `0.165.0`, Pydantic `2.14.4`, jsonschema `4.26.0`, Uvicorn `0.54.0`. Pydantic parses bounded JSON and jsonschema validates the shared v1 contract. |

The BSD notice is included in the image. The locked wheels retain their distribution license notices. No Scrapling source was changed. [Dependency lock](../apps/collection-service/uv.lock)

## Representative synthetic checks

| Case | Expected | Observed |
| --- | --- | --- |
| Native structured permit feed | Project the requested permit number and stage evidence | `SYNTHETIC-123` matched. The consumer verified the artifact checksum and size on its read-only mount. |
| HTML fetch and extraction over TLS | Read a declarative selector and use one request | `#permit-label` returned `Synthetic public label` in one request through Squid. |
| Oversized synthetic HTML body | Stop at the byte cap without retry or evidence | The attempt reported `BUDGET_EXCEEDED`, eight counted bytes, one request, and empty evidence. |
| Qualified publisher redirects outside the task source | Deny before a second connection | The attempt reported `POLICY_BLOCKED` after one request. |
| Approved name resolves to an internal test address | Proxy blocks the packet destination | The attempt failed without evidence. The internal publisher canary received no request. The collector also failed direct connections to the origin addresses. |
| HTTP 200 verification page or moved selector | Classify the page or recipe drift and avoid staging | The local fixtures produced `CHALLENGE_REQUIRED` or `SOURCE_CHANGED`, with zero staged evidence. |
| Quota depletion, repeated submission, and cancellation | Charge each attempted request once and cancel active I/O | Zero quota prevented an upstream request. Duplicate submissions performed one retrieval. Cancellation stopped active I/O and permitted a new attempt ID. |
| Municipal projection and publisher delay | Use approved recipe fields on every hop and honor `Retry-After` across attempts | The Seattle redirect used the original approved projection. Extra response fields were rejected before staging. A slow-body HTML 503 sent headers before cancellation. The queued task expired with zero requests. |
| Partial field extraction | Preserve valid matches and keep overlength originals in private evidence | A unique match survived missing and ambiguous selectors in a partial result with `SOURCE_CHANGED`. An overlength original produced `PARTIAL_CONTENT` and survived intact in the staged artifact. |

The positive structured and HTML cases matched the two expected synthetic field values. The assessed sites were represented by local DNS and TLS fixtures. No live page volume, accuracy, latency, or memory performance result was measured. Adaptive selector recovery stays disabled. A missing selector produces a source-change result for review. The Census file body and field layout require a separate live qualification before campaign use.

## Supported HTTP integration

The pinned Scrapling `AsyncFetcher.get` and `FetcherSession` expose request options and body callbacks. The released wrapper creates its own curl-cffi session without a public option for the incoming-header callback. In the pinned curl-cffi release, streaming returns response headers once the first body chunk arrives or the transfer ends. The synthetic 503 fixture reproduced the resulting loss of `Retry-After` when task cancellation preceded the body.

The collector uses the pinned curl-cffi `AsyncSession` for HTML transport and the unmodified pinned Scrapling `Selector` for HTML extraction. The session's incoming-header callback records `Retry-After` before body transfer and emits no trace output. The existing curl-cffi body callback enforces the byte limit. The session uses the configured proxy and TLS trust, a fixed collector user agent, and HTTP/1.1 or HTTP/2 over TLS. Impersonation, automatic redirects and retries stay disabled. The collector validates redirects and counts each request. [Pinned Scrapling release](https://pypi.org/project/scrapling/0.5.1/) [curl-cffi requests documentation](https://curl-cffi.readthedocs.io/en/latest/requests.html)

## Browser mode remains pending

The pinned Scrapling wheel's browser exports are `StealthyFetcher`, `StealthySession`, `AsyncStealthySession`, and CDP remote sessions that inherit the stealth session implementation. The local implementation uses Patchright and adds its stealth browser arguments. The supported `page_setup` hook runs before navigation, and the released implementation catches its exceptions and continues to navigation. Enforce network policy independently of that hook. The owner approved ordinary Playwright transport for Chromium on 2026-11-21, with unmodified pinned Scrapling retained for extraction. Playwright exposes explicit Chromium sandbox and proxy options. This collector image reports structured and HTML modes. Browser support requires separate sandbox and isolation qualification under `sky-browser`. [Scrapling 0.5.1 release](https://pypi.org/project/scrapling/0.5.1/) [Playwright launch options](https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch)

A local prototype used Playwright Python `1.65.2` with Chromium Headless Shell `159.0.8154.6` revision `1255`. Chromium was tested as UID 10001 with zero added capabilities, no-new-privileges, private networking, and Playwright's supplied Docker seccomp profile from `v1.65.1`. The ordinary headless shell and full Chromium both exited in the zygote namespace sandbox before navigation. Basic combined user, network, and PID namespace creation succeeded under the same container policy. The host had AppArmor enforcement and unprivileged namespace restrictions enabled. The precise kernel or LSM denial was not established. [Playwright Docker guidance](https://playwright.dev/python/docs/docker) [Chromium sandbox design](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md)

For browser qualification, use a private Linux host that permits Chromium's complete unprivileged namespace sandbox under a reviewed container seccomp and AppArmor policy. Verify sandboxed launch there before running the browser internal-canary, redirect, and transport checks. Protected logins, human verification, and external providers remain unavailable in this service. [Ubuntu AppArmor guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
