// server.js
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
// rooms = {
//   [roomId]: {
//     teacherId: socketId,
//     students: Set<socketId>,
//     offers: { [studentId]: { offererSocketId, offer, answer, candidates: [] } }
//   }
// }

const rooms = {};
// Buffer ICE candidates that arrive before the offer/room entry exists
// { [offererSocketId]: [ { fromSocketId, candidate } ] }
const pendingCandidates = {};

io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // Teacher creates room
  socket.on("createRoom", ({ roomId }) => {
    if (!roomId) {
      console.warn("createRoom called without roomId");
      return;
    }
    if (!rooms[roomId]) {
      rooms[roomId] = {
        teacherId: socket.id,
        students: new Set(),
        offers: {},
      };
      socket.join(roomId);
      console.log(`Teacher ${socket.id} created room ${roomId}`);
    } else {
      // If teacher reconnects or a second teacher tries to create, overwrite teacher
      rooms[roomId].teacherId = socket.id;
      socket.join(roomId);
      console.log(`Teacher ${socket.id} re-created/claimed room ${roomId}`);
      // notify teacher of existing offers
      io.to(socket.id).emit("availableOffers", Object.values(rooms[roomId].offers));
    }
  });

  // Student joins room
  socket.on("joinRoom", ({ roomId }) => {
    if (!roomId) {
      socket.emit("roomClosed", { reason: "RoomId missing" });
      return;
    }
    const room = rooms[roomId];
    if (!room) {
      socket.emit("roomClosed", { reason: "Room not found" });
      console.log(`joinRoom: student ${socket.id} tried to join missing room ${roomId}`);
      return;
    }

    room.students.add(socket.id);
    socket.join(roomId);
    console.log(`Student ${socket.id} joined room ${roomId}`);

    // ensure an offer entry exists (empty) so ICE candidates can be attached even before student sends offer
    if (!room.offers[socket.id]) {
      room.offers[socket.id] = {
        offererSocketId: socket.id,
        offer: null,
        answer: null,
        candidates: [],
      };
    }

    // forward any pending candidates that were gathered before join (unlikely, but safe)
    if (pendingCandidates[socket.id]) {
      const entry = room.offers[socket.id];
      entry.candidates.push(...pendingCandidates[socket.id].map(p => p.candidate));
      delete pendingCandidates[socket.id];
    }

    // Send teacher existing offers (teacher can re-handle)
    if (room.teacherId) {
      io.to(room.teacherId).emit("availableOffers", Object.values(room.offers));
    }
  });

  // Student sends new offer
  socket.on("newOffer", (offer, ack) => {
    // find the room where this student is present
    const roomId = findRoomForStudent(socket.id);
    if (!roomId) {
      console.warn(`newOffer: Offer from ${socket.id} ignored, not in any room`);
      // still create a record to accept candidates buffered later
      if (!pendingCandidates[socket.id]) pendingCandidates[socket.id] = [];
      if (ack) ack({ status: "ignored", reason: "not in room" });
      return;
    }

    const room = rooms[roomId];
    // create or update the offer entry
    room.offers[socket.id] = room.offers[socket.id] || {
      offererSocketId: socket.id,
      offer: null,
      answer: null,
      candidates: [],
    };
    room.offers[socket.id].offer = offer;

    // attach any pending candidates for this offerer
    if (pendingCandidates[socket.id]) {
      const pending = pendingCandidates[socket.id];
      pending.forEach((p) => {
        room.offers[socket.id].candidates.push(p.candidate);
      });
      delete pendingCandidates[socket.id];
    }

    console.log(`Student ${socket.id} sent offer for room ${roomId}`);

    // Notify teacher about this new offer
    if (room.teacherId) {
      io.to(room.teacherId).emit("newOfferAwaiting", [room.offers[socket.id]]);
    }

    if (ack) ack({ status: "ok", offerId: socket.id });
  });

  // Teacher sends new answer back to student
  socket.on("newAnswer", ({ offererSocketId, answer }, ack) => {
    const roomId = findRoomForTeacher(socket.id);
    if (!roomId) {
      console.warn(`newAnswer: Answer from ${socket.id} ignored, teacher not in any room`);
      if (ack) ack({ status: "ignored", reason: "teacher not in a room" });
      return;
    }

    const room = rooms[roomId];
    const offerEntry = room.offers[offererSocketId];
    if (!offerEntry) {
      console.warn(`newAnswer: student ${offererSocketId} not found in room ${roomId}`);
      if (ack) ack({ status: "ignored", reason: "student not found" });
      return;
    }

    offerEntry.answer = answer;
    console.log(`Teacher ${socket.id} answered offer from ${offererSocketId} in room ${roomId}`);

    // send answer to student
    io.to(offererSocketId).emit("answerResponse", { ...offerEntry });

    // reply with any candidates we have stored (so teacher can pass initial ones)
    if (ack) ack(offerEntry.candidates || []);
  });

  // Any peer sends ICE candidate (student -> teacher or teacher -> student)
  socket.on("sendIceCandidateToSignalingServer", ({ offererSocketId, candidate, fromSocketId }) => {
    // attempt to find room by checking if either socket is known in any room
    const roomId = findRoomForSocketPair(fromSocketId, offererSocketId);
    if (!roomId) {
      // If we can't find the room, buffer the candidate so we can attach it later when offer/room exists
      pendingCandidates[offererSocketId] = pendingCandidates[offererSocketId] || [];
      pendingCandidates[offererSocketId].push({ fromSocketId, candidate });
      console.warn(`ICE candidate from ${fromSocketId} buffered (no room yet) for offerer ${offererSocketId}`);
      return;
    }

    const room = rooms[roomId];
    if (!room) {
      console.warn(`ICE candidate ignored: room missing for ${roomId}`);
      return;
    }

    // ensure an offer entry exists (create if student joined but hasn't sent newOffer)
    if (!room.offers[offererSocketId]) {
      room.offers[offererSocketId] = {
        offererSocketId,
        offer: null,
        answer: null,
        candidates: [],
      };
    }

    room.offers[offererSocketId].candidates.push(candidate);

    console.log(`ICE candidate relayed in room ${roomId} from ${fromSocketId} to ${offererSocketId}`);

    // Forward candidate:
    // If candidate came from the offerer (student), forward to the teacher
    if (fromSocketId === offererSocketId) {
      if (room.teacherId) {
        io.to(room.teacherId).emit("receivedIceCandidateFromServer", { fromSocketId, candidate });
      } else {
        // no teacher yet, buffer (already stored in room.offers candidates)
        console.warn("No teacher to receive candidate; already stored in offer entry.");
      }
    } else {
      // Candidate came from teacher (or other), forward to student (offerer)
      io.to(offererSocketId).emit("receivedIceCandidateFromServer", { fromSocketId, candidate });
    }
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);

    // Remove from pendingCandidates if present
    if (pendingCandidates[socket.id]) {
      delete pendingCandidates[socket.id];
    }

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.teacherId === socket.id) {
        io.to(roomId).emit("roomClosed", { reason: "Teacher disconnected" });
        delete rooms[roomId];
        console.log(`Room ${roomId} closed (teacher left)`);
      } else if (room.students.has(socket.id)) {
        room.students.delete(socket.id);
        if (room.offers && room.offers[socket.id]) {
          delete room.offers[socket.id];
        }
        io.to(room.teacherId).emit("availableOffers", Object.values(room.offers || {}));
        console.log(`Student ${socket.id} left room ${roomId}`);
      }
    }
  });

  // Helpers:

  // find the room where a student socket is present
  function findRoomForStudent(socketId) {
    for (const [rid, room] of Object.entries(rooms)) {
      if (room.students && room.students.has(socketId)) return rid;
    }
    return null;
  }

  // find the room where a teacher socket is present
  function findRoomForTeacher(socketId) {
    for (const [rid, room] of Object.entries(rooms)) {
      if (room.teacherId === socketId) return rid;
    }
    return null;
  }

  // find a room which contains either of fromSocketId or offererSocketId (teacher <-> student relationship)
  function findRoomForSocketPair(fromSocketId, offererSocketId) {
    for (const [rid, room] of Object.entries(rooms)) {
      const teacherMatch = room.teacherId === fromSocketId || room.teacherId === offererSocketId;
      const studentMatch =
        (room.students && room.students.has(fromSocketId)) ||
        (room.students && room.students.has(offererSocketId));
      if (teacherMatch && studentMatch) return rid;
    }
    return null;
  }
});

server.listen(8181, () => {
  console.log("Signaling server listening on port 8181");
});
