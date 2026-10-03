# Dropwatch

Dropwatch tells you the minute a trading-card product is back in stock, so you can buy it yourself before it sells out. It opens the product page, sounds an alarm and can buzz your phone.

It never buys anything for you, and it does not pretend to be a person. See [What it will not do](#what-it-will-not-do).

## Download

**[Download Dropwatch for Windows](https://github.com/kfancy420/dropwatch/releases/latest)** (Windows 10 or 11, 64-bit). On the release page, pick the file named `Dropwatch-Setup-…exe`.

1. Run the file you downloaded. Dropwatch installs for your user account only, with no administrator prompt, and adds a shortcut to the desktop and the Start menu.
2. Windows may show a blue "Windows protected your PC" box, because the installer is not signed with a paid certificate. Click **More info**, then **Run anyway**.
3. Open Dropwatch. It walks you through three steps: how you want to be alerted, phone alerts, and your first product.

There is no Mac version yet.

## How to use it

**Add a product.** Open the product page in your browser, copy the address from the address bar, and paste it into **Add a product**. Dropwatch checks the link and shows you what it found before it starts watching. You can set a price limit, so a reseller's marked-up stock does not set off the alarm.

**Get alerts on your phone.** Install the free ntfy app ([iPhone](https://apps.apple.com/us/app/ntfy/id1625396347), [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)). In Dropwatch, open **Settings**, turn on phone alerts, and subscribe to the channel name it shows you in the ntfy app. Press **Send a test alert** to check that it reaches you. Dropwatch can also post alerts to a Discord channel.

**Leave it running.** Closing the window keeps Dropwatch watching from the system tray, next to the clock. To stop it completely, right-click the tray icon and choose **Quit Dropwatch**. In Settings you can have it start when you sign in to Windows.

**Set reminders for the big stores.** Dropwatch does not check Pokemon Center, Target, Walmart and a few others (see below). For those, add a reminder a few minutes before an announced drop, and Dropwatch alerts you at that minute.

## Which stores it can watch

| Store | Watched | How |
|---|---|---|
| Card shops that run on Shopify, which covers many independent game stores online | Yes | Reads the product data the shop publishes, every 30 seconds |
| Other small shops | Often | Reads the stock information on the product page, every 60 seconds. If the page has none, you can tell Dropwatch the words the page shows when it is sold out |
| Best Buy | Yes, with a free key | Uses Best Buy's official product API. Get a key at [developer.bestbuy.com](https://developer.bestbuy.com/) and paste it in Settings |
| Pokemon Center, Target, Walmart, GameStop, Amazon, Costco, Sam's Club | No | These stores do not allow automated checks. Use reminders |

If a shop's own rules (its robots.txt file) say not to read a page, or the shop refuses the request, Dropwatch stops checking that product and tells you why. It does not try to get around it.

## Before a drop

Checkout is where people lose time. Do these ahead of time at every store on your list:

- Sign in, and stay signed in.
- Save your shipping address and a payment method to your account.
- Know the regular price, so you can tell a fair listing from a marked-up one.
- When the alert fires, go straight to checkout.

The app has a drop-day guide with notes for each store.

## What it will not do

Dropwatch is a lookout. You are the buyer. It does not:

- add to cart or check out for you
- solve CAPTCHAs, skip waiting rooms or get around purchase limits
- hide what it is, rotate addresses or use more than one account
- check stores whose rules forbid automated checks

Those are the things scalper bots do. They break the stores' terms and can get orders cancelled and accounts closed. Dropwatch reads information shops publish, at a slow pace, under its own name.

It also cannot promise you the product. On a first-come, first-served drop a checkout bot can still be faster than a person. What Dropwatch removes is the part where you find out an hour too late.

## Privacy

Dropwatch has no account and no analytics. Your watchlist and settings stay in a folder on your computer (`%APPDATA%\Dropwatch`). It connects to:

- the product pages on your watchlist, and each shop's robots.txt
- ntfy.sh or Discord, only if you turn those alerts on
- Best Buy's API, only if you add a key
- GitHub, once a day, to see whether a newer version is out

Phone alerts travel through the public ntfy.sh service. Anyone who knows your channel name can read them, so Dropwatch generates a random one for you. The alerts hold a product name, price and link.

Uninstalling from Windows Settings removes the app and leaves that folder in place. Delete it by hand to remove your watchlist too.

## For developers

Needs Node 20 or newer and pnpm.

```
pnpm install
pnpm test          # unit tests
pnpm typecheck
pnpm app:dev       # run the app with hot reload
pnpm app:build     # build into out/
pnpm e2e           # drive the built app end to end against a local pretend shop
pnpm app:dist      # build the Windows installer into release/
```

The checking engine lives in `src/` and has no Electron in it. The desktop app in `app/` wraps it. The same engine also runs as a command-line tool: `pnpm build`, then `node dist/cli.js --help`.
