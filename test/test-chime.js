'use strict';

const XGenClient = require('./../lib/xgenClient');

function getArg(name, defaultValue = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return defaultValue;
  }
  return process.argv[index + 1];
}

const config = {
  host: getArg('host'),
  protocol: getArg('protocol', 'http'),
  port: Number(getArg('port', getArg('protocol') === 'https' ? 443 : 80)),
  username: getArg('user'),
  pin: getArg('pin'),
  rejectUnauthorized: getArg('rejectUnauthorized', 'false') === 'true',
};

const AREA = Number(getArg('area', 1));

if (!config.host || !config.username || !config.pin) {
  console.log(`
Usage:

node test-chime.js \\
  --host <ip> \\
  --user <username> \\
  --pin <pin> \\
  [--area 1] \\
  [--protocol http|https] \\
  [--port 80] \\
  [--rejectUnauthorized false]

Example:

node test-chime.js \\
  --host 192.168.1.50 \\
  --user master \\
  --pin 1234
`);
  process.exit(1);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const client = new XGenClient(config);

  try {
    console.log('=== XGen Chime Test ===\n');

    console.log('Logging in...');
    await client.login();
    console.log('✓ Login successful\n');

    console.log('Refreshing status...');
    await client.refreshStatus();

    let state = client.decodeAreaState(AREA);

    if (!state) {
      throw new Error(`Could not decode state for area ${AREA}`);
    }

    console.log(`Area ${AREA}:`);
    console.log(state);

    const originalState = state.chime;

    console.log(
      `\nCurrent chime: ${originalState ? 'ON' : 'OFF'}`
    );

    if (originalState) {
      console.log('\nSending CHIME_OFF...');
      await client.sendAreaCommand('CHIME_OFF', AREA);
    } else {
      console.log('\nSending CHIME_ON...');
      await client.sendAreaCommand('CHIME_ON', AREA);
    }

    console.log('Waiting 2 seconds...');
    await sleep(2000);

    console.log('\nRefreshing status...');
    await client.refreshStatus();

    state = client.decodeAreaState(AREA);

    console.log('Updated Area State:');
    console.log(state);

    console.log(
      `\nChime is now ${state.chime ? 'ON' : 'OFF'}`
    );

    console.log('\nRestoring original state...');

    await client.sendAreaCommand(
      originalState ? 'CHIME_ON' : 'CHIME_OFF',
      AREA
    );

    await sleep(2000);

    await client.refreshStatus();

    state = client.decodeAreaState(AREA);

    console.log(
      `✓ Restored. Chime is ${state.chime ? 'ON' : 'OFF'}`
    );

    await client.logout();

    console.log('\n✓ Test complete!');
  } catch (err) {
    console.error('\n✗ Test failed');
    console.error(err);
    process.exitCode = 1;
  }
}

main();