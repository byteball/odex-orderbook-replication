# ODEX orderbook replication bot

This trading bot replicates the orderbook from Bittrex to ODEX for GBYTE/BTC trading pair. On ODEX, a BTC-pegged stablecoin is used instead of BTC. The bot copies all pending buy and sell orders from the source exchange (Bittrex) to the destination exchange (ODEX) while adding a configurable (2% by default) markup. Once an order is filled on ODEX, the bot immediately sends an opposite market order of the same amount to Bittrex. For example, if the bot's sell order for 1 GBYTE is filled on ODEX, it immediately buys 1 GBYTE on Bittrex. Thus, its exposure stays constant while it earns the difference between the buy and sell prices, which is supposed to be equal to the markup, minus exchange fees.

If the source exchange is more liquid than the destination exchange, the bot's activity improves the depth of the orderbook on the destination exchange (ODEX).

This bot and its source code are offered as is, without any guarantees of its correct operation. The bot might lose money because of bugs, unreliable network connections, and other reasons.

## Install
Install node.js 8+, clone the repository, then say
```sh
npm install
```

## Configure

Enable API access on Bittrex and get the corresponding API key. Your API keys should be with access to trading only, don't enable withdrawals for security reasons.

Create a `~/.config/odex-orderbook-replication/conf.json` file and set your API credentials for the source (Bittrex) exchange in `sourceApiKey` and `sourceApiSecret` keys. Alternatively, you can set these fields in `.env` (see the `.env.sample` provided).

Regarding its work with ODEX, there are two modes the bot can operate in:
* The bot includes its own Obyte wallet, separate from your main trading account. You don't need to setup any API access on ODEX. But you need to deposit/withdraw to/from the bot's account separately.
* The bot trades on your main ODEX account. ODEX UI doesn't include this option yet but you can send a `grant` command to the ODEX AA directly to grant the bot the right to trade on your behalf. Then, the bot's address will be allowed to create and cancel orders but not to deposit and withdraw funds. Set your main ODEX address as `owner_address` in conf.

Subsequent discussion assumes the former mode.

## Prepare

Deposit BTC and GBYTE to Bittrex.

To deposit to ODEX, run this script first:
```sh
node run-idle.js
```
Note the pairing code that it prints, use it to pair your Obyte wallet to the bot. In chat with the bot, type `address` to learn its Obyte address.

Click the address and send both GBYTE and a BTC-pegged stablecoin to the bot. Now the coins are on the bot's wallet but not on the exchange yet.

Type e.g. `deposit 10 GBYTE` or `deposit 0.2 BTC_20200701` to deposit 10 GBYTE or 0.2 BTC_20200701 respectively to the bot's balance on the exchange. You'll have to wait for confirmation after the first deposit, otherwise the bot will complain about lack of funds when you attempt a second deposit. All subsequent deposit commands can be issued without delay.

After the bot's deposits to ODEX are confirmed, you are ready to trade.

Refer to [ODEX client documentation](https://github.com/byteball/odex-client#trading-balances) and [headless wallet documentation](https://github.com/byteball/headless-obyte#remote-control) for other chat commands you can give to the bot.

The total amount of orders the bot can create on the destination exchange is capped by your balances on the exchanges. For example, the total amount of GBYTE you can have in asks on the destination exchange is capped by both your GBYTE balance on the destination exchange and your BTC balance on the source exchange (as you will use BTC to buy GBYTE on the source exchange when GBYTE is sold on the destination exchange).

## Run
```sh
node start.js
```
It is recommended to run the bot using [pm2](https://pm2.keymetrics.io/) to enable automatic restarts. Install pm2 globally:
```sh
npm install -g pm2
```
Run:
```sh
pm2 start start.js --time
```
Stop:
```sh
pm2 stop start.js
```
Logs will grow quite fast. Refer to pm2 documentation for proper log management.
