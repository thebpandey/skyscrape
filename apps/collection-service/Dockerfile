FROM ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d AS uv
FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PYTHON_DOWNLOADS=never \
    HOME=/tmp
WORKDIR /opt/collection
COPY --from=uv /uv /usr/local/bin/uv
COPY apps/collection-service/pyproject.toml apps/collection-service/uv.lock ./
RUN uv sync --frozen --no-dev
COPY apps/collection-service/collector ./collector
COPY apps/collection-service/LICENSE-Scrapling ./
COPY packages/contracts/src/collection/v1.schema.json ./
RUN groupadd --gid 10001 collector \
    && useradd --uid 10001 --gid collector --no-create-home collector \
    && install -d -o collector -g collector -m 0750 /run/collection /var/staging/collection
USER 10001:10001
ENTRYPOINT ["/opt/collection/.venv/bin/python", "-m", "collector.main"]
