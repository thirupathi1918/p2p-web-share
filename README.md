# 🔗 MARS P2P Direct Web Share Node

> An advanced, decentralized, multi-peer swarming P2P file-sharing web application featuring zero-knowledge end-to-end encryption (E2EE), automatic connection drop recovery, sequential multi-file queuing, and sub-threaded background disk streaming for large file support beyond 500 MB — all running entirely inside the browser with no server ever touching your data.

---

| Field | Details |
|---|---|
| **Developer** | Badavath Thirupathi |
| **Roll Number** | 23116022 |
| **Evaluation Framework** | MARS Problem Statement 2 — Direct Browser-to-Browser File Transfer |
| **Stack** | React · TypeScript · Vite · Node.js · Socket.io · WebRTC · AES-GCM · OPFS |

---

## 🚀 Live Deployment Links

| Service | URL |
|---|---|
| **Frontend (React UI)** | `https://p2p-web-share-frontend.vercel.app` *(Replace with your live Vercel URL)* |
| **Backend (Signaling Server)** | https://p2p-web-share-backend-qiri.onrender.com |

---

## 🛠️ Project Architecture & Directory Layout

The workspace is organized into a fully decoupled two-service architecture — the frontend client compilation thread is completely isolated from the central signaling WebSocket coordination node. The signaling backend never touches, processes, or stores any file payload data at any point.

```text
P2P-WEB-SHARE/
│
├── backend/                             # Swarm Signaling WebSocket Server
│   ├── node_modules/                    # Backend Dependencies
│   ├── package.json                     # Environment Scripts & Package Registry
│   ├── package-lock.json                # Locked Dependency Tree
│   └── server.js                        # Multi-Peer Targeted Handshake Coordinator
│
└── frontend/                            # Client User Interface (Vite + React)
    ├── node_modules/                    # Frontend Dependencies
    ├── package.json                     # Compilation & Execution Scripts
    ├── package-lock.json                # Locked Dependency Tree
    ├── vite.config.ts                   # Dev Server & Build Tool Configuration
    ├── tailwind.config.js               # Atomic Utility Style Configuration
    │
    ├── public/                          # Static Asset Serving Path
    │   └── opfs-worker.js               # Background Sub-Threaded OPFS Disk Writer
    │
    └── src/                             # React Application Source
        ├── App.tsx                      # Mesh Logic, Crypto Layers & UI View
        ├── main.tsx                     # Vite Root DOM Mount Entrypoint
        ├── index.css                    # Tailwind Core Stylesheet
        └── vite-env.d.ts                # TypeScript Environment Typings
```

---

## ✅ Implemented Features Matrix

### Core MVP Capabilities

| Feature | Description |
|---|---|
| **Dynamic Sharing Room Creation** | Generates a unique, sandboxed sharing key and a one-click join invite link per session |
| **Metadata Handshake Coordinator** | Lightweight Node.js/Socket.io backend handles peer connection handshakes without ever seeing, processing, or storing file payloads |
| **Direct WebRTC Binary Streaming** | Reads local files via the browser `FileReader` API and streams raw binary chunks instantly across an ordered `RTCDataChannel` |
| **SHA-256 Integrity Verification** | Generates cryptographic block hash codes on both sender and receiver sides to guarantee zero bit corruption or payload manipulation |
| **Telemetry Dashboard UI** | Real-time dashboard tracks streaming percentage, transfer speed (MB/s), and live peer connection state |
| **Graceful Crash Prevention** | Captures tab closures or sudden disconnections instantly, cleanly dissolving dead peer configurations without blocking threads |
| **Memory Buffer Auto-Download** | Reassembles received chunks into a local virtual blob URL and fires an automated browser download trigger upon SHA-256 signature validation |
| **Interactive File Queue** | Staged file registry with individual red `✕` delete buttons per entry, allowing removal of mistakenly selected files before launching the room |

---

### 🏆 Advanced Extension Modules

| Module | Description |
|---|---|
| 🌐 **Multi-Peer Mesh Swarming** | Eliminates legacy 1-to-1 bounds. Newly joined peers establish multi-directional connection maps and pull data simultaneously from all active participants |
| 🔐 **Zero-Knowledge E2EE (AES-256-GCM)** | Encrypts every chunk segment inside the browser using 256-bit AES-GCM before transmission. Cryptographic keys travel exclusively inside the client-side URL hash fragment (`#key=...`), remaining entirely invisible to the signaling backend |
| 🔄 **Connection Churn Recovery (Auto-Resume)** | Tracks chunk offset indexes mid-stream. If the connection drops, transmission pauses and automatically resumes from the exact last verified block upon reconnection — never resetting to 0% |
| 💾 **OPFS Large File Support (>500 MB)** | Bypasses browser RAM sandbox limits. When a file exceeds 50 MB, incoming chunks are routed into a background Web Worker (`opfs-worker.js`) that streams them directly onto the local drive via the Origin Private File System (OPFS) |

---

## ⚙️ Local Development Setup

### Prerequisites

- **Node.js** v18+ and **npm** installed
- Two terminal windows open side by side

---

### Step 1 — Launch the Backend Signaling Server

Open a terminal, navigate to the `backend/` directory, install dependencies, and start the server:

```bash
cd backend
npm install
npm start
```

Expected terminal output:
```
Swarm Signaling Server operational on port 5000
```

The signaling node will now be listening at `http://localhost:5000`.

---

### Step 2 — Launch the Frontend React Client

Open a **second terminal**, navigate to the `frontend/` directory, install dependencies, and spin up the Vite dev server:

```bash
cd frontend
npm install
npm run dev
```

Expected terminal output:
```
  VITE ready in Xms

  ➜  Local:   http://localhost:3000/
```

Open your browser and navigate to `http://localhost:3000`.

---

## 🧪 Multi-Window Simulation & Verification Protocol

To fully validate multi-peer mesh connections, zero-knowledge encryption, and auto-resume recovery on a **single local machine**, set up your screen with three separate browser contexts:

| Window | Browser Context | URL |
|---|---|---|
| **Window 1 — Host Node** | Standard Chrome tab | `http://localhost:3000` |
| **Window 2 — Mesh Client A** | Chrome Incognito window | Paste invite link |
| **Window 3 — Mesh Client B** | Firefox or Microsoft Edge | Paste invite link |

---

### 🔁 Full Testing Workflow

**1. Stage Files & Open Room (Window 1)**
- Drag and drop 3 test files into the dropzone.
- Click the red `✕` button on one file to verify the interactive queue removal feature works.
- Click **Open Sharing Channel** to generate your room.

**2. Copy & Share the Invite Link**
- Click **Copy Invite Link**.
- Inspect the generated URL — notice the secret encryption key is embedded safely in the hash fragment (`#key=...`), completely hidden from the server.

**3. Connect Client A (Window 2)**
- Paste the invite link into the Chrome Incognito window.
- Watch files stream in, decrypt inside the browser sandbox, and auto-download upon completion.

**4. Connect Client B & Verify Mesh Scaling (Window 3)**
- Paste the same invite link into Firefox or Edge.
- The telemetry dashboard across all open windows should dynamically update to show **Active Network Handshakes: 2 peer links**, confirming the multi-peer mesh is scaling correctly.

**5. Simulate Connection Drop & Test Auto-Resume**
- While a file is actively transferring to Window 3, **refresh or close that browser tab** to simulate a network failure.
- Observe Window 1 gracefully pause the transfer queue.
- Re-open the invite link in a new tab — the tracker will automatically resume from the last verified chunk offset instead of restarting at 0%.

---

## 🧰 Tech Stack Summary

| Layer | Technology |
|---|---|
| Frontend Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| P2P Transport | WebRTC (`RTCPeerConnection` + `RTCDataChannel`) |
| Signaling Layer | Node.js + Socket.io |
| Encryption | Web Crypto API — AES-256-GCM |
| Large File I/O | OPFS + Web Workers (`opfs-worker.js`) |
| Integrity Check | SHA-256 (block-level hashing) |

---

## 📄 License

This project was developed as a submission for the **MARS Evaluation Framework — Problem Statement 2**.  
**Developer:** Badavath Thirupathi · Roll No. 23116022 · IIT Roorkee
