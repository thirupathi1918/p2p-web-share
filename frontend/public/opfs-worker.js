// public/opfs-worker.js

let fileHandle = null;
let writableStream = null;

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'init-file') {
    try {
      // Access the root of the Origin Private File System sandbox
      const root = await navigator.storage.getDirectory();
      
      // Create (or overwrite) a high-performance temporary file path
      fileHandle = await root.getFileHandle(message.name, { create: true });
      
      // Open a high-speed synchronous writable accessor stream straight to disk
      writableStream = await fileHandle.createWritable();
      
      console.log(`OPFS worker configured disk pipeline for asset: ${message.name}`);
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', details: error.toString() });
    }
  }

  else if (message.type === 'write-chunk') {
    if (writableStream) {
      // Pipe the encrypted chunk array right out of RAM onto the physical drive block
      await writableStream.write(message.chunk);
    }
  }

  else if (message.type === 'finalize-file') {
    if (writableStream) {
      // Flush remaining data blocks and safely close the storage channel
      await writableStream.close();
      
      // Hand the completed file handle back up to the interface layer
      const completedFile = await fileHandle.getFile();
      
      self.postMessage({ 
        type: 'download-ready', 
        fileBlob: completedFile,
        name: message.name 
      });
      
      // Clean cleanup loops
      fileHandle = null;
      writableStream = null;
    }
  }
};