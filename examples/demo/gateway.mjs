// IPC lets the launcher request graceful shutdown on Windows as well as Unix.
await import('../../build/sse.js');
process.on('message', message => {
  if (message === 'stop') process.emit('SIGTERM');
});
