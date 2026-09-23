import base64
import io
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3
import pika
import psycopg
import torch
from dotenv import load_dotenv
from PIL import Image
from torch import nn
from torchvision import models, transforms

load_dotenv()
QUEUE = "agent.inference.v2"
DEAD_LETTER_EXCHANGE = "agent.inference.dlx"
DEAD_LETTER_QUEUE = "agent.inference.failed"
DEAD_LETTER_ROUTING_KEY = "agent.inference.failed"
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://agent:agent@localhost:5432/agent_platform")
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://localhost:4566")
S3_REGION = os.getenv("S3_REGION", "us-east-1")
S3_BUCKET = os.getenv("S3_BUCKET", "agent-inputs")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
configured_model_path = Path(os.getenv("MODEL_PATH", "models/medical_scan_classifier.pt"))
MODEL_PATH = str(configured_model_path if configured_model_path.is_absolute() else PROJECT_ROOT / configured_model_path)
SCAN_LABELS = {
    "AbdomenCT": "Abdominal CT scan",
    "BreastMRI": "Breast MRI scan",
    "CXR": "Chest X-ray",
    "ChestCT": "Chest CT scan",
    "Hand": "Hand X-ray",
    "HeadCT": "Head CT scan",
}


def load_agent():
    checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict) or "model_state_dict" not in checkpoint or "class_names" not in checkpoint:
        raise RuntimeError("Checkpoint must contain model_state_dict and class_names")
    if checkpoint.get("architecture", "resnet18") != "resnet18":
        raise ValueError(f"Unsupported architecture: {checkpoint.get('architecture')}")
    class_names = list(checkpoint["class_names"])
    model = models.resnet18(weights=None)
    model.fc = nn.Linear(model.fc.in_features, len(class_names))
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    image_size = int(checkpoint.get("image_size", 224))
    transform = transforms.Compose([
        transforms.Grayscale(num_output_channels=3),
        transforms.Resize(int(image_size * 256 / 224)),
        transforms.CenterCrop(image_size),
        transforms.ToTensor(),
        transforms.Normalize(checkpoint.get("mean", [0.485, 0.456, 0.406]), checkpoint.get("std", [0.229, 0.224, 0.225])),
    ])
    metadata = {
        "architecture": checkpoint.get("architecture", "resnet18"),
        "accuracy": checkpoint.get("best_val_accuracy"),
    }
    print(f"Loaded {MODEL_PATH}: {class_names}")
    return model, transform, class_names, metadata


def predict(image_bytes, agent):
    model, transform, class_names, _metadata = agent
    with Image.open(io.BytesIO(image_bytes)) as image:
        tensor = transform(image.convert("RGB")).unsqueeze(0)
    with torch.inference_mode():
        probabilities = torch.softmax(model(tensor), dim=1)[0]
    count = min(3, len(class_names))
    confidences, indices = torch.topk(probabilities, k=count)
    return [{"className": class_names[int(index)], "label": SCAN_LABELS.get(class_names[int(index)], class_names[int(index)]), "confidence": float(confidence)} for confidence, index in zip(confidences, indices)]


def ensure_schema() -> None:
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0")
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model_arch TEXT")
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model_accuracy DOUBLE PRECISION")
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inference_ms INTEGER")
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ")
        connection.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ")


def mark_failed(job_id: uuid.UUID, error: Exception, duration_ms: int) -> None:
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("UPDATE jobs SET status = 'failed', error = %s, inference_ms = %s, updated_at = %s WHERE id = %s", (str(error), duration_ms, datetime.now(timezone.utc), job_id))


def process_job(message: bytes, agent, s3_client) -> None:
    payload = json.loads(message)
    job_id = uuid.UUID(payload["jobId"])
    started = time.perf_counter()
    try:
        with psycopg.connect(DATABASE_URL) as connection:
            status = connection.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
            if status is None or status[0] == "completed":
                return
            connection.execute("UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = %s, updated_at = %s WHERE id = %s", (datetime.now(timezone.utc), datetime.now(timezone.utc), job_id))
        if not payload.get("inputKey"):
            raise ValueError("inputKey is required for medical scan classification")
        image_bytes = s3_client.get_object(Bucket=S3_BUCKET, Key=payload["inputKey"])["Body"].read()
        predictions = predict(image_bytes, agent)
        duration_ms = int((time.perf_counter() - started) * 1000)
        metadata = agent[3]
        result = {"predictions": predictions, "filename": payload.get("imageName")}
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE jobs SET status = 'completed', result = %s, model_arch = %s, model_accuracy = %s, inference_ms = %s, completed_at = %s, updated_at = %s WHERE id = %s AND status <> 'completed'", (json.dumps(result), metadata["architecture"], metadata["accuracy"], duration_ms, datetime.now(timezone.utc), datetime.now(timezone.utc), job_id))
    except Exception as error:
        duration_ms = int((time.perf_counter() - started) * 1000)
        mark_failed(job_id, error, duration_ms)
        raise


def configure_queue(channel):
    channel.exchange_declare(exchange=DEAD_LETTER_EXCHANGE, exchange_type="direct", durable=True)
    channel.queue_declare(queue=DEAD_LETTER_QUEUE, durable=True)
    channel.queue_bind(queue=DEAD_LETTER_QUEUE, exchange=DEAD_LETTER_EXCHANGE, routing_key=DEAD_LETTER_ROUTING_KEY)
    channel.queue_declare(queue=QUEUE, durable=True, arguments={"x-dead-letter-exchange": DEAD_LETTER_EXCHANGE, "x-dead-letter-routing-key": DEAD_LETTER_ROUTING_KEY})


def main() -> None:
    ensure_schema()
    agent = load_agent()
    s3_client = boto3.client("s3", endpoint_url=S3_ENDPOINT, region_name=S3_REGION, aws_access_key_id="test", aws_secret_access_key="test")
    while True:
        try:
            connection_parameters = pika.URLParameters(os.getenv("RABBITMQ_URL", "amqp://agent:agent@localhost:5672/"))
            connection_parameters.heartbeat = 60
            connection_parameters.blocked_connection_timeout = 120
            connection = pika.BlockingConnection(connection_parameters)
            channel = connection.channel()
            configure_queue(channel)
            channel.basic_qos(prefetch_count=1)

            def callback(ch, method, _properties, body):
                try:
                    process_job(body, agent, s3_client)
                    ch.basic_ack(method.delivery_tag)
                except Exception as error:
                    print(f"Job failed and moved to dead-letter queue: {error}")
                    ch.basic_nack(method.delivery_tag, requeue=False)

            channel.basic_consume(queue=QUEUE, on_message_callback=callback)
            print("Agent worker listening")
            channel.start_consuming()
        except Exception as error:
            print(f"Worker connection lost: {error}; reconnecting")
            time.sleep(5)


if __name__ == "__main__":
    main()