import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Prediction = { className: string; confidence: number };
type Job = { id: string; status: string; created_at: string; error?: string; result?: { filename?: string; predictions?: Prediction[] } };
const maxImageBytes = 10 * 1024 * 1024;
const scanLabels: Record<string, string> = {
  AbdomenCT: "Abdominal CT scan",
  BreastMRI: "Breast MRI scan",
  CXR: "Chest X-ray",
  ChestCT: "Chest CT scan",
  Hand: "Hand X-ray",
  HeadCT: "Head CT scan",
};
const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function App() {
  const [image, setImage] = useState<File | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!image) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(() => {
    if (!selectedJob || selectedJob.status === "completed" || selectedJob.status === "failed") return;
    const timer = window.setInterval(() => {
      fetch(`${apiUrl}/api/jobs/${selectedJob.id}`).then((response) => response.json()).then((job: Job) => {
        setSelectedJob(job);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedJob]);
  async function submitJob() {
    if (!image) return;
    setError("");
    setSubmitting(true);
    try {
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(image);
      });
      const response = await fetch(`${apiUrl}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageBase64, imageName: image.name }) });
      const body = await response.json() as Job & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The scan could not be submitted.");
      setSelectedJob(body);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "The scan could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }
  function selectImage(file: File | undefined) {
    setError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > maxImageBytes) {
      setError("Please choose an image smaller than 10 MB.");
      return;
    }
    setImage(file);
  }
  return <main>
    <header><span className="eyebrow"><span className="pulse" /> MEDICAL IMAGE CLASSIFIER</span><h1>What is this medical image?</h1><p>Upload a medical image and our trained agent will identify the scan type for you.</p><small className="disclaimer">AI-assisted scan classification only. This is not a medical diagnosis.</small></header>
    <section className="workspace">
      <div className="panel"><div className="panel-heading"><h2>Image input</h2><span className="status-dot">READY</span></div><label className="upload"><input type="file" accept="image/*" onChange={(event) => selectImage(event.target.files?.[0])} />{image ? image.name : "Choose a medical image"}</label>{previewUrl && <img className="preview" src={previewUrl} alt="Selected medical scan" />}<button disabled={!image || submitting} onClick={() => void submitJob()}>{submitting ? "Uploading..." : "Analyze image"}</button>{error && <p className="error" role="alert">{error}</p>}</div>
      <div className="panel result-panel"><div className="panel-heading"><h2>Classification result</h2>{selectedJob && <span className={`badge ${selectedJob.status}`}>{selectedJob.status}</span>}</div>{selectedJob?.result?.predictions ? <><div className="prediction"><span>{scanLabels[selectedJob.result.predictions[0].className] ?? selectedJob.result.predictions[0].className}</span><strong>{(selectedJob.result.predictions[0].confidence * 100).toFixed(1)}%</strong></div><div className="confidence-bar"><span style={{ width: `${selectedJob.result.predictions[0].confidence * 100}%` }} /></div><ul className="alternatives">{selectedJob.result.predictions.map((prediction) => <li key={prediction.className}><span>{scanLabels[prediction.className] ?? prediction.className}</span><span>{(prediction.confidence * 100).toFixed(2)}%</span></li>)}</ul></> : <p className="empty">{selectedJob?.status === "queued" || selectedJob?.status === "running" ? "Reviewing scan..." : selectedJob?.error ?? "Classification will appear here."}</p>}</div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);