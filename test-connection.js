#!/usr/bin/env node
'use strict';

/**
 * Connectivity test — run this before wiring the plugin into Homebridge,
 * to confirm login/polling works, or to safely try things out against a
 * simulated panel with --mock.
 *
 * Real panel:
 * node test-connection.js --host 192.168.1.50 --user master --pin 1234
 *
 * Simulated panel (no real network access, completely safe):
 * node test-connection.js --mock --watch
 * node test-connection.js --mock --command away
 * node test-connection.js --mock --expire-session
 * node test-connection.js --mock --trigger-alarm
 * * Simulated panel bound to specific network interfaces/ports for multi-client testing:
 * node test-connection.js --mock --host 0.0.0.0 --port 8080 --watch
 *
 * Options:
 * --host <ip>            Panel IP/hostname (default: 127.0.0.1 if --mock)
 * --user <name>          lgname (default: mockuser if --mock)
 * --pin <pin>            lgpin (default: 0000 if --mock)
 * --protocol http|https  (default: http)
 * --port <n>             (default: 80/443, or dynamic/specified if --mock)
 * --insecure             Don't verify TLS cert (self-signed HTTPS)
 * --area <n>             1-based area number to report on (default: 1)
 * --watch                Keep polling every 5s and print state changes
 * --command away|stay|disarm
 * ⚠️ Against a real panel, this actually arms/
 * disarms it. Omit for a safe, read-only test.
 * --mock                 Use an in-process simulated panel instead of a
 * real one.
 * --expire-session       (--mock only) Simulate a session timeout
 * --trigger-alarm        (--mock only) Flip the simulated alarm bit on
 */

const XGenClient = require('./lib/xgenClient');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const area = args.area ? parseInt(args.area, 10) : 1;

async function buildClient() {
  if (args.mock) {
    // Look in current directory or fallback to test/ subdirectory
    let createMockPanel;
    try {
      createMockPanel = require('./mock-panel-server').createMockPanel;
    } catch {
      createMockPanel = require('./test/mock-panel-server').createMockPanel;
    }

    const panel = createMockPanel();
    
    // Fallback to localhost if no host is specified, and 0 (ephemeral auto-assign) if no port specified
    const mockHost = args.host || '127.0.0.1';
    const mockPort = args.port ? parseInt(args.port, 10) : 0;

    const port = await panel.listen(mockPort, mockHost);
    console.log(`(Simulated panel listening on ${mockHost}:${port} — supports concurrent connections)`);

    const client = new XGenClient(
      { 
        host: mockHost, 
        port, 
        protocol: 'http', 
        username: args.user || 'mockuser', 
        pin: args.pin || '0000' 
      }, 
      console
    );
    return { client, panel };
  }

  if (!args.host || !args.user || !args.pin) {
    console.error(
      'Usage: node test-connection.js --host <ip> --user <lgname> --pin <lgpin> [options]\n' +
        '   or: node test-connection.js --mock [options]   (simulated panel, no real network)'
    );
    process.exit(1);
  }

  const client = new XGenClient(
    {
      host: args.host,
      port: args.port ? parseInt(args.port, 10) : undefined,
      protocol: args.protocol === 'https' ? 'https' : 'http',
      username: args.user,
      pin: args.pin,
      rejectUnauthorized: !args.insecure,
    },
    console
  );
  return { client, panel: null };
}

function printState(client) {
  const bits = client.decodeAreaState(area);
  const state = client.deriveState(area);
  console.log(`\n--- Area ${area} ---`);
  console.log(`Derived state: ${state}  (${XGenClient.labelFor(state)})`);
  console.log('Raw decoded bits:', bits);
  if (client.sysStatus && client.sysStatus.length) {
    console.log('Panel system messages:', client.sysStatus);
  }
}

async function main() {
  const { client, panel } = await buildClient();

  console.log(`Logging in to ${client.protocol}://${client.host}:${client.port} as "${client.username}"...`);
  await client.login();
  console.log('Login OK. Session token:', client.session);
  console.log('Area names:', client.areaNames);
  printState(client);

  if (args['trigger-alarm'] && panel) {
    console.log('\n🚨 Simulating an alarm trigger...');
    panel.setAlarm(true);
    await client.refreshStatus();
    printState(client);
  }

  if (args['expire-session'] && panel) {
    console.log('\n⏱  Simulating the panel timing out all sessions...');
    panel.expireSession();
    console.log('Polling again — this should silently log in again and succeed:');
    await client.refreshStatus();
    console.log(`Success. New session token: ${client.session}`);
    printState(client);
  }

  if (args.command) {
    if (args.host == "127.0.0.1") {
      console.log(`\n⚠️  Sending ${args.command} to the MOCK panel in 3 seconds... Ctrl+C now to abort.`);
    } else {
      console.log(`\n⚠️  Sending ${args.command} to the REAL panel in 3 seconds... Ctrl+C now to abort.`);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const actionMap = { away: 'AWAY_ARM', stay: 'STAY_ARM', disarm: 'DISARMED' };
    const action = actionMap[String(args.command).toLowerCase()];
    if (!action) {
      console.error(`Unknown --command "${args.command}". Use away, stay, or disarm.`);
      process.exit(1);
    }
    await client.sendAreaCommand(action, area);
    console.log(`Sent ${action} (${XGenClient.labelFor(action)}).`);
    printState(client);
  }

  if (args.watch) {
    console.log('\nWatching for changes every 5s (Ctrl+C to stop)...');
    setInterval(async () => {
      try {
        await client.refreshStatus();
        printState(client);
      } catch (err) {
        console.error('Poll error:', err.message);
      }
    }, 5000);
  } else {
    await client.logout();
    if (panel) await panel.close();
  }
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});