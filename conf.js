/*jslint node: true */
"use strict";
exports.port = null;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = true;

exports.storage = 'sqlite';

// TOR is recommended. Uncomment the next two lines to enable it
//exports.socksHost = '127.0.0.1';
//exports.socksPort = 9050;

exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'ODEX Orderbook Replication';
exports.permanent_pairing_secret = '0000'; // * allows to pair with any code, the code is passed as 2nd param to the pairing event handler
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.bIgnoreUnpairRequests = true;
exports.bSingleAddress = true;
exports.bStaticChangeAddress = true;
exports.KEYS_FILENAME = 'keys.json';

exports.bNoPassphrase = true;

// emails
exports.admin_email = '';
exports.from_email = '';

// set owner_address if this bot is trading on behalf of another account. In this case, the bot can trade but is not allowed to withdraw funds. If owner_address is not set, the bot is trading its own money and has full access.
exports.owner_address = process.env.owner_address || '';

// websocket URL of ODEX node we are are connecting to
exports.odex_ws_url = process.env.testnet ? 'wss://testnet.odex.ooo/socket' : 'wss://odex.ooo/socket';
exports.odex_http_url = process.env.testnet ? 'https://testnet.odex.ooo/api' : 'https://odex.ooo/api';

exports.MAX_PRICE_PRECISION = 8;
exports.aa_address = 'FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ';

// override in conf.json or .env
exports.sourceApiKey = process.env.sourceApiKey;
exports.sourceApiSecret = process.env.sourceApiSecret;

// override in conf.json or .env
exports.MARKUP = (typeof process.env.MARKUP !== 'undefined') ? parseFloat(process.env.MARKUP) : 2; // %
exports.bittrex_fees = 0.2; // %

// source
exports.first_bittrex_pair = 'GBYTE-BTC';
//exports.second_bittrex_pair = 'BTC-USD'; // comment if not used


// destination quote
exports.quote_currency = process.env.testnet ? (exports.second_bittrex_pair ? 'USDC' : 'BTC_20200701') : (exports.second_bittrex_pair ? 'OUSD' : 'OBIT');

// destination base is always GBYTE


exports.MIN_QUOTE_BALANCE = 0.001;
exports.MIN_BASE_BALANCE = 0.01;

exports.MIN_DEST_ORDER_SIZE = 0.01; // in base currency
exports.MIN_SOURCE_ORDER_SIZE = 0.2; // in base currency
