/*jslint node: true */
'use strict';
const odex = require('odex-client');
const ccxws = require("ccxws");
const conf = require("ocore/conf");
const mutex = require("ocore/mutex");
const source = require("./source");

let { orders, ws_api, balances, exchange } = odex;

let compositeSourceBids = {};
let compositeSourceAsks = {};
let previousBestAsk = Infinity
let previousBestBid = 0 ;

let assocFirstMarketSourceBids = {};
let assocFirstMarketSourceAsks = {};

let assocSecondMarketSourceBids = {};
let assocSecondMarketSourceAsks = {};

let first_market, second_market, quote_decimals;

let assocDestOrdersBySourcePrice = {};
let bExiting = false;

const dest_pair = 'GBYTE/' + conf.quote_currency;
let queued_amount = 0; // positive on the buy side



function getDestOrderByHash(hash) {
	for (let source_price in assocDestOrdersBySourcePrice) {
		let dest_order = assocDestOrdersBySourcePrice[source_price];
		if (dest_order.hash === hash)
			return dest_order;
	}
	return null;
}

async function cancelAllTrackedDestOrdersBeforeExiting() {
	if (bExiting)
		return;
	bExiting = true;
	await cancelAllTrackedDestOrders();
}

async function cancelAllTrackedDestOrders() {
	console.log("will cancel " + Object.keys(assocDestOrdersBySourcePrice).length + " tracked dest orders");
	for (let source_price in assocDestOrdersBySourcePrice) {
		let dest_order = assocDestOrdersBySourcePrice[source_price];
		console.log("cancelling order " + dest_order.hash);
		await orders.createAndSendCancel(dest_order.hash);
	}
}

async function cancelAllDestOrders() {
	console.log("will cancel " + Object.keys(orders.assocMyOrders).length + " dest orders");
	for (let hash in orders.assocMyOrders)
		await orders.createAndSendCancel(hash);
}

async function createOrReplaceDestOrder(side, size, source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (dest_order) {
		if (dest_order.size === 0)
			throw Error("0-sized dest order " + dest_order.hash);
		if (dest_order.size === size) // unchanged
			return console.log("order " + size + " GB at source price " + source_price + " already exists");
		// size changed, cancel the old order first
		console.log("will cancel previous " + side + " order at source price " + source_price);
		delete assocDestOrdersBySourcePrice[source_price];
		await orders.createAndSendCancel(dest_order.hash); // order cancelled or modified
	}
	let sign = (side === 'BUY') ? -1 : 1;
	let dest_price = parseFloat(source_price) * (1 + sign * conf.MARKUP / 100);
	console.log("will place " + side + " order for " + size + " GB at " + dest_price + " corresponding to source price " + source_price);
	let hash = await orders.createAndSendOrder(dest_pair, side, size, dest_price);
	console.log("sent order " + hash);
	assocDestOrdersBySourcePrice[source_price] = { hash, size, side };
}

async function createDestOrders(arrNewOrders) {
	for (let i = 0; i < arrNewOrders.length; i++){
		let { size, source_price, side } = arrNewOrders[i];
		await createOrReplaceDestOrder(side, size, source_price);
	}
}

// returns true if a previous order not exists or is different and was cancelled
async function cancelPreviousDestOrderIfChanged(side, size, source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (!dest_order)
		return true;
	if (dest_order.size === 0)
		throw Error("0-sized dest order " + dest_order.hash);
	if (dest_order.size === size && dest_order.side === side) { // unchanged
		console.log("order " + size + " GB at source price " + source_price + " already exists");
		return false;
	}
	// size changed, cancel the old order first
	console.log("will cancel previous " + side + " order at source price " + source_price);
	delete assocDestOrdersBySourcePrice[source_price];
	await orders.createAndSendCancel(dest_order.hash); // order cancelled or modified
	return true;
}

async function cancelDestOrder(source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (dest_order) {
		delete assocDestOrdersBySourcePrice[source_price];
		console.log("will cancel order " + dest_order.hash + " at source price " + source_price);
		await orders.createAndSendCancel(dest_order.hash);
	}
	else
		console.log("no dest order at source price " + source_price);
}


async function updateDestBids(bids) {
	let unlock = await mutex.lock('bids');
	let dest_balances = await balances.getBalances();
	let dest_quote_balance_available = (dest_balances[conf.quote_currency] || 0) / (10**quote_decimals) - conf.MIN_QUOTE_BALANCE;
	let arrNewOrders = [];
	let bDepleted = dest_quote_balance_available <= 0; //bids array is already truncated for a total size not exceeding source balance available
	for (let i = 0; i < bids.length; i++){
		let bid = bids[i];
		let source_price = bid.price;
		if (bDepleted) { // cancel all remaining orders to make sure we have enough free funds for other orders
			await cancelDestOrder(source_price);
			continue;
		}
		let size = parseFloat(bid.size);
		let dest_price = parseFloat(source_price) * (1 - conf.MARKUP / 100);
		let dest_quote_amount_required = size * dest_price;
		if (dest_quote_amount_required > dest_quote_balance_available) {
			bDepleted = true;
			console.log("bid #" + i + ": " + size + " GB at " + source_price + " requires " + dest_quote_amount_required + " "+ conf.quote_currency +" on dest but have only " + dest_quote_balance_available + " available on dest");
			dest_quote_amount_required = dest_quote_balance_available;
			size = dest_quote_amount_required / dest_price;
		}
		// cancel the old order first, otherwise if it was downsized and made up more room for other orders, we might hit insufficient balance error when we try to place them
		let bNeedNewOrder = await cancelPreviousDestOrderIfChanged('BUY', size, source_price);
		if (bNeedNewOrder && size >= conf.MIN_DEST_ORDER_SIZE)
			arrNewOrders.push({ size, source_price, side: 'BUY' });
		if (size >= conf.MIN_DEST_ORDER_SIZE) {
			dest_quote_balance_available -= dest_quote_amount_required;
		}
		else
			console.log("skipping bid " + size + " GB at " + source_price + " as it is too small");
	}
	unlock();
	return arrNewOrders;
}


async function updateDestAsks(asks) {
	let unlock = await mutex.lock('asks');
	let dest_balances = await balances.getBalances();
	let dest_base_balance_available = (dest_balances.GBYTE || 0)/1e9 - conf.MIN_BASE_BALANCE;
	let arrNewOrders = [];
	let bDepleted = dest_base_balance_available <=0;  //asks array is already truncated for a total size not exceeding quote balance available
	for (let i = 0; i < asks.length; i++){
		let ask = asks[i];
		let source_price = ask.price;
		if (bDepleted) { // cancel all remaining orders to make sure we have enough free funds for other orders
			await cancelDestOrder(source_price);
			continue;
		}
		let size = parseFloat(ask.size);
		if (size > dest_base_balance_available) {
			bDepleted = true;
			console.log("ask #" + i + ": " + size + " GB at " + source_price + " but have only " + dest_base_balance_available + " GB available on dest");
			size = dest_base_balance_available;
		}
		// cancel the old order first, otherwise if it was downsized and made up more room for other orders, we might hit insufficient balance error when we try to place them
		let bNeedNewOrder = await cancelPreviousDestOrderIfChanged('SELL', size, source_price);
		if (bNeedNewOrder && size >= conf.MIN_DEST_ORDER_SIZE)
			arrNewOrders.push({ size, source_price, side: 'SELL' });
		if (size >= conf.MIN_DEST_ORDER_SIZE) {
			dest_base_balance_available -= size;
		}
		else
			console.log("skipping ask " + size + " GB at " + source_price + " as it is too small");
	}
	unlock();
	return arrNewOrders;
}


async function removeDestinationOrdersNotMatchingPriceSourceOrders(bUpdateDestAsks, bUpdateDestBids) {

	const assocAllCompositeOrders = {};
	for (var i=0; i < compositeSourceBids.length; i++)
		assocAllCompositeOrders[compositeSourceBids[i].price] = compositeSourceBids[i].size;

	for (var i=0; i < compositeSourceAsks.length; i++)
		assocAllCompositeOrders[compositeSourceAsks[i].price] = compositeSourceAsks[i].size;

	for (let source_price in assocDestOrdersBySourcePrice) {
		if (!bUpdateDestBids && assocDestOrdersBySourcePrice[source_price].side == 'BUY') // we don't cancel order on a side that is not being updated
			continue;
		if (!bUpdateDestAsks && assocDestOrdersBySourcePrice[source_price].side == 'SELL')
			continue;
		if (!assocAllCompositeOrders[source_price]) {
			console.log("order at " + source_price + " not found in new snapshot from source, will cancel on dest");
			await cancelDestOrder(source_price);
		}
	}
}


async function updateDestinationOrdersIfNecessary(bForceDestUpdate){

	await updateCompositeOrderbook();

	let arrNewBuyOrders = [];
	let arrNewSellOrders = [];

	const threshold = conf.MARKUP / (10 * 100); // we update destination orders only if best prices from composite orderbook has moved significantly in comparaison from the profit margin

	var bUpdateDestBids = bForceDestUpdate || !compositeSourceBids[0] || previousBestBid < compositeSourceBids[0].price * (1 - threshold) || previousBestBid > compositeSourceBids[0].price * (1 + threshold);
	var bUpdateDestAsks = bForceDestUpdate || !compositeSourceAsks[0] || previousBestAsk < compositeSourceAsks[0].price * (1 - threshold) || previousBestAsk > compositeSourceAsks[0].price * (1 + threshold);

	if (bUpdateDestAsks) {
		previousBestAsk = compositeSourceAsks[0] ? compositeSourceAsks[0].price : Infinity;
		arrNewSellOrders = await updateDestAsks(compositeSourceAsks);
	}
	if (bUpdateDestBids) {
		previousBestBid = compositeSourceBids[0] ? compositeSourceBids[0].price : 0;
		arrNewBuyOrders = await updateDestBids(compositeSourceBids);
	}

	if (bUpdateDestAsks || bUpdateDestBids) {
		await removeDestinationOrdersNotMatchingPriceSourceOrders(bUpdateDestAsks, bUpdateDestBids);
		// we cancel all removed/updated orders first, then create new ones to avoid overlapping prices and self-trades
		await createDestOrders(arrNewBuyOrders.concat(arrNewSellOrders));
	} else 
		process.stdout.write(" ------ dest update skipped");
}

async function onSourceOrderbookUpdate(update) {
	let unlock = await mutex.lock('update');
	console.error('update', JSON.stringify(update, null, '\t'));

	function updateSide(side, target){
		update[side].forEach(bidOrAsk => {
			if (parseFloat(bidOrAsk.size) == 0)
				delete target[bidOrAsk.price];
			else
				target[bidOrAsk.price] = bidOrAsk.size;
		});
	}
	var bForceUpdate = false;
	if (update.base == first_market.base && update.quote == first_market.quote){
		updateSide('bids', assocFirstMarketSourceBids);
		updateSide('asks', assocFirstMarketSourceAsks);
		bForceUpdate = true; // since GB market may lack of liquidity in depth, we always update destination orders
	} else if (second_market && update.base == second_market.base && update.quote == second_market.quote) {
		updateSide('bids', assocSecondMarketSourceBids);
		updateSide('asks', assocSecondMarketSourceAsks);
	} else
		throw Error("unsolicited update received " + snapshot.id)

	await updateDestinationOrdersIfNecessary(bForceUpdate);

	return unlock();
}


async function onSourceOrderbookSnapshot(snapshot) {
	console.log('onSourceOrderbookSnapshot');

	let unlock = await mutex.lock('update');
	function indexSnapshotByPrice(side){
		const assocOrders = {};
		snapshot[side].forEach(bidOrAsk => {
			assocOrders[bidOrAsk.price] = bidOrAsk.size;
		});
		return assocOrders;
	}

	if (snapshot.base == first_market.base && snapshot.quote == first_market.quote){
		assocFirstMarketSourceBids = indexSnapshotByPrice('bids');
		assocFirstMarketSourceAsks = indexSnapshotByPrice('asks');
	} else if (second_market && snapshot.base == second_market.base && snapshot.quote == second_market.quote) {
		assocSecondMarketSourceBids = indexSnapshotByPrice('bids');
		assocSecondMarketSourceAsks = indexSnapshotByPrice('asks');
	} else
		throw Error("unsolicited snapshot received " + snapshot.id)

	await updateDestinationOrdersIfNecessary(true)
	unlock();

}


async function updateCompositeOrderbook(){

	let source_balances = await source.getBalances();

	const baseBalanceOnSource = source_balances.free[first_market.base] || 0;
	const quoteBalanceOnSource = source_balances.free[second_market ? second_market.quote : first_market.quote] || 0;

	if (second_market) {
		const truncatedBids = truncateBids(assocFirstMarketSourceBids, baseBalanceOnSource);
		compositeSourceBids = combineBooks(truncatedBids, 'bids', assocSecondMarketSourceBids);
	}
	else
		compositeSourceBids = truncateBids(assocFirstMarketSourceBids, baseBalanceOnSource);

	const truncatedAsks = truncateAsks(second_market ? assocSecondMarketSourceAsks : assocFirstMarketSourceAsks, quoteBalanceOnSource);
	if (second_market)
		compositeSourceAsks = combineBooks(truncatedAsks, 'asks', assocFirstMarketSourceAsks);
	else
		compositeSourceAsks = truncatedAsks;

	function assocOrders2ArrOrders(type, assocOrders){
		const orders = [];
		for (let price in assocOrders)
			orders.push({ price, size: assocOrders[price] });
		if (type == 'asks')
			orders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
		else if (type == 'bids')
			orders.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
		else
			throw Error("unknown type");
		return orders;
	}

	function truncateBids(assocOrders, balance){
		const allOrders = assocOrders2ArrOrders('bids', assocOrders);
		const truncatedOrders = [];
		for (var i = 0; i < allOrders.length; i++){
			if (balance > allOrders[i].size) {
				balance -= allOrders[i].size;
				allOrders[i].size =  allOrders[i].size;
				allOrders[i].price =  allOrders[i].price;
				truncatedOrders.push(allOrders[i]);
			} else {
				if (balance > 0){
					allOrders[i].size =  balance;
					allOrders[i].price = allOrders[i].price;
					truncatedOrders.push(allOrders[i]);
				}
				break;
			}
		}
		return truncatedOrders;
	}


	function truncateAsks(assocOrders, balance){
		const allOrders = assocOrders2ArrOrders('asks', assocOrders);
		const truncatedOrders = [];
		for (var i = 0; i < allOrders.length; i++){
			if (balance > allOrders[i].size * allOrders[i].price) {
				balance -= allOrders[i].size * allOrders[i].price;
				truncatedOrders.push(allOrders[i]);
			} else {
				if (balance > 0){
					allOrders[i].size = balance / allOrders[i].price;
					truncatedOrders.push(allOrders[i]);
				}
				break;
			}
		}

		return truncatedOrders;
	}

	// pivot as base
	function combineBooks(truncatedOrders, type, assocOrders){
		const orders = assocOrders2ArrOrders(type, assocOrders)
		const combinedOrders = [];
		var j = 0;
		var i = 0; 
	
		while (truncatedOrders[i] && orders[j]){
			const price = orders[j].price * truncatedOrders[i].price;
			if (type == 'bids') {
				if (truncatedOrders[i].size * truncatedOrders[i].price >= orders[j].size){
					combinedOrders.push({
						price, 
						size: orders[j].size / truncatedOrders[i].price, 
						pivot_size: truncatedOrders[i].size * truncatedOrders[i].price, 
					});
					truncatedOrders[i].size -= orders[j].size;
					j++;
				} else {
					combinedOrders.push({
						price, 
						size: truncatedOrders[i].size,
						pivot_size: truncatedOrders[i].size * truncatedOrders[i].price, 
					});
					orders[j].size -= truncatedOrders[i].size * truncatedOrders[i].price;
					i++;
				}
			} else {
				if (truncatedOrders[i].size >= orders[j].price * orders[j].size){
					combinedOrders.push({
						price,
						size: orders[j].size,
						pivot_size: orders[j].price * orders[j].size,
					})

					truncatedOrders[i].size -= orders[j].price * orders[j].size;
					j++;
				} else {
					combinedOrders.push({
						price, 
						size: truncatedOrders[i].size / orders[j].price,
						pivot_size: truncatedOrders[i].size, 
					})
					orders[j].size -= truncatedOrders[i].size * orders[j].price ;
					i++;
				}
			}
		}
		return combinedOrders;
	}

}

async function onDestDisconnect() {
	console.log("will cancel all dest orders after disconnect");
	let bResetOrders = false;
	ws_api.once('reset_orders', async () => {
		bResetOrders = true;
	});
	let waitForResetOrders = () => {
		if (bResetOrders)
			return;
		return new Promise(resolve => ws_api.once('reset_orders', resolve));
	};
	let unlock = await mutex.lock('update');
	console.log("got lock to cancel all dest orders after disconnect");
	await cancelAllTrackedDestOrders(); // this will be actually executed after reconnect
	assocDestOrdersBySourcePrice = {};
	console.log("done cancelling all tracked dest orders after disconnect");
	
	await waitForResetOrders();
	console.log("reset_orders: will cancel all my dest orders after reconnect");
	await cancelAllDestOrders();
	console.log("done cancelling all my dest orders after reconnect");
	await ws_api.subscribeOrdersAndTrades(dest_pair);
	await updateDestinationOrdersIfNecessary(true);
	console.log("done updating dest orders after reconnect");
	unlock();
}


async function onDestTrade(matches) {
	console.log("dest trade", JSON.stringify(matches, null, '\t'));
	let size = 0;
	let side;
	let role;
	for (let i = 0; i < matches.trades.length; i++){
		let trade = matches.trades[i];
		let dest_order = getDestOrderByHash(trade.makerOrderHash);
		if (dest_order) {
			if (role && role !== 'maker')
				throw Error("self-trade?");
			if (dest_order.filled)
				continue;
			role = 'maker';
			side = matches.makerOrders[i].side;
			dest_order.filled = true;
		}
		else {
			dest_order = getDestOrderByHash(trade.takerOrderHash);
			if (dest_order) {
				if (role && role !== 'taker')
					throw Error("self-trade?");
				if (dest_order.filled)
					continue;
				role = 'taker';
				side = matches.takerOrder.side;
				dest_order.filled = true;
			}
		}
		if (dest_order)
			size += trade.amount;
	}
	if (size && !side)
		throw Error("no side");
	if (size) {
		let unlock = await mutex.lock('source_trade');

		size /= 1e9;
		console.log("detected fill of my " + side + " " + size + " GB on dest exchange, will do the opposite on source exchange");

		if (side === 'BUY')
			size += queued_amount;
		else
			size -= queued_amount;
		if (size < 0) { // flip the sides
			size = -size;
			side = (side === 'BUY') ? 'SELL' : 'BUY';
		}
		if (size < conf.MIN_SOURCE_ORDER_SIZE) {
			queued_amount = (side === 'BUY') ? size : -size;
			console.log("amount " + size + " is less than source min order size, will queue");
			return unlock();
		}
		queued_amount = 0;

		if (second_market){

			if (side === 'BUY'){
				const resp = await source.createMarketTx(first_market.base + '/' + first_market.quote, 'SELL', size);
				if (resp.status === 'closed')
					await source.createMarketTx(first_market.quote + '/' + second_market.quote, 'SELL', resp.cost - resp.fee.cost);
				else
					console.log(`first market SELL failed`, resp);
			//	await source.createMarketTx(first_market.quote + '/' + second_market.quote, 'SELL', getPivotSize(compositeSourceBids, size) * (1 - conf.bittrex_fees / 100));

			} else {
			//	await source.createMarketTx(first_market.quote + '/' + second_market.quote, 'BUY', getPivotSize(compositeSourceAsks, size));
				const resp = await source.createMarketTx(first_market.base + '/' + first_market.quote, 'BUY', size);
				if (resp.status === 'closed')
					await source.createMarketTx(first_market.quote + '/' + second_market.quote, 'BUY', resp.cost - resp.fee.cost);
				else
					console.log(`first market BUY failed`, resp);
			}
				
		} else {
			await source.createMarketTx(first_market.base + '/' + first_market.quote, side === 'BUY' ? 'SELL' : 'BUY', size);
		}
		unlock();
	}
	else
		console.log("no my orders or duplicate");
}


function getPivotSize(arr, size){

	let pivot_size = 0;

	for (var i=0; i < arr.length; i++){
		if (size > arr[i].size){
			pivot_size += arr[i].pivot_size;
			size -= arr[i].size;
		} else {
			pivot_size += arr[i].pivot_size * (size / arr[i].size);
			break;
		}

	}
	return pivot_size;
}

function startBittrexWs() {
	const bittrexWS = new ccxws.bittrex();
	// market could be from CCXT or genearted by the user

	bittrexWS.on("error", err => console.error('---- error from bittrex socket', err));

	// handle trade events
	bittrexWS.on("trade", trade => console.error('trade', JSON.stringify(trade, null, '\t')));

	// handle level2 orderbook snapshots
	bittrexWS.on("l2snapshot", onSourceOrderbookSnapshot);
	bittrexWS.on("l2update", onSourceOrderbookUpdate);

	// subscribe to trades
	bittrexWS.subscribeTrades(first_market);
	if (second_market)
		bittrexWS.subscribeTrades(second_market);

	// subscribe to level2 orderbook snapshots
	bittrexWS.subscribeLevel2Updates(first_market);
	if (second_market)
		bittrexWS.subscribeLevel2Updates(second_market);
}





/**
 * headless wallet is ready
 */
async function start() {
	await odex.start();
	await source.start();

	ws_api.on('trades', (type, payload) => {
		console.error('---- received trades', type, payload);
	});
	ws_api.on('orderbook', (type, {asks, bids}) => {
		console.error('---- received orderbook', type, asks, bids);
	});
	ws_api.on('ohlcv', (type, payload) => {
		console.error('---- received ohlcv', type, payload);
	});
	ws_api.on('orders', async (type, payload) => {
		console.error('---- received orders', type, payload);
		if (type === 'ORDER_CANCELLED')
			console.log("order " + payload.hash + " at " + payload.price + " cancelled");
		else if (type === 'ORDER_ADDED')
			console.log("order " + payload.hash + " at " + payload.price + " added with status " + payload.status);
		else if (type === 'ERROR') {
			if (payload.match(/Cannot cancel order .+\. Status is FILLED/))
				return console.error("attempting to cancel a filled order");
			if (payload.match(/Cannot cancel order .+\. Status is CANCELLED/))
				return console.error("attempting to cancel a cancelled order");
			if (payload.match(/failed to find the order to be cancelled/))
				return console.error("attempting to cancel a non-existent order");
			console.error('latest dest balances', await balances.getBalances());
			let matches = payload.match(/^Insufficient.+open orders:\n([^]*)$/);
			if (matches) {
				let arrLines = matches[1].split('\n');
				let arrUnknownHashes = [];
				arrLines.forEach(line => {
					let hash = line.match(/^\S+/)[0];
					if (!getDestOrderByHash(hash))
						arrUnknownHashes.push(hash);
				});
				console.error("unknown orders: " + arrUnknownHashes.join(', '));
				let arrSourcePrices = Object.keys(assocDestOrdersBySourcePrice);
				arrSourcePrices.sort((a, b) => parseFloat(b) - parseFloat(a)); // reverse order
				let arrDestOrders = arrSourcePrices.map(source_price => {
					let dest_order = assocDestOrdersBySourcePrice[source_price];
					return dest_order.hash + ": " + dest_order.size + " at " + source_price;
				});
				console.error("dest orders:\n" + arrDestOrders.join('\n'));
			}
		//	await cancelAllTrackedDestOrdersBeforeExiting();
			process.exit(1);
		}
	});
	ws_api.on('raw_orderbook', (type, payload) => {
		console.error('---- received raw_orderbook', type, payload);
	});
	ws_api.on('orders', (type, payload) => {
		console.error('---- received orders', type, payload);
		if (type === 'ORDER_MATCHED')
			onDestTrade(payload.matches);
	});
	ws_api.on('disconnected', onDestDisconnect);
//	ws_api.on('reset_orders', resetDestOrders);

	await ws_api.subscribeOrdersAndTrades(dest_pair);
	await orders.trackMyOrders();
	await cancelAllDestOrders();

	first_market = {
		id: conf.first_bittrex_pair, // remote_id used by the exchange
		base: conf.first_bittrex_pair.split('-')[0], // standardized base symbol for Bitcoin
		quote: conf.first_bittrex_pair.split('-')[1], // standardized quote symbol for Tether
	};

	if (conf.second_bittrex_pair){
		second_market = {
			id: conf.second_bittrex_pair, // remote_id used by the exchange
			base: conf.second_bittrex_pair.split('-')[0], // standardized base symbol for Bitcoin
			quote: conf.second_bittrex_pair.split('-')[1], // standardized quote symbol for Tether
		};
	}
	let tokensBysymbols = exchange.getTokensBySymbol();
	quote_decimals = tokensBysymbols[conf.quote_currency].decimals;
	startBittrexWs();
}


start();


process.on('unhandledRejection', async up => {
	console.error('unhandledRejection event', up);
	await cancelAllTrackedDestOrdersBeforeExiting();
	console.error('unhandledRejection done cancelling orders');
	process.exit(1);
//	throw up;
});
process.on('exit', () => {
	console.error('exit event');
	cancelAllTrackedDestOrdersBeforeExiting();
});
process.on('beforeExit', async () => {
	console.error('beforeExit event');
	await cancelAllTrackedDestOrdersBeforeExiting();
	console.error('beforeExit done cancelling orders');
});
['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'].forEach(function (sig) {
	process.on(sig, async () => {
		console.error(sig + ' event');
		await cancelAllTrackedDestOrdersBeforeExiting();
		console.error(sig + ' done cancelling orders');
		process.exit(1);
	});
});
