# CAD orthophoto export worker. Not the NodeODM image: ClusterODM runs that
# image only as the UI reference node, which starts this job. The container
# streams the source GeoTIFF via GDAL /vsigs so a multi-gigabyte object is
# not copied onto the container disk.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CPL_MACHINE_IS_GCE=YES \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    GDAL_HTTP_MULTIPLEX=YES \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=268435456 \
    GDAL_CACHEMAX=512

WORKDIR /app

# The rasterio wheel bundles GDAL but links libexpat from the OS, and the
# slim image does not ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-job.txt .
RUN pip install --no-cache-dir -r requirements-job.txt

COPY gcs_export.py .
COPY ortho_downsizer ./ortho_downsizer

RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

ENTRYPOINT ["python", "gcs_export.py"]
