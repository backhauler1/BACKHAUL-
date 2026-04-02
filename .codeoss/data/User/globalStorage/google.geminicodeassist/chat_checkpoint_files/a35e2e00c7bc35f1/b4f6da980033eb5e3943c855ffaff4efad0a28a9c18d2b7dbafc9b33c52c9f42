const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const { createServer } = require('http');
const { Server } = require('socket.io');

// After updating package.json, run this command to install the new dependency:
// npm install

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // socket.io options can be configured here
});

const port = process.env.PORT || 3000;

// Middleware should be registered before your routes. The order is important.

// Use compression middleware to gzip responses for better performance.
app.use(compression());

// Use morgan for HTTP request logging. The 'dev' format is great for development.
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.send('<h1>Hello World!</h1><p>Your request has been logged by morgan.</p>');
});

httpServer.listen(port, () => {
  console.log(`Server with socket.io listening on http://localhost:${port}`);
});