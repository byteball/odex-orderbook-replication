const ccxt = require('ccxt');
const conf = require("ocore/conf");
const mutex = require("ocore/mutex");


let source_balances = null;


let bittrex = new ccxt.bittrex({
	apiKey: conf.sourceApiKey,
	secret: conf.sourceApiSecret,
});


async function createMarketTx(pair, side, size) {

	if (process.env.testnet)
		return console.log("testnet: won't send market tx " + pair + " " + side + " " + size);
	let unlock = await mutex.lock('source_balances');
	let m_resp = (side === 'BUY')
		? await bittrex.createMarketBuyOrder(pair, size)
		: await bittrex.createMarketSellOrder(pair, size);
	console.error('---- m_resp', m_resp);
	source_balances = await bittrex.fetchBalance();
	unlock();
	return m_resp;
}

async function getBalances() {
	let unlock = await mutex.lock('source_balances');
	unlock();
	return source_balances;
}

async function updateBalances() {
	let unlock = await mutex.lock('source_balances');
	try {
		source_balances = await bittrex.fetchBalance();
	}
	catch (e) {
		console.error("error from fetchBalance: " + e)
	}
	unlock();
}

async function start() {
	await updateBalances();
	setInterval(updateBalances, 60 * 1000);
}

exports.start = start;
exports.getBalances = getBalances;
exports.createMarketTx = createMarketTx;
