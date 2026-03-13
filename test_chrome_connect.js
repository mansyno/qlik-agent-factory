const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from minimal Node server on 5180\n');
});
const PORT = 5180;
const HOST = '0.0.0.0'; // Listen on all interfaces
server.listen(PORT, HOST, () => {
  console.log(`Test server running at http://localhost:${PORT}/`);
  console.log(`Also try http://192.168.1.126:${PORT}/`);
});
