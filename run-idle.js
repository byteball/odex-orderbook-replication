/*jslint node: true */
'use strict';
const odex = require('odex-client');
const eventBus = require('ocore/event_bus');

eventBus.on('headless_wallet_ready', async () => {
	await odex.start();
	console.log("\nPlease use the above pairing code to pair your Obyte wallet to this bot and manage it.\n");
	console.log("Ctrl-C to exit");
});
