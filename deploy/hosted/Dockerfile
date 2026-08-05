# Hosted remote MCP server (Phase 1, ticket #33 / epic #31).
#
# Container-image Lambda so the local-image toolchain works hosted: the design tools shell
# out to python3 + Pillow for transparency keying and quality stats (python/*.py). The zip
# prototype ran the same handler without python and those tools degraded with a structured
# notice; this image closes that gap.
#
# OCR runs on the WASM engine here rather than the native binary: tesseract is not in the
# Amazon Linux 2023 repos and EPEL is unsupported there, so `dnf install tesseract` cannot
# work (amazonlinux/amazon-linux-2023#959). Without it verify_design_text answered "unknown"
# for every design on this server, leaving an agent no way to spell-check its own work.
FROM public.ecr.aws/lambda/nodejs:22

# Pillow comes from the distro repo, NOT pip: the Lambda base image's python3 ships without
# a working ssl module, so pip cannot reach PyPI inside the build (observed in CI run 28713648215).
RUN dnf install -y python3 python3-pillow \
    && dnf clean all

# tesseract.js is a devDependency of the package, deliberately: it carries tens of megabytes
# of WASM, and npx users can install the faster native binary instead, so shipping it to every
# npm consumer would be a poor trade. The hosted image is the one place that cannot use the
# native binary, so it installs the runtime copy here. Keep this version in step with the
# devDependency — test/hosted-image.test.ts fails if they drift.
RUN npm install --no-save --no-audit --no-fund --prefix ${LAMBDA_TASK_ROOT} tesseract.js@^7.0.0

# The bundled handler sits two directories deep so the imaging module's relative
# ../../python/*.py and ../../tessdata resolution lands on ${LAMBDA_TASK_ROOT}/... (mirrors
# the repo layout).
COPY deploy/hosted/build/handler.mjs ${LAMBDA_TASK_ROOT}/dist/http/handler.mjs
COPY python/ ${LAMBDA_TASK_ROOT}/python/

# Bundled language data. Without it tesseract.js fetches the model from a CDN on first use —
# a cold-start network round trip that can simply fail, putting OCR back into exactly the
# "unavailable" state this image is being changed to fix.
COPY tessdata/ ${LAMBDA_TASK_ROOT}/tessdata/

CMD ["dist/http/handler.handler"]
