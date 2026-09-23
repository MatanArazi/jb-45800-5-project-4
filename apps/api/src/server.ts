import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import amqp from "amqplib";
import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_platform" });
const queueName = "agent.inference.v2";
const deadLetterExchange = "agent.inference.dlx";
const deadLetterQueue = "agent.inference.failed";
const deadLetterRoutingKey = "agent.inference.failed";
const s3 = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:4566",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const bucket = process.env.S3_BUCKET ?? "agent-inputs";
const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => {
  void handler(request, response).catch(next);
};

async function configureQueue(channel: amqp.Channel) {
  await channel.assertExchange(deadLetterExchange, "direct", { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true });
  await channel.bindQueue(deadLetterQueue, deadLetterExchange, deadLetterRoutingKey);
  await channel.assertQueue(queueName, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": deadLetterExchange,
      "x-dead-letter-routing-key": deadLetterRoutingKey,
    },
  });
}

app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.get("/health", asyncRoute(async (_request, response) => {
  await pool.query("SELECT 1");
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  response.json({ status: "ok", service: "api" });
}));

app.get("/api/storage/health", asyncRoute(async (_request, response) => {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  response.json({ status: "ok", bucket });
}));

app.get("/api/jobs", asyncRoute(async (_request, response) => {
  const result = await pool.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50");
  response.json(result.rows);
}));

app.post("/api/jobs", asyncRoute(async (request, response) => {
  const id = randomUUID();
  const input = request.body?.input ?? {};
  const imageBase64 = request.body?.imageBase64;
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    response.status(400).json({ error: "imageBase64 is required" });
    return;
  }
  if (imageBase64.length > 20 * 1024 * 1024) {
    response.status(413).json({ error: "Image is too large" });
    return;
  }
  const imageName = path.basename(typeof request.body?.imageName === "string" ? request.body.imageName : `${id}.image`);
  const inputKey = imageBase64 ? `inputs/${id}/${imageName}` : null;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: inputKey!, Body: Buffer.from(imageBase64, "base64") }));
  await pool.query("INSERT INTO jobs (id, status, input_key, result) VALUES ($1, 'queued', $2, $3)", [id, inputKey, JSON.stringify({ input })]);
  const connection = await amqp.connect(process.env.RABBITMQ_URL ?? "amqp://agent:agent@localhost:5672/");
  const channel = await connection.createChannel();
  await configureQueue(channel);
  channel.sendToQueue(queueName, Buffer.from(JSON.stringify({ jobId: id, input, inputKey, imageName })), { persistent: true });
  await channel.close();
  await connection.close();
  response.status(202).json({ id, status: "queued" });
}));

app.get("/api/jobs/:id", asyncRoute(async (request, response) => {
  const result = await pool.query("SELECT * FROM jobs WHERE id = $1", [request.params.id]);
  if (result.rowCount === 0) {
    response.status(404).json({ error: "Job not found" });
    return;
  }
  response.json(result.rows[0]);
}));

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(503).json({ error: "Service unavailable" });
});

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));