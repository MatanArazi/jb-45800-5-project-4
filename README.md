# Medical Image Classifier

A local full-stack application that accepts a medical image, sends it through a queue to a PyTorch inference worker, and returns the predicted scan type and confidence to a React browser interface.

## Architecture

```text
                         +-------------------+
                         | React / Vite      |
                         | localhost:5173    |
                         +---------+---------+
                                   |
                                   v
                         +-------------------+
                         | Express API       |
                         | localhost:3000    |
                         +--+------+------+--+
                            |      |      |
                            |      |      +------------------+
                            |      |                         |
                            v      v                         v
                     PostgreSQL  LocalStack/S3       RabbitMQ queue
                     localhost   localhost:4566              |
                                                            v
                                                   Python/Torch worker
                                                            |
                                                            v
                                                        PostgreSQL
```

### Request flow

1. A user selects a medical image in the React interface.
2. The browser sends the image as base64 JSON to Express.
3. Express stores the original image in the LocalStack S3 bucket `agent-inputs`.
4. Express creates a `queued` job in PostgreSQL and publishes an inference message to RabbitMQ.
5. The Python worker consumes the message, loads the trained checkpoint, and runs inference on CPU.
6. The worker writes the top predictions and job status back to PostgreSQL.
7. The browser polls the job until it displays the classification result.

## Technology

- **Frontend:** React 18, TypeScript, Vite
- **Backend:** Node.js, Express, TypeScript
- **Object storage:** LocalStack S3-compatible storage
- **Message queue:** RabbitMQ
- **Database:** PostgreSQL 16
- **Inference:** Python, PyTorch, torchvision, Pillow
- **Model:** ResNet-18 checkpoint trained by the companion mission project
- **Package managers:** npm for JavaScript, pip/venv for Python
- **Infrastructure:** Docker Compose

## Repository structure

```text
apps/
  api/
    src/server.ts          Express API, PostgreSQL, S3, and RabbitMQ integration
    package.json
  web/
    src/main.tsx           React upload and result workflow
    src/styles.css         Application styling
services/
  agent-worker/
    worker.py              RabbitMQ consumer and PyTorch inference pipeline
    requirements.txt
infra/
  postgres/init.sql        Jobs table and index
  localstack/init-s3.sh    Creates the agent-inputs bucket
models/
  .gitkeep                 Model directory placeholder; model binaries are ignored
docker-compose.yml          PostgreSQL, RabbitMQ, and LocalStack services
.env.example                Local configuration template
package.json                npm workspaces and development scripts
```

## Prerequisites

- Docker Engine and Docker Compose
- Node.js 20 or newer
- npm
- Python 3.11 or newer
- Enough disk space for PyTorch and its runtime dependencies
- The trained checkpoint included at `models/medical_scan_classifier.pt`

Python 3.14 is supported by the current dependency ranges. The first installation can download a large PyTorch runtime.

## Configuration

Copy the example configuration if you want to customize values:

```bash
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://agent:agent@localhost:5432/agent_platform` | API and worker database connection |
| `RABBITMQ_URL` | `amqp://agent:agent@localhost:5672/` | Queue connection |
| `S3_ENDPOINT` | `http://localhost:4566` | LocalStack endpoint |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_BUCKET` | `agent-inputs` | Uploaded image bucket |
| `MODEL_PATH` | `models/medical_scan_classifier.pt` | Trained model checkpoint |
| `VITE_API_URL` | `http://localhost:3000` | API URL used by the browser |

The trained model is included in this repository. Set `MODEL_PATH` to another absolute or project-relative checkpoint location only when replacing it.

## Run the project

### 1. Start the complete application stack

```bash
docker compose up -d --build
docker compose ps
```

This is the recommended cross-platform workflow. Docker Desktop on Windows and macOS, or Docker Engine on Linux, runs the frontend, API, Python worker, PostgreSQL, RabbitMQ, and LocalStack together.

The application job lifecycle is:

```text
queued -> running -> completed
                  -> failed -> agent.inference.failed
```

The first worker image build can be large. The Docker worker uses CPU-only PyTorch wheels and does not need CUDA or a GPU.

The services use these ports:

- PostgreSQL: `5432`
- RabbitMQ AMQP: `5672`
- RabbitMQ management UI: `15672`
- LocalStack: `4566`
- Express API: `3000`
- React web app: `5173`

### 2. Optional host-side development dependencies

```bash
npm install
```

The Docker workflow does not require Node.js, npm, Python, or a host Python virtual environment. The following setup is only for developing services outside Docker.

### 3. Optional Python worker development environment

```bash
python3 -m venv services/agent-worker/.venv
services/agent-worker/.venv/bin/pip install -r services/agent-worker/requirements.txt
```

The Compose setup already runs the worker in its own Python container. The virtual environment is only needed when developing or debugging the worker directly on the host.

### 4. Host-side development mode

```bash
npm run dev
```

This starts the API and React processes from the host. It does not start the Docker worker:

- React/Vite: `http://localhost:5173`
- Express API: `http://localhost:3000`
- Python inference worker: start it separately with `services/agent-worker/.venv/bin/python -m worker`

Open `http://localhost:5173` in a browser, select a scan, and click **Analyze image**.

## Useful npm commands

```bash
npm run typecheck       # Type-check API and web workspaces
npm run build           # Build API and frontend
npm run dev             # Start API and frontend for host-side development
```

## API

### Health checks

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/storage/health
```

`/health` checks PostgreSQL and S3. `/api/storage/health` checks the S3 bucket directly. A `503` response means one of the local infrastructure services is unavailable.

### Create an inference job

The API accepts an image as base64 JSON. The browser performs this conversion automatically.

```json
POST /api/jobs
Content-Type: application/json

{
  "imageBase64": "...",
  "imageName": "scan.png"
}
```

Successful response:

```json
{
  "id": "job-uuid",
  "status": "queued"
}
```

The image is stored in S3 under `inputs/<job-id>/<filename>`. RabbitMQ receives only a small message containing the job ID and S3 key:

```json
{
  "jobId": "job-uuid",
  "inputKey": "inputs/job-uuid/scan.png",
  "imageName": "scan.png"
}
```

### Read a job

```bash
curl http://localhost:3000/api/jobs/<job-id>
```

Completed jobs contain predictions similar to:

```json
{
  "status": "completed",
  "result": {
    "filename": "scan.png",
    "predictions": [
      { "className": "Hand", "label": "Hand X-ray", "confidence": 0.9974 },
      { "className": "ChestCT", "label": "Chest CT scan", "confidence": 0.0022 }
    ]
  }
}
```

## Model contract

The supplied checkpoint is a regular PyTorch checkpoint, not a TorchScript module. The worker rebuilds the model using the metadata stored in the checkpoint:

- Architecture: ResNet-18
- Input: one grayscale medical image converted to 3 RGB channels
- Input tensor: `(1, 3, 128, 128)` for the supplied checkpoint
- Normalization: ImageNet mean and standard deviation
- Output classes: `AbdomenCT`, `BreastMRI`, `CXR`, `ChestCT`, `Hand`, `HeadCT`
- Output: top three classes with confidence values

The browser presents those internal classes as human-readable labels such as `Hand X-ray` and `Chest CT scan`.

RabbitMQ carries only the PostgreSQL job ID and S3 input key. The queue is durable and failed messages are routed to `agent.inference.failed` through a dead-letter exchange. Completed jobs include prediction data, model metadata, attempt count, and inference duration.

## Troubleshooting

### API returns `503 Service unavailable`

Check the infrastructure:

```bash
docker compose ps
docker compose logs postgres rabbitmq localstack
```

If the API starts without a `.env`, it uses the local defaults shown above.

### Jobs stay queued

Make sure the Python environment exists and the combined development command was used:

```bash
services/agent-worker/.venv/bin/python -m worker
```

Run it from `services/agent-worker` only for host-side worker development. In the normal setup, inspect it with `docker compose logs -f worker`.

### Model not found

Set the checkpoint explicitly:

```bash
export MODEL_PATH=/absolute/path/to/medical_scan_classifier.pt
npm run dev
```

When the model file changes, reload it without rebuilding the Docker image:

```bash
docker compose up -d --force-recreate worker
docker compose logs --tail=30 worker
```

The worker reads the model from the mounted `models/` directory at startup.

### Inspect queue backlog or failed jobs

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
docker compose logs -f worker
```

The active queue is `agent.inference.v2`. Failed messages are routed to `agent.inference.failed`.

If the queue has messages but `consumers` is `0`, recreate the worker:

```bash
docker compose up -d --force-recreate worker
```

### Reset local data

This removes PostgreSQL and LocalStack data volumes:

```bash
docker compose down -v
docker compose up -d postgres rabbitmq localstack
```

## Verification

The project has been verified with:

```bash
npm run typecheck
npm run build
services/agent-worker/.venv/bin/python -m unittest discover -s services/agent-worker -p 'test_*.py'
python3 -m py_compile services/agent-worker/worker.py
docker compose config
```

An end-to-end sample image was also processed successfully through S3, RabbitMQ, the PyTorch worker, and PostgreSQL.
