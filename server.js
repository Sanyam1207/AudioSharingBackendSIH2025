import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://audio-sharing-sih-2025.vercel.app",
      "https://localhost:5173",
      "http://localhost:5173",
    ],
  },
});

// Room structure:
// { roomId: { teacherId, students: Set<socketId>, offers: { studentId: { offer, answer, candidates } } } }
const rooms = {};

io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // Teacher creates room
  socket.on("createRoom", ({ roomId }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        teacherId: socket.id,
        students: new Set(),
        offers: {},
      };
      socket.join(roomId);
      console.log(`Teacher ${socket.id} created room ${roomId}`);
    } else {
      console.log(`Room ${roomId} already exists`);
    }
  });

  // Student joins room
  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("roomClosed", { reason: "Room not found" });
      return;
    }
    room.students.add(socket.id);
    socket.join(roomId);
    console.log(`Student ${socket.id} joined room ${roomId}`);

    // Send teacher existing offers (teacher can handle them)
    io.to(room.teacherId).emit(
      "availableOffers",
      Object.values(room.offers)
    );
  });

  // Student sends new offer
  socket.on("newOffer", (offer, ack) => {
    const roomId = findRoomForStudent(socket.id);
    if (!roomId) {
      console.warn(`Offer from ${socket.id} ignored, not in any room`);
      return;
    }
    const room = rooms[roomId];
    room.offers[socket.id] = {
      offererSocketId: socket.id,
      offer,
      answer: null,
      candidates: [],
    };
    console.log(`Student ${socket.id} sent offer for room ${roomId}`);
    io.to(room.teacherId).emit("newOfferAwaiting", [
      room.offers[socket.id],
    ]);
    if (ack) ack({ status: "ok", offerId: socket.id });
  });

  // Teacher sends new answer
  socket.on("newAnswer", ({ offererSocketId, answer }, ack) => {
    const roomId = findRoomForTeacher(socket.id);
    if (!roomId) {
      console.warn(`Answer from ${socket.id} ignored, not in any room`);
      return;
    }
    const room = rooms[roomId];
    if (!room.offers[offererSocketId]) {
      console.warn(`Answer from ${socket.id} ignored, student not found`);
      return;
    }
    room.offers[offererSocketId].answer = answer;
    console.log(`Teacher ${socket.id} answered offer from ${offererSocketId} in room ${roomId}`);
    io.to(offererSocketId).emit("answerResponse", {
      ...room.offers[offererSocketId],
    });
    if (ack) ack(room.offers[offererSocketId].candidates || []);
  });

  // Handle ICE candidates
  socket.on("sendIceCandidateToSignalingServer", ({ offererSocketId, candidate, fromSocketId }) => {
    const roomId = findRoomForSocketPair(fromSocketId, offererSocketId);
    if (!roomId) {
      console.warn(`ICE candidate from ${fromSocketId} ignored, invalid room or participants`);
      return;
    }
    const room = rooms[roomId];
    const offerEntry = room.offers[offererSocketId];
    if (offerEntry) {
      offerEntry.candidates.push(candidate);
    }
    console.log(`ICE candidate relayed in room ${roomId} from ${fromSocketId} to ${offererSocketId}`);
    if (fromSocketId === offererSocketId) {
      // Student candidate -> teacher
      io.to(room.teacherId).emit("receivedIceCandidateFromServer", { fromSocketId, candidate });
    } else {
      // Teacher candidate -> student
      io.to(offererSocketId).emit("receivedIceCandidateFromServer", { fromSocketId, candidate });
    }
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.teacherId === socket.id) {
        io.to(roomId).emit("roomClosed", { reason: "Teacher disconnected" });
        delete rooms[roomId];
        console.log(`Room ${roomId} closed (teacher left)`);
      } else if (room.students.has(socket.id)) {
        room.students.delete(socket.id);
        delete room.offers[socket.id];
        console.log(`Student ${socket.id} left room ${roomId}`);
      }
    }
  });

  // Helper: find room by student socket ID
  function findRoomForStudent(socketId) {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.students.has(socketId)) {
        return roomId;
      }
    }
    return null;
  }

  // Helper: find room by teacher socket ID
  function findRoomForTeacher(socketId) {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.teacherId === socketId) {
        return roomId;
      }
    }
    return null;
  }

  // Helper: find room containing both participants
  function findRoomForSocketPair(fromSocketId, offererSocketId) {
    for (const [roomId, room] of Object.entries(rooms)) {
      const teacherMatch = room.teacherId === fromSocketId || room.teacherId === offererSocketId;
      const studentMatch = room.students.has(fromSocketId) || room.students.has(offererSocketId);
      if (teacherMatch && studentMatch) {
        return roomId;
      }
    }
    return null;
  }
});

server.listen(8181, () => {
  console.log("Signaling server listening on port 8181");
});
