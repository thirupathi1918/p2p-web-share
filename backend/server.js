const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Track all active socket allocations inside rooms
const roomPeers = {};

io.on('connection', (socket) => {
  console.log('Node online:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!roomPeers[roomId]) {
      roomPeers[roomId] = [];
    }
    
    // Send the list of existing peers to the newly joined peer BEFORE adding them
    socket.emit('all-existing-peers', roomPeers[roomId]);
    
    // Add this new peer to the tracking roster
    roomPeers[roomId].push(socket.id);
    console.log(`Socket ${socket.id} joined swarm room: ${roomId}`);

    // Notify everyone else in the room that a new peer has arrived
    socket.to(roomId).emit('peer-joined-swarm', { peerId: socket.id });
  });

  // Targeted signaling: Route the WebRTC offer/answer directly to a specific target peer
  socket.on('signal-swarm', ({ targetPeerId, roomId, data }) => {
    io.to(targetPeerId).emit('signal-swarm', {
      senderPeerId: socket.id,
      data
    });
  });

  // Targeted ICE Trading: Route candidate packets directly to the matching peer connection
  socket.on('ice-candidate-swarm', ({ targetPeerId, roomId, candidate }) => {
    io.to(targetPeerId).emit('ice-candidate-swarm', {
      senderPeerId: socket.id,
      candidate
    });
  });

  socket.on('disconnect', () => {
    console.log('Node disconnected:', socket.id);
    
    // Clean up the disconnected socket from all rooms it occupied
    Object.keys(roomPeers).forEach((roomId) => {
      roomPeers[roomId] = roomPeers[roomId].filter(id => id !== socket.id);
      if (roomPeers[roomId].length === 0) {
        delete roomPeers[roomId];
      } else {
        // Inform remaining peers in the mesh to drop that connection node
        io.to(roomId).emit('peer-left-swarm', { peerId: socket.id });
      }
    });
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Swarm Signaling Server operational on port ${PORT}`);
});