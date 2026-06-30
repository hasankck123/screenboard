const els = {
  appShell: document.querySelector("#appShell"),
  lobbyScreen: document.querySelector("#lobbyScreen"),
  lobbyStatus: document.querySelector("#lobbyStatus"),
  modeCreate: document.querySelector("#modeCreate"),
  modeJoin: document.querySelector("#modeJoin"),
  createFields: document.querySelector("#createFields"),
  joinFields: document.querySelector("#joinFields"),
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
  raiseHand: document.querySelector("#raiseHand"),
  questionInput: document.querySelector("#questionInput"),
  sendQuestion: document.querySelector("#sendQuestion"),
  clearQuestions: document.querySelector("#clearQuestions"),
  questionsList: document.querySelector("#questionsList"),
  materialInput: document.querySelector("#materialInput"),
  clearMaterial: document.querySelector("#clearMaterial"),
  materialName: document.querySelector("#materialName"),
  materialControls: document.querySelector("#materialControls"),
  imageSizeControl: document.querySelector("#imageSizeControl"),
  materialScale: document.querySelector("#materialScale"),
  materialScaleValue: document.querySelector("#materialScaleValue"),
  materialLayer: document.querySelector("#materialLayer"),
  materialImage: document.querySelector("#materialImage"),
  materialPdf: document.querySelector("#materialPdf"),
  startAirPlay: document.querySelector("#startAirPlay"),
  startScreen: document.querySelector("#startScreen"),
  stopShare: document.querySelector("#stopShare"),
  toggleSelfCamera: document.querySelector("#toggleSelfCamera"),
  toggleMicrophone: document.querySelector("#toggleMicrophone"),
  toggleRecording: document.querySelector("#toggleRecording"),
  statusText: document.querySelector("#statusText"),
  roomTitle: document.querySelector("#roomTitle"),
  roleTitle: document.querySelector("#roleTitle"),
  topActions: document.querySelector(".top-actions"),
  recordingBadge: document.querySelector("#recordingBadge"),
  viewerGreeting: document.querySelector("#viewerGreeting"),
  peerCount: document.querySelector("#peerCount"),
  mirrorState: document.querySelector("#mirrorState"),
  remoteVideo: document.querySelector("#remoteVideo"),
  selfCamera: document.querySelector("#selfCamera"),
  emptyState: document.querySelector("#emptyState"),
  board: document.querySelector("#board"),
  toolPointer: document.querySelector("#toolPointer"),
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
  lobbyMode: "create",
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
  questions: [],
  material: null,
  tool: "pen",
  strokes: [],
  ownStrokes: [],
  activeStroke: null,
  drawingLocked: false
};

const ctx = els.board.getContext("2d", { willReadFrequently: false });

function setStatus(text) {
  els.statusText.textContent = text;
  els.lobbyStatus.textContent = text;
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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

function setLobbyMode(mode) {
  state.lobbyMode = mode === "join" ? "join" : "create";
  const isJoin = state.lobbyMode === "join";
  els.lobbyScreen.classList.toggle("mode-join", isJoin);
  els.lobbyScreen.classList.toggle("mode-create", !isJoin);
  els.modeCreate.classList.toggle("active", !isJoin);
  els.modeJoin.classList.toggle("active", isJoin);
  els.createFields.hidden = isJoin;
  els.joinFields.hidden = !isJoin;
  els.createRoom.hidden = isJoin;
  els.joinRoom.hidden = !isJoin;
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
  const isPresenter = state.role === "presenter";
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
    role.textContent = `${participant.role === "presenter" ? "Sunucu" : "Izleyici"}${participant.handRaised ? " - El kaldirdi" : ""}`;

    meta.append(name, role);
    row.append(avatar, meta);
    if (participant.handRaised) {
      const hand = document.createElement("span");
      hand.className = "hand-badge";
      hand.textContent = "El";
      row.append(hand);
    }
    if (isPresenter && participant.clientId !== clientId) {
      const kick = document.createElement("button");
      kick.type = "button";
      kick.className = "kick-button";
      kick.textContent = "Cikar";
      kick.addEventListener("click", () => kickParticipant(participant.clientId));
      row.append(kick);
    }
    return row;
  }));
}

function renderQuestions() {
  const questions = state.questions || [];
  if (!questions.length) {
    els.questionsList.innerHTML = "<span class=\"empty-participant\">Henuz soru yok.</span>";
    return;
  }
  els.questionsList.replaceChildren(...questions.slice().reverse().map(question => {
    const row = document.createElement("div");
    row.className = "question";

    const meta = document.createElement("small");
    meta.textContent = question.name || "Misafir";

    const text = document.createElement("span");
    text.textContent = question.text || "";

    row.append(meta, text);
    return row;
  }));
}

function renderMaterial() {
  const material = state.material;
  els.materialLayer.hidden = !material;
  els.materialName.textContent = material ? material.name : "Materyal yok.";
  els.materialControls.hidden = !material || material.type !== "image";
  els.imageSizeControl.hidden = !material || material.type !== "image";
  if (!material) {
    els.materialImage.hidden = true;
    els.materialPdf.hidden = true;
    els.materialImage.removeAttribute("src");
    els.materialPdf.removeAttribute("src");
    releaseMaterialObjectUrl();
    delete els.materialImage.dataset.renderSrc;
    delete els.materialPdf.dataset.renderSrc;
    els.materialLayer.style.removeProperty("--material-scale");
    return;
  }
  const scale = clampNumber(material.scale, 40, 160, 100);
  const page = Math.round(clampNumber(material.page, 1, 9999, 1));
  els.materialScale.value = String(scale);
  els.materialScaleValue.textContent = `${scale}%`;
  if (material.type === "image") {
    els.materialLayer.style.setProperty("--material-scale", `${scale}%`);
    if (els.materialImage.dataset.renderSrc !== material.dataUrl) {
      els.materialImage.src = material.dataUrl;
      els.materialImage.dataset.renderSrc = material.dataUrl;
    }
    els.materialImage.hidden = false;
    els.materialPdf.hidden = true;
    els.materialPdf.removeAttribute("src");
    releaseMaterialObjectUrl();
    delete els.materialPdf.dataset.renderSrc;
  } else {
    els.materialLayer.style.removeProperty("--material-scale");
    if (els.materialPdf.dataset.objectKey !== material.dataUrl) {
      releaseMaterialObjectUrl();
      els.materialPdf.dataset.objectUrl = dataUrlToBlobUrl(material.dataUrl);
      els.materialPdf.dataset.objectKey = material.dataUrl;
      delete els.materialPdf.dataset.renderSrc;
    }
    const pdfBase = els.materialPdf.dataset.objectUrl || material.dataUrl;
    const pdfSrc = `${pdfBase}#page=${page}&zoom=page-fit`;
    if (els.materialPdf.dataset.renderSrc !== pdfSrc) {
      els.materialPdf.src = pdfSrc;
      els.materialPdf.dataset.renderSrc = pdfSrc;
    }
    els.materialPdf.hidden = false;
    els.materialImage.hidden = true;
    els.materialImage.removeAttribute("src");
    delete els.materialImage.dataset.renderSrc;
  }
}

function updateUi() {
  const connected = Boolean(state.roomId && (state.events || state.pollTimer));
  const isPresenter = state.role === "presenter";
  els.lobbyScreen.classList.toggle("hidden", connected);
  els.appShell.classList.toggle("hidden", !connected);
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
  els.copyInvite.hidden = connected && !isPresenter;
  els.closeRoom.hidden = connected && !isPresenter;
  els.clearQuestions.hidden = !isPresenter;
  els.clearQuestions.disabled = !connected || !isPresenter || state.questions.length === 0;
  els.raiseHand.hidden = !connected || isPresenter;
  els.raiseHand.disabled = !connected || isPresenter;
  const self = state.participants.find(participant => participant.clientId === clientId);
  els.raiseHand.textContent = self?.handRaised ? "Eli Indir" : "El Kaldir";
  els.sendQuestion.disabled = !connected || !els.questionInput.value.trim();
  els.materialInput.disabled = !connected || !isPresenter;
  els.clearMaterial.disabled = !connected || !isPresenter || !state.material;
  els.materialScale.disabled = !connected || !isPresenter || state.material?.type !== "image";
  els.materialInput.closest(".material-panel").hidden = !isPresenter;
  els.topActions.hidden = connected && !isPresenter;
  els.viewerGreeting.hidden = !connected || isPresenter;
  els.startAirPlay.disabled = !connected || !isPresenter;
  els.startScreen.disabled = !connected || !isPresenter;
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
  els.board.classList.toggle("pointer-mode", state.tool === "pointer");
  renderParticipants();
  renderQuestions();
  renderMaterial();
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
        if (data.error === "Odadan cikarildin") {
          leaveRoom("Odadan cikarildin");
          return;
        }
        setStatus(data.error || "Canli baglanti bekleniyor");
      } else {
        state.cursor = Number(data.cursor || state.cursor);
        if (typeof data.drawingLocked === "boolean") state.drawingLocked = data.drawingLocked;
        if (Array.isArray(data.participants)) state.participants = data.participants;
        if (Array.isArray(data.questions)) state.questions = data.questions;
        if ("material" in data) state.material = data.material || null;
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
  state.questions = Array.isArray(joinData.questions) ? joinData.questions : [];
  state.material = joinData.material || null;
  state.strokes = Array.isArray(joinData.board) ? joinData.board : [];
  startPolling();
  setStatus(state.role === "presenter" ? "Oda kuruldu" : "Odaya katildin");
  updateUi();
  requestAnimationFrame(resizeCanvas);
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
  state.questions = [];
  state.material = null;
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

async function toggleRaiseHand() {
  const self = state.participants.find(participant => participant.clientId === clientId);
  const response = await postMessage({ type: "hand-raise", raised: !self?.handRaised });
  if (response?.participants) state.participants = response.participants;
  updateUi();
}

async function sendQuestion() {
  const text = els.questionInput.value.trim();
  if (!text) return;
  const response = await postMessage({ type: "question", text });
  if (response?.questions) state.questions = response.questions;
  els.questionInput.value = "";
  updateUi();
}

async function clearQuestions() {
  if (state.role !== "presenter") return;
  const response = await postMessage({ type: "question-clear" });
  if (response?.questions) state.questions = response.questions;
  updateUi();
}

async function kickParticipant(targetId) {
  if (state.role !== "presenter") return;
  const target = state.participants.find(participant => participant.clientId === targetId);
  const confirmed = window.confirm(`${target?.name || "Katilimci"} odadan cikarilsin mi?`);
  if (!confirmed) return;
  const response = await postMessage({ type: "participant-kick", clientId: targetId });
  if (response?.participants) state.participants = response.participants;
  updateUi();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Dosya okunamadi"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlobUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return "";
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function releaseMaterialObjectUrl() {
  if (els.materialPdf.dataset.objectUrl) {
    URL.revokeObjectURL(els.materialPdf.dataset.objectUrl);
    delete els.materialPdf.dataset.objectUrl;
    delete els.materialPdf.dataset.objectKey;
  }
}

async function uploadMaterial() {
  if (state.role !== "presenter") return;
  const file = els.materialInput.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setStatus("Materyal 5 MB'den kucuk olmali");
    els.materialInput.value = "";
    return;
  }
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/");
  if (!isPdf && !isImage) {
    setStatus("Sadece PDF veya gorsel eklenebilir");
    els.materialInput.value = "";
    return;
  }
  try {
    setStatus("Materyal yukleniyor");
    const dataUrl = await readFileAsDataUrl(file);
    const response = await postMessage({
      type: "material-set",
      material: {
        type: isPdf ? "pdf" : "image",
        name: file.name,
        dataUrl,
        scale: 100,
        page: 1
      }
    });
    if (response?.material !== undefined) state.material = response.material;
    if (isPdf) setTool("pointer");
    setStatus("Materyal eklendi");
  } catch (error) {
    setStatus("Materyal eklenemedi");
  }
  els.materialInput.value = "";
  updateUi();
}

async function updateMaterialOptions(nextOptions) {
  if (state.role !== "presenter" || !state.material) return;
  state.material = { ...state.material, ...nextOptions };
  updateUi();
  const response = await postMessage({
    type: "material-update",
    options: nextOptions
  });
  if (response?.material) state.material = response.material;
  updateUi();
}

function changeMaterialScale() {
  if (state.material?.type !== "image") return;
  const scale = clampNumber(els.materialScale.value, 40, 160, 100);
  updateMaterialOptions({ scale });
}

async function clearMaterial() {
  if (state.role !== "presenter") return;
  const response = await postMessage({ type: "material-clear" });
  if (response?.material === null) state.material = null;
  updateUi();
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
    if (Array.isArray(message.questions)) state.questions = message.questions;
    if ("material" in message) state.material = message.material || null;
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
  if (message.type === "questions") {
    state.questions = Array.isArray(message.questions) ? message.questions : [];
    updateUi();
  }
  if (message.type === "material") {
    state.material = message.material || null;
    updateUi();
  }
  if (message.type === "participant-kicked") {
    if (message.to === clientId) leaveRoom("Odadan cikarildin");
    return;
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
  if (state.micStream) {
    for (const track of state.micStream.getAudioTracks()) pc.addTrack(track, state.micStream);
  }
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
      setStatus("Pencere sec");
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
    const micTracks = state.micStream ? state.micStream.getAudioTracks() : [];
    for (const track of state.localStream.getTracks()) {
      if (!micTracks.includes(track)) track.stop();
    }
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
        for (const pc of state.peers.values()) {
          pc.addTrack(track, state.micStream);
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

function drawContain(ctx, video, x, y, width, height, sizePercent = 100) {
  const sourceWidth = video.videoWidth || video.naturalWidth || width;
  const sourceHeight = video.videoHeight || video.naturalHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight) * (sizePercent / 100);
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
  } else if (state.material?.type === "image" && els.materialImage.complete && els.materialImage.naturalWidth) {
    drawContain(ctx, els.materialImage, 0, 0, width, height, clampNumber(state.material.scale, 40, 160, 100));
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

function recordingMimeType(hasAudio) {
  const types = hasAudio
    ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || "";
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
    const micTracks = state.micStream
      ? state.micStream.getAudioTracks().filter(track => track.readyState === "live" && track.enabled)
      : [];
    if (micTracks.length) {
      for (const track of micTracks) stream.addTrack(track);
    }
    state.recordChunks = [];
    const mimeType = recordingMimeType(micTracks.length > 0);
    state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
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
    setStatus(micTracks.length ? "Kayit basladi (mikrofonlu)" : "Kayit basladi (mikrofon kapali)");
    drawRecordingFrame();
  } catch (error) {
    state.recorder = null;
    setStatus("Kayit baslatilamadi");
  }
  updateUi();
}

function resizeCanvas() {
  const rect = els.board.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = window.devicePixelRatio || 1;
  els.board.width = Math.max(1, Math.round(rect.width * scale));
  els.board.height = Math.max(1, Math.round(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  redraw();
}

function boardNeedsResize() {
  const rect = els.board.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const expectedWidth = Math.max(1, Math.round(rect.width * scale));
  const expectedHeight = Math.max(1, Math.round(rect.height * scale));
  return Math.abs(els.board.width - expectedWidth) > 1 || Math.abs(els.board.height - expectedHeight) > 1;
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
  if (state.tool === "pointer") return;
  if (state.drawingLocked && state.role !== "presenter") {
    setStatus("Izleyici cizimi kapali");
    event.preventDefault();
    return;
  }
  if (els.board.width <= 1 || els.board.height <= 1 || boardNeedsResize()) {
    resizeCanvas();
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

function setTool(tool) {
  state.tool = ["pointer", "pen", "eraser"].includes(tool) ? tool : "pen";
  els.toolPointer.classList.toggle("active", state.tool === "pointer");
  els.toolPen.classList.toggle("active", state.tool === "pen");
  els.toolEraser.classList.toggle("active", state.tool === "eraser");
  updateUi();
}

els.createRoom.addEventListener("click", createRoom);
els.joinRoom.addEventListener("click", () => connect("viewer"));
els.modeCreate.addEventListener("click", () => setLobbyMode("create"));
els.modeJoin.addEventListener("click", () => setLobbyMode("join"));
els.copyInvite.addEventListener("click", copyInviteLink);
els.closeRoom.addEventListener("click", closeRoom);
els.raiseHand.addEventListener("click", toggleRaiseHand);
els.sendQuestion.addEventListener("click", sendQuestion);
els.clearQuestions.addEventListener("click", clearQuestions);
els.questionInput.addEventListener("input", updateUi);
els.questionInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendQuestion();
  }
});
els.materialInput.addEventListener("change", uploadMaterial);
els.clearMaterial.addEventListener("click", clearMaterial);
els.materialScale.addEventListener("input", changeMaterialScale);
els.startAirPlay.addEventListener("click", () => startShare("airplay"));
els.startScreen.addEventListener("click", () => startShare("screen"));
els.stopShare.addEventListener("click", () => stopShare(true));
els.toggleSelfCamera.addEventListener("click", toggleSelfCamera);
els.toggleMicrophone.addEventListener("click", toggleMicrophone);
els.toggleRecording.addEventListener("click", toggleRecording);

els.toolPointer.addEventListener("click", () => setTool("pointer"));
els.toolPen.addEventListener("click", () => setTool("pen"));
els.toolEraser.addEventListener("click", () => setTool("eraser"));
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
if ("ResizeObserver" in window) {
  const boardResizeObserver = new ResizeObserver(() => resizeCanvas());
  boardResizeObserver.observe(els.board);
}

const initialRoom = normalizeRoom(new URLSearchParams(window.location.search).get("room"));
if (initialRoom) {
  els.roomCode.value = initialRoom;
  setLobbyMode("join");
  setStatus("Davet linki acildi");
} else {
  setLobbyMode("create");
}

resizeCanvas();
updateUi();
