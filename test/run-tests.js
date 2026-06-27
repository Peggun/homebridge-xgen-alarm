#!/usr/bin/env node
'use strict';

/**
 * Local, offline test suite — runs entirely against an in-process mock
 * panel server (test/mock-panel-server.js) and a mock HAP layer
 * (test/mock-hap.js). No real network access, no real panel, completely
 * safe to run any time, including in the middle of the night.
 *
 * Usage:
 *   node test/run-tests.js
 */

const assert = require('assert');
const http = require('http');

const XGenClient = require('../lib/xgenClient');
const Notifier = require('../lib/notifier');
const { createMockPanel } = require('./mock-panel-server');
const { createMockHapApi, createFakeLog } = require('./mock-hap');

// Loading the platform module registers it as a side effect of the
// exported function being called with a fake api — we want the *class*
// though, so for tests we reach into the module a different way: we
// require the file and call its export (which calls registerPlatform),
// capturing the class via a spy api. This avoids needing to change how
// lib/platform.js exports things just for testing.
function loadPlatformClass() {
  let Captured;
  const spyApi = { hap: {}, on() {}, registerPlatform: (name, cls) => (Captured = cls) };
  // Each require of a fresh module instance keeps tests independent.
  const modulePath = require.resolve('../lib/platform');
  delete require.cache[modulePath];
  const register = require('../lib/platform');
  register(spyApi);
  return Captured;
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.stack || err.message}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Suite 1 — XGenClient against the mock panel
// ---------------------------------------------------------------------

async function suiteClientBasics() {
  console.log('\nXGenClient — login, polling, arm/disarm cycle');
  const panel = createMockPanel();
  const port = await panel.listen();
  const client = new XGenClient({ host: '127.0.0.1', port, protocol: 'http', username: 'master', pin: '1234' });

  await test('logs in and decodes the captured disarmed/chime-on state', async () => {
    await client.login();
    assert.strictEqual(client.deriveState(1), 'DISARMED');
    assert.strictEqual(client.decodeAreaState(1).chime, true);
  });

  await test('refreshStatus() is a no-op when nothing changed', async () => {
    const before = client.areaSequence[0];
    await client.refreshStatus();
    assert.strictEqual(client.areaSequence[0], before);
  });

  await test('AWAY_ARM → DISARM → STAY_ARM all decode correctly', async () => {
    await client.sendAreaCommand('AWAY_ARM', 1);
    assert.strictEqual(client.deriveState(1), 'AWAY_ARM');

    await client.sendAreaCommand('DISARMED', 1);
    assert.strictEqual(client.deriveState(1), 'DISARMED');

    await client.sendAreaCommand('STAY_ARM', 1);
    assert.strictEqual(client.deriveState(1), 'STAY_ARM');
  });

  await test('friendly labels match what was requested', async () => {
    assert.strictEqual(XGenClient.labelFor('DISARMED'), 'Disarmed');
    assert.strictEqual(XGenClient.labelFor('STAY_ARM'), 'Armed Stay');
    assert.strictEqual(XGenClient.labelFor('AWAY_ARM'), 'Armed Away');
  });

  await client.logout();
  await panel.close();
}

// ---------------------------------------------------------------------
// Suite 2 — THE reported bug: session expiry shows up as a 302
// ---------------------------------------------------------------------

async function suiteSessionExpiry() {
  console.log('\nReproducing the reported bug: 302 on an expired session');
  const panel = createMockPanel();
  const port = await panel.listen();
  const client = new XGenClient({ host: '127.0.0.1', port, protocol: 'http', username: 'master', pin: '1234' });
  await client.login();
  const originalSession = client.session;

  await test('panel returns a 302 once the session is expired (confirms the repro is realistic)', async () => {
    panel.expireSession();
    const res = await client._request({ method: 'POST', path: '/user/seq.json', body: `sess=${client.session}` });
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, '/login.htm');
  });

  await test('refreshStatus() auto-recovers instead of throwing', async () => {
    // Session is still expired from the previous test.
    const status = await client.refreshStatus();
    assert.ok(status, 'refreshStatus should resolve, not throw');
    assert.notStrictEqual(client.session, originalSession, 'client should have logged in again with a new session token');
  });

  await test('a command also auto-recovers from an expired session', async () => {
    panel.expireSession();
    await client.sendAreaCommand('STAY_ARM', 1);
    assert.strictEqual(client.deriveState(1), 'STAY_ARM');
  });

  await test('a genuinely dead panel (always 500) still fails with a clear error, not a hang', async () => {
    panel.setFailMode('500');
    await assert.rejects(() => client.refreshStatus(), /HTTP status 500/);
    panel.setFailMode(null);
  });

  await client.logout();
  await panel.close();
}

// ---------------------------------------------------------------------
// Suite 3 — platform-level: HAP state mapping + log throttling + notifications
// ---------------------------------------------------------------------

async function suitePlatform() {
  console.log('\nXGenAlarmPlatform — HomeKit state mapping, log throttling, notifications');

  // A tiny webhook receiver so we can assert the notifier actually fired
  // (or didn't), without depending on any real external service.
  let webhookHits = [];
  const webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      webhookHits.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  const webhookPort = await new Promise((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve(webhookServer.address().port)));

  const panel = createMockPanel();
  const panelPort = await panel.listen();

  const XGenAlarmPlatform = loadPlatformClass();
  const log = createFakeLog();
  const api = createMockHapApi();
  const platform = new XGenAlarmPlatform(
    log,
    {
      host: '127.0.0.1',
      port: panelPort,
      protocol: 'http',
      username: 'master',
      pin: '1234',
      pollIntervalSeconds: 3600, // we'll call poll() manually, not rely on the timer
      notifications: {
        enabled: true,
        service: 'webhook',
        webhook: { url: `http://127.0.0.1:${webhookPort}/notify` },
      },
    },
    api
  );

  await test('discoverDevices() logs in and sets up the HAP service', async () => {
    api._emit('didFinishLaunching');
    // discoverDevices() is async; give it a tick to finish login + first poll.
    await wait(100);
    assert.ok(platform.securityService, 'security service should have been created');
    assert.strictEqual(log.calls.error.length, 0, 'no errors expected on a clean startup');
  });

  await test('CurrentState reflects Disarmed using the HAP enum (not text — see note below)', async () => {
    const { Characteristic } = api.hap;
    assert.strictEqual(platform.lastCurrentState, Characteristic.SecuritySystemCurrentState.DISARMED);
  });

  await test('setting TargetState to Away actually arms the (mock) panel and updates CurrentState', async () => {
    const { Characteristic } = api.hap;
    await platform.targetStateChar.write(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    assert.strictEqual(platform.lastCurrentState, Characteristic.SecuritySystemCurrentState.AWAY_ARM);
    assert.ok(
      log.calls.info.some((m) => m.includes('Armed Away')),
      'log should use the friendly label "Armed Away"'
    );
  });

  await test('an alarm trigger fires exactly one notification on the rising edge', async () => {
    webhookHits = [];
    panel.setAlarm(true);
    await platform.poll();
    await wait(100); // let the fire-and-forget notification land
    assert.strictEqual(webhookHits.length, 1, 'expected exactly one notification');
    const payload = JSON.parse(webhookHits[0]);
    assert.ok(payload.title.includes('Alarm Triggered'));
  });

  await test('the notification does NOT repeat on subsequent polls while still triggered', async () => {
    webhookHits = [];
    await platform.poll();
    await platform.poll();
    await wait(100);
    assert.strictEqual(webhookHits.length, 0, 'should not re-notify while still triggered');
  });

  await test('clearing the alarm and re-triggering it fires a second notification', async () => {
    panel.setAlarm(false);
    await platform.poll();
    webhookHits = [];
    panel.setAlarm(true);
    await platform.poll();
    await wait(100);
    assert.strictEqual(webhookHits.length, 1, 'expected a fresh notification on the new rising edge');
  });

  await test('poll-failure logging is throttled on a sustained outage', async () => {
    panel.setAlarm(false);
    await platform.poll(); // get back to a clean, known state first
    log.calls.error = [];
    log.calls.warn = [];
    log.calls.debug = [];
    panel.setFailMode('500');

    for (let i = 0; i < 25; i++) {
      await platform.poll();
    }

    // Design: the FIRST occurrence of a new error logs at `error` level
    // (1 line). Every 20th *repeat* of the same message logs a reminder
    // at `warn` level (1 line, for failure #20). Everything else drops to
    // `debug` (visible with `homebridge -D`, silent otherwise). So 25
    // identical failures should produce exactly 1 error + 1 warn line —
    // not 25 error lines.
    assert.strictEqual(log.calls.error.length, 1, `expected exactly one error line, got ${log.calls.error.length}`);
    assert.strictEqual(log.calls.warn.length, 1, `expected exactly one throttled warn reminder, got ${log.calls.warn.length}`);
    assert.strictEqual(log.calls.debug.length, 23, `expected the remaining 23 occurrences at debug level, got ${log.calls.debug.length}`);

    panel.setFailMode(null);
    await platform.poll();
    assert.ok(
      log.calls.info.some((m) => m.includes('recovered after')),
      'should log a recovery message after a sustained failure clears'
    );
  });

  clearInterval(platform._timer);
  await panel.close();
  await new Promise((resolve) => webhookServer.close(resolve));
}

// ---------------------------------------------------------------------
// Suite 4 — Notifier in isolation (ntfy/pushover URL construction)
// ---------------------------------------------------------------------

async function suiteNotifier() {
  console.log('\nNotifier — service dispatch');

  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { url: req.url, headers: req.headers, body };
      res.writeHead(200);
      res.end('ok');
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  await test('ntfy: posts the message body with a Title header', async () => {
    const notifier = new Notifier(
      { enabled: true, service: 'ntfy', ntfy: { server: `http://127.0.0.1:${port}`, topic: 'home-alarm' } },
      createFakeLog()
    );
    received = null;
    await notifier.notify({ title: 'Test Title', message: 'Test message body' });
    assert.ok(received, 'expected a request to be made');
    assert.strictEqual(received.url, '/home-alarm');
    assert.strictEqual(received.headers.title, 'Test Title');
    assert.strictEqual(received.body, 'Test message body');
  });

  await test('webhook: substitutes {{title}}/{{message}} into the body template', async () => {
    const notifier = new Notifier(
      {
        enabled: true,
        service: 'webhook',
        webhook: { url: `http://127.0.0.1:${port}/hook`, body: '{"t":"{{title}}","m":"{{message}}"}' },
      },
      createFakeLog()
    );
    received = null;
    await notifier.notify({ title: 'Hi', message: 'There' });
    const parsed = JSON.parse(received.body);
    assert.strictEqual(parsed.t, 'Hi');
    assert.strictEqual(parsed.m, 'There');
  });

  await test('disabled notifier does not make any request', async () => {
    const notifier = new Notifier({ enabled: false, service: 'ntfy', ntfy: { topic: 'x' } }, createFakeLog());
    received = null;
    await notifier.notify({ title: 'Should not send', message: 'x' });
    assert.strictEqual(received, null);
  });

  await test('a misconfigured service logs a warning instead of throwing', async () => {
    const log = createFakeLog();
    const notifier = new Notifier({ enabled: true, service: 'pushover', pushover: {} }, log);
    await notifier.notify({ title: 'x', message: 'y' }); // missing userKey/appToken
    assert.ok(log.calls.warn.length > 0);
  });

  await new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------

async function main() {
  await suiteClientBasics();
  await suiteSessionExpiry();
  await suitePlatform();
  await suiteNotifier();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
