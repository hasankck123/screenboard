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
