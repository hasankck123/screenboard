const els = {
  roomCode: document.querySelector("#roomCode"),
  presenterPassword: document.querySelector("#presenterPassword"),
  createRoom: document.querySelector("#createRoom"),
  joinPresenter: document.querySelector("#joinPresenter"),
  joinViewer: document.querySelector("#joinViewer"),
  startAirPlay: document.querySelector("#startAirPlay"),
  startScreen: document.querySelector("#startScreen"),
  startCamera: document.querySelector("#startCamera"),
  stopShare: document.querySelector("#stopShare"),
  statusText: document.querySelector("#statusText"),
  roomTitle: document.querySelector("#roomTitle"),
  roleTitle: document.querySelector("#roleTitle"),
  peerCount: document.querySelector("#peerCount"),
  mirrorState: document.querySelector("#mirrorState"),
  remoteVideo: document.querySelector("#remoteVideo"),
  emptyState: document.querySelector("#emptyState"),
  board: document.querySelector("#board"),
  toolPen: document.querySelector("#toolPen"),
  toolEraser: document.querySelector("#toolEraser"),
  colorPicker: document.querySelector("#colorPicker"),
  sizePicker: document.querySelector("#sizePicker"),
  sizeValue: document.querySelector("#sizeValue"),
  toggleViewerDraw: document.querySelector("#toggleViewerDraw"),
  undoStroke: document.querySelector("#undoStroke"),
  clearBoard: document.querySelector("#clearBoard"),
  saveBoard: document.querySelector("#saveBoard")
};

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => {
    const value = byte.toString(16).padStart(2, "0");
    return [4, 6, 8, 10].includes(index) ? `-${value}` : value;
  }).join("");
}

const clientId = makeId();
const state = {
  roomId: "",
  role: "",
  source: null,
  events: null,
  pollTimer: null,
  cursor: 0,
  localStream: null,
  peers: new Map(),
  connectedPeers: new Set(),
  tool: "pen",
  strokes: [],
  ownStrokes: [],
  activeStroke: null,
  drawingLocked: false
};

const ctx = els.board.getContext("2d", { willReadFrequently: false });

function setStatus(text) {
  els.statusText.textContent = text;
}

function normalizeRoom(value) {
  return String(value || "").replace(/[^a-z0-9-]/gi, "").toUpperCase().slice(0, 16);
}

function updateUi() {
  const connected = Boolean(state.roomId && (state.events || state.pollTimer));
  const isPresenter = state.role === "presenter";
  els.roomTitle.textContent = state.roomId ? `Oda ${state.roomId}` : "Oda yok";
  els.roleTitle.textContent = state.role ? (isPresenter ? "Sunucu" : "Izleyici") : "Baglanmadi";
  els.startAirPlay.disabled = !connected || !isPresenter;
  els.startScreen.disabled = !connected || !isPresenter;
  els.startCamera.disabled = !connected || !isPresenter;
  els.stopShare.disabled = !state.localStream;
  els.toggleViewerDraw.hidden = !isPresenter;
  els.toggleViewerDraw.disabled = !isPresenter || !connected;
  els.toggleViewerDraw.textContent = state.drawingLocked ? "Izleyici cizimi ac" : "Izleyici cizimi kapat";
  els.peerCount.textContent = `${state.connectedPeers.size} baglanti`;
  els.mirrorState.textContent = state.localStream || els.remoteVideo.srcObject ? "Yayin aktif" : "Yayin yok";
  els.emptyState.classList.toggle("hidden", Boolean(els.remoteVideo.srcObject));
  els.board.classList.toggle("locked", state.drawingLocked && !isPresenter);
}

async function postMessage(payload) {
  if (!state.roomId) return;
  const response = await fetch(`/api/rooms/${state.roomId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, from: clientId, role: state.role })
  });
  if (!response.ok) return { ok: false };
  return response.json().catch(() => ({ ok: true }));
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    if (!state.roomId || !state.role) return;
    try {
      const query = new URLSearchParams({ clientId, after: String(state.cursor) });
      const response = await fetch(`/api/rooms/${state.roomId}/poll?${query.toString()}`);
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error || "Canli baglanti bekleniyor");
      } else {
        state.cursor = Number(data.cursor || state.cursor);
        if (typeof data.drawingLocked === "boolean") state.drawingLocked = data.drawingLocked;
        for (const event of data.events || []) handleEvent(event);
        updateUi();
      }
    } catch (error) {
      setStatus("Canli baglanti bekleniyor");
    }
    state.pollTimer = setTimeout(tick, 650);
  };
  state.pollTimer = setTimeout(tick, 50);
}

async function connect(role) {
  try {
    const roomId = normalizeRoom(els.roomCode.value);
    if (!roomId) {
      setStatus("Oda kodu gerekli");
      return;
    }
    const password = els.presenterPassword.value;
    if (role === "presenter" && !password) {
      setStatus("Sunucu sifresi gerekli");
      return;
    }
    setStatus(role === "presenter" ? "Sunucu girisi kontrol ediliyor" : "Izleyici baglaniyor");
    const joinResponse = await fetch(`/api/rooms/${roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, role, password })
    });
    const joinData = await joinResponse.json().catch(() => ({ ok: false, error: "Baglanti reddedildi" }));
    if (!joinResponse.ok || !joinData.ok) {
      setStatus(joinData.error || "Baglanti reddedildi");
      return;
    }
    if (state.events) state.events.close();
    stopPolling();
    for (const pc of state.peers.values()) pc.close();
    state.peers.clear();
    state.connectedPeers.clear();
    state.roomId = roomId;
    state.role = role;
    state.drawingLocked = Boolean(joinData.drawingLocked);
    state.cursor = Number(joinData.cursor || 0);
    state.strokes = Array.isArray(joinData.board) ? joinData.board : [];
    redraw();
    startPolling();
    setStatus("Odaya bagli");
    updateUi();
    postMessage({ type: role === "presenter" ? "presenter-online" : "viewer-ready", to: joinData.presenterId || null });
  } catch (error) {
    setStatus("Baglanti kurulamadi");
  }
}

function handleEvent(message) {
  if (message.from === clientId) return;
  if (message.type === "snapshot") {
    state.strokes = Array.isArray(message.board) ? message.board : [];
    state.drawingLocked = Boolean(message.drawingLocked);
    redraw();
    if (state.role === "viewer" && message.presenterId) {
      postMessage({ type: "viewer-ready", to: message.presenterId });
    }
    return;
  }
  if (message.to && message.to !== clientId) return;

  if (message.type === "presence") {
    if (message.action === "leave") state.connectedPeers.delete(message.clientId);
    if (state.role === "viewer" && message.role === "presenter" && message.action === "join") {
      postMessage({ type: "viewer-ready", to: message.clientId });
    }
    if (typeof message.drawingLocked === "boolean") state.drawingLocked = message.drawingLocked;
    updateUi();
  }
  if (message.type === "board-lock") {
    state.drawingLocked = Boolean(message.locked);
    setStatus(state.drawingLocked ? "Izleyici cizimi kapali" : "Izleyici cizimi acik");
    updateUi();
  }
  if (message.type === "presenter-online" && state.role === "viewer") {
    postMessage({ type: "viewer-ready", to: message.from });
  }
  if (message.type === "presenter-stopped") {
    if (state.role === "viewer") {
      clearRemoteVideo();
    }
    updateUi();
  }
  if (message.type === "viewer-ready" && state.role === "presenter") {
    createPresenterPeer(message.from);
  }
  if (message.type === "offer" && state.role === "viewer") {
    acceptOffer(message);
  }
  if (message.type === "answer" && state.role === "presenter") {
    const pc = state.peers.get(message.from);
    if (pc) pc.setRemoteDescription(message.answer);
  }
  if (message.type === "ice") {
    const pc = state.peers.get(message.from);
    if (pc && message.candidate) pc.addIceCandidate(message.candidate).catch(() => {});
  }
  if (message.type === "board-stroke" && message.stroke) {
    state.strokes.push(message.stroke);
    drawStroke(message.stroke);
  }
  if (message.type === "board-clear") {
    state.strokes = [];
    state.ownStrokes = [];
    redraw();
  }
  if (message.type === "board-undo" && message.strokeId) {
    state.strokes = state.strokes.filter(stroke => stroke.id !== message.strokeId);
    state.ownStrokes = state.ownStrokes.filter(id => id !== message.strokeId);
    redraw();
  }
}

function makePeer(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  state.peers.set(peerId, pc);
  pc.onicecandidate = event => {
    if (event.candidate) postMessage({ type: "ice", to: peerId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (["connected", "completed"].includes(pc.connectionState)) state.connectedPeers.add(peerId);
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) state.connectedPeers.delete(peerId);
    updateUi();
  };
  return pc;
}

async function createPresenterPeer(viewerId) {
  if (!state.localStream) return;
  const old = state.peers.get(viewerId);
  if (old) old.close();
  const pc = makePeer(viewerId);
  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await postMessage({ type: "offer", to: viewerId, offer });
}

async function acceptOffer(message) {
  const old = state.peers.get(message.from);
  if (old) old.close();
  const pc = makePeer(message.from);
  pc.ontrack = event => {
    const stream = event.streams[0];
    els.remoteVideo.srcObject = stream;
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (state.role === "viewer") clearRemoteVideo();
      };
    }
    els.remoteVideo.classList.add("live");
    updateUi();
  };
  await pc.setRemoteDescription(message.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await postMessage({ type: "answer", to: message.from, answer });
}

async function startShare(kind) {
  try {
    if (!navigator.mediaDevices) {
      setStatus("Medya icin HTTPS gerekir");
      return;
    }
    if ((kind === "screen" || kind === "airplay") && !navigator.mediaDevices.getDisplayMedia) {
      setStatus("Bu tarayici ekran paylasimini desteklemiyor");
      return;
    }
    stopShare(false);
    if (kind === "airplay") {
      setStatus("AirServer penceresini sec");
    }
    state.localStream = kind === "screen" || kind === "airplay"
      ? await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "window" },
        audio: kind !== "airplay"
      })
      : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    els.remoteVideo.srcObject = state.localStream;
    els.remoteVideo.muted = true;
    els.remoteVideo.classList.add("live");
    setStatus(kind === "airplay" ? "AirPlay yayinda" : kind === "screen" ? "Ekran yayinda" : "Kamera yayinda");
    for (const track of state.localStream.getTracks()) {
      track.onended = () => stopShare(true);
    }
    await postMessage({ type: "presenter-online", to: null });
    updateUi();
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "Paylasim iptal edildi" : "Yayin baslatilamadi");
  }
}

function stopShare(notify = true) {
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) track.stop();
  }
  state.localStream = null;
  if (state.role === "presenter") {
    clearRemoteVideo();
  }
  for (const pc of state.peers.values()) pc.close();
  state.peers.clear();
  state.connectedPeers.clear();
  if (notify) postMessage({ type: "presenter-stopped", to: null });
  updateUi();
}

function clearRemoteVideo() {
  const stream = els.remoteVideo.srcObject;
  if (stream && typeof stream.getTracks === "function") {
    for (const track of stream.getTracks()) track.stop();
  }
  els.remoteVideo.pause();
  els.remoteVideo.removeAttribute("src");
  els.remoteVideo.srcObject = null;
  els.remoteVideo.load();
  els.remoteVideo.classList.remove("live");
}

function resizeCanvas() {
  const rect = els.board.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  els.board.width = Math.max(1, Math.round(rect.width * scale));
  els.board.height = Math.max(1, Math.round(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  redraw();
}

function pointFor(event) {
  const rect = els.board.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function drawStroke(stroke) {
  const rect = els.board.getBoundingClientRect();
  const points = stroke.points || [];
  if (points.length < 1) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color || "#f24b3d";
  ctx.lineWidth = stroke.size || 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x * rect.width, points[0].y * rect.height);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x * rect.width, points[index].y * rect.height);
  }
  if (points.length === 1) {
    ctx.lineTo(points[0].x * rect.width + 0.01, points[0].y * rect.height + 0.01);
  }
  ctx.stroke();
  ctx.restore();
}

function redraw() {
  const rect = els.board.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  for (const stroke of state.strokes) drawStroke(stroke);
}

function beginStroke(event) {
  if (state.drawingLocked && state.role !== "presenter") {
    setStatus("Izleyici cizimi kapali");
    event.preventDefault();
    return;
  }
  els.board.setPointerCapture(event.pointerId);
  const stroke = {
    id: makeId(),
    author: clientId,
    tool: state.tool,
    color: els.colorPicker.value,
    size: Number(els.sizePicker.value),
    points: [pointFor(event)]
  };
  state.activeStroke = stroke;
  event.preventDefault();
}

function moveStroke(event) {
  if (!state.activeStroke) return;
  state.activeStroke.points.push(pointFor(event));
  redraw();
  drawStroke(state.activeStroke);
  event.preventDefault();
}

async function endStroke(event) {
  if (!state.activeStroke) return;
  const stroke = state.activeStroke;
  state.activeStroke = null;
  state.strokes.push(stroke);
  state.ownStrokes.push(stroke.id);
  drawStroke(stroke);
  const response = await postMessage({ type: "board-stroke", stroke });
  if (response && !response.ok) {
    state.strokes = state.strokes.filter(item => item.id !== stroke.id);
    state.ownStrokes = state.ownStrokes.filter(id => id !== stroke.id);
    redraw();
    setStatus("Cizim reddedildi");
  }
  event.preventDefault();
}

els.createRoom.addEventListener("click", async () => {
  const response = await fetch("/api/rooms", { method: "POST" });
  const data = await response.json();
  els.roomCode.value = data.roomId;
  setStatus("Oda olusturuldu");
});

els.joinPresenter.addEventListener("click", () => connect("presenter"));
els.joinViewer.addEventListener("click", () => connect("viewer"));
els.startAirPlay.addEventListener("click", () => startShare("airplay"));
els.startScreen.addEventListener("click", () => startShare("screen"));
els.startCamera.addEventListener("click", () => startShare("camera"));
els.stopShare.addEventListener("click", () => stopShare(true));

els.toolPen.addEventListener("click", () => {
  state.tool = "pen";
  els.toolPen.classList.add("active");
  els.toolEraser.classList.remove("active");
});
els.toolEraser.addEventListener("click", () => {
  state.tool = "eraser";
  els.toolEraser.classList.add("active");
  els.toolPen.classList.remove("active");
});
els.sizePicker.addEventListener("input", () => {
  els.sizeValue.textContent = els.sizePicker.value;
});
els.toggleViewerDraw.addEventListener("click", async () => {
  if (state.role !== "presenter") return;
  const nextLocked = !state.drawingLocked;
  state.drawingLocked = nextLocked;
  updateUi();
  const response = await postMessage({ type: "board-lock", locked: nextLocked });
  if (response && !response.ok) {
    state.drawingLocked = !nextLocked;
    setStatus("Kilit degistirilemedi");
    updateUi();
  }
});
els.clearBoard.addEventListener("click", async () => {
  state.strokes = [];
  state.ownStrokes = [];
  redraw();
  await postMessage({ type: "board-clear" });
});
els.undoStroke.addEventListener("click", async () => {
  const strokeId = state.ownStrokes.pop();
  if (!strokeId) return;
  state.strokes = state.strokes.filter(stroke => stroke.id !== strokeId);
  redraw();
  await postMessage({ type: "board-undo", strokeId });
});
els.saveBoard.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `screenboard-${state.roomId || "board"}.png`;
  link.href = els.board.toDataURL("image/png");
  link.click();
});

els.board.addEventListener("pointerdown", beginStroke);
els.board.addEventListener("pointermove", moveStroke);
els.board.addEventListener("pointerup", endStroke);
els.board.addEventListener("pointercancel", endStroke);
window.addEventListener("resize", resizeCanvas);

resizeCanvas();
updateUi();
