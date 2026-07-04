# Hosted remote MCP server (Phase 1, ticket #33 / epic #31).
#
# Container-image Lambda so the local-image toolchain works hosted: the design tools shell
# out to python3 + Pillow for transparency keying and quality stats (python/*.py). The zip
# prototype ran the same handler without python and those tools degraded with a structured
# notice; this image closes that gap.
#
# OCR (tesseract) is intentionally absent for now: it is not packaged in the base distro's
# repos, and verify_design_text already degrades gracefully to "ocr unavailable". Revisit if
# hosted OCR proves worth the image weight.
FROM public.ecr.aws/lambda/nodejs:22

RUN dnf install -y python3 python3-pip \
    && pip3 install --no-cache-dir Pillow \
    && dnf clean all

# The bundled handler sits two directories deep so the imaging module's relative
# ../../python/*.py resolution lands on ${LAMBDA_TASK_ROOT}/python (mirrors the repo layout).
COPY deploy/hosted/build/handler.mjs ${LAMBDA_TASK_ROOT}/dist/http/handler.mjs
COPY python/ ${LAMBDA_TASK_ROOT}/python/

CMD ["dist/http/handler.handler"]
