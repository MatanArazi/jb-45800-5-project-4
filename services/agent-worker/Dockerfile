FROM python:3.14-slim

WORKDIR /app

COPY services/agent-worker/requirements.txt /app/services/agent-worker/requirements.txt
RUN grep -vE '^(torch|torchvision)' /app/services/agent-worker/requirements.txt > /tmp/requirements-runtime.txt \
	&& pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
	&& pip install --no-cache-dir -r /tmp/requirements-runtime.txt

COPY services/agent-worker/worker.py /app/services/agent-worker/worker.py

WORKDIR /app/services/agent-worker
CMD ["python", "-m", "worker"]