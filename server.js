const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5177);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER;
const ROOT = path.join(__dirname, "public");
const CERT_PATH = path.join(__dirname, "certs", "screenboard-dev.pfx");
const PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD || "1234";
const MAX_PRESENTERS = Number(process.env.MAX_PRESENTERS || 2);
const rooms = new Map();

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const isEmpty = room.clients.size === 0;
    const isOld = now - room.updatedAt > 60 * 60 * 1000;
    if (isEmpty && isOld) rooms.delete(roomId);
  }
}

setInterval(cleanupRooms, 10 * 60 * 1000).unref();

function roomFor(id) {
  const key = String(id || "").replace(/[^A-Z0-9-]/gi, "").toUpperCase().slice(0, 16);
  if (!key) return null;
  if (!rooms.has(key)) {
    rooms.set(key, {
      clients: new Map(),
      presenters: new Set(),
      events: [],
      nextSeq: 1,
      board: [],
      drawingLocked: false,
      presenterId: null,
      updatedAt: Date.now()
    });
  }
  return rooms.get(key);
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function remember(room, payload) {
  const event = { ...payload, seq: room.nextSeq++ };
  room.events.push(event);
  if (room.events.length > 1000) room.events.splice(0, room.events.length - 1000);
  return event;
}

function broadcast(roomId, payload, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.updatedAt = Date.now();
  const event = remember(room, payload);
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptId && client.res) sendEvent(client.res, event);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function isPresenter(room, clientId) {
  return room.presenters.has(clientId);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`);
  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.normalize(path.join(ROOT, cleanPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const url = new URL(req.url, `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime())
    });
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const id = crypto.randomBytes(3).toString("hex").toUpperCase();
    roomFor(id);
    json(res, 200, { roomId: id });
    return undefined;
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/join$/i);
  if (req.method === "POST" && joinMatch) {
    (async () => {
      try {
        const roomId = joinMatch[1].toUpperCase();
        const room = roomFor(roomId);
        const payload = await readBody(req);
        const clientId = String(payload.clientId || "");
        const role = payload.role === "presenter" ? "presenter" : "viewer";
        const password = String(payload.password || "");

        if (!clientId) {
          json(res, 400, { ok: false, error: "Eksik cihaz kimligi" });
          return;
        }
        if (role === "presenter" && password !== PRESENTER_PASSWORD) {
          json(res, 403, { ok: false, error: "Sunucu sifresi hatali" });
          return;
        }
        if (role === "presenter" && !room.presenters.has(clientId) && room.presenters.size >= MAX_PRESENTERS) {
          json(res, 409, { ok: false, error: "Sunucu limiti dolu" });
          return;
        }
        room.clients.set(clientId, { ...(room.clients.get(clientId) || {}), role, joinedAt: Date.now() });
        if (role === "presenter") {
          room.presenters.add(clientId);
          if (!room.presenterId) room.presenterId = clientId;
        }

        json(res, 200, {
          ok: true,
          drawingLocked: room.drawingLocked,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          board: room.board,
          cursor: room.nextSeq - 1
        });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  const eventMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/events$/i);
  if (req.method === "GET" && eventMatch) {
    const roomId = eventMatch[1].toUpperCase();
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const role = url.searchParams.get("role") === "presenter" ? "presenter" : "viewer";
    const password = url.searchParams.get("password") || "";
    const room = roomFor(roomId);

    if (role === "presenter" && password !== PRESENTER_PASSWORD) {
      json(res, 403, { ok: false, error: "Sunucu sifresi hatali" });
      return undefined;
    }
    if (role === "presenter" && !room.presenters.has(clientId) && room.presenters.size >= MAX_PRESENTERS) {
      json(res, 409, { ok: false, error: "Sunucu limiti dolu" });
      return undefined;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");

    room.clients.set(clientId, { res, role, joinedAt: Date.now() });
    if (role === "presenter") {
      room.presenters.add(clientId);
      if (!room.presenterId) room.presenterId = clientId;
    }

    sendEvent(res, {
      type: "snapshot",
      clientId,
      roomId,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      drawingLocked: room.drawingLocked,
      board: room.board
    });
    broadcast(roomId, {
      type: "presence",
      action: "join",
      clientId,
      role,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      drawingLocked: room.drawingLocked
    }, clientId);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      const activeRoom = rooms.get(roomId);
      if (!activeRoom) return;
      const activeClient = activeRoom.clients.get(clientId);
      if (activeClient && activeClient.res && activeClient.res !== res) return;
      activeRoom.clients.delete(clientId);
      if (role === "presenter") activeRoom.presenters.delete(clientId);
      if (activeRoom.presenterId === clientId) activeRoom.presenterId = null;
      if (!activeRoom.presenterId) {
        activeRoom.presenterId = [...activeRoom.presenters][0] || null;
      }
      broadcast(roomId, {
        type: "presence",
        action: "leave",
        clientId,
        role,
        presenterId: activeRoom.presenterId,
        presenterCount: activeRoom.presenters.size,
        maxPresenters: MAX_PRESENTERS,
        drawingLocked: activeRoom.drawingLocked
      });
    });
    return undefined;
  }

  const pollMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/poll$/i);
  if (req.method === "GET" && pollMatch) {
    const roomId = pollMatch[1].toUpperCase();
    const room = roomFor(roomId);
    const clientId = url.searchParams.get("clientId") || "";
    const after = Number(url.searchParams.get("after") || 0);
    const client = room.clients.get(clientId);

    if (!client) {
      json(res, 403, { ok: false, error: "Once odaya katil" });
      return undefined;
    }

    const events = room.events.filter(event => event.seq > after && event.from !== clientId);
    json(res, 200, {
      ok: true,
      cursor: room.nextSeq - 1,
      drawingLocked: room.drawingLocked,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      events
    });
    return undefined;
  }

  const messageMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/messages$/i);
  if (req.method === "POST" && messageMatch) {
    (async () => {
    try {
      const roomId = messageMatch[1].toUpperCase();
      const room = roomFor(roomId);
      const payload = await readBody(req);
      const sender = room.clients.get(payload.from);
      const senderIsPresenter = Boolean(sender && isPresenter(room, payload.from));
      const message = {
        ...payload,
        roomId,
        sentAt: Date.now()
      };

      if (message.type === "board-lock") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.drawingLocked = Boolean(message.locked);
        broadcast(roomId, {
          type: "board-lock",
          from: payload.from,
          role: "presenter",
          roomId,
          locked: room.drawingLocked,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, drawingLocked: room.drawingLocked });
        return;
      }

      if (message.type === "board-stroke" && message.stroke) {
        if (room.drawingLocked && !senderIsPresenter) {
          json(res, 403, { ok: false, error: "Izleyici cizimi kapali" });
          return;
        }
        room.board.push(message.stroke);
        if (room.board.length > 5000) room.board.splice(0, room.board.length - 5000);
      }
      if (message.type === "board-clear") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.board = [];
      }
      if (message.type === "board-undo" && message.strokeId) {
        if (room.drawingLocked && !senderIsPresenter) {
          json(res, 403, { ok: false, error: "Izleyici cizimi kapali" });
          return;
        }
        room.board = room.board.filter(stroke => stroke.id !== message.strokeId);
      }

      broadcast(roomId, message);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    })();
    return undefined;
  }

  serveStatic(req, res);
  return undefined;
}

const server = http.createServer(handleRequest);

server.listen(PORT, "0.0.0.0", () => {
  const addresses = [];
  const nets = require("os").networkInterfaces();
  for (const values of Object.values(nets)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) addresses.push(`http://${net.address}:${PORT}`);
    }
  }
  console.log(`ScreenBoard is running at http://localhost:${PORT}`);
  for (const address of addresses) console.log(`LAN: ${address}`);
});

if (!IS_PRODUCTION && fs.existsSync(CERT_PATH)) {
  const secureServer = https.createServer({
    pfx: fs.readFileSync(CERT_PATH),
    passphrase: process.env.CERT_PASSPHRASE || ""
  }, handleRequest);

  secureServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    const addresses = [];
    const nets = require("os").networkInterfaces();
    for (const values of Object.values(nets)) {
      for (const net of values || []) {
        if (net.family === "IPv4" && !net.internal) addresses.push(`https://${net.address}:${HTTPS_PORT}`);
      }
    }
    console.log(`Secure ScreenBoard is running at https://localhost:${HTTPS_PORT}`);
    for (const address of addresses) console.log(`Secure LAN: ${address}`);
  });
} else {
  console.log(IS_PRODUCTION
    ? "Local HTTPS disabled in production; Render provides public HTTPS."
    : "HTTPS disabled: run scripts\\create-dev-cert.ps1 to create certs\\screenboard-dev.pfx");
}
