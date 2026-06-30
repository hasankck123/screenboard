const els = {
  displayName: document.querySelector("#displayName"),
  lessonTitle: document.querySelector("#lessonTitle"),
  roomCode: document.querySelector("#roomCode"),
  roomPassword: document.querySelector("#roomPassword"),
  createRoom: document.querySelector("#createRoom"),
  joinRoom: document.querySelector("#joinRoom"),
  copyInvite: document.querySelector("#copyInvite"),
  closeRoom: document.querySelector("#closeRoom"),
  sessionBadge: document.querySelector("#sessionBadge"),
  participantCount: document.querySelector("#participantCount"),
  participantsList: document.querySelector("#participantsList"),
  startAirPlay: document.querySelector("#startAirPlay"),
  startScreen: document.querySelector("#startScreen"),
  startCamera: document.querySelector("#startCamera"),
  stopShare: document.querySelector("#stopShare"),
  toggleSelfCamera: document.querySelector("#toggleSelfCamera"),
  toggleMicrophone: document.querySelector("#toggleMicrophone"),
  toggleRecording: document.querySelector("#toggleRecording"),
  statusText: document.querySelector("#statusText"),
  roomTitle: document.querySelector("#roomTitle"),
  roleTitle: document.querySelector("#roleTitle"),
  recordingBadge: document.querySelector("#recordingBadge"),
  peerCount: document.querySelector("#peerCount"),
  mirrorState: document.querySelector("#mirrorState"),
  remoteVideo: document.querySelector("#remoteVideo"),
  selfCamera: document.querySelector("#selfCamera"),
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
  title: "Canli Ders",
  role: "",
  source: null,
  events: null,
  pollTimer: null,
  cursor: 0,
  localStream: null,
  selfCameraStream: null,
  micStream: null,
  recorder: null,
  recordChunks: [],
  recordCanvas: null,
  recordCtx: null,
  recordFrame: 0,
  peers: new Map(),
  connectedPeers: new Set(),
  participants: [],
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

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function normalizeTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64) || "Canli Ders";
}

function slugify(value) {
  return String(value || "screenboard")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "screenboard";
}

function requireLobbyFields(requireRoom) {
  const displayName = normalizeName(els.displayName.value);
  const title = normalizeTitle(els.lessonTitle.value);
  const password = els.roomPassword.value;
  const roomId = normalizeRoom(els.roomCode.value);
  if (!displayName) {
    setStatus("Kullanici adi gerekli");
    els.displayName.focus();
    return null;
  }
  if (password.length < 4) {
    setStatus("Oda sifresi en az 4 karakter olmali");
    els.roomPassword.focus();
    return null;
  }
  if (requireRoom && !roomId) {
    setStatus("Oda kodu gerekli");
    els.roomCode.focus();
    return null;
  }
  return { displayName, title, password, roomId };
}

function renderParticipants() {
  const participants = state.participants || [];
  els.participantCount.textContent = `${participants.length} kisi`;
  if (!participants.length) {
    els.participantsList.innerHTML = "<span class=\"empty-participant\">Odaya girince burada gorunur.</span>";
    return;
  }
  els.participantsList.replaceChildren(...participants.map(participant => {
    const row = document.createElement("div");
    row.className = "participant";
    if (participant.clientId === clientId) row.classList.add("self");

    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = (participant.name || "M").slice(0, 1).toUpperCase();

    const meta = document.createElement("span");
    meta.className = "participant-meta";

    const name = document.createElement("strong");
    name.textContent = participant.clientId === clientId ? `${participant.name} (Sen)` : participant.name;

    const role = document.createElement("small");
    role.textContent = participant.role === "presenter" ? "Sunucu" : "Izleyici";

    meta.append(name, role);
    row.append(avatar, meta);
    return row;
  }));
}

function updateUi() {
  const connected = Boolean(state.roomId && (state.events || state.pollTimer));
  const isPresenter = state.role === "presenter";
  els.roomTitle.textContent = state.roomId ? state.title : "Canli Ders";
  els.roleTitle.textContent = state.role
    ? `${isPresenter ? "Sunucu" : "Izleyici"} - Oda ${state.roomId}`
    : "Baglanmadi";
  els.sessionBadge.textContent = connected ? (isPresenter ? "Sunucu" : "Izleyici") : "Hazir";
  els.roomCode.disabled = connected;
  els.roomPassword.disabled = connected;
  els.displayName.disabled = connected;
  els.lessonTitle.disabled = connected;
  els.createRoom.disabled = connected;
  els.joinRoom.disabled = connected;
  els.copyInvite.disabled = !connected;
  els.closeRoom.disabled = !connected || !isPresenter;
  els.startAirPlay.disabled = !connected || !isPresenter;
  els.startScreen.disabled = !connected || !isPresenter;
  els.startCamera.disabled = !connected || !isPresenter;
  els.stopShare.disabled = !state.localStream;
  els.toggleSelfCamera.disabled = !isPresenter || !connected;
  els.toggleSelfCamera.textContent = state.selfCameraStream ? "Kamerayi Kapat" : "On Kamera";
  els.toggleSelfCamera.classList.toggle("is-live", Boolean(state.selfCameraStream));
  els.toggleMicrophone.disabled = !isPresenter || !connected;
  els.toggleMicrophone.textContent = state.micStream ? "Mikrofonu Kapat" : "Mikrofon";
  els.toggleMicrophone.classList.toggle("is-live", Boolean(state.micStream));
  els.toggleRecording.disabled = !connected || Boolean(state.recorder && state.recorder.state === "stopping");
  els.toggleRecording.textContent = state.recorder?.state === "recording" ? "Kaydi Durdur" : "Kayit";
  els.toggleRecording.classList.toggle("is-recording", state.recorder?.state === "recording");
  els.recordingBadge.hidden = state.recorder?.state !== "recording";
  els.toggleViewerDraw.hidden = !isPresenter;
  els.toggleViewerDraw.disabled = !isPresenter || !connected;
  els.toggleViewerDraw.textContent = state.drawingLocked ? "Izleyici cizimi ac" : "Izleyici cizimi kapat";
  els.toggleViewerDraw.classList.toggle("is-warning", state.drawingLocked);
  els.peerCount.textContent = `${state.connectedPeers.size} baglanti`;
  els.mirrorState.textContent = state.localStream || els.remoteVideo.srcObject ? "Yayin aktif" : "Yayin yok";
  els.emptyState.classList.toggle("hidden", Boolean(els.remoteVideo.srcObject));
  els.board.classList.toggle("locked", state.drawingLocked && !isPresenter);
  renderParticipants();
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
        if (response.status === 404 || data.error === "Oda bulunamadi") {
          leaveRoom("Oda kapatildi");
          return;
        }
        setStatus(data.error || "Canli baglanti bekleniyor");
      } else {
        state.cursor = Number(data.cursor || state.cursor);
        if (typeof data.drawingLocked === "boolean") state.drawingLocked = data.drawingLocked;
        if (Array.isArray(data.participants)) state.participants = data.participants;
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

function resetRoomState() {
  if (state.events) state.events.close();
  stopPolling();
  for (const pc of state.peers.values()) pc.close();
  state.peers.clear();
  state.connectedPeers.clear();
}

function applyJoin(roomId, role, joinData) {
  resetRoomState();
  state.roomId = roomId;
  state.title = normalizeTitle(joinData.title);
  state.role = joinData.role || role;
  state.drawingLocked = Boolean(joinData.drawingLocked);
  state.cursor = Number(joinData.cursor || 0);
  state.participants = Array.isArray(joinData.participants) ? joinData.participants : [];
  state.strokes = Array.isArray(joinData.board) ? joinData.board : [];
  redraw();
  startPolling();
  setStatus(state.role === "presenter" ? "Oda kuruldu" : "Odaya katildin");
  updateUi();
  postMessage({ type: state.role === "presenter" ? "presenter-online" : "viewer-ready", to: joinData.presenterId || null });
}

function leaveRoom(message = "Oda kapatildi") {
  stopShare(false);
  clearSelfCamera();
  resetRoomState();
  clearRemoteVideo();
  state.roomId = "";
  state.role = "";
  state.title = "Canli Ders";
  state.cursor = 0;
  state.participants = [];
  state.strokes = [];
  state.ownStrokes = [];
  state.drawingLocked = false;
  redraw();
  setStatus(message);
  updateUi();
}

async function copyInviteLink() {
  if (!state.roomId) return;
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("Davet linki kopyalandi");
  } catch (error) {
    window.prompt("Davet linki", url.toString());
  }
}

async function closeRoom() {
  if (state.role !== "presenter" || !state.roomId) return;
  const confirmed = window.confirm("Odayi herkes icin kapatmak istiyor musun?");
  if (!confirmed) return;
  const roomId = state.roomId;
  try {
    const response = await fetch(`/api/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId })
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Oda kapatilamadi" }));
    if (!response.ok || !data.ok) {
      setStatus(data.error || "Oda kapatilamadi");
      return;
    }
    leaveRoom("Oda kapatildi");
  } catch (error) {
    setStatus("Oda kapatilamadi");
  }
}

async function createRoom() {
  try {
    const fields = requireLobbyFields(false);
    if (!fields) return;
    setStatus("Oda olusturuluyor");
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        displayName: fields.displayName,
        title: fields.title,
        password: fields.password
      })
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Oda olusturulamadi" }));
    if (!response.ok || !data.ok) {
      setStatus(data.error || "Oda olusturulamadi");
      return;
    }
    els.roomCode.value = data.roomId;
    applyJoin(data.roomId, "presenter", data);
  } catch (error) {
    setStatus("Oda olusturulamadi");
  }
}

async function connect(role = "viewer") {
  try {
    const fields = requireLobbyFields(true);
    if (!fields) return;
    setStatus("Odaya baglaniliyor");
    const joinResponse = await fetch(`/api/rooms/${fields.roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        role,
        displayName: fields.displayName,
        password: fields.password
      })
    });
    const joinData = await joinResponse.json().catch(() => ({ ok: false, error: "Baglanti reddedildi" }));
    if (!joinResponse.ok || !joinData.ok) {
      setStatus(joinData.error || "Baglanti reddedildi");
      return;
    }
    applyJoin(fields.roomId, role, joinData);
  } catch (error) {
    setStatus("Baglanti kurulamadi");
  }
}

function handleEvent(message) {
  if (message.from === clientId) return;
  if (message.type === "snapshot") {
    state.strokes = Array.isArray(message.board) ? message.board : [];
    state.drawingLocked = Boolean(message.drawingLocked);
    if (message.title) state.title = normalizeTitle(message.title);
    if (Array.isArray(message.participants)) state.participants = message.participants;
    redraw();
    if (state.role === "viewer" && message.presenterId) {
      postMessage({ type: "viewer-ready", to: message.presenterId });
    }
    return;
  }
  if (message.to && message.to !== clientId) return;

  if (message.type === "presence") {
    if (message.action === "leave") state.connectedPeers.delete(message.clientId);
    if (message.title) state.title = normalizeTitle(message.title);
    if (Array.isArray(message.participants)) state.participants = message.participants;
    if (state.role === "viewer" && message.role === "presenter" && message.action === "join") {
      postMessage({ type: "viewer-ready", to: message.clientId });
    }
    if (typeof message.drawingLocked === "boolean") state.drawingLocked = message.drawingLocked;
    updateUi();
  }
  if (message.type === "room-closed") {
    leaveRoom("Oda sunucu tarafindan kapatildi");
    return;
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
    if (state.micStream) {
      for (const track of state.micStream.getAudioTracks()) {
        state.localStream.addTrack(track);
      }
    }
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
  clearMicrophone(false);
  if (state.role === "presenter") {
    clearRemoteVideo();
  }
  for (const pc of state.peers.values()) pc.close();
  state.peers.clear();
  state.connectedPeers.clear();
  if (notify) postMessage({ type: "presenter-stopped", to: null });
  updateUi();
}

async function toggleMicrophone() {
  if (state.micStream) {
    clearMicrophone(true);
    setStatus("Mikrofon kapali");
    updateUi();
    return;
  }
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    if (state.localStream) {
      for (const track of state.micStream.getAudioTracks()) {
        state.localStream.addTrack(track);
        for (const pc of state.peers.values()) {
          pc.addTrack(track, state.localStream);
        }
      }
      await postMessage({ type: "presenter-online", to: null });
    }
    setStatus(state.recorder?.state === "recording"
      ? "Mikrofon acik; kayit icin kaydi yeniden baslat"
      : "Mikrofon acik");
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "Mikrofon izni verilmedi" : "Mikrofon acilamadi");
  }
  updateUi();
}

function clearMicrophone(removeFromPeers = true) {
  if (!state.micStream) return;
  const micTracks = state.micStream.getAudioTracks();
  if (removeFromPeers) {
    for (const pc of state.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && micTracks.includes(sender.track)) {
          pc.removeTrack(sender);
        }
      }
    }
  }
  if (state.localStream) {
    for (const track of micTracks) {
      state.localStream.removeTrack(track);
    }
  }
  for (const track of micTracks) track.stop();
  state.micStream = null;
}

async function toggleSelfCamera() {
  if (state.selfCameraStream) {
    clearSelfCamera();
    setStatus("On kamera kapali");
    updateUi();
    return;
  }
  try {
    state.selfCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false
    });
    els.selfCamera.srcObject = state.selfCameraStream;
    els.selfCamera.classList.add("live");
    setStatus("On kamera acik");
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "Kamera izni verilmedi" : "On kamera acilamadi");
  }
  updateUi();
}

function clearSelfCamera() {
  if (state.selfCameraStream) {
    for (const track of state.selfCameraStream.getTracks()) track.stop();
  }
  state.selfCameraStream = null;
  els.selfCamera.pause();
  els.selfCamera.removeAttribute("src");
  els.selfCamera.srcObject = null;
  els.selfCamera.load();
  els.selfCamera.classList.remove("live");
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

function ensureRecordCanvas() {
  const rect = els.board.getBoundingClientRect();
  const width = Math.max(640, Math.round(rect.width));
  const height = Math.max(360, Math.round(rect.height));
  if (!state.recordCanvas) {
    state.recordCanvas = document.createElement("canvas");
    state.recordCtx = state.recordCanvas.getContext("2d");
  }
  state.recordCanvas.width = width;
  state.recordCanvas.height = height;
  return { width, height };
}

function drawContain(ctx, video, x, y, width, height) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  ctx.fillStyle = "#111821";
  ctx.fillRect(x, y, width, height);
  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

function drawCover(ctx, video, x, y, width, height) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
}

function drawRecordingFrame() {
  if (!state.recorder || state.recorder.state !== "recording") return;
  const { width, height } = ensureRecordCanvas();
  const ctx = state.recordCtx;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (els.remoteVideo.srcObject && els.remoteVideo.readyState >= 2) {
    drawContain(ctx, els.remoteVideo, 0, 0, width, height);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#edf2f8";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  ctx.drawImage(els.board, 0, 0, width, height);

  if (state.selfCameraStream && els.selfCamera.readyState >= 2) {
    const camWidth = Math.round(Math.min(220, width * 0.32));
    const camHeight = Math.round(camWidth * 10 / 16);
    const camX = 16;
    const camY = height - camHeight - 16;
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillRect(camX - 2, camY - 2, camWidth + 4, camHeight + 4);
    drawCover(ctx, els.selfCamera, camX, camY, camWidth, camHeight);
    ctx.restore();
  }

  state.recordFrame = requestAnimationFrame(drawRecordingFrame);
}

function downloadRecording() {
  const blob = new Blob(state.recordChunks, { type: state.recordChunks[0]?.type || "video/webm" });
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = URL.createObjectURL(blob);
  link.download = `${slugify(state.title)}-${state.roomId || "recording"}-${stamp}.webm`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    cancelAnimationFrame(state.recordFrame);
    setStatus("Kayit hazirlaniyor");
    updateUi();
    return;
  }

  try {
    const { width, height } = ensureRecordCanvas();
    const canvasStream = state.recordCanvas.captureStream(30);
    const stream = new MediaStream(canvasStream.getVideoTracks());
    if (state.micStream) {
      for (const track of state.micStream.getAudioTracks()) stream.addTrack(track);
    } else if (state.localStream) {
      for (const track of state.localStream.getAudioTracks()) stream.addTrack(track);
    }
    state.recordChunks = [];
    state.recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm"
    });
    state.recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) state.recordChunks.push(event.data);
    };
    state.recorder.onstop = () => {
      downloadRecording();
      state.recorder = null;
      setStatus(`Kayit indirildi (${width}x${height})`);
      updateUi();
    };
    state.recorder.start(1000);
    setStatus("Kayit basladi");
    drawRecordingFrame();
  } catch (error) {
    state.recorder = null;
    setStatus("Kayit baslatilamadi");
  }
  updateUi();
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

els.createRoom.addEventListener("click", createRoom);
els.joinRoom.addEventListener("click", () => connect("viewer"));
els.copyInvite.addEventListener("click", copyInviteLink);
els.closeRoom.addEventListener("click", closeRoom);
els.startAirPlay.addEventListener("click", () => startShare("airplay"));
els.startScreen.addEventListener("click", () => startShare("screen"));
els.startCamera.addEventListener("click", () => startShare("camera"));
els.stopShare.addEventListener("click", () => stopShare(true));
els.toggleSelfCamera.addEventListener("click", toggleSelfCamera);
els.toggleMicrophone.addEventListener("click", toggleMicrophone);
els.toggleRecording.addEventListener("click", toggleRecording);

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

const initialRoom = normalizeRoom(new URLSearchParams(window.location.search).get("room"));
if (initialRoom) {
  els.roomCode.value = initialRoom;
  setStatus("Davet linki acildi");
}

resizeCanvas();
updateUi();
