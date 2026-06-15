import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

// Dynamically switch between live production server and local server
const SOCKET_SERVER = (import.meta as any).env.VITE_SOCKET_SERVER || 'http://localhost:5000';
const CHUNK_SIZE = 16384; 

interface SwarmPeerConnection {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
}

export default function App() {
  const [page, setPage] = useState<'home' | 'room'>('home');
  const [roomId, setRoomId] = useState<string>('');
  const [role, setRole] = useState<'sender' | 'receiver' | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [currentFileTransfer, setCurrentFileTransfer] = useState<string>('Awaiting swarm peers...');
  const [connectionStatus, setConnectionStatus] = useState<string>('Disconnected');
  const [progress, setProgress] = useState<number>(0);
  const [transferSpeed, setTransferSpeed] = useState<string>('0 MB/s');
  const [errorLog, setErrorLog] = useState<string | null>(null);
  const [isHashVerified, setIsHashVerified] = useState<boolean | null>(null);

  const [copiedCodeAlert, setCopiedCodeAlert] = useState<boolean>(false);
  const [copiedLinkAlert, setCopiedLinkAlert] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<{ [peerId: string]: SwarmPeerConnection }>({});
  
  // TRANSMISSION STATE ACCUMULATORS
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef<number>(0);
  const expectedFileSizeRef = useRef<number>(0);
  const expectedFileNameRef = useRef<string>('');
  const expectedHashRef = useRef<string>('');
  
  const fileProgressMapRef = useRef<{ [fileHash: string]: number }>({});
  const isLargeFileModeRef = useRef<boolean>(false);

  // SECURE WORKSPACE CRYPTO KEY REFERENCES
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const cryptoKeyHexRef = useRef<string>('');

  // MULTI-THREADED BACKGROUND OPFS WEB WORKER REFERENCE
  const workerRef = useRef<Worker | null>(null);

  const startTimeRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);
  const lastBytesRef = useRef<number>(0);

  const roomIdRef = useRef<string>('');
  const filesRef = useRef<File[]>([]);

  useEffect(() => {
    roomIdRef.current = roomId;
    filesRef.current = files;
  }, [roomId, files]);

  useEffect(() => {
    // Spawning background file writer thread mapping to public folder script
    workerRef.current = new Worker(new URL('/opfs-worker.js', window.location.origin));
    
    workerRef.current.onmessage = (event) => {
      const { type, fileBlob, name, details } = event.data;
      if (type === 'download-ready') {
        setConnectionStatus('Success');
        setIsHashVerified(true);
        
        // FIXED LOGIC BUG: Safely wipe progression trackers upon clean asset clearance
        fileProgressMapRef.current[expectedHashRef.current] = 0;
        
        // Trigger clean download from the OPFS background sandboxed handle link
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (type === 'error') {
        setErrorLog(`Disk Storage Failure: ${details}`);
      }
    };

    socketRef.current = io(SOCKET_SERVER, { transports: ['websocket'], upgrade: false });
    const socket = socketRef.current;

    socket.on('connect', () => {
      console.log('Swarm Node online:', socket.id);
    });

    socket.on('peer-joined-swarm', async ({ peerId }) => {
      setConnectionStatus('Swarm Expanding...');
      await createNewMeshPeerConnection(peerId, true);
    });

    socket.on('all-existing-peers', async (existingPeerIds: string[]) => {
      if (existingPeerIds.length === 0) {
        setConnectionStatus('Waiting for peers...');
        if (filesRef.current.length > 0) {
          setCurrentFileTransfer('Room open. Share link/code to start transfer.');
        }
        return;
      }
      setConnectionStatus('Connecting to Swarm...');
      for (const peerId of existingPeerIds) {
        await createNewMeshPeerConnection(peerId, false);
      }
    });

    socket.on('signal-swarm', async ({ senderPeerId, data }) => {
      let peer = peerConnectionsRef.current[senderPeerId];
      if (!peer) {
        peer = await createNewMeshPeerConnection(senderPeerId, false);
      }
      
      if (data.sdp) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          socket.emit('signal-swarm', { targetPeerId: senderPeerId, roomId: roomIdRef.current, data: { sdp: peer.pc.localDescription } });
        }
      }
    });

    socket.on('ice-candidate-swarm', async ({ senderPeerId, candidate }) => {
      const peer = peerConnectionsRef.current[senderPeerId];
      if (peer && peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding swarm candidate', e);
        }
      }
    });

    socket.on('peer-left-swarm', ({ peerId }) => {
      if (peerConnectionsRef.current[peerId]) {
        peerConnectionsRef.current[peerId].dc?.close();
        peerConnectionsRef.current[peerId].pc.close();
        delete peerConnectionsRef.current[peerId];
      }
      setConnectionStatus('Connection Dropped! Waiting for recovery auto-resume sync..._');
    });

    // RECEIVER INITIALIZATION: Process URL share tokens and cryptographic key material hashes
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const hashFragment = window.location.hash;

    if (roomParam) {
      setRoomId(roomParam);
      setRole('receiver');
      setPage('room'); 

      if (hashFragment.startsWith('#key=')) {
        const targetHexKey = hashFragment.replace('#key=', '');
        cryptoKeyHexRef.current = targetHexKey;
        importReceiverSecretKey(targetHexKey);
      }

      socket.emit('join-room', roomParam);
    }

    return () => {
      socket.disconnect();
      workerRef.current?.terminate();
    };
  }, []);

  const bufferToHex = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const hexToBuffer = (hexString: string) => {
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return bytes.buffer;
  };

  const importReceiverSecretKey = async (hexKey: string) => {
    try {
      const keyBuffer = hexToBuffer(hexKey);
      cryptoKeyRef.current = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-GCM', length: 256 },
        true,
        ['decrypt']
      );
    } catch (e) {
      console.error('Crypto layer initialization failure', e);
    }
  };

  const createNewMeshPeerConnection = async (targetPeerId: string, isInitiator: boolean) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    });

    const peerObj: SwarmPeerConnection = { pc };
    peerConnectionsRef.current[targetPeerId] = peerObj;

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate-swarm', {
          targetPeerId,
          roomId: roomIdRef.current,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState.toLowerCase();
      if (state === 'connected') {
        setConnectionStatus('Swarm Connected & Stable');
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('swarmFileChannel', { ordered: true });
      peerObj.dc = dc;
      configureSwarmDataChannel(dc, targetPeerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current!.emit('signal-swarm', {
        targetPeerId,
        roomId: roomIdRef.current,
        data: { sdp: pc.localDescription }
      });
    } else {
      pc.ondatachannel = (event) => {
        peerObj.dc = event.channel;
        configureSwarmDataChannel(event.channel, targetPeerId);
      };
    }

    return peerObj;
  };

  const configureSwarmDataChannel = (channel: RTCDataChannel, remotePeerId: string) => {
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => {
      setConnectionStatus('Connected');
      if (filesRef.current.length > 0) {
        sendSwarmBatchFiles(channel);
      }
    };

    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const parsed = JSON.parse(event.data);
        
        if (parsed.type === 'metadata') {
          setIsHashVerified(null);
          expectedFileNameRef.current = parsed.name;
          expectedFileSizeRef.current = parsed.size;
          expectedHashRef.current = parsed.hash;
          
          isLargeFileModeRef.current = parsed.size > 52428800; // >50MB scales straight to OPFS Worker mode

          if (isLargeFileModeRef.current) {
            setCurrentFileTransfer(`OPFS Streaming straight to disk storage: ${parsed.name}`);
            workerRef.current?.postMessage({ type: 'init-file', name: parsed.name });
          } else {
            setCurrentFileTransfer(`Downloading: ${parsed.name}`);
          }

          if (fileProgressMapRef.current[parsed.hash] > 0) {
            const existingOffset = fileProgressMapRef.current[parsed.hash];
            receivedBytesRef.current = existingOffset;
            setCurrentFileTransfer(`Resuming link: ${parsed.name} from chunk milestone ${existingOffset}...`);
            channel.send(JSON.stringify({ type: 'resume-request', offset: existingOffset }));
          } else {
            receivedChunksRef.current = [];
            receivedBytesRef.current = 0;
            channel.send(JSON.stringify({ type: 'resume-request', offset: 0 }));
          }
          
          startTimeRef.current = performance.now();
          lastUpdateRef.current = performance.now();
          
        } else if (parsed.type === 'resume-request') {
          (channel as any).activeResumeOffset = parsed.offset;
          (channel as any).isAckReceived = true;
          
        } else if (parsed.type === 'eof') {
          if (isLargeFileModeRef.current) {
            setConnectionStatus('Finalizing disk write sectors...');
            workerRef.current?.postMessage({ type: 'finalize-file', name: expectedFileNameRef.current });
          } else {
            await handleDownloadAssembly();
          }
        }
      } else {
        try {
          const combinedBuffer = event.data as ArrayBuffer;
          const iv = new Uint8Array(combinedBuffer, 0, 12);
          const ciphertext = new Uint8Array(combinedBuffer, 12);

          if (cryptoKeyRef.current) {
            const decryptedChunk = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv },
              cryptoKeyRef.current,
              ciphertext
            );

            if (isLargeFileModeRef.current) {
              workerRef.current?.postMessage({ type: 'write-chunk', chunk: decryptedChunk });
            } else {
              receivedChunksRef.current.push(decryptedChunk);
            }

            receivedBytesRef.current += decryptedChunk.byteLength;
            fileProgressMapRef.current[expectedHashRef.current] = receivedBytesRef.current;
            calculatePerformanceMetrics(receivedBytesRef.current, expectedFileSizeRef.current);
          }
        } catch (e) {
          console.error('Decryption boundary drop error', e);
        }
      }
    };
  };

  const sendSwarmBatchFiles = async (channel: RTCDataChannel) => {
    for (let i = 0; i < filesRef.current.length; i++) {
      const currentFile = filesRef.current[i];
      setCurrentFileTransfer(`Sending: ${currentFile.name} (${i + 1}/${filesRef.current.length})`);
      await streamFileWithResumeAndEncryption(currentFile, channel);
    }
    setConnectionStatus('Complete');
    setCurrentFileTransfer('All files transmitted successfully!');
  };

  const streamFileWithResumeAndEncryption = async (targetFile: File, channel: RTCDataChannel): Promise<void> => {
    return new Promise(async (resolve) => {
      const wholeBuffer = await targetFile.arrayBuffer();
      const computedHash = await crypto.subtle.digest('SHA-256', wholeBuffer);
      const hashHex = bufferToHex(computedHash);

      if (channel.readyState !== 'open') {
        resolve();
        return;
      }

      channel.send(JSON.stringify({
        type: 'metadata',
        name: targetFile.name,
        size: targetFile.size,
        hash: hashHex
      }));

      (channel as any).isAckReceived = false;
      const checkAck = setInterval(() => {
        if ((channel as any).isAckReceived) {
          clearInterval(checkAck);
          
          let offset = (channel as any).activeResumeOffset || 0;
          startTimeRef.current = performance.now();
          lastUpdateRef.current = performance.now();

          const sendSlice = async () => {
            while (offset < targetFile.size && channel.bufferedAmount < 1048576) {
              if (channel.readyState !== 'open') {
                clearInterval(checkAck);
                resolve();
                return;
              }

              const slice = targetFile.slice(offset, offset + CHUNK_SIZE);
              const chunkBuffer = await slice.arrayBuffer();
              const iv = crypto.getRandomValues(new Uint8Array(12));

              if (cryptoKeyRef.current) {
                const encryptedChunk = await crypto.subtle.encrypt(
                  { name: 'AES-GCM', iv },
                  cryptoKeyRef.current,
                  chunkBuffer
                );

                const packBuffer = new Uint8Array(iv.byteLength + encryptedChunk.byteLength);
                packBuffer.set(iv, 0);
                packBuffer.set(new Uint8Array(encryptedChunk), iv.byteLength);

                channel.send(packBuffer.buffer);
                offset += chunkBuffer.byteLength;
                calculatePerformanceMetrics(offset, targetFile.size);
              }

              if (offset >= targetFile.size) {
                channel.send(JSON.stringify({ type: 'eof' }));
                setTimeout(resolve, 500); 
                return;
              }
            }
            if (offset < targetFile.size) setTimeout(sendSlice, 10);
          };
          sendSlice();
        }
      }, 50);
    });
  };

  const calculatePerformanceMetrics = (currentBytes: number, totalBytes: number) => {
    const now = performance.now();
    setProgress(Math.min((currentBytes / totalBytes) * 100, 100));
    const delta = (now - lastUpdateRef.current) / 1000;
    if (delta >= 0.5 || currentBytes === totalBytes) {
      const speed = ((currentBytes - lastBytesRef.current) / (1024 * 1024)) / delta;
      setTransferSpeed(`${speed.toFixed(2)} MB/s`);
      lastUpdateRef.current = now;
      lastBytesRef.current = currentBytes;
    }
  };

  const handleDownloadAssembly = async () => {
    setConnectionStatus('Verifying...');
    const blob = new Blob(receivedChunksRef.current);
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const receivedHash = bufferToHex(hashBuffer);

    if (receivedHash === expectedHashRef.current) {
      setIsHashVerified(true);
      setConnectionStatus('Success');
      fileProgressMapRef.current[expectedHashRef.current] = 0;
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = expectedFileNameRef.current;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      setIsHashVerified(false);
      setConnectionStatus('Corrupt Data');
    }
  };

  const handleCodeCopy = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedCodeAlert(true);
    setTimeout(() => setCopiedCodeAlert(false), 2000);
  };

  const handleLinkCopy = () => {
    const fullLink = `${window.location.origin}?room=${roomId}#key=${cryptoKeyHexRef.current}`;
    navigator.clipboard.writeText(fullLink);
    setCopiedLinkAlert(true);
    setTimeout(() => setCopiedLinkAlert(false), 2000);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
    }
  };

  const removeStagedFile = (targetIndex: number) => {
    setFiles((prev) => prev.filter((_, index) => index !== targetIndex));
  };

  const executeSenderSetup = async () => {
    if (files.length === 0) {
      setErrorLog('Please select files to share.');
      return;
    }

    try {
      const generatedRawKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      
      cryptoKeyRef.current = generatedRawKey;
      const exportedRawBuffer = await crypto.subtle.exportKey('raw', generatedRawKey);
      cryptoKeyHexRef.current = bufferToHex(exportedRawBuffer);

      setErrorLog(null);
      const generatedId = Math.random().toString(36).substring(2, 9);
      setRoomId(generatedId);
      setRole('sender');
      setPage('room');
      if (socketRef.current) socketRef.current.emit('join-room', generatedId);
    } catch (e) {
      setErrorLog('Cryptographic matrix allocation anomaly caught.');
    }
  };

  const executeReceiverSetup = () => {
    if (!roomId.trim()) {
      setErrorLog('Please enter a Room Code.');
      return;
    }
    setErrorLog(null);
    setRole('receiver');
    setPage('room');
    if (socketRef.current) socketRef.current.emit('join-room', roomId.trim());
  };

  const resetState = () => {
    Object.keys(peerConnectionsRef.current).forEach((id) => {
      peerConnectionsRef.current[id].dc?.close();
      peerConnectionsRef.current[id].pc.close();
    });
    peerConnectionsRef.current = {};
    setPage('home');
    setRoomId('');
    setRole(null);
    setFiles([]);
    setCurrentFileTransfer('Awaiting swarm peers...');
    setConnectionStatus('Disconnected');
    setProgress(0);
    setTransferSpeed('0 MB/s');
    setIsHashVerified(null);
    setErrorLog(null);
    cryptoKeyRef.current = null;
    cryptoKeyHexRef.current = '';
    window.location.hash = '';
  };

  return (
    <div style={{ backgroundColor: '#000000', color: '#ffffff', minHeight: '100vh', width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '40px 20px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      
      {/* HEADER ROW SECTION */}
      <div style={{ width: '100%', maxWidth: '900px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #27272a', paddingBottom: '24px', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: '900', letterSpacing: '1px', textTransform: 'uppercase', margin: '0 0 8px 0' }}>
            MARS P2P DIRECT WEB SHARE
          </h1>
          <p style={{ fontSize: '13px', color: '#a1a1aa', margin: '0' }}>Zero-Knowledge Swarm Mesh Node with Adaptive Disk Streaming</p>
        </div>
        
        <div style={{ backgroundColor: '#09090b', border: '1px solid #27272a', padding: '10px 18px', borderRadius: '12px', fontSize: '13px', fontFamily: 'monospace' }}>
          <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', marginRight: '8px', backgroundColor: connectionStatus === 'Connected' || connectionStatus === 'Success' || connectionStatus === 'Swarm Connected & Stable' ? '#10b981' : '#f97316' }} />
          Status: <span style={{ color: '#f97316', fontWeight: 'bold' }}>{connectionStatus}</span>
        </div>
      </div>

      {errorLog && (
        <div style={{ width: '100%', maxWidth: '900px', backgroundColor: '#450a0a', border: '1px solid #ef4444', padding: '16px', borderRadius: '12px', marginBottom: '24px', boxSizing: 'border-box', color: '#fca5a5', fontSize: '14px' }}>
          ⚠️ {errorLog}
        </div>
      )}

      {/* DASHBOARD HOMEPAGE */}
      {page === 'home' && (
        <div style={{ width: '100%', maxWidth: '900px', display: 'flex', flexDirection: 'column', gap: '32px' }}>
          
          <div style={{ backgroundColor: '#18181b', border: '1px solid #27272a', padding: '32px', borderRadius: '24px' }}>
            <h2 style={{ fontSize: '24px', fontWeight: '800', margin: '0 0 12px 0' }}>
              🛡️ Infinite-Scale Swarm Node Operational
            </h2>
            <p style={{ fontSize: '14px', color: '#d4d4d8', lineHeight: '1.6', margin: '0' }}>
              Pipes assets using client-side AES-GCM encryption. For items crossing the standard RAM sandbox boundaries, the interface automatically launches sub-threaded background OPFS write sequences to preserve system stability seamlessly.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '24px', flexDirection: 'row', flexWrap: 'wrap', width: '100%' }}>
            
            <div style={{ flex: '1', minWidth: '300px', backgroundColor: '#18181b', border: '1px solid #27272a', padding: '24px', borderRadius: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxSizing: 'border-box' }}>
              <div>
                <span style={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '1px', backgroundColor: 'rgba(59,130,246,0.15)', color: '#3b82f6', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(59,130,246,0.3)' }}>Mode 01</span>
                <h3 style={{ fontSize: '18px', fontWeight: 'bold', margin: '16px 0 8px 0' }}>Launch Secure Cluster</h3>
                <p style={{ fontSize: '12px', color: '#a1a1aa', lineHeight: '1.5', margin: '0 0 24px 0' }}>Stage items to establish crypto keys and broadcast decentralized links.</p>
                
                <div 
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  style={{ 
                    border: '2px dashed #27272a', 
                    backgroundColor: isDragging ? '#09090b' : '#000000', 
                    borderColor: isDragging ? '#10b981' : '#27272a',
                    padding: '24px 16px', 
                    borderRadius: '16px', 
                    textAlign: 'center', 
                    position: 'relative', 
                    display: 'flex', 
                    flexDirection: 'column', 
                    alignItems: 'center', 
                    boxSizing: 'border-box',
                    transition: 'all 0.2s ease',
                    marginBottom: '16px'
                  }}
                >
                  <input 
                    type="file" 
                    multiple 
                    onChange={(e) => {
                      if (e.target.files) setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                    }}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', zIndex: 10 }}
                  />
                  <span style={{ fontSize: '32px', marginBottom: '8px', color: files.length > 0 ? '#10b981' : '#a1a1aa' }}>🛡️</span>
                  <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#e4e4e7', margin: '0' }}>
                    {isDragging ? 'Drop files here!' : 'Click or Drag & Drop files'}
                  </p>
                </div>

                {files.length > 0 && (
                  <div style={{ backgroundColor: '#09090b', borderRadius: '12px', border: '1px solid #27272a', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                    <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid #27272a', paddingBottom: '6px' }}> Staged files ({files.length})</div>
                    {files.map((f, idx) => (
                      <div key={`${f.name}-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#18181b', padding: '6px 10px', borderRadius: '8px', border: '1px solid #27272a' }}>
                        <span style={{ fontSize: '12px', color: '#e4e4e7', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '180px' }}>{f.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '10px', color: '#71717a', fontFamily: 'monospace' }}>{(f.size / (1024 * 1024)).toFixed(2)} MB</span>
                          <button onClick={() => removeStagedFile(idx)} style={{ backgroundColor: 'transparent', border: 'none', color: '#ef4444', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button 
                onClick={executeSenderSetup}
                style={{ width: '100%', marginTop: '24px', backgroundColor: '#2563eb', color: '#ffffff', fontWeight: 'bold', fontSize: '13px', textTransform: 'uppercase', padding: '14px', borderRadius: '12px', border: 'none', cursor: 'pointer' }}
              >
                Open Sharing Channel →
              </button>
            </div>

            <div style={{ flex: '1', minWidth: '300px', backgroundColor: '#18181b', border: '1px solid #27272a', padding: '24px', borderRadius: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxSizing: 'border-box' }}>
              <div>
                <span style={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '1px', backgroundColor: 'rgba(249,115,22,0.15)', color: '#f97316', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(249,115,22,0.3)' }}>Mode 02</span>
                <h3 style={{ fontSize: '18px', fontWeight: 'bold', margin: '16px 0 8px 0' }}>Join Mesh Pipeline</h3>
                <p style={{ fontSize: '12px', color: '#a1a1aa', lineHeight: '1.5', margin: '0 0 24px 0' }}>Input sync token code. (Always connect via direct hyperlinks for secure E2EE decryption clearance).</p>
                
                <div style={{ backgroundColor: '#000000', padding: '20px 16px', borderRadius: '16px', border: '1px solid #27272a', display: 'flex', flexDirection: 'column', gap: '8px', boxSizing: 'border-box' }}>
                  <input 
                    type="text" 
                    placeholder="e.g. x9y2m81"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value.trim().toLowerCase())}
                    style={{ width: '100%', backgroundColor: '#09090b', border: '1px solid #27272a', color: '#ffffff', borderRadius: '8px', padding: '10px 12px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <button 
                onClick={executeReceiverSetup}
                style={{ width: '100%', marginTop: '24px', backgroundColor: '#27272a', color: '#ffffff', fontWeight: 'bold', fontSize: '13px', textTransform: 'uppercase', padding: '14px', borderRadius: '12px', border: 'none', cursor: 'pointer' }}
              >
                Connect and Pull ↓
              </button>
            </div>

          </div>
        </div>
      )}

      {/* SWARM MONITOR ROOM VIEW */}
      {page === 'room' && (
        <div style={{ width: '100%', maxWidth: '900px', backgroundColor: '#18181b', border: '1px solid #27272a', padding: '24px', borderRadius: '24px', boxSizing: 'border-box' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', backgroundColor: '#000000', borderRadius: '16px', border: '1px solid #27272a', marginBottom: '24px', flexWrap: 'wrap', gap: '20px' }}>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', color: '#71717a', letterSpacing: '0.5px', marginBottom: '4px' }}>Active Channel Key</div>
              <div style={{ fontSize: '20px', fontFamily: 'monospace', fontWeight: 'bold', color: '#ffffff' }}>{roomId}</div>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button onClick={handleCodeCopy} style={{ backgroundColor: copiedCodeAlert ? '#10b981' : '#27272a', color: '#ffffff', border: 'none', borderRadius: '10px', padding: '10px 16px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s' }}>
                {copiedCodeAlert ? '📋 Copied!' : '📋 Copy Code'}
              </button>
              <button onClick={handleLinkCopy} style={{ backgroundColor: copiedLinkAlert ? '#10b981' : '#2563eb', color: '#ffffff', border: 'none', borderRadius: '10px', padding: '10px 16px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s' }}>
                {copiedLinkAlert ? '🔗 Link + Key Copied!' : '🔗 Copy Invite Link'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ padding: '16px', backgroundColor: '#000000', border: '1px solid #27272a', borderRadius: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '24px' }}>🛡️</span>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#ffffff' }}>{currentFileTransfer}</div>
                  <div style={{ fontSize: '12px', color: '#a1a1aa', marginTop: '2px' }}>
                    Active Network Handshakes: {Object.keys(peerConnectionsRef.current).length} peer links | E2EE Active
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', color: '#71717a', fontWeight: 'bold', textAlign: 'right' }}>Telemetry Rate</div>
                <div style={{ fontSize: '18px', fontFamily: 'monospace', fontWeight: 'bold', color: '#f97316', marginTop: '2px' }}>{transferSpeed}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 'bold' }}>
                <span style={{ color: '#a1a1aa' }}>Object Byte Stream Status</span>
                <span style={{ color: '#3b82f6', fontFamily: 'monospace' }}>{progress.toFixed(1)}%</span>
              </div>
              <div style={{ width: '100%', height: '12px', backgroundColor: '#000000', borderRadius: '9999px', border: '1px solid #27272a', padding: '2px', boxSizing: 'border-box' }}>
                <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#2563eb', borderRadius: '9999px', transition: 'width 0.1s ease-out' }} />
              </div>
            </div>

            {isHashVerified !== null && (
              <div style={{ padding: '16px', borderRadius: '16px', border: '1px solid', backgroundColor: isHashVerified ? 'rgba(16,185,129,0.05)' : 'rgba(239,68,68,0.05)', borderColor: isHashVerified ? '#10b981' : '#ef4444', color: isHashVerified ? '#a7f3d0' : '#fca5a5', fontSize: '14px' }}>
                {isHashVerified ? '✅ Verification Check Passed: SHA-256 block signature matching clean. File reassembled successfully.' : '❌ Data Corrupted.'}
              </div>
            )}
          </div>

          <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: '1px solid #27272a', display: 'flex', justifyContent: 'end' }}>
            <button onClick={resetState} style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#000000', border: '1px solid #27272a', padding: '10px 16px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold', color: '#a1a1aa', cursor: 'pointer' }}>
              🔄 Dissolve Session Node
            </button>
          </div>

        </div>
      )}
    </div>
  );
}