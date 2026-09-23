let ioInstance = null;

function initRealtime(ioServer) {
  ioInstance = ioServer;
}

function getIo() {
  return ioInstance;
}

function emitToGym(gymId, eventName, payload) {
  if (!ioInstance || typeof ioInstance.to !== "function") return false;
  if (!gymId) return false;
  ioInstance.to(gymId).emit(eventName, payload);
  return true;
}

module.exports = { initRealtime, getIo, emitToGym };