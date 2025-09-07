import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "https://audio-sharing-sih-2025.vercel.app/" },
});

const rooms = {}; // { roomId: { teacherId, offers: { studentId: { offer, answer, candidates } } } }

io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // Teacher creates room
  socket.on("createRoom", ({ roomId }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { teacherId: socket.id, offers: {} };
      socket.join(roomId);
      console.log(`Teacher ${socket.id} created room ${roomId}`);
    } else {
      console.log(`Room ${roomId} already exists`);
    }
  });

  // Student joins room
  socket.on("joinRoom", ({ roomId }) => {
    if (!rooms[roomId]) {
      socket.emit("roomClosed", { reason: "Room not found" });
      return;
    }
    socket.join(roomId);
    console.log(`Student ${socket.id} joined room ${roomId}`);

    // Send teacher existing offers (teacher will re-check)
    io.to(rooms[roomId].teacherId).emit(
      "availableOffers",
      Object.values(rooms[roomId].offers)
    );
  });

  // Student sends new offer
  socket.on("newOffer", (offer, ack) => {
    const roomId = Object.keys(rooms).find((rid) => rooms[rid].offers);
    if (!roomId) return;

    rooms[roomId].offers[socket.id] = {
      offererSocketId: socket.id,
      offer,
      answer: null,
      candidates: [],
    };

    console.log(`Student ${socket.id} sent offer for room ${roomId}`);

    // Notify teacher
    io.to(rooms[roomId].teacherId).emit("newOfferAwaiting", [
      rooms[roomId].offers[socket.id],
    ]);

    if (ack) ack({ status: "ok", offerId: socket.id });
  });

  // Teacher sends new answer
  socket.on("newAnswer", ({ offererSocketId, answer }, ack) => {
    const roomId = Object.keys(rooms).find(
      (rid) => rooms[rid].offers[offererSocketId]
    );
    if (!roomId) return;

    if (rooms[roomId].offers[offererSocketId]) {
      rooms[roomId].offers[offererSocketId].answer = answer;
      console.log(
        `Teacher ${socket.id} answered offer from ${offererSocketId} in room ${roomId}`
      );

      // Send back to student
      io.to(offererSocketId).emit("answerResponse", {
        ...rooms[roomId].offers[offererSocketId],
      });

      if (ack) {
        ack(rooms[roomId].offers[offererSocketId].candidates || []);
      }
    }
  });

  // Any peer sends ICE candidate
  socket.on(
    "sendIceCandidateToSignalingServer",
    ({ offererSocketId, candidate, fromSocketId }) => {
      const roomId = Object.keys(rooms).find(
        (rid) => rooms[rid].offers[offererSocketId]
      );
      if (!roomId) return;

      const offerEntry = rooms[roomId].offers[offererSocketId];
      if (offerEntry) {
        offerEntry.candidates.push(candidate);
      }

      console.log(
        `ICE candidate relayed in room ${roomId} from ${fromSocketId} to ${offererSocketId}`
      );

      if (fromSocketId === offererSocketId) {
        // Student candidate -> teacher
        io.to(rooms[roomId].teacherId).emit(
          "receivedIceCandidateFromServer",
          { fromSocketId, candidate }
        );
      } else {
        // Teacher candidate -> student
        io.to(offererSocketId).emit("receivedIceCandidateFromServer", {
          fromSocketId,
          candidate,
        });
      }
    }
  );

  // Disconnect cleanup
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.teacherId === socket.id) {
        // Teacher left, close room
        io.to(roomId).emit("roomClosed", { reason: "Teacher disconnected" });
        delete rooms[roomId];
        console.log(`Room ${roomId} closed (teacher left)`);
      } else if (room.offers[socket.id]) {
        // Student left
        delete room.offers[socket.id];
        console.log(`Student ${socket.id} left room ${roomId}`);
      }
    }
  });
});

server.listen(8181, () => {
  console.log("Signaling server listening on :5000");
});
