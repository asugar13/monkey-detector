import React from "react";
import { useState, useRef, useCallback, useEffect } from "react";

const API_KEY = "97dGvv5O6FYPYEZuHBWN";
const MODEL_ENDPOINT = "https://detect.roboflow.com/monkey-species-i9zg3/1";

const COLORS = {
  monkey: { box: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" },
  human: { box: "#3b82f6", bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)" },
};

const getColor = (cls) => COLORS[cls?.toLowerCase()] || { box: "#888", bg: "rgba(136,136,136,0.12)", border: "rgba(136,136,136,0.3)" };

export default function App() {
  const [mode, setMode] = useState("upload");
  const [detections, setDetections] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [liveRunning, setLiveRunning] = useState(false);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState(null);
  const [hasResult, setHasResult] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const liveLoopRef = useRef(null);
  const lastFrameTime = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
      stopLiveDetection();
    };
  }, []);

  // --- API Call ---
  const detectImage = useCallback(async (base64Data) => {
    const resp = await fetch(
      `${MODEL_ENDPOINT}?api_key=${API_KEY}&confidence=30&overlap=40`,
      {
        method: "POST",
        body: base64Data,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();
    return data.predictions || [];
  }, []);

  // --- Draw boxes on canvas ---
  const drawDetections = useCallback((canvas, img, preds) => {
    const ctx = canvas.getContext("2d");
    canvas.width = img.width || img.videoWidth;
    canvas.height = img.height || img.videoHeight;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    preds.forEach((pred) => {
      const cls = pred.class?.toLowerCase();
      const color = getColor(cls);
      const x = pred.x - pred.width / 2;
      const y = pred.y - pred.height / 2;
      const lw = Math.max(2, canvas.width * 0.003);

      // Box
      ctx.strokeStyle = color.box;
      ctx.lineWidth = lw;
      ctx.strokeRect(x, y, pred.width, pred.height);

      // Semi-transparent fill
      ctx.fillStyle = color.box + "18";
      ctx.fillRect(x, y, pred.width, pred.height);

      // Label
      const label = `${pred.class} ${Math.round(pred.confidence * 100)}%`;
      const fontSize = Math.max(14, canvas.width * 0.022);
      ctx.font = `600 ${fontSize}px "DM Sans", sans-serif`;
      const textW = ctx.measureText(label).width;
      const pad = fontSize * 0.35;

      ctx.fillStyle = color.box;
      const labelH = fontSize + pad * 2;
      const labelY = y > labelH + 4 ? y - labelH : y;
      ctx.beginPath();
      ctx.roundRect(x, labelY, textW + pad * 2, labelH, 4);
      ctx.fill();

      ctx.fillStyle = cls === "monkey" ? "#000" : "#fff";
      ctx.fillText(label, x + pad, labelY + fontSize + pad * 0.4);
    });
  }, []);

  // --- Upload handler ---
  const handleFile = useCallback(
    async (file) => {
      if (!file?.type.startsWith("image/")) return;
      setError(null);
      setIsLoading(true);
      setHasResult(true);

      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(file);
      });

      const img = new Image();
      img.onload = async () => {
        try {
          const base64 = dataUrl.split(",")[1];
          const preds = await detectImage(base64);
          drawDetections(canvasRef.current, img, preds);
          setDetections(preds);
        } catch (err) {
          setError(err.message);
          setDetections([]);
        }
        setIsLoading(false);
      };
      img.src = dataUrl;
    },
    [detectImage, drawDetections]
  );

  // --- Camera ---
  const startCamera = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
      setCameraActive(true);
      setError(null);
    } catch {
      setError("Camera access denied or unavailable.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopLiveDetection();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setDetections([]);
    setHasResult(false);
  }, []);

  // --- Live video detection loop ---
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const offscreen = document.createElement("canvas");
    offscreen.width = video.videoWidth;
    offscreen.height = video.videoHeight;
    offscreen.getContext("2d").drawImage(video, 0, 0);
    return offscreen.toDataURL("image/jpeg", 0.7).split(",")[1];
  }, []);

  const startLiveDetection = useCallback(() => {
    setLiveRunning(true);
    setHasResult(true);
    let running = true;

    const loop = async () => {
      if (!running) return;
      const frame = captureFrame();
      if (!frame) {
        liveLoopRef.current = requestAnimationFrame(loop);
        return;
      }

      const start = performance.now();
      try {
        const preds = await detectImage(frame);
        if (!running) return;
        drawDetections(canvasRef.current, videoRef.current, preds);
        setDetections(preds);
        const elapsed = performance.now() - start;
        setFps(Math.round(1000 / elapsed));
      } catch {
        if (!running) return;
        // on error, just keep trying
      }

      if (running) {
        // Small delay to avoid hammering the API
        setTimeout(() => {
          if (running) liveLoopRef.current = requestAnimationFrame(loop);
        }, 100);
      }
    };

    liveLoopRef.current = { stop: () => { running = false; } };
    loop();
  }, [captureFrame, detectImage, drawDetections]);

  const stopLiveDetection = useCallback(() => {
    liveLoopRef.current?.stop?.();
    liveLoopRef.current = null;
    setLiveRunning(false);
    setFps(0);
  }, []);

  // --- Drag and drop ---
  const [dragOver, setDragOver] = useState(false);

  const styles = {
    app: {
      minHeight: "100vh",
      background: "#0a0a0a",
      fontFamily: '"DM Sans", system-ui, sans-serif',
      color: "#e8e8e8",
    },
    container: { maxWidth: 920, margin: "0 auto", padding: "40px 20px" },

    // Header
    badge: {
      display: "inline-flex", alignItems: "center", gap: 6,
      fontFamily: '"Courier New", monospace', fontSize: 11,
      textTransform: "uppercase", letterSpacing: 2, color: "#888",
      background: "#141414", border: "1px solid #2a2a2a",
      padding: "6px 14px", borderRadius: 100, marginBottom: 20,
    },
    dot: {
      width: 6, height: 6, background: "#22c55e", borderRadius: "50%",
      animation: "pulse 2s ease infinite",
    },
    title: {
      fontSize: "clamp(32px, 6vw, 52px)", fontWeight: 700,
      letterSpacing: -1.5, lineHeight: 1.1, marginBottom: 12,
    },
    subtitle: { color: "#888", fontSize: 16, maxWidth: 480, margin: "0 auto", lineHeight: 1.5 },

    // Tabs
    tabs: {
      display: "flex", gap: 4, background: "#141414",
      border: "1px solid #2a2a2a", borderRadius: 10, padding: 4,
      marginBottom: 32, maxWidth: 380, marginLeft: "auto", marginRight: "auto",
    },
    tab: (active) => ({
      flex: 1, padding: "10px 16px", border: "none",
      background: active ? "#1e1e1e" : "transparent",
      color: active ? "#e8e8e8" : "#888",
      fontFamily: '"DM Sans", sans-serif', fontSize: 14, fontWeight: 600,
      borderRadius: 7, cursor: "pointer", transition: "all 0.2s",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      boxShadow: active ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
    }),

    // Upload zone
    uploadZone: (drag) => ({
      border: `2px dashed ${drag ? "#f59e0b" : "#2a2a2a"}`,
      borderRadius: 12, padding: "60px 40px", textAlign: "center",
      cursor: "pointer", transition: "all 0.25s", background: drag ? "rgba(245,158,11,0.04)" : "#141414",
      position: "relative",
    }),

    // Camera
    videoWrap: {
      position: "relative", borderRadius: 12, overflow: "hidden",
      background: "#141414", border: "1px solid #2a2a2a",
    },
    video: { width: "100%", display: "block", borderRadius: 12 },
    controls: { display: "flex", justifyContent: "center", padding: 16, gap: 10, flexWrap: "wrap" },

    // Buttons
    btn: (variant) => ({
      fontFamily: '"DM Sans", sans-serif', fontSize: 14, fontWeight: 600,
      padding: "11px 22px", border: "none", borderRadius: 8, cursor: "pointer",
      display: "inline-flex", alignItems: "center", gap: 8, transition: "all 0.2s",
      ...(variant === "primary"
        ? { background: "#f59e0b", color: "#000" }
        : variant === "danger"
        ? { background: "#ef4444", color: "#fff" }
        : { background: "#1e1e1e", color: "#e8e8e8", border: "1px solid #2a2a2a" }),
    }),

    // Results
    resultWrap: {
      position: "relative", borderRadius: 12, overflow: "hidden",
      border: "1px solid #2a2a2a", background: "#141414", marginTop: 24,
    },
    canvas: { width: "100%", display: "block" },
    loaderOverlay: {
      position: "absolute", inset: 0, background: "rgba(10,10,10,0.85)",
      display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 16, borderRadius: 12, zIndex: 10,
    },

    // Detection chips
    chipsRow: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 },
    chip: (cls) => {
      const c = getColor(cls);
      return {
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "8px 14px", borderRadius: 8,
        fontFamily: '"Courier New", monospace', fontSize: 13,
        background: c.bg, border: `1px solid ${c.border}`, color: c.box,
      };
    },

    // FPS badge
    fpsBadge: {
      position: "absolute", top: 12, right: 12, zIndex: 5,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)",
      padding: "4px 10px", borderRadius: 6,
      fontFamily: '"Courier New", monospace', fontSize: 12, color: "#22c55e",
      border: "1px solid rgba(34,197,94,0.3)",
    },

    noResult: {
      textAlign: "center", padding: 24, color: "#888", fontSize: 14,
      background: "#141414", borderRadius: 12, border: "1px solid #2a2a2a", marginTop: 16,
    },

    status: {
      marginTop: 32, textAlign: "center",
      fontFamily: '"Courier New", monospace', fontSize: 11, color: "#555", letterSpacing: 0.5,
    },
  };

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes spin { to{transform:rotate(360deg)} }
        * { margin:0; padding:0; box-sizing:border-box; }
      `}</style>

      <div style={styles.container}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={styles.badge}>
            <span style={styles.dot} /> YOLOv11 — Live
          </div>
          <h1 style={styles.title}>
            <span style={{ color: "#f59e0b" }}>Monkey</span>
            <span style={{ color: "#555", fontWeight: 400 }}> / </span>
            <span style={{ color: "#3b82f6" }}>Human</span>
            {" "}Detector
          </h1>
          <p style={styles.subtitle}>
            Upload an image or stream your camera for real-time monkey and human detection.
          </p>
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button style={styles.tab(mode === "upload")} onClick={() => { setMode("upload"); stopCamera(); }}>
            ↑ Upload
          </button>
          <button style={styles.tab(mode === "camera")} onClick={() => setMode("camera")}>
            ◉ Camera
          </button>
        </div>

        {/* Upload Panel */}
        {mode === "upload" && (
          <div
            style={styles.uploadZone(dragOver)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            onClick={() => document.getElementById("fileInput").click()}
          >
            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }}>🖼</div>
            <h3 style={{ fontSize: 18, marginBottom: 8, fontWeight: 600 }}>
              Drop image here or click to browse
            </h3>
            <p style={{ color: "#888", fontSize: 14 }}>Supports JPG, PNG, WEBP</p>
            <input
              id="fileInput"
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => handleFile(e.target.files[0])}
            />
          </div>
        )}

        {/* Camera Panel */}
        {mode === "camera" && (
          <>
            <div style={styles.videoWrap}>
              <video ref={videoRef} autoPlay playsInline muted style={{
                ...styles.video,
                display: cameraActive ? "block" : "none"
              }} />
              {!cameraActive && (
                <div style={{ padding: "80px 20px", textAlign: "center", color: "#555" }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>📷</div>
                  <p>Camera is off. Hit Start to begin.</p>
                </div>
              )}
            </div>
            <div style={styles.controls}>
              {!cameraActive ? (
                <button style={styles.btn("secondary")} onClick={startCamera}>
                  ▶ Start Camera
                </button>
              ) : (
                <>
                  <button style={styles.btn("danger")} onClick={stopCamera}>
                    ■ Stop
                  </button>
                  {!liveRunning && (
                    <button style={styles.btn("primary")} onClick={startLiveDetection}>
                      ◉ Start Live Detection
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Results */}
        {hasResult && (
          <div style={styles.resultWrap}>
            {liveRunning && fps > 0 && (
              <div style={styles.fpsBadge}>{fps} FPS</div>
            )}
            <canvas ref={canvasRef} style={styles.canvas} />
            {isLoading && (
              <div style={styles.loaderOverlay}>
                <div style={{
                  width: 32, height: 32, border: "3px solid #2a2a2a",
                  borderTopColor: "#f59e0b", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }} />
                <p style={{ fontSize: 14, color: "#888" }}>Running inference…</p>
              </div>
            )}
          </div>
        )}

        {/* Detection chips */}
        {hasResult && !isLoading && detections.length > 0 && (
          <div style={styles.chipsRow}>
            {detections.map((d, i) => (
              <span key={i} style={styles.chip(d.class)}>
                {d.class}{" "}
                <span style={{ opacity: 0.7, fontSize: 11 }}>
                  {Math.round(d.confidence * 100)}%
                </span>
              </span>
            ))}
          </div>
        )}

        {hasResult && !isLoading && detections.length === 0 && !liveRunning && (
          <div style={styles.noResult}>No monkeys or humans detected. Try another image.</div>
        )}

        {error && (
          <div style={{ ...styles.noResult, color: "#ef4444", borderColor: "rgba(239,68,68,0.3)" }}>
            {error}
          </div>
        )}

        <div style={styles.status}>
          model: monkey-species-i9zg3/1 · roboflow hosted api
        </div>
      </div>
    </div>
  );
}

