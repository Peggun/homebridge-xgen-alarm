'use strict';

const http = require('http');

/**
 * A tiny in-process fake of the real alarm panel's web server, for local
 * testing without touching real hardware. Implements just enough of
 * login.cgi / seq.json / status.json / keyfunction.cgi / logout.cgi to
 * exercise XGenClient end-to-end.
 * * Supports multiple concurrent connections by keeping track of an active session registry.
 */

const DEFAULT_BANKSTATES =
  '00000000000000000000000000000000000001000000000000000000000000000000000000000000';

function createMockPanel({ initialBankstates = DEFAULT_BANKSTATES } = {}) {
  let bankstates = initialBankstates;
  let aseq = 100;
  let sessionCounter = 0;
  
  // Track multiple concurrent active sessions
  const activeSessions = new Set();
  
  /** @type {?'redirect'|'500'} */
  let failMode = null;

  function bytesOf() {
    return bankstates.match(/.{2}/g);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = new URLSearchParams(body);

      if (req.url === '/login.cgi') {
        sessionCounter += 1;
        const newSession = `MOCKSESSION_${sessionCounter}_${Math.random().toString(36).substr(2, 5)}`;
        activeSessions.add(newSession);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          var areaNames = ["","%21","%21","%21"];
          var areaSequence = [${aseq}];
          var areaStatus = ["${bankstates}"];
          var sysStatus = [];
          function getSession(){return "${newSession}";}
        `);
        return;
      }

      // Every other endpoint requires a currently-valid session token
      const presented = params.get('sess');
      const authedOk = activeSessions.has(presented);

      if (!authedOk || failMode === 'redirect') {
        res.writeHead(302, { Location: '/login.htm' });
        res.end('');
        return;
      }
      if (failMode === '500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('simulated server error');
        return;
      }

      if (req.url === '/user/seq.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ area: [aseq], zone: [1] }));
        return;
      }

      if (req.url === '/user/status.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ abank: 0, aseq, bankstates, system: [] }));
        return;
      }

      if (req.url === '/user/keyfunction.cgi') {
        const fnum = params.get('fnum');
        const bytes = bytesOf();
        if (fnum === '15') {
          bytes[3] = '01'; // away bit on
          bytes[2] = '00'; // stay bit off
        } else if (fnum === '1') {
          bytes[2] = '01'; // stay bit on
          bytes[3] = '00'; // away bit off
        } else if (fnum === '0') {
          bytes[2] = '00';
          bytes[3] = '00';
        }
        bankstates = bytes.join('');
        aseq++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ abank: 0, aseq, bankstates, system: [] }));
        return;
      }

      if (req.url === '/logout.cgi') {
        activeSessions.delete(presented);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  });

  return {
    server,

    /** * @param {number} port - Port to bind to (0 for dynamic auto-assignment)
     * @param {string} host - Host interface bind to
     * @returns {Promise<number>} The port it's now listening on. 
     */
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          resolve(server.address().port);
        });
        server.on('error', reject);
      });
    },

    /** @returns {Promise<void>} */
    close() {
      return new Promise((resolve) => server.close(resolve));
    },

    /**
          * Simulates the panel server-side timing out all current sessions.
     */
    expireSession() {
      activeSessions.clear();
    },

    /**
     * Forces every authenticated request to fail a particular way.
     * @param {?'redirect'|'500'} mode
     */
    setFailMode(mode) {
      failMode = mode;
    },

    /**
     * Flips an alarm bit on/off for area 1.
     * @param {boolean} triggered
     */
    setAlarm(triggered) {
      const bytes = bytesOf();
      bytes[8] = triggered ? '01' : '00';
      bankstates = bytes.join('');
      aseq++;
    },

    /** @returns {string} The current raw bankstates hex string. */
    getBankstates() {
      return bankstates;
    },
  };
}

module.exports = { createMockPanel, DEFAULT_BANKSTATES };