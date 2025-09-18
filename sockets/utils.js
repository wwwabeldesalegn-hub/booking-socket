let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function getIo() {
  return ioRef;
}

const sendMessageToSocketId = (socketId, messageObject) => {
  const io = ioRef;
  if (io) {
    try {
      console.log('message sent to: ', socketId);
      io.to(socketId).emit(messageObject.event, messageObject.data);
    } catch (e) {
      console.error('Failed to send message to socket', socketId, e);
    }
  } else {
    console.log('Socket.io not initialized.');
  }
};

module.exports = { setIo, getIo, sendMessageToSocketId };

